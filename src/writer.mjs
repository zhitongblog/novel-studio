// 写作编排：为一本书 spawn 绑定 profile 的新 Unterm 实例 → 开代理 → 启动选定 agent（带初始指令）
// → 连上该实例 MCP → 启动 autopilot 监控应答。
import fs from 'node:fs';
import path from 'node:path';
import { getModel, detectModel, resolveBin, trustAgyWorkspace } from './models.mjs';
import {
  ensureProfile, spawnInstance, instancePids, waitForNewInstance, resolveSpawnedInstance,
  resolveProxyNode, proxyUrl, findUntermCli, listInstances, killProcess, closeWindow, killBookAgents, processAlive, winShell, destroyPaneViaCli,
} from './unterm.mjs';
import { connectInstance } from './mcpclient.mjs';
import { Autopilot } from './autopilot.mjs';
import { refreshContext } from './scaffold.mjs';
import { reviewOutline, buildReviseInstruction, buildProceedInstruction, buildRenudgeInstruction, buildRecheckRenudgeInstruction, recheckRevision, snapshotOutline, verifyRevision, reviewEnding, buildEndingRenudgeInstruction } from './editor.mjs';
import { buildFinaleInstruction, buildAfterwordInstruction } from './planner.mjs';
import { setPending, hasPending, getReviewEvery, setReviewEvery, setReviewDefault, takeResume } from './pending.mjs';
import { saveSession, removeSession, listSessions } from './sessions.mjs';
import { recordUsage, currentContextSize } from './usage.mjs';
import { bookStats, getBook, setBookStatus, archiveFlatChapters, archiveVolumeFolders, clearFlatImport, plannedVolumes, currentVolume, plannedTotalChapters, chaptersPerVol } from './books.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { runFinaleClosure } from './finale.mjs';
import { finaleArtifacts, buildFinaleFixInstruction, finaleSummary } from './finaledone.mjs';
import { continueWithVoice } from './voiceprint.mjs';

const IS_WIN = process.platform === 'win32';

const normDir = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

// 清掉【属于某本书目录】的残留窗口/pane（开写前的去重保护）。
// ⚠️ 两代破坏性变更叠加，老写法已经彻底不成立：
//   0.61：instances/*.json 的 cwd/profile 恒为 null → "按 json 的 cwd 找窗口"永远匹配不到；
//   0.65：所有窗口【共用一个 MCP 端口】，session.list 返回【全机器】的 pane，且没有 pane→窗口的映射
//        （meta.surface 自陈 "pane location metadata is synthetic"）。于是"连上每个实例、看有没有 pane
//        的 cwd 等于本书目录"会把【每一个】窗口都判成本书的孤儿 → 反手去杀别的书的窗口。
// 新做法：归属只认 pane 自己的 shell.cwd，并且【按 pane 关】(session.destroy)，不再对窗口进程动手
//（0.65 下杀窗口进程还有连坐 unterm-core 的风险，见 unterm.mjs 的 killProcess）。
// 别的书正在驱动的 pane 一律跳过（那是活窗口，不是孤儿）。
export async function closeBookOrphans(dir, selfSlug, onLog = () => {}) {
  const want = normDir(dir);
  const others = listSessions().filter(s => s.slug !== selfSlug);
  const busyInstances = new Set(others.map(s => s.instanceId));
  const busyPanes = new Set(others.filter(s => s.pane != null).map(s => String(s.pane)));
  let panes = 0, windows = 0;

  // ① 老版本（instances json 里真的带 cwd）：还能按窗口归属判 → 直接关窗口
  for (const inst of listInstances()) {
    if (busyInstances.has(inst.id)) continue;
    if (inst.cwd && normDir(inst.cwd) === want) {
      onLog({ level: 'warn', msg: `发现残留窗口 ${inst.id}(pid ${inst.pid})，引擎未在驱动 → 关闭` });
      try { killProcess(inst.pid); windows++; } catch {}
    }
  }

  // ② 0.61+：按 pane 的 shell.cwd 认归属。pane 列表是全局的，连上任意一个实例即可枚举全部。
  for (const inst of listInstances()) {
    let mcp = null;
    try {
      mcp = await connectInstance(inst, {});
      const list = await mcp.sessionList();
      for (const p of list) {
        if (busyPanes.has(String(p.id))) continue;
        if (normDir(p?.shell?.cwd) !== want) continue;
        // 死 pane 也要清：0.71 上关不掉的 pane 会以"死 tab"留在窗口里，一本书堆一个，作者看着全是空 tab
        if (p.is_dead) { if (destroyPaneViaCli(p.id, inst.id)) panes++; continue; }
        onLog({ level: 'warn', msg: `发现残留 pane ${p.id}（cwd 指向本书目录、引擎未在驱动）→ 关闭，避免两个窗口抢写同一章` });
        try {
          if (!destroyPaneViaCli(p.id, inst.id)) await mcp.destroyPane(p.id);
          panes++;
        } catch (e) { onLog({ level: 'warn', msg: `关闭 pane ${p.id} 失败：${e.message}` }); }
      }
      break;   // 端口/pane 命名空间是全局的，成功枚举过一次就够了
    } catch {}
    finally { try { mcp?.close?.(); } catch {} }
  }
  return { panes, windows };
}

