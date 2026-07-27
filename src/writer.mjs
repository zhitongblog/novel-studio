// 写作编排：为一本书 spawn 绑定 profile 的新 Unterm 实例 → 开代理 → 启动选定 agent（带初始指令）
// → 连上该实例 MCP → 启动 autopilot 监控应答。
import fs from 'node:fs';
import path from 'node:path';
import { getModel, detectModel } from './models.mjs';
import {
  ensureProfile, spawnInstance, instancePids, waitForNewInstance,
  resolveProxyNode, proxyUrl, findUntermCli, listInstances, killProcess,
} from './unterm.mjs';
import { connectInstance } from './mcpclient.mjs';
import { Autopilot } from './autopilot.mjs';
import { refreshContext } from './scaffold.mjs';
import { reviewOutline, buildReviseInstruction, buildProceedInstruction, buildRenudgeInstruction, buildRecheckRenudgeInstruction, recheckRevision, snapshotOutline, verifyRevision, reviewEnding, buildEndingRenudgeInstruction } from './editor.mjs';
import { buildFinaleInstruction, buildAfterwordInstruction } from './planner.mjs';
import { setPending, hasPending, getReviewEvery, setReviewEvery, setReviewDefault, takeResume } from './pending.mjs';
import { saveSession } from './sessions.mjs';
import { recordUsage, currentContextSize } from './usage.mjs';
import { bookStats, getBook, setBookStatus, archiveFlatChapters, archiveVolumeFolders, clearFlatImport, plannedVolumes, currentVolume, plannedTotalChapters, chaptersPerVol } from './books.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { runFinaleClosure } from './finale.mjs';

const IS_WIN = process.platform === 'win32';

