// 写作编排：为一本书 spawn 绑定 profile 的新 Unterm 实例 → 开代理 → 启动选定 agent（带初始指令）
// → 连上该实例 MCP → 启动 autopilot 监控应答。
import fs from 'node:fs';
import path from 'node:path';
import { getModel, detectModel } from './models.mjs';
import {
  ensureProfile, spawnInstance, instancePids, waitForNewInstance,
  resolveProxyNode, proxyUrl, findUntermCli,
} from './unterm.mjs';
import { connectInstance } from './mcpclient.mjs';
import { Autopilot } from './autopilot.mjs';
import { refreshContext } from './scaffold.mjs';
import { reviewOutline, buildReviseInstruction, buildProceedInstruction, buildRenudgeInstruction, buildRecheckRenudgeInstruction, recheckRevision, snapshotOutline, verifyRevision } from './editor.mjs';
import { saveSession } from './sessions.mjs';
import { recordUsage } from './usage.mjs';
import { bookStats } from './books.mjs';

// 生成 launch.ps1：设代理环境、（best-effort）切 unterm 代理、cd 到书目录、启动 agent 带初始指令
export function writeLaunchScript(book, model, instruction, cfg) {
  const m = getModel(model);
  const seed = m.seedArgs(instruction, cfg);
  // 安全网：把任何换行折叠成空格 —— 多行 prompt 会被 agent 当多行草稿、等人工回车，无法自动开跑。
  const psArr = '@(' + seed.map(a => "'" + String(a).replace(/[\r\n]+/g, ' ').replace(/'/g, "''") + "'").join(',') + ')';
  const proxy = cfg.enableProxy ? proxyUrl() : '';
  const lines = [
    '$ErrorActionPreference = "Continue"',
    `Set-Location -LiteralPath '${book.dir.replace(/'/g, "''")}'`,
    `Write-Host "== Novel Studio :: 《${book.title.replace(/"/g, '`"')}》 / ${m.name} ==" -ForegroundColor Cyan`,
  ];
  if (cfg.enableProxy && proxy) {
    // 只为本会话注入代理环境变量（大小写都给，兼容 codex 的 Rust HTTP 客户端）；
    // 绝不改动 unterm 全局 proxy.json，避免污染用户配置。
    lines.push(
      `$env:HTTP_PROXY = '${proxy}'`, `$env:HTTPS_PROXY = '${proxy}'`, `$env:ALL_PROXY = '${proxy}'`,
      `$env:http_proxy = '${proxy}'`, `$env:https_proxy = '${proxy}'`, `$env:all_proxy = '${proxy}'`,
      `Write-Host "[proxy] 本会话已启用 ${proxy}" -ForegroundColor DarkGray`,
    );
  }
  lines.push(
    `Write-Host "[agent] 启动 ${m.bin} ，初始指令已注入…" -ForegroundColor DarkGray`,
    `$seed = ${psArr}`,
    `& ${m.bin} @seed`,
  );
  const p = path.join(book.dir, '.studio', 'launch.ps1');
  fs.writeFileSync(p, '﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM 保证中文
  return p;
}

// 主流程。返回 { instance, mcp, autopilot, paneId }。
export async function startWriting({ book, model, instruction, cfg, onLog = () => {}, attachAutopilot = true }) {
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  const det = detectModel(model);
  if (!det.available) {
    throw new Error(`${m.name} 不可用（${m.bin} 不在 PATH）。可用 \`unterm-cli agent install ${m.untermAgentId}\` 安装。`);
  }

  // 刷新本书 agent 上下文（写作 skill 标准）
  refreshContext(book);

  // 确保 profile
  const profileName = book.profile;
  onLog({ msg: `确保 profile：${profileName}` });
  ensureProfile(profileName);

  // 写 launch.ps1
  const launch = writeLaunchScript(book, model, instruction, cfg);
  onLog({ msg: `已生成启动脚本：${path.relative(book.dir, launch)}` });

  // spawn 新实例
  const beforePids = instancePids();
  onLog({ msg: `spawn 新 Unterm 实例（绑定 profile ${profileName}，cwd ${book.dir}）…` });
  const pid = spawnInstance({ profile: profileName, cwd: book.dir, launchScript: launch });
  onLog({ msg: `已启动 unterm 进程 pid=${pid}，等待实例注册…` });

  const instance = await waitForNewInstance({ beforePids, pid, cwd: book.dir, timeoutMs: 30000 });
  if (!instance) throw new Error('未能定位到新实例（30s 超时）。请确认 Unterm 正常启动。');
  onLog({ msg: `新实例：${instance.id}  mcp_port=${instance.mcp_port}  v${instance.version}` });

  // 连 MCP（实例刚起，端口可能稍迟，做几次重试）
  let mcp = null;
  for (let i = 0; i < 12; i++) {
    try { mcp = await connectInstance(instance, { identifyAs: cfg.untermAgentName }); break; }
    catch { await sleep(800); }
  }
  if (!mcp) throw new Error('连接实例 MCP 失败');
  onLog({ msg: `已连接实例 MCP（auth ok）` });

  // 代理：仅靠 launch.ps1 注入的会话级环境变量，不改 unterm 全局配置
  if (cfg.enableProxy) onLog({ msg: `代理已为会话注入环境变量：${proxyUrl() || '(未配置)'}` });

  // 找到 agent 所在 pane
  const paneId = await waitForPane(mcp, 20000);
  if (paneId == null) throw new Error('未找到 agent pane');
  onLog({ msg: `agent pane id=${paneId}` });

  // 登记为运行中会话，供 send / watch / stop（任意进程）连接
  saveSession({
    slug: book.slug, title: book.title, model,
    instanceId: instance.id, mcp_port: instance.mcp_port, auth_token: instance.auth_token,
    pane: paneId, pid: instance.pid, startedAt: new Date().toISOString(),
  });

  // 启动 autopilot
  let autopilot = null;
  const tokenKey = instance.id + '@' + (instance.started_at || '');
  if (attachAutopilot && cfg.autopilot?.enabled) {
    // 大纲审稿门：作者输出「【大纲待审：xxx】」时，换一个模型无头审稿，把修订指令注回，并给相关文件拍快照。
    const editorOff = cfg.editorReview?.enabled === false;
    const renudge = new Map();   // scope -> 已重催次数
    const onOutlineReady = editorOff ? undefined : async (scope) => {
      try {
        const r = await reviewOutline({ book, scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) });
        try { snapshotOutline(book, scope); } catch {}   // 拍快照，供后续核对作者是否真改了
        return buildReviseInstruction(book, scope, r.file);
      } catch (e) { onLog({ level: 'warn', msg: '大纲审稿失败：' + e.message, source: 'editor' }); return null; }
    };
    // 修订验证门：作者输出「【大纲已修订：xxx】」时——①文件没动就便宜重催；②动了则由主编二次复审硬伤是否真改对，过了才放行。
    const maxNudge = cfg.editorReview?.maxRenudge ?? 2;
    const onRevisionDone = editorOff ? undefined : async (scope) => {
      const v = verifyRevision(book, scope);
      if (!v.hadSnapshot) return buildProceedInstruction(book, scope);  // 无快照(如手动流)→不拦
      // ① 文件根本没动 → 便宜重催，不花模型调用
      if (!v.changed) {
        const n = (renudge.get(scope) || 0) + 1; renudge.set(scope, n);
        if (n > maxNudge) { renudge.delete(scope); onLog({ level: 'warn', msg: `大纲仍未见改动，已达重催上限 → 放行（请人工留意 ${scope}）`, source: 'editor' }); return buildProceedInstruction(book, scope); }
        onLog({ level: 'warn', msg: `大纲文件未见改动 → 第 ${n} 次要求作者真正修改`, source: 'editor' });
        return buildRenudgeInstruction(book, scope);
      }
      // ② 文件改了 → C：主编二次复审，确认硬伤真解决了
      if (cfg.editorReview?.recheck === false) { renudge.delete(scope); onLog({ level: 'act', msg: `已核实大纲修订（改动：${v.changedFiles.join('、')}）→ 放行开写`, source: 'editor' }); return buildProceedInstruction(book, scope); }
      let rc;
      try { rc = await recheckRevision({ book, scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) }); }
      catch (e) { renudge.delete(scope); onLog({ level: 'warn', msg: '复审失败（放行）：' + e.message, source: 'editor' }); return buildProceedInstruction(book, scope); }
      if (rc.pass) { renudge.delete(scope); onLog({ level: 'act', msg: `主编复审通过：硬伤已解决 → 放行开写`, source: 'editor' }); return buildProceedInstruction(book, scope); }
      // 复审没过 → 退回作者再改（更新快照作下一轮基线，计数到上限则放行）
      const n = (renudge.get(scope) || 0) + 1; renudge.set(scope, n);
      try { snapshotOutline(book, scope); } catch {}
      if (n > maxNudge) { renudge.delete(scope); onLog({ level: 'warn', msg: `复审仍未过，已达上限 → 放行（请人工留意 ${scope}）`, source: 'editor' }); return buildProceedInstruction(book, scope); }
      onLog({ level: 'warn', msg: `主编复审未过：仍有硬伤未解决 → 第 ${n} 次退回作者`, source: 'editor' });
      return buildRecheckRenudgeInstruction(book, scope, rc.file);
    };
    autopilot = new Autopilot(mcp, paneId, {
      ...cfg.autopilot,
      onLog: (e) => onLog({ ...e, source: 'autopilot' }),
      onTokens: (n) => recordUsage(book.slug, tokenKey, n),
      onOutlineReady,
      onRevisionDone,
      shouldStopContinue: () => { const t = book.targetChapters || 0; return t > 0 && bookStats(book).chapters >= t; },
    });
    autopilot.start();   // 不 await，后台跑
  }

  return { instance, mcp, autopilot, paneId, pid };
}

async function waitForPane(mcp, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ss = await mcp.sessionList().catch(() => []);
    const alive = ss.filter(s => !s.is_dead);
    if (alive.length) return alive[0].id;
    await sleep(500);
  }
  return null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