// 在【已经开着的】Unterm 里给这本书开一个 tab 跑 launch 脚本（session.create，0.71.8 实测回 { id }）。
// 没有开着的 Unterm / 连不上 / create 失败 → 返回 null，由调用方起第一个窗口。
export async function openBookTab({ cwd, launchScript, profile, identifyAs }) {
  const shellArgv = IS_WIN
    ? [winShell(), '-NoLogo', '-NoExit', '-File', launchScript]
    : [process.env.SHELL || '/bin/zsh', '-l', '-c', `source '${String(launchScript).replace(/'/g, "'\\''")}'; exec "$SHELL" -i`];
  const alive = listInstances().filter(i => i.mcp_port && (i.pid == null || processAlive(i.pid)));
  for (const inst of alive) {
    let mcp = null;
    try {
      mcp = await connectInstance(inst, { identifyAs });
      const before = new Set((await mcp.sessionList()).map(p => String(p.id)));
      // ⚠️【超时 ≠ 没开出来】2026-09-19 实测：引擎事件循环被别的同步活堵住时，create 的回包
      // 排在队里超时了，tab 其实已经开好；当时"失败就再开一次"的写法于是开出两个 tab、
      // 同一本书两个 agy 抢着改，autopilot 还往其中一个里灌了一串 y。
      // 所以：超时给足；报错后先去 pane 列表里找本书目录的新 pane，确实没有才换参数再开。
      const attempt = async (params) => {
        try {
          const r = await mcp.call('session.create', params, 60000);
          const id = r?.id ?? r?.pane_id ?? r?.session_id;
          if (id != null) return id;
        } catch {}
        await sleep(1500);
        const want = normDir(cwd);
        const fresh = (await mcp.sessionList()).filter(p => !before.has(String(p.id)) && !p.is_dead && normDir(p?.shell?.cwd) === want);
        return fresh.length ? fresh[fresh.length - 1].id : null;
      };
      // profile 是 Unterm 的身份 profile；不认识就退回不带 profile 再开一次，别因为它开不了 tab
      let paneId = await attempt({ cwd, argv: shellArgv, ...(profile ? { profile } : {}) });
      if (paneId == null && profile) paneId = await attempt({ cwd, argv: shellArgv });
      if (paneId != null) return { instance: inst, mcp, paneId };
    } catch {}
    try { mcp?.close?.(); } catch {}
  }
  return null;
}

// spawn 之前把当前【全局】pane id 拍个快照，用于之后认出"新出现的那个 pane"。
// 拿不到（一个实例都没有/连不上）就返回空集合——那种情况下所有 pane 都算新的，同样能认。
export async function snapshotPaneIds() {
  for (const inst of listInstances()) {
    let mcp = null;
    try {
      mcp = await connectInstance(inst, {});
      const list = await mcp.sessionList();
      return new Set(list.map(p => String(p.id)));
    } catch {}
    finally { try { mcp?.close?.(); } catch {} }
  }
  return new Set();
}