// 生成启动脚本：设代理环境、cd 到书目录、启动 agent 带初始指令。
// Windows → launch.ps1（pwsh）；macOS/Linux → launch.sh（POSIX sh）。
export function writeLaunchScript(book, model, instruction, cfg) {
  const m = getModel(model);
  // 安全网：把任何换行折叠成空格 —— 多行 prompt 会被 agent 当多行草稿、等人工回车，无法自动开跑。
  const seed = m.seedArgs(instruction, cfg).map(a => String(a).replace(/[\r\n]+/g, ' '));
  const proxy = cfg.enableProxy ? proxyUrl() : '';
  const dir = path.join(book.dir, '.studio');
  fs.mkdirSync(dir, { recursive: true });

  if (IS_WIN) {
    const psArr = '@(' + seed.map(a => "'" + a.replace(/'/g, "''") + "'").join(',') + ')';
    const lines = [
      '$ErrorActionPreference = "Continue"',
      `Set-Location -LiteralPath '${book.dir.replace(/'/g, "''")}'`,
      `Write-Host "== Novel Studio :: 《${book.title.replace(/"/g, '`"')}》 / ${m.name} ==" -ForegroundColor Cyan`,
    ];
    if (proxy) {
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
    const p = path.join(dir, 'launch.ps1');
    fs.writeFileSync(p, '﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM 保证中文
    return p;
  }

  // POSIX sh：单引号包裹（内部 ' → '\'' 转义）。agent 跑前台，不 exec（退出后由外层 shell 保持窗口）。
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const lines = ['#!/bin/sh', `cd ${q(book.dir)} || exit 1`,
    `echo "== Novel Studio :: 《${book.title}》 / ${m.name} =="`];
  if (proxy) {
    for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      lines.push(`export ${v}=${q(proxy)}`);
    }
    lines.push(`echo "[proxy] 本会话已启用 ${proxy}"`);
  }
  lines.push(`echo "[agent] 启动 ${m.bin} ，初始指令已注入…"`,
    `${m.bin} ${seed.map(q).join(' ')}`);
  const p = path.join(dir, 'launch.sh');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  try { fs.chmodSync(p, 0o755); } catch {}
  return p;
}

// 主流程。返回 { instance, mcp, autopilot, paneId }。
// autopilotConfirmOnly：只挂"自动确认提问"的极简 autopilot，绝不自动续写（共创窗口模式用）。
export async function startWriting({ book, model, instruction, cfg, onLog = () => {}, attachAutopilot = true, autopilotConfirmOnly = false, onFreshRestart = null }) {
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  const det = detectModel(model);
  if (!det.available) {
    throw new Error(`${m.name} 不可用（${m.bin} 不在 PATH）。可用 \`unterm-cli agent install ${m.untermAgentId}\` 安装。`);
  }

  // 刷新本书 agent 上下文（写作 skill 标准）
  refreshContext(book);

  // 平铺分章兜底：每次开写前由代码幂等地把根目录残留正文移进 chapters/卷01/（应对续传/后补文件），
  // 移完清掉 flatImport，避免续写指令里反复出现"去归档"的无用噪音。
  try {
    const r = archiveFlatChapters(book.dir);
    const rv = archiveVolumeFolders(book.dir);
    if (r.moved + rv.moved > 0) onLog({ msg: `已自动归档 ${r.moved + rv.moved} 个章节文件 → chapters/（${rv.vols} 个卷目录）` });
    if (book.flatImport) { try { clearFlatImport(book.slug); } catch {} }
  } catch {}

  // 确保 profile
  const profileName = book.profile;
  onLog({ msg: `确保 profile：${profileName}` });
  ensureProfile(profileName);

  // 写 launch.ps1
  const launch = writeLaunchScript(book, model, instruction, cfg);
  onLog({ msg: `已生成启动脚本：${path.relative(book.dir, launch)}` });

  // 【去重】startWriting 只在会话已死/探不到时才走到这（doWrite/resume 已判过 sessionLive）——此时该书目录若还残留活窗口，
  // 就是引擎驱动不了的"孤儿窗口"（会 sentinel 卡死、又抢写同一本撞章）。开新窗口前先把它们杀掉，保证一本书只有一个受控窗口。
  try {
    const normDir = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    const orphans = listInstances().filter(i => normDir(i.cwd) === normDir(book.dir));
    for (const inst of orphans) {
      onLog({ level: 'warn', msg: `发现《${book.title}》残留孤儿窗口 ${inst.id}(pid ${inst.pid})，引擎未在驱动 → 关闭，避免开出重复窗口抢写` });
      try { killProcess(inst.pid); } catch {}
    }
    if (orphans.length) await new Promise(r => setTimeout(r, 1500));
  } catch {}

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
  if (attachAutopilot && cfg.autopilot?.enabled && autopilotConfirmOnly) {
    // 【共创窗口模式】只挂"自动确认提问"的极简 autopilot：确认 y/n、菜单、信任目录，绝不自动续写下一章。
    autopilot = new Autopilot(mcp, paneId, {
      ...cfg.autopilot, confirmOnly: true,
      onLog: (e) => onLog({ ...e, source: 'autopilot' }),
      onTokens: (n) => recordUsage(book.slug, tokenKey, n),
    });
    autopilot.start();
  } else if (attachAutopilot && cfg.autopilot?.enabled) {
    // 大纲审稿门：作者输出「【大纲待审：xxx】」时，换一个模型无头审稿。
    const editorOff = cfg.editorReview?.enabled === false;
    const slug = book.slug;
    // 从持久化的写作模式播种运行时审核开关（重启/重挂后恢复）：review→每 reviewEvery 批审核；auto→0。
    // 读 store 最新值，不用入参 book（它可能是 setBookWriteMode 之前抓的旧引用，writeMode 会缺）。
    { const fb = getBook(slug) || book; setReviewEvery(slug, fb.writeMode === 'review' ? (fb.reviewEvery || 1) : 0); }
    // 确认门：仅【逐批审核 review 模式】要人工确认；【全自动 auto 模式】审稿后直接自动采纳、不停手（自动处理）。
    const gateOn = ((getBook(slug) || book)?.writeMode !== 'auto') && cfg.editorReview?.requireApproval !== false;
    const renudge = new Map();   // scope -> 已重催次数
    const onOutlineReady = editorOff ? undefined : async (scope) => {
      try {
        const r = await reviewOutline({ book, scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) });
        if (gateOn) {
          // 确认门：不自动改内容，挂起等用户决定（应用/跳过）。autopilot 据 isPending 暂停。
          setPending(slug, { kind: 'outline', scope, file: r.file, critique: (r.critique || '').slice(0, 6000) });
          onLog({ level: 'act', source: 'editor', kind: 'pending-review', scope, file: path.basename(r.file), msg: `⏸ 主编审稿意见已生成（${scope}），待你确认：应用修订 / 跳过` });
          // 让作者窗口先停手，别在等确认时乱改
          return '主编审稿意见已生成，请先暂停：不要改大纲、也不要写正文，等待用户确认是否采纳后再继续。';
        }
        try { snapshotOutline(book, scope); } catch {}   // 非确认门：自动改，先拍快照供核对
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
    // —— 完本策略：收尾入口判定 + 收束令 + 完本审稿 + 完本状态 ——
    const finaleOn = cfg.finale?.enabled !== false;
    let finaleBatches = 0;
    const renudgeF = new Map();
    // 当前阶段：'done' 已完本 | 'finale' 收尾中 | 'writing' 连载中（每次实时重读 book + 章数）
    const finalePhase = () => {
      const b = getBook(slug) || book;
      if (b.status === '已完本') return 'done';
      if (b.status === '收尾中') return 'finale';
      if (finaleOn && cfg.finale?.autoEnterLastVolume !== false) {
        // 自动入口：已写到"规划总章数 − 一卷"(即进入最后一卷的体量)就进收尾。
        // 总章数从 目标章数/bible全书章数/卷数×每卷章数 推导——比数卷目录可靠(空/错位卷目录不会误判)。
        const total = plannedTotalChapters(b);
        if (total > 0) {
          const lastVol = chaptersPerVol(b) || Math.ceil(total * 0.1);
          if (bookStats(b).chapters >= total - lastVol) return 'finale';
        }
      }
      return 'writing';
    };
    // 收尾分支：处于收尾就返回收束令（首次给全套+标状态；之后精简续推；超批次封顶则强制立刻收束）。
    const finaleCheck = !finaleOn ? undefined : async () => {
      if (finalePhase() !== 'finale') return null;
      const b = getBook(slug) || book;
      let first = false;
      if (b.status !== '收尾中') {
        try { setBookStatus(slug, '收尾中'); } catch {} first = true;
        const pv = plannedVolumes(b), cv = currentVolume(b), ch = bookStats(b).chapters;
        onLog({ level: 'act', msg: `已进入【收尾 / 完本冲刺】阶段（卷${cv}${pv ? '/' + pv : ''}，第${ch}章）`, source: 'finale' });
      }
      finaleBatches++;
      const cap = cfg.finale?.maxFinaleBatches || 30;
      if (finaleBatches > cap) {
        onLog({ level: 'warn', msg: `收尾已 ${finaleBatches} 批仍未完本 → 要求立即收束`, source: 'finale' });
        return `收尾批次已偏多，请【立即】把当前所有未了线索快速但合理地收束，写出大高潮与结局，务必在本批或下一批内完成并输出「【完本待审】」，不要再拖延铺陈。`;
      }
      return buildFinaleInstruction(b, { first });
    };
    // 完本闸：作者输出「【完本待审】」→ 主编核对完本清单。过则标已完本+afterword+停；不过退回补写（上限保护）。
    const onFinaleReady = !finaleOn ? undefined : async () => {
      const b = getBook(slug) || book;
      const done = (text) => {
        try { setBookStatus(slug, '已完本'); } catch {}
        // 完结终发布闭环(C)：标已完本后，延迟自动"收口"——把收尾新增章(含尾声/完本感言)发齐到番茄并对账。
        // 延迟是为了等作者把"完本感言/尾声"那一章写完(autopilot 随后即停)。失败不影响完本，UI 也可手动重跑。
        if (cfg.finale?.autoClosure !== false) {
          const delay = cfg.finale?.closureDelayMs ?? 120000;
          const b0 = getBook(slug) || book;
          if (b0?.publish?.profilePath && b0?.publish?.bookId) {
            onLog({ level: 'act', source: 'fanqie', msg: `已标记【已完本】。约 ${Math.round(delay / 1000)} 秒后自动完结收口（把尾声/完本感言发齐到番茄并对账）；也可在「📤发布番茄→完结收口」手动触发。` });
            setTimeout(() => {
              runFinaleClosure(getBook(slug) || b0, { cfg, onLog: (e) => onLog({ ...e }) }).catch(() => {});
            }, Math.max(0, delay)).unref?.();
          }
        }
        return { text, stop: true };
      };
      if (cfg.finale?.reviewEnding === false) { onLog({ level: 'act', msg: '已完本（未开完本审稿）', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      let rc;
      try { rc = await reviewEnding({ book: b, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'finale' }) }); }
      catch (e) { onLog({ level: 'warn', msg: '完本审稿失败 → 放行标完本：' + e.message, source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      if (rc.pass) { onLog({ level: 'act', msg: '完本审稿通过 → 标记【已完本】', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      const n = (renudgeF.get('完本') || 0) + 1; renudgeF.set('完本', n);
      if (n > (cfg.finale?.maxRenudge ?? 2)) { onLog({ level: 'warn', msg: '完本审稿仍未过，已达上限 → 标完本（请人工把关结局）', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      onLog({ level: 'warn', msg: `完本审稿未过 → 第 ${n} 次退回补写结局`, source: 'finale' });
      return { text: buildEndingRenudgeInstruction(b, rc.file), stop: false };
    };
    // —— 逐批审核（半自动写作模式）：审核模式下每写够 N 批就停下，等用户在界面裁决（批准/按要求改/停止）——
    // reviewEvery 实时从 pending store 读，支持运行中热切换全自动 ↔ 审核模式。
    const onBatchReview = async ({ n, defaultText }) => {
      const b = getBook(slug) || book;
      const chapters = (() => { try { return bookStats(b).chapters; } catch { return 0; } })();
      setReviewDefault(slug, defaultText);   // 暂存"批准并继续"的默认续写文案
      setPending(slug, { kind: 'batch-review', scope: `已写到第 ${chapters} 章 · 第 ${n} 批`, n, chapters });
      onLog({ level: 'act', source: 'autopilot', kind: 'pending-batch', n, chapters,
        msg: `⏸ 本批已写完（已到第 ${chapters} 章），待你审核：批准继续 / 按要求继续 / 停止` });
      return '本批已写完。请【暂停】：先不要写下一批，也不要改大纲，等用户审核当前内容并下达下一步要求后再继续。';
    };
    autopilot = new Autopilot(mcp, paneId, {
      ...cfg.autopilot,
      onLog: (e) => onLog({ ...e, source: 'autopilot' }),
      onTokens: (n) => recordUsage(book.slug, tokenKey, n),
      onOutlineReady,
      onRevisionDone,
      finaleCheck,
      onFinaleReady,
      reviewEvery: () => getReviewEvery(slug),   // 0=全自动；N=每 N 批审核（实时热切换）
      onBatchReview,
      // 写完一批后：给"写够章却没卷名"的卷自动起名写回 bible（后台、best-effort，不阻塞）
      onBatchDone: async () => { try { const { ensureVolumeNames } = await import('./volname.mjs'); await ensureVolumeNames(getBook(slug) || book, { cfg, onLog: (e) => onLog({ ...e, source: 'volname' }) }); } catch {} },
      takeReviewResume: () => takeResume(slug),
      // 省 token：上下文快满就重开新会话（靠 continuity_ledger 重建）
      contextSize: () => currentContextSize((getBook(slug) || book).dir, model),
      freshContextLimit: cfg.autopilot?.freshContextLimit || 0,
      freshFallbackBatches: cfg.autopilot?.freshFallbackBatches || 0,
      onFreshRestart: typeof onFreshRestart === 'function' ? onFreshRestart : undefined,
      isPending: () => hasPending(slug),   // 全局确认门：有待确认审稿/审核时 autopilot 挂起
      // 启用完本：不靠章数硬停，交给收尾流程收束；已完本则停。未启用完本时沿用旧的"到目标章数即停"。
      shouldStopContinue: () => {
        const b = getBook(slug) || book;
        if (b.status === '已完本') return true;
        if (finaleOn) return false;
        const t = b.targetChapters || 0; return t > 0 && bookStats(b).chapters >= t;
      },
      onReachedTarget: () => { try { maybeAutoPublish(getBook(slug) || book, { cfg, onLog: (e) => onLog({ ...e }) }); } catch {} },
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