// 这条路径【只能跑 CLI 模型】：它要开一个 Unterm 窗口、把 agent 拉起来、往里注入指令。
// api 类（直连接口）和 web 类（驱动网页聊天框）都没有可执行文件、也没有 seedArgs，
// 走到这里只会崩在 `m.seedArgs is not a function` —— 一句纯技术报错，用户完全看不懂。
//
// ⚠️ 这个口子很宽：server.mjs 里有十几处「重写/续写/收尾/重建大纲」都直接传 book.model 调 startWriting，
// 没有一处校验类型。只要书的默认模型是 api-*/web-*，这些功能全会崩。与其在十几处各加一遍，
// 不如在入口拦一次，并且把话说清楚：这个功能要什么、你现在是什么、该怎么办。
function assertCliModel(m, id) {
  if (typeof m.seedArgs === 'function') return;
  const kindName = m.kind === 'api' ? '直连接口的 API 模型' : m.kind === 'web' ? '驱动网页版的模型' : '该模型';
  throw new Error(
    `「${m.name}」是${kindName}，这个功能用不了它。`
    + `\n它需要能在终端窗口里跑起来的 CLI 模型（codex / claude / gemini / qwen / trae）——`
    + `本功能靠开窗口、启动 agent、注入指令来工作，而 ${m.name} 没有可执行文件。`
    + `\n\n怎么办：`
    + `\n· 想用${kindName}写正文：回写作台选它，点「开始写作」走的是对的那条路（直接调接口、引擎自己落盘）。`
    + `\n· 想用这个功能：把书的模型换成一个 CLI 模型，或在装了 codex/claude 后重试。`);
}

// 生成启动脚本：设代理环境、cd 到书目录、启动 agent 带初始指令。
// Windows → launch.ps1（pwsh）；macOS/Linux → launch.sh（POSIX sh）。
export function writeLaunchScript(book, model, instruction, cfg) {
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  assertCliModel(m, model);
  // 安全网：把任何换行折叠成空格 —— 多行 prompt 会被 agent 当多行草稿、等人工回车，无法自动开跑。
  // 【英文双引号在 Windows 上会把一句话切成好几个参数】
  // 2026-09-19 实证：按签约诊断给王莽改稿，指令里写了 签约诊断里"1–3 章合成 2 章"……
  // agy 一启动就报 Error: unexpected argument "章合成"——根本没跑起来。
  // 原因：窗口里是 Windows PowerShell 5.1，`& agy @seed` 把参数传给外部程序时
  // 不转义内嵌的双引号，Windows 的命令行解析再按引号重新切分，一整句 prompt 被切碎。
  // 同类病 8022ee4e 修过一次（起书名"参数被 shell 拼碎"），那次修的是拼接方式，
  // 这次是内容里的引号——作者在界面上随手打个 "…" 就会中招。
  // 换成中文引号：模型读起来一样，命令行不会再拿它当分隔符。
  const safeArg = (a) => {
    let s = String(a).replace(/[\r\n]+/g, ' ');
    if (IS_WIN) s = s.replace(/"([^"]*)"/g, '“$1”').replace(/"/g, '”');
    return s;
  };
  const seed = m.seedArgs(instruction, cfg).map(safeArg);
  // ⚠️【别再给 agy 写死"走直连"】两天里同一台机器上翻了个个儿：
  //   09-13：直连能回答；挂代理 → FAILED_PRECONDITION: User location is not supported
  //   09-15：直连 → Eligibility check failed: Get ".../oauth2/v2/userinfo": EOF（连不上）；挂代理 → 正常
  // 原因是代理是【节点轮换】的（proxyNode: 'auto'）：换到不支持的地区就被 Google 按 IP 拒，
  // 换回来又好了。所以"agy 永远不要代理"这条是对着某一刻的网络状态过拟合，
  // 我 09-13 写死它，结果 09-15 这本书的窗口每一轮都失败、白跑了几个小时。
  // 现在跟其它模型一样【听 cfg.enableProxy 的】；地区被拒那种失败由 CLI_FAIL_PATTERNS 认出来报给作者。
  const proxy = cfg.enableProxy ? proxyUrl() : '';
  // 顺手把本书目录写进 agy 的 trustedWorkspaces：这样窗口起来就不会弹"是否信任此项目"，
  // 少一个要 autopilot 去认的弹窗（认弹窗是这套编排里最脆的一环，能绕开就绕开）。
  if (m.id === 'agy') { try { trustAgyWorkspace(book.dir); } catch {} }
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
    // 用 resolveBin 而不是 m.bin：agy 这类"装了但不在 PATH"的 CLI，直接写命令名开出来的窗口
    // 只会打印 "'agy' 不是内部或外部命令" 然后停在 shell 提示符——窗口是开了，agent 从没起来。
    // 路径可能带空格，单引号包起来（PowerShell 里 '' 转义单引号）。
    const exe = resolveBin(model);
    const isPath = exe.indexOf(' ') >= 0 || exe.indexOf('/') >= 0 || exe.indexOf(String.fromCharCode(92)) >= 0;
    const exeQ = isPath ? `& '${exe.replace(/'/g, "''")}'` : `& ${exe}`;
    lines.push(
      `Write-Host "[agent] 启动 ${m.bin} ，初始指令已注入…" -ForegroundColor DarkGray`,
      `$seed = ${psArr}`,
      `${exeQ} @seed`,
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
    `${q(resolveBin(model))} ${seed.map(q).join(' ')}`);
  const p = path.join(dir, 'launch.sh');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  try { fs.chmodSync(p, 0o755); } catch {}
  return p;
}

// 主流程。返回 { instance, mcp, autopilot, paneId }。
// autopilotConfirmOnly：只挂"自动确认提问"的极简 autopilot，绝不自动续写（共创窗口模式用）。
export async function startWriting({ book, model, instruction, cfg, onLog = () => {}, attachAutopilot = true, autopilotConfirmOnly = false, onFreshRestart = null, onTerminalStop = null, untilChapter = 0 }) {
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  assertCliModel(m, model);
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
    const r = await closeBookOrphans(book.dir, book.slug,
      (e) => onLog({ ...e, msg: `《${book.title}》${e.msg}` }));
    if (r.panes + r.windows > 0) await new Promise(r2 => setTimeout(r2, 1500));
  } catch {}

  // 【只开 tab，不开新窗口】作者要求（2026-09-19）：每本书在【已经开着的 Unterm】里开一个 tab，
  // 而不是每次 `unterm-cli start` 甩出一个新窗口——书一多桌面上全是窗口。
  // session.create 在现有窗口里开 tab、直接回 pane id（实测 0.71.8），连"认新 pane"都省了。
  // 只有机器上一个 Unterm 都没开着时，才起第一个窗口（那时没有窗口可挂 tab）。
  let instance = null, mcp = null, paneId = null;
  const opened = await openBookTab({ cwd: book.dir, launchScript: launch, profile: profileName, identifyAs: cfg.untermAgentName });
  if (opened) {
    ({ instance, mcp, paneId } = opened);
    onLog({ msg: `已在现有 Unterm（${instance.id}，v${instance.version}）里开 tab：pane ${paneId}` });
  } else {
    const beforePids = instancePids();
    // 认 pane 的第一判据：spawn 之后【新出现】的那个 pane（0.65 起 pane 编号是全机器共用的）
    const beforePaneIds = await snapshotPaneIds();
    onLog({ msg: `没有开着的 Unterm → 启动第一个窗口（profile ${profileName}，cwd ${book.dir}）…` });
    const pid = spawnInstance({ profile: profileName, cwd: book.dir, launchScript: launch });
    onLog({ msg: `已启动 unterm 进程 pid=${pid}，等待实例注册…` });

    const r = await resolveSpawnedInstance({ beforePids, pid, cwd: book.dir, timeoutMs: 30000 });
    instance = r.instance;
    if (!instance) throw new Error('未能定位到 Unterm 实例（30s 超时）。请确认 Unterm 正常启动。');
    onLog({ msg: `实例：${instance.id}  mcp_port=${instance.mcp_port}  v${instance.version}` });

    // 连 MCP（实例刚起，端口可能稍迟，做几次重试）
    for (let i = 0; i < 12; i++) {
      try { mcp = await connectInstance(instance, { identifyAs: cfg.untermAgentName }); break; }
      catch { await sleep(800); }
    }
    if (!mcp) throw new Error('连接实例 MCP 失败');
    onLog({ msg: `已连接实例 MCP（auth ok）` });

    paneId = await waitForPane(mcp, 20000, { beforePaneIds, cwd: book.dir });
    if (paneId == null) throw new Error('未找到 agent pane');
  }

  // 代理：仅靠 launch.ps1 注入的会话级环境变量，不改 unterm 全局配置
  if (cfg.enableProxy) onLog({ msg: `代理已为会话注入环境变量：${proxyUrl() || '(未配置)'}` });
  onLog({ msg: `agent pane id=${paneId}` });

  // 登记为运行中会话，供 send / watch / stop（任意进程）连接
  saveSession({
    slug: book.slug, title: book.title, model,
    instanceId: instance.id, mcp_port: instance.mcp_port, auth_token: instance.auth_token,
    pane: paneId, pid: instance.pid, tab: !!opened, startedAt: new Date().toISOString(),
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
      // 终止性停止(撞用量上限/agent 已退出/已完本…)→ 让上层清掉会话记录，别让书永远挂在"写作中"
      onTerminalStop: (r) => { try { onTerminalStop && onTerminalStop(r); } catch {} },
      // 任务干完 → 自动收窗 + 从会话表移除(状态转"写作完成")。续写与否由作者决定。
      onDone: () => {
        try { onLog({ level: 'act', source: 'autopilot', msg: '✅ 本次任务完成，已收起窗口（要不要继续由你定）' }); } catch {}
        try { removeSession(book.slug); } catch {}
        // 先关 pane 再关窗口（0.65 下只杀窗口 pid 会留下还在跑的 agent），关完再断自己的连接
        closeWindow({ id: instance.id, mcp_port: instance.mcp_port, auth_token: instance.auth_token, pid: instance.pid, pane: paneId, tab: !!opened })
          .catch(() => {})
          // 再按书目录兜底杀 agent 外壳：pane 没关成时 agent 会接着往后写新章（见 killBookAgents）
          .finally(() => { try { mcp.close(); } catch {} try { killBookAgents(book.dir); } catch {} });
      },
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
    //
    // 【"已完本"必须由落盘产物说了算，不能由模型说了算】
    // 原来 done() 是先 setBookStatus('已完本')，再把收尾指令扔出去并 stop:true——
    // 指令写没写、写成什么样，无人检查；而那条指令自己还写着"①可选写一章完本感言…"。
    // 加上三条"放行"路（审稿关了 / 审稿抛异常 / 退回 2 次仍不过），标完本的门槛
    // 实际上比写完低得多。《大乾女帝贴身神探》就这么挂着完本的牌子在往下铺新坑：
    // 9/4 标完本（480 章），之后又写了 45 章到 525，没有尾声、结尾是纯悬念。
    //
    // 现在：审稿只决定【要不要继续补正文】，标不标完本另看一份【落盘可查的产物清单】
    // （尾声/完本感言、chapter_index 的"全书完"、bible 的【已完结】）。
    // 产物没齐 → 发"补齐"指令、stop:false，让它把活干完再回来；补不出来 → 停在「收尾中」，
    // 把缺什么说清楚，【绝不标完本】。宁可让书停在收尾中，也不给没写完的书盖完本的章。
    let finaleFixRounds = 0;
    const onFinaleReady = !finaleOn ? undefined : async () => {
      const b = getBook(slug) || book;
      // 真正落地的"完本"：产物齐了才标，齐不了就别标
      const done = (text) => {
        const art = finaleArtifacts(getBook(slug) || b);
        if (!art.ok) {
          finaleFixRounds++;
          const cap = cfg.finale?.maxFinaleFixRounds ?? 3;
          if (finaleFixRounds > cap) {
            try { setBookStatus(slug, '收尾中'); } catch {}
            onLog({ level: 'warn', source: 'finale',
              msg: `⚠️ 催了 ${cap} 轮仍缺完本产物（${art.missing.join('、')}）→ 【不标完本】，书停在「收尾中」等你处理。错标成完本比没标严重得多：番茄那边会按完本走签约/推荐流程。` });
            return { text: buildFinaleFixInstruction(b, art.missing), stop: true };
          }
          onLog({ level: 'warn', source: 'finale',
            msg: `完本产物还差：${art.missing.join('、')} → 先补齐再标完本（第 ${finaleFixRounds}/${cap} 轮）` });
          return { text: buildFinaleFixInstruction(b, art.missing), stop: false };
        }
        onLog({ level: 'act', source: 'finale', msg: `✅ 完本产物已齐（${art.items.map(i => i.label).join('、')}）→ 标记【已完本】` });
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
      if (cfg.finale?.reviewEnding === false) { onLog({ level: 'act', msg: '未开完本审稿 → 直接进完本产物核对', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      let rc;
      try { rc = await reviewEnding({ book: b, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'finale' }) }); }
      catch (e) { onLog({ level: 'warn', msg: '完本审稿跑不起来（' + e.message + '）→ 跳过审稿，但完本产物照查不误', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      if (rc.pass) { onLog({ level: 'act', msg: '完本审稿通过 → 核对完本产物', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
      const n = (renudgeF.get('完本') || 0) + 1; renudgeF.set('完本', n);
      if (n > (cfg.finale?.maxRenudge ?? 2)) { onLog({ level: 'warn', msg: '完本审稿仍未过、已达上限 → 不再纠结正文，转去核对完本产物（结局质量请你人工把关）', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
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
    // 上一批结束时的最高章号——用来算"这一批新写了哪几章"，交给排版矫正闸。
    // 初值取当前值：重挂/刚开窗时先记下水位，第一批写完才有区间可矫正。
    let batchLowWater = bookStats(getBook(slug) || book)?.maxChapter || 0;
    autopilot = new Autopilot(mcp, paneId, {
      ...cfg.autopilot,
      // 每批的续写指令后面接上本书范本原文（见 continueWithVoice 的说明）
      continueText: continueWithVoice(getBook(slug) || book, cfg.autopilot?.continueText),
      onLog: (e) => onLog({ ...e, source: 'autopilot' }),
      onTokens: (n) => recordUsage(book.slug, tokenKey, n),
      // 终止性停止(撞用量上限/agent 已退出/已完本…)→ 让上层清掉会话记录，别让书永远挂在"写作中"
      onTerminalStop: (r) => { try { onTerminalStop && onTerminalStop(r); } catch {} },
      onOutlineReady,
      onRevisionDone,
      finaleCheck,
      onFinaleReady,
      reviewEvery: () => getReviewEvery(slug),   // 0=全自动；N=每 N 批审核（实时热切换）
      onBatchReview,
      // 写完一批后：给"写够章却没卷名"的卷自动起名写回 bible（后台、best-effort，不阻塞）
      onBatchDone: async () => {
        const b = getBook(slug) || book;
        // 排版矫正/查重/节奏/快照都已搬到 onBeforeContinue（那才是"下一批开写前"的时机）。
        // 这里只剩卷名：后台、best-effort、不阻塞写作循环。
        try { const { ensureVolumeNames } = await import('./volname.mjs'); await ensureVolumeNames(b, { cfg, onLog: (e) => onLog({ ...e, source: 'volname' }) }); } catch {}
      },
      // —— 写后闸：排版矫正(deslop) + 章号查重 + 节奏闸 + 台账快照闸 ——
      // 【为什么落在"发继续之前"而不是 onBatchDone】onBatchDone 是在 autopilot 发完"继续"
      // 之后才触发的、返回值还被丢弃——等于"下一批已经开写了才想起来体检"。
      // 而这几道闸的全部意义就是【趁这一批还没变成下一批的上下文，先把病章改干净】。
      // 节奏闸与快照闸原来只挂在 statelessWriter / cowrite 上，窗口这条主路径一次都没跑过：
      // 《重生三国》151 章全是窗口模式写的，攒出 36 章数目堆砌（最密每 51 字一个数）、
      // 13 章字数不足 3000、4 章预告腔假钩子、台账快照落后 2 章——全是这两道闸会拦下的。
      onBeforeContinue: async () => {
        const b = getBook(slug) || book;
        try {
          const { afterBatch, batchGateInstruction } = await import('./afterbatch.mjs');
          const now = bookStats(b)?.maxChapter || 0;
          const prev = batchLowWater;
          const from = prev > 0 ? prev + 1 : 0;
          if (!(now > 0) || now <= prev) return null;         // 这一拍没写出新章 → 放行
          afterBatch(b, { from, to: now, onLog });             // 排版矫正是纯代码，先做掉
          const instr = batchGateInstruction(b, { slug, from, to: now, cfg, onLog });
          if (instr) return instr;                             // 不过 → 顶替"继续"，退回自纠
          batchLowWater = now;                                 // 过了才推进水位
          // 全文逻辑自检：原判据是 autopilot 的 continueCount % N，而那个计数
          // 【每次会话重开就归零】。152 章的《重生三国》只跑过 1 次，攒出 264 条逻辑问题。
          // 改成按书算：距上一份 reviews/全文逻辑自检-至NNN.md 又写了 N 章就插一次。
          const { fullCheckDue } = await import('./logicgate.mjs');
          const due = fullCheckDue(b.dir, now, { everyChapters: cfg.autopilot?.fullCheckEveryChapters || 15 });
          if (due.due && cfg.autopilot?.fullCheckText) {
            onLog({ level: 'act', source: 'logicgate',
              msg: `🧭 距上次全文逻辑自检已写 ${due.since} 章（上次至第 ${due.last} 章）→ 插入一次自检` });
            return cfg.autopilot.fullCheckText;
          }
          return null;
        } catch (e) { onLog({ level: 'warn', msg: '写后闸异常（不阻断）：' + (e.message || e) }); return null; }
      },
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
        // 【本轮停止点】untilChapter：只写到第 N 章就收手，不动书的持久设置。
        // 由来（2026-09-23）：任务里写「只写第 009 章一章，写完就停」，agy 照样写到了 013。
        // 因为那句话只是【给模型的初始 prompt】，而 autopilot 是另一套逻辑——模型一空闲就发「继续」，
        // 它只看 maxAutoContinue(默认40) 和书级 targetChapters。这本书 targetChapters 没设，
        // 于是一路续到第 40 次上限才会停。想只写一章，光在 prompt 里说没用，得有这道闸。
        if (untilChapter > 0 && bookStats(b).maxChapter >= untilChapter) return true;
        if (b.status === '已完本') return true;
        if (finaleOn) return false;
        const t = b.targetChapters || 0; return t > 0 && bookStats(b).chapters >= t;
      },
      onReachedTarget: () => { try { maybeAutoPublish(getBook(slug) || book, { cfg, onLog: (e) => onLog({ ...e }) }); } catch {} },
    });
    autopilot.start();   // 不 await，后台跑
  }

  return { instance, mcp, autopilot, paneId, pid: instance.pid };
}

// 认出刚开的窗口里那个 pane。
// ⚠️【绝不能再取"第一个活 pane"】—— Unterm ≥0.65 的 session.list 是【全机器】的 pane 列表，
// 第一个 pane 往往是【另一本书】的窗口：挂上去等于两个 autopilot 抢同一个窗口打字、新窗口没人驱动
//（多本书并行写作直接串窗）。
// 判据按可靠性排：① spawn 后新出现的 pane 且 shell.cwd == 本书目录（最强，两条独立证据）→
// ② 新出现且全场只有它一个新 pane → ③ 只有它一个 pane 的 cwd 指向本书目录。都没有就返回 null，
// 宁可报"未找到 agent pane"让上层重试，也不要挂错窗口。
export async function waitForPane(mcp, timeoutMs, { beforePaneIds = new Set(), cwd = '' } = {}) {
  const want = normDir(cwd);
  const deadline = performance.now() + timeoutMs;
  let fallback = null;
  while (performance.now() < deadline) {
    const alive = (await mcp.sessionList().catch(() => [])).filter(s => !s.is_dead);
    const fresh = alive.filter(s => !beforePaneIds.has(String(s.id)));
    const matchCwd = (arr) => want ? arr.filter(s => normDir(s?.shell?.cwd) === want) : [];
    const freshCwd = matchCwd(fresh);
    if (freshCwd.length) return freshCwd[freshCwd.length - 1].id;                  // ①
    if (fresh.length === 1 && !want) return fresh[0].id;                            // ② 没有目录可比时
    if (fresh.length === 1) fallback = fallback ?? fresh[0].id;                     // ② 暂存，继续等 ①
    const anyCwd = matchCwd(alive);
    if (anyCwd.length === 1) fallback = fallback ?? anyCwd[0].id;                   // ③
    await sleep(500);
  }
  return fallback;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
