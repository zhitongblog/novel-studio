// 引擎服务层：HTTP REST + SSE。作为长驻进程托管所有写作会话与 autopilot，
// 给 Tauri/网页前端提供接口。复用全部既有模块，不重写编排逻辑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROMANCE_LEVELS } from './romance.mjs';
const NL = String.fromCharCode(10);
const NL2 = NL + NL;
import { listRefs, addRef, removeRef, readCard, saveCard, CARD_PROMPT, readRefs, hasVoicePrint } from './voiceprint.mjs';
import { draftCandidates, adoptCandidate, deriveCard, TONES } from './voiceboot.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, updateConfig } from './config.mjs';
import { CONFIG_DIR } from './paths.mjs';
import { listBooksWithStats, createBook, getBook, importBook, setBookStyle, deleteBook, detectTitleFromDir, setBookTarget, setBookModel, setBookSynopsis, setBookStatus, renameBook, renameEntity, suggestRenamePairs, applyRenamePairs, setBookPublish, setBookFanqieStatus, setBookWriteMode, setParticipation, participationOf, setBookPlanMode, bookStats, plannedTotalChapters, plannedVolumes, currentVolume, chaptersPerVol, setBookRomance, setBookCategory, setBookTags} from './books.mjs';
import { STYLES } from './styles.mjs';
import { recommendStyle, recommendCategory, recommendFanqieTags } from './planner.mjs';
import { detectAll, getModel, canRunHeadless } from './models.mjs';
import { listInstances, instanceIds, findUntermExe, findUntermCli, untermVersion, readProxyConfig, killBookAgents } from './unterm.mjs';
import { getSession, removeSession, pruneSessionsByPanes } from './sessions.mjs';
import { connectInstance } from './mcpclient.mjs';
import { startWriting, snapshotPaneIds } from './writer.mjs';
import { runStateless } from './statelessWriter.mjs';
import { runWebWrite, getAdapter } from './webwriter.mjs';
import { runApiWrite, isApiProvider } from './apiwriter.mjs';
import { API_PROVIDERS, providerConfigured, isKeylessProvider, chatComplete } from './apichat.mjs';
import { localHealth, probeText, probeImage } from './localai.mjs';
import { brainstorm, writeChapterInWindow, writeChapterFromIntent, writeChaptersFromPlot, rewriteChapter, reflowChapter, isCowriteModel, isCowriteWindowModel, COWRITE_MODELS, STYLE_SLANTS } from './cowrite.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { listSessions, sendToBook, stopBook, streamBook, attachAutopilot, sessionAgentAlive } from './attach.mjs';
import { chapterProgressLine, isFirstSight } from './progress.mjs';
import { FANQIE_CATEGORIES, isValidCategory } from './categories.mjs';
import { finaleArtifacts, finaleSummary } from './finaledone.mjs';
import { checkupBook } from './checkup.mjs';
import { buildAllDigests, rebuildVolumeOutlines } from './outlinerun.mjs';
import { digestProgress } from './outlinerebuild.mjs';
import { diagnoseSigning } from './signrun.mjs';
import { loadBooks } from './store.mjs';
import { loadUsage, bookUsage, codexTokensForDir, claudeTokensForDir } from './usage.mjs';
import { proposeTitles, buildKickoffInstruction, buildCompassKickoffInstruction, buildFreehandKickoffInstruction, buildVolumePlanPrompt, buildResumeInstruction, buildReviewInstruction, generateSynopsis, buildFinaleInstruction, buildRewriteInstruction, buildReprojectInstruction, buildAfterwordInstruction, buildRebuildOutlineInstruction, buildReviseSettingInstruction, buildRenameInstruction, resolveGenModel, runModelOnce, analyzeStyleSample } from './planner.mjs';
import { styleFromFanqieUrl } from './refstyle.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { reviewOutline, snapshotOutline, reviewEnding, buildReviseInstruction, buildReviseFromItems, buildEndingRenudgeInstruction, parseReviewItems, critiqueOf } from './editor.mjs';
import { getPending, setPending, clearPending, setReviewEvery, getReviewEvery, getReviewDefault, setResume } from './pending.mjs';
import { listBookFiles, readBookFile, saveBookFile, renumberGlobalChapters, deleteChapters, deleteReviews, listReviews } from './files.mjs';
import { previewPublish, publishToFanqie, republishRange, loadPublishChapters, loadPublishedHashes } from './publish.mjs';
import { diagnoseBook } from './diagnose.mjs';
import { runOverhaul, runReadFix, parseReadReportFile, getState as getOverhaulState } from './overhaul.mjs';
import { readReview, writeReadReport } from './readreview.mjs';
import { generateVolumeName, existingVolName } from './volname.mjs';
import { listProfiles as listUnzooProfiles, getFanqieBooks, getFanqieVolumes, renameFanqieVolume, stopPublish, changeFanqieCover, createFanqieBook, pushNameExperiment, updateFanqieBookInfo } from './fanqie.mjs';
import { getCompletionReport, runFinaleClosure, locateCompletion, buildCompletionNote } from './finale.mjs';
import { previewFanqieImport, importFromFanqie } from './import_fanqie.mjs';
import { generateCoverBg, buildArtPromptAuto } from './imagegen.mjs';
import { generateNameExperiment, readNameExperiment } from './nameexp.mjs';
import { generateCoverViaChatGPT, grabCoverFromChatGPT, buildChatGptCoverPrompt } from './covergen_web.mjs';
import { generateCoverViaGemini, grabCoverFromGemini } from './covergen_gemini.mjs';

const UI_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'ui');

// ChatGPT 网页版生成封面是慢活（2~4 分钟）→ 后台跑，前端轮询状态。slug -> {status,url,error,msg}
const coverJobs = new Map();
// 单章重写的后台任务表。为什么必须后台跑：一次重写要 1–8 分钟，
// 若把生成压在 HTTP 请求里，中间任何一环断掉（webview 超时 / 用户关弹窗 / 应用重启）
// 整个活就白干且不留痕迹——实测就是这么丢的。改成"起任务→立刻返回→前端轮询"，
// 关掉弹窗、切去别的页面都不影响它写完。
const rewriteJobs = new Map();
// 推送封面到番茄（换封面）后台任务。slug -> {status,submitted,error,msg}
const fanqieCoverJobs = new Map();
// 改造流水线的在跑任务（slug → {status, stop}）。停止=置 stop 标志，流水线在批间自己收。
const overhaulJobs = new Map();

// 哪些章【真的改过】：本地指纹 ≠ 上次发布时记下的指纹。没有基线的不算（宁可漏发，不能误覆盖线上）。
function changedChapters(book, { from = 1, to = 0 } = {}) {
  const hashes = loadPublishedHashes(book);
  return loadPublishChapters(book)
    .filter(c => c.num >= from && (!to || c.num <= to))
    .filter(c => hashes[String(c.num)] && hashes[String(c.num)] !== c.hash)
    .map(c => c.num);
}
const fanqieCreateJobs = new Map();
const nameExpJobs = new Map();
const nameExpPushJobs = new Map();   // 书名实验「推到番茄」job

// 每本书的运行时状态（仅在 serve 进程内）
const rt = new Map(); // slug -> { logs:[], clients:Set<res>, streamer, session }
function rtOf(slug) {
  if (!rt.has(slug)) rt.set(slug, { logs: [], clients: new Set(), streamer: null, session: null });
  return rt.get(slug);
}
function pushLog(slug, e) {
  const r = rtOf(slug);
  const entry = { t: Date.now(), ...e };
  r.logs.push(entry); if (r.logs.length > 300) r.logs.shift();
  broadcast(slug, 'log', entry);
}
function broadcast(slug, event, data) {
  const r = rt.get(slug); if (!r) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of r.clients) { try { res.write(payload); } catch {} }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// —— 无状态写作的【断电续跑】持久化 ——
// 无状态模式没有 Unterm 窗口，引擎一旦重启/崩溃，内存里的 runStateless 循环随之消失，
// 长驻模式能被 reattachLiveSessions/看门狗接回、无状态却会【静默停掉】（用户 22:05 崩溃丢了两本）。
// 既然无状态已是默认写作方式，就把"正在跑哪些书"落盘，引擎启动时自动接着跑。
const STATELESS_ACTIVE_FILE = path.join(CONFIG_DIR, 'stateless-active.json');
function readStatelessActive() {
  try { return JSON.parse(fs.readFileSync(STATELESS_ACTIVE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeStatelessActive(map) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(STATELESS_ACTIVE_FILE, JSON.stringify(map, null, 2)); } catch {}
}
function markStatelessActive(slug, info) {
  const map = readStatelessActive(); map[slug] = { ...info, t: Date.now() }; writeStatelessActive(map);
}
function clearStatelessActive(slug) {
  const map = readStatelessActive(); if (slug in map) { delete map[slug]; writeStatelessActive(map); }
}

export function runServer(port = 8787) {
  // 引擎是长驻进程，托管所有写作会话/autopilot——绝不能被一条野生 socket error（写到已关的 pane / 断开的 SSE 客户端）
  // 或未捕获 promise 拒绝整个拖崩（一崩全崩：图书预览/阅读/发布/写作都没了）。这里兜底记录、保持存活。
  if (!globalThis.__nsEngineGuarded) {
    globalThis.__nsEngineGuarded = true;
    // ⚠️【崩了要留下案发现场】原来这两行只 console.error，而引擎是 Tauri 用 CREATE_NO_WINDOW 拉起来的，
    // stdout/stderr 没人接——2026-09-15 引擎两次无声消失，事后一点线索都没有，只能靠"HTTP 000"发现。
    // 现在同时写进 ~/.novel-studio/engine.log，带时间戳和完整堆栈。
    const crashLog = (tag, e) => {
      const line = `[${new Date().toISOString()}] ${tag}: ${(e && (e.stack || e.message)) || e}
`;
      try { console.error('[engine] ' + line.trim()); } catch {}
      try {
        const dir = path.join(os.homedir(), '.novel-studio');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'engine.log'), line, 'utf8');
      } catch {}
    };
    process.on('uncaughtException', (e) => crashLog('uncaughtException(已忽略保活)', e));
    process.on('unhandledRejection', (e) => crashLog('unhandledRejection(已忽略保活)', e));
    // 进程真要退了也记一笔：区分"自己退的"和"被外面杀的"，下次崩了才有得对。
    process.on('exit', (code) => { if (code !== 0) crashLog('process exit', new Error('exit code ' + code)); });
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
      try { process.on(sig, () => { crashLog('收到信号退出', new Error(sig)); process.exit(0); }); } catch {}
    }
  }
  const server = http.createServer(async (req, res) => {
    // CORS（Tauri webview 跨源调用）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname;
    if (p.startsWith('/api/') && p !== '/api/bootstrap' && p !== '/api/usage')
      console.log(`[${new Date().toISOString()}] ${req.method} ${p}${u.search}`);
    try {
      if (p === '/api/stream') return sseStream(u, res);
      if (p.startsWith('/api/')) return await api(p, req, res, u);
      return serveStatic(p, res, req);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Novel Studio engine 已启动: http://127.0.0.1:${port}`);
    setTimeout(reattachLiveSessions, 1500);
    setTimeout(() => { resumeStatelessRuns().catch(e => console.error('[engine] resumeStatelessRuns:', e?.message || e)); }, 2500);
    startOrphanWatchdog();
    startChapterProgressWatchdog();
  });
  return server;
}

// autopilot 因【终止性原因】停下来时的收尾：把会话记录清掉，让这本书回到空闲。
// 不清的后果（《大宋第一女帝：我成了李清照》实证）：撞上模型用量上限 → autopilot 停并说
// "不再重试，等额度恢复后手动继续" → 60 秒后孤儿看门狗看见"在册会话没有活着的 autopilot"
// → 补挂一个 → 新的立刻又撞上限 → 停 → 再补挂…… 日志里来回刷，而书永远挂在"写作中"，
// 界面上写作/复检/发布全被那个状态挡着，什么都点不动。
// 记录一清，看门狗自然不会再补挂（它遍历的就是在册会话），状态也跟着回正。
// 窗口本身留着不动——agent 可能还能用，作者要么手动继续，要么下次开写时 closeBookOrphans 会清掉它。
function mkTerminalStop(slug) {
  return (reason) => {
    try { pushLog(slug, { level: 'warn', msg: `autopilot 终止性停止（${reason}）→ 已清理会话记录，这本书回到空闲；窗口留着没关，你可以去窗口手动继续` }); } catch {}
    try { removeSession(slug); } catch {}
    const st = rt.get(slug);
    try { st?.streamer?.stop(); } catch {}
    // 【不能 rt.delete】原来这里整条删掉——日志跟着没了，刚写的那句"为什么停"当场被抹掉；
    // 而且下面那句 broadcast 找的是 rt.get(slug)，删了之后连着的界面一个都收不到"已停止"。
    // 2026-09-19 王莽改稿：agy 因参数被切碎没启动起来，作者界面上【一个字都没有】，
    // 会话也消失了，只能去翻 Unterm 窗口才知道是 Error: unexpected argument。
    // 同 9/17 修过的"开写缘由被 logs=[] 抹掉"是一个模式。只清会话相关的状态，日志和观众留着。
    if (st) { st.session = null; st.streamer = null; }
    try { broadcast(slug, 'stopped', { reason: 'terminal', detail: reason }); } catch {}
  };
}

// 穿插一条新任务（复检/收束令/改名/重写/修订…）。
// 【必须走这个包装，别直接调 sendToBook】：穿插新任务 = 作者还要它干活，得先撤销之前那次「优雅停止」。
// 血泪现场（2026-09-05）：先点【停止】(autopilot 进入 draining)，紧接着点【复检】——
// 复检指令确实穿进去了、git 也存档了，但 draining 还挂着，claude 一跑到待续点就被
// "当前批次已完成 → 已关闭窗口"收掉，复检跑了一半窗口没了，日志里只有那一句，谁也看不出因果。
async function injectToBook(slug, text, cfg) {
  try { rt.get(slug)?.session?.autopilot?.cancelDrain?.(); } catch {}
  return sendToBook(slug, text, cfg);
}

// 引擎(重)启动时，把 autopilot 重新挂到仍在运行的写作会话上，避免重启后会话失去监控。
async function reattachLiveSessions() {
  const cfg = loadConfig();
  for (const s of listSessions()) {
    if (rt.get(s.slug)?.session?.autopilot?.running) continue;   // 只有【活着的】autopilot 才跳过
    try {
      const h = await attachAutopilot(s.slug, cfg, (e) => pushLog(s.slug, e), mkFresh(s.slug, cfg), mkTerminalStop(s.slug));
      rtOf(s.slug).session = { autopilot: h.autopilot, mcp: h.mcp, reattached: true };
      pushLog(s.slug, { msg: '引擎启动 → 已重新挂载 autopilot 继续监控' });
    } catch (e) { /* 会话可能已死，listSessions 会自动清理 */ }
  }
}

// 【孤儿窗口看门狗】：写作窗口可能在崩溃/重启/重开后丢了 autopilot（在册但没人监控）→ 静默卡死（霍元甲卡5天的根因）。
// 每 60s 巡检：凡是在册会话没挂 autopilot 的，补挂一个（新代码带审稿门/完本门处理器）；死窗口 attach 会失败自动跳过。
function startOrphanWatchdog() {
  if (globalThis.__nsOrphanWatchdog) return;
  globalThis.__nsOrphanWatchdog = setInterval(async () => {
    let cfg; try { cfg = loadConfig(); } catch { return; }
    // 先按【还活着的 pane】清一遍陈旧会话记录。0.71 起会话记的 pid 是共用的 GUI pid，
    // 只要 Unterm 开着就永远"活着"，pane 早关了书还挂在写作中 → 下次写作/复检只去穿插指令、
    // 打进一个不存在的 pane，界面上就是点了没反应。连不上时 snapshotPaneIds 返回空集，
    // 这里按 null 传下去 → 一个都不删，绝不误杀在跑的会话。
    try {
      const panes = await snapshotPaneIds();
      for (const slug of pruneSessionsByPanes(panes.size ? panes : null)) {
        pushLog(slug, { level: 'warn', msg: '窗口已不在（pane 没了）→ 清理陈旧会话记录，这本书回到空闲' });
        const st = rt.get(slug);
        try { st?.session?.autopilot?.stop('窗口已关闭'); } catch {}
        try { st?.streamer?.stop(); } catch {}
        rt.delete(slug);
        broadcast(slug, 'stopped', { reason: 'pane-gone' });
      }
    } catch {}
    for (const s of listSessions()) {
      let st = rt.get(s.slug);
      const ap = st?.session?.autopilot;
      // ⚠️ 关键：不能只看 autopilot【对象是否存在】，要看它【是否还活着(running)】。
      // 之前 bug：autopilot 在会话慢启动/启动报错时 stop() 掉了(running=false)，但对象还挂在 rt.session 上，
      // 看门狗以为"有人盯着"就不补挂 → 窗口其实无人应答、卡在 Yes/No 门里没人点(圣女 csld 卡死的根因)。
      if (!ap || !ap.running) {
        try { st?.session?.mcp?.close?.(); } catch {}                 // 清掉停掉的旧连接，避免泄漏
        try {
          const h = await attachAutopilot(s.slug, cfg, (e) => pushLog(s.slug, e), mkFresh(s.slug, cfg), mkTerminalStop(s.slug));
          rtOf(s.slug).session = { ...(st?.session || {}), autopilot: h.autopilot, mcp: h.mcp, reattached: true };
          pushLog(s.slug, { level: 'act', msg: ap ? '🐕 看门狗：写作窗口的 autopilot 已停掉/掉线 → 重新补挂继续盯' : '🐕 看门狗：发现写作窗口无人监控 → 已补挂 autopilot 继续盯' });
          st = rt.get(s.slug);
        } catch { continue; /* 窗口已死或连不上 → 跳过，下一轮再看 */ }
      }
      // 状态驱动审稿门：不阻塞主循环（fire-and-forget，内部 dedup 防重入）
      checkOutlineGate(s.slug, cfg).catch(() => {});
    }
  }, 60000);
  globalThis.__nsOrphanWatchdog.unref?.();
}

// 【落章播报】每 20 秒对在册的窗口会话点一次章数，涨了就播一行（缘由见 progress.mjs）。
// 只管【在册的 Unterm 会话】=窗口模式；无状态那条自己每批都报，不重复播。
const _chapHigh = new Map();   // slug -> 上次播报时的最高章号
function startChapterProgressWatchdog() {
  if (globalThis.__nsChapterWatchdog) return;
  globalThis.__nsChapterWatchdog = setInterval(() => {
    let live;
    try { live = listSessions(); } catch { return; }
    const alive = new Set();
    for (const s of live) {
      const slug = s.slug; alive.add(slug);
      const book = getBook(slug); if (!book) continue;
      let st; try { st = bookStats(book); } catch { continue; }
      const prev = _chapHigh.get(slug);
      if (isFirstSight(prev)) { _chapHigh.set(slug, st?.maxChapter || 0); continue; }
      const line = chapterProgressLine(prev, st);
      if (!line) continue;
      _chapHigh.set(slug, st.maxChapter);
      pushLog(slug, { level: 'act', source: 'progress', msg: line });
    }
    for (const slug of _chapHigh.keys()) if (!alive.has(slug)) _chapHigh.delete(slug);   // 会话没了就别占着
  }, 20000);
  globalThis.__nsChapterWatchdog.unref?.();
}

// 启动一次无状态写作（后台跑、日志推 SSE、登记 rt + 落盘 stateless-active 供崩溃后自愈）。
// 供 /api/book/stateless-start 端点与引擎启动时的 resumeStatelessRuns 共用同一条路径。
function startStatelessRun(book, { model, batches = 1, untilTarget = false, cfg }) {
  const slug = book.slug;
  const control = { stopped: false };
  rtOf(slug).statelessRun = control;
  rtOf(slug).logs = [];
  markStatelessActive(slug, { book: book.title || slug, model, batches, untilTarget });
  pushLog(slug, { level: 'act', msg: `▶ 无状态省钱模式启动（模型 ${model}，${untilTarget ? '写到目标章数' : batches + ' 批'}）` });
  runStateless({
    book, model, cfg, batches, untilTarget, control,
    onLog: (e) => pushLog(slug, { ...e, source: e.source || 'stateless' }),
    onReachedTarget: () => { try { maybeAutoPublish(getBook(slug) || book, { cfg, onLog: (e) => pushLog(slug, { ...e }) }); } catch {} },
  })
    .catch(e => pushLog(slug, { level: 'error', source: 'stateless', msg: '无状态写作异常：' + e.message }))
    .finally(() => {
      const st = rt.get(slug); if (st) st.statelessRun = null;
      clearStatelessActive(slug);   // 正常/停止结束 → 从"待自愈清单"移除；崩溃时不会执行到这里，故重启会自愈
      broadcast(slug, 'stopped', { stateless: true });
      pushLog(slug, { level: 'act', msg: '■ 无状态写作已结束' });
    });
  return { ok: true, started: true, mode: 'stateless', untilTarget, batches };
}

// 引擎(重)启动时：把上次崩溃/被杀时仍在跑的无状态写作接着跑起来。
// 只自愈"落盘登记了、但当前既没在跑无状态、也没有长驻窗口"的书；未达目标才续。
async function resumeStatelessRuns() {
  const map = readStatelessActive();
  const slugs = Object.keys(map);
  if (!slugs.length) return;
  let cfg; try { cfg = loadConfig(); } catch { return; }
  for (const slug of slugs) {
    const info = map[slug] || {};
    const book = getBook(slug);
    if (!book) { clearStatelessActive(slug); continue; }
    if (sessionLive(slug)) { clearStatelessActive(slug); continue; }           // 已被长驻模式接管 → 放弃自愈
    if (rtOf(slug).statelessRun && !rtOf(slug).statelessRun.stopped) continue;  // 已经在跑
    // 已达目标章数就别再拉起来了
    const target = book.targetChapters || 0;
    if (target > 0) { try { if (bookStats(book).chapters >= target) { clearStatelessActive(slug); continue; } } catch {} }
    const model = info.model || book.model || cfg.defaultModel;
    const untilTarget = info.untilTarget === true || (target > 0 && info.batches == null);
    const batches = Math.max(1, parseInt(info.batches, 10) || 1);
    try {
      startStatelessRun(book, { model, batches, untilTarget, cfg });
      pushLog(slug, { level: 'act', msg: '🔁 引擎重启 → 自动接续上次未完成的无状态写作' });
    } catch (e) { pushLog(slug, { level: 'warn', msg: '无状态写作自愈失败：' + e.message }); }
  }
}

// 【状态驱动·自动过门】治"autopilot 读屏识别门天生脆"：看门狗读一次窗口屏幕，只要出现明确门信号
// （sentinel【大纲待审：卷N】或大白话"缺 大纲审稿-卷N / 不能动笔"）且审稿文件不存在 → 直接用 codex 生成审稿
// （editor 里失败会自动放行），再把"据审稿修订并继续"指令送进窗口。绝不打扰正常写作的书（没门信号就不动）。
const _gateHandled = new Map();   // slug -> Set，防重复处理同一 scope
async function checkOutlineGate(slug, cfg) {
  const st = rt.get(slug);
  const mcp = st?.session?.mcp;
  const paneId = st?.session?.autopilot?.paneId;
  if (!mcp || paneId == null) return;
  let tail = '';
  try {
    const scr = await mcp.screenText(paneId);
    tail = (typeof scr === 'string' ? scr : '').split(/\r?\n/).filter(l => l.trim()).slice(-40).join('\n');
  } catch { return; }
  // 提取"待审卷"
  let scope = null;
  const sm = tail.match(/【大纲待审[:：]\s*([^】\n]+)】/);
  if (sm) scope = sm[1].trim();
  else {
    const pm = tail.match(/大纲审稿[-－]?\s*(卷\s*[0-9零一二三四五六七八九十百]+)/);
    if (pm && /(需要等|缺|没有|尚未|还没|不能[动开]笔|无法继续|才能(继续|写))/.test(tail)) scope = pm[1].replace(/\s+/g, '');
  }
  if (!scope) return;
  const book = getBook(slug); if (!book) return;
  const safe = scope.replace(/[\\/:*?"<>|]/g, '_');
  const reviewFile = path.join(book.dir, 'reviews', `大纲审稿-${safe}.md`);
  const handled = _gateHandled.get(slug) || new Set();
  _gateHandled.set(slug, handled);
  if (fs.existsSync(reviewFile)) {
    // 审稿已在 → 门其实已过、作者卡着没回头 → 催一次让它据审稿修订并继续（每 scope 只催一次）
    if (handled.has(scope + ':nudge')) return;
    handled.add(scope + ':nudge');
    try { await injectToBook(slug, buildReviseInstruction(book, scope, reviewFile), cfg); pushLog(slug, { level: 'act', msg: `🐕 看门狗：${scope}审稿已在 → 已催作者据此修订并继续写作` }); } catch {}
    return;
  }
  if (handled.has(scope + ':gen')) return;   // 正在生成，勿重入
  handled.add(scope + ':gen');
  pushLog(slug, { level: 'act', msg: `🐕 看门狗：检测到卡在【${scope}大纲审稿门】→ 自动生成审稿（codex）并放行…` });
  try {
    const r = await reviewOutline({ book, scope, cfg, authorModel: book.model || cfg.defaultModel, onLog: (e) => pushLog(slug, { ...e, source: 'editor' }) });
    await injectToBook(slug, buildReviseInstruction(book, scope, r.file), cfg);
    pushLog(slug, { level: 'act', msg: `🐕 看门狗：${scope}审稿已生成（${r.editorModel}）→ 已让作者据此修订并继续写作` });
  } catch (e) {
    pushLog(slug, { level: 'warn', msg: `看门狗自动过门失败：${e.message}（下一轮重试）` });
    handled.delete(scope + ':gen');   // 允许下一轮重试
  }
}

async function api(p, req, res, u) {
  const cfg = loadConfig();
  if (req.method === 'GET') {
    if (p === '/api/book/cover') {
      const book = getBook(u.searchParams.get('book'));
      const f = book && path.join(book.dir, 'cover.png');
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('no cover'); }
      // 【关键】带 CORS 头：前端 <img crossOrigin=anonymous> 画到 canvas 后才不会"污染"画布，
      // 否则 canvas.toDataURL() 会抛 SecurityError → 保存封面失败（尤其带 AI 底图时）。
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/book/cover-bg') {   // AI 生成的封面底图（未叠字），给前端 canvas 当背景
      const book = getBook(u.searchParams.get('book'));
      const f = book && path.join(book.dir, 'cover_bg.png');
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('no bg'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/book/exp-image') {   // 书名实验里某个候选的封面底图（experiment/NN.png）
      const book = getBook(u.searchParams.get('book'));
      const rel = path.basename(u.searchParams.get('file') || '');   // 只取文件名，防目录穿越
      const f = book && /^[\w.-]+\.png$/.test(rel) && path.join(book.dir, 'experiment', rel);
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('no img'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/bootstrap') return json(res, 200, bootstrap(cfg));
    if (p === '/api/book/files') {     // 阅读工作台：文件树 + 进度
      try {
        const book = getBook(u.searchParams.get('book') || ''); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, listBookFiles(book));
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/read') {      // 读单个文件内容
      try {
        const book = getBook(u.searchParams.get('book') || ''); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, readBookFile(book, u.searchParams.get('rel') || ''));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/shelf-status') {
      // 书架用：每本书【在等你做什么】+ 异常计数。
      //
      // 为什么单开一个端点而不是塞进 /api/books：书架要先把卡片画出来（封面/书名一出来
      // 人就能动手），状态随后补。塞进 bootstrap 会让整个开屏等最慢的那本书。
      // 也不进轮询——书架是按需刷新的，没必要一直算。
      try {
        const out = [];
        for (const b of loadBooks()) {
          let next = 'write', nextLabel = '继续往下写', counts = { bad: 0, warn: 0, info: 0 };
          try {
            const st = bookStats(b);
            const pend = getPending(b.slug);
            const live = sessionLive(b.slug) || !!(rt.get(b.slug)?.statelessRun && !rt.get(b.slug).statelessRun.stopped);
            const planned = plannedTotalChapters(b) || 0;
            if (b.status === '已完本') { next = 'publish'; nextLabel = '去发行'; }
            else if (pend) { next = 'review'; nextLabel = '等你拍板'; }
            else if (live) { next = 'watch'; nextLabel = '正在写'; }
            else if (planned > 0 && st.chapters >= planned) { next = 'finale'; nextLabel = '可以收尾了'; }
            counts = memo('chk:' + b.slug, 60000, () => checkupBook(b).counts);
          } catch {}
          out.push({ slug: b.slug, next, nextLabel, ...counts });
        }
        return json(res, 200, { ok: true, books: out });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/digest-progress') {
      try { const b=getBook(u.searchParams.get('book')); if(!b) return json(res,400,{error:'找不到书'});
        const st=rt.get(b.slug); return json(res,200,{ ok:true, running: !!(st?.outlineRun && !st.outlineRun.stopped), ...digestProgress(b) }); }
      catch(e){ return json(res,500,{error:e.message}); }
    }
    if (p === '/api/book/overhaul/status') {
      // 改造进度：批次做到哪、还剩几批、有哪些没达标、阅读复核挑出多少条
      try {
        const slug = u.searchParams.get('book');
        const book = getBook(slug); if (!book) return json(res, 400, { error: '找不到书：' + slug });
        const st = getOverhaulState(book.slug) || null;
        const job = overhaulJobs.get(book.slug) || null;
        const done = st?.doneBatches?.length || 0;
        return json(res, 200, {
          ok: true, state: st, running: job?.status === 'running',
          done, total: st?.total || 0,
          percent: st?.total ? Math.round(done / st.total * 100) : 0,
          changed: (() => { try { return changedChapters(book, { from: st?.from || 1, to: st?.to || 0 }); } catch { return []; } })(),
        });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/checkup') {
      // 体检：把软件已经知道、但从来没说出口的异常摆出来（缺章/漏发/状态与事实不符/模型能力…）。
      // 每条都带 action，指向界面上真实存在的入口——只报事实不给出口，等于把活儿推回给作者。
      try {
        const slug = u.searchParams.get('book');
        const book = getBook(slug); if (!book) return json(res, 400, { error: '找不到书：' + slug });
        return json(res, 200, { ok: true, ...checkupBook(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/dashboard') {   // 创作看板：我在哪 / 健康体检 / 下一步
      try {
        const slug = slugOf(u.searchParams.get('book') || '');
        const book = getBook(slug); if (!book) return json(res, 400, { error: '找不到书：' + slug });
        const st = bookStats(book);
        const planned = plannedTotalChapters(book);
        const words = Math.round((st.kb || 0) * 1024 / 3);   // 中文 UTF-8 约 3 字节/字
        const progress = planned > 0 ? Math.min(100, Math.round(st.chapters / planned * 100)) : 0;
        let tokens = 0; try { tokens = bookUsage(slug) || 0; } catch {}
        // 健康：连贯性台账 + 最近一份自检/审稿(数 硬伤/隐患)
        let ledger = false, lastReview = '', crit = 0, warn = 0;
        try { ledger = fs.existsSync(path.join(book.dir, 'continuity_ledger.md')); } catch {}
        try {
          const rdir = path.join(book.dir, 'reviews');
          const files = fs.readdirSync(rdir).filter(f => f.endsWith('.md'));
          let latest = null, lt = 0;
          for (const f of files) { const mt = fs.statSync(path.join(rdir, f)).mtimeMs; if (mt > lt) { lt = mt; latest = f; } }
          if (latest) { lastReview = latest; const txt = fs.readFileSync(path.join(rdir, latest), 'utf8'); crit = (txt.match(/硬伤/g) || []).length; warn = (txt.match(/隐患/g) || []).length; }
        } catch {}
        // 状态 + 下一步建议
        const live = sessionLive(slug) || !!(rtOf(slug).statelessRun && !rtOf(slug).statelessRun.stopped);
        const pend = getPending(slug);
        let status = '连载中', next = 'write', nextLabel = '继续往下写';
        if (book.status === '已完本') { status = '已完本'; next = 'publish'; nextLabel = '去发行'; }
        else if (pend) { status = pend.kind === 'outline' ? '待你定大纲' : '待你审核'; next = 'review'; nextLabel = '去处理'; }
        else if (live) { status = '正在写'; next = 'watch'; nextLabel = '看写作进度'; }
        else if (planned > 0 && st.chapters >= planned) { status = '已达目标'; next = 'finale'; nextLabel = '可以完本/发行了'; }
        return json(res, 200, {
          ok: true, title: book.title, status, chapters: st.chapters, words, kb: st.kb, tokens,
          curVol: currentVolume(book), plannedVolumes: plannedVolumes(book), plannedChapters: planned, progress,
          health: { ledger, lastReview, crit, warn }, next, nextLabel, participation: participationOf(book),
        });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/pending') {   // 写作台重开时恢复"待确认审稿/审核"动作条
      const slug = slugOf(u.searchParams.get('book') || '');
      const pend = getPending(slug);
      const reviewEvery = getReviewEvery(slug);
      const base = { reviewEvery, writeMode: reviewEvery > 0 ? 'review' : 'auto' };
      if (!pend) return json(res, 200, { pending: false, ...base });
      return json(res, 200, {
        pending: true, kind: pend.kind || 'outline', scope: pend.scope,
        file: path.basename(pend.file || ''), critique: pend.critique || '',
        items: pend.items || [],
        chapters: pend.chapters, n: pend.n, ...base,
      });
    }
    if (p === '/api/env') {   // 环境自检：unterm 路径 + 模型 + 代理 + 实例 + 书库（供环境页展示与操作）
      const proxy = readProxyConfig();
      const uexe = findUntermExe() || '';
      return json(res, 200, {
        platform: process.platform,
        untermExe: uexe,
        untermVersion: uexe ? untermVersion(uexe) : '',
        untermCli: findUntermCli() || '',
        models: detectAll(),
        proxy: { enabled: !!cfg.enableProxy, node: cfg.proxyNode, url: proxy?.http_proxy || proxy?.socks_proxy || '' },
        instances: listInstances().map(i => ({ id: i.id, version: i.version, mcp_port: i.mcp_port })),
        workspace: cfg.workspace,
        workspaceExists: (() => { try { return fs.existsSync(cfg.workspace); } catch { return false; } })(),
      });
    }
    if (p === '/api/books') return json(res, 200, withUsage(listBooksWithStats()));
    if (p === '/api/sessions') return json(res, 200, sessionsInfo());
    // 番茄主分类清单（男频/女频各一套，实抓自创建作品页）。前端据此渲染下拉，不再各写各的硬编码。
    if (p === '/api/fanqie/categories') return json(res, 200, { ok: true, categories: FANQIE_CATEGORIES });
    if (p === '/api/usage') {
      const usage = loadUsage();
      const books = {};
      for (const b of listBooksWithStats()) {
        const t = bookTokens(b);                                   // codex/claude 订阅制 token（真实日志优先）
        const apiU = (usage.books[b.slug] && usage.books[b.slug].api) || null;  // API 付费用量+成本
        if (t || apiU) books[b.slug] = { total: t, sessions: {}, api: apiU };
      }
      return json(res, 200, { books });
    }
    if (p === '/api/models') return json(res, 200, detectAll());
    if (p === '/api/styles') return json(res, 200, STYLES);
    if (p === '/api/romance-levels') return json(res, 200, ROMANCE_LEVELS);   // 建书表单用：感情线档位表
    if (p === '/api/config') return json(res, 200, maskConfig(cfg));
    if (p === '/api/logs') { const slug = u.searchParams.get('book'); return json(res, 200, rtOf(slug).logs); }
    return json(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    if (p === '/api/book/create') {
      const b = createBook(body, cfg);
      // 手动建书也走同一条路：挑中的开头 = 本书第一份范本（见 /api/book/launch 里的说明）
      if (body.voiceRef && body.voiceRef.text) {
        try { await adoptCandidate(b, body.voiceRef, { model: body.model || b.model || cfg.defaultModel, cfg }); }
        catch (e) { pushLog(b.slug, { level: 'warn', source: 'voice', msg: '文风范本落盘失败：' + e.message }); }
      }
      return json(res, 200, { ok: true, book: { ...b, stats: { chapters: 0, kb: 0 } } });
    }
    if (p === '/api/book/delete') {
      const slug = slugOf(body.book);
      const st = rt.get(slug); if (st?.session?.autopilot) { try { st.session.autopilot.stop('删除'); } catch {} } if (st?.streamer) { try { st.streamer.stop(); } catch {} } rt.delete(slug);
      try { const r = deleteBook(slug, { deleteFiles: !!body.deleteFiles }); return json(res, 200, r); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/detect-title') {
      try { return json(res, 200, { title: detectTitleFromDir(body.dir) }); }
      catch (e) { return json(res, 200, { title: '' }); }
    }
    if (p === '/api/book/import') {
      try {
        const b = importBook(body, cfg);
        const withStats = listBooksWithStats().find(x => x.slug === b.slug) || { ...b, stats: { chapters: 0, kb: 0 } };
        return json(res, 200, { ok: true, book: { ...withStats, tokens: 0 } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/recommend-style') {
      try { const rec = await recommendStyle(body, cfg); return json(res, 200, { ok: true, style: rec }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/set-target') {
      try { const b = setBookTarget(body.book, body.targetChapters); return json(res, 200, { ok: true, targetChapters: b.targetChapters }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/synopsis') {
      // 带 text=直接保存(用户手改)；不带=用 AI 生成约150字简介(写作模型是 claude 时自动换 codex/gemini)。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        if (typeof body.text === 'string') { const b = setBookSynopsis(book.slug, body.text); return json(res, 200, { ok: true, synopsis: b.synopsis, saved: true }); }
        const { synopsis, model } = generateSynopsis(book, cfg);
        if (!synopsis) return json(res, 500, { error: 'AI 未生成有效简介，请重试' });
        const b = setBookSynopsis(book.slug, synopsis);
        return json(res, 200, { ok: true, synopsis: b.synopsis, model });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/renumber') {    // 全局重编号：每卷独立编号→全书连续 001…N（重建索引）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        if (sessionLive(book.slug)) return json(res, 409, { error: '这本书正在写作中，请先停止再重编号' });
        const hash = gitSnapshot(book.dir, '全局重编号前存档');
        const r = renumberGlobalChapters(book);
        pushLog(book.slug, { level: 'act', msg: `全局重编号完成：${r.chapters} 章连续编号（改名 ${r.renamed}，卷简介移出 ${r.intros}）` });
        return json(res, 200, { ok: true, ...r, snapshot: hash });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/save-file') {   // 在 app 里编辑章节/设定后保存
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const r = saveBookFile(book, body.rel, body.content);
        pushLog(book.slug, { level: 'act', msg: '已保存编辑：' + body.rel });
        return json(res, 200, r);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/open-dir') {
      // 在系统文件管理器里打开这本书的目录
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        if (!fs.existsSync(book.dir)) return json(res, 400, { error: '目录不存在：' + book.dir });
        const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        try { spawn(cmd, [book.dir], { detached: true, stdio: 'ignore' }).unref(); } catch {}
        return json(res, 200, { ok: true, dir: book.dir });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/open-path') {
      // 在系统文件管理器里打开任意目录（环境页/设置“打开书库目录”）；缺省打开书库目录。不存在则先建。
      try {
        let dir = String(body.path || cfg.workspace || '').trim();
        if (!dir) return json(res, 400, { error: '未指定目录' });
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
        if (!fs.existsSync(dir)) return json(res, 400, { error: '目录不存在且无法创建：' + dir });
        const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        try { spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch {}
        return json(res, 200, { ok: true, dir });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rename') {
      // 中途改书名并全书生效。写作中禁止改（要先停，避免与运行中的窗口冲突）。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        if (sessionLive(book.slug)) return json(res, 409, { error: '这本书正在写作中，请先【停止】再改名' });
        const r = renameBook(book.slug, body.title);
        pushLog(book.slug, { level: 'act', msg: `已改名为《${r.book.title}》，改写 ${r.touched} 个文件 + 重生成上下文` });
        return json(res, 200, { ok: true, title: r.book.title, slug: book.slug, touched: r.touched });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/set-model') {
      try {
        const b = setBookModel(body.book, body.model);
        // 提示：运行中的旧窗口换不了模型，需停掉重开才生效（点“写作/续写”会自动按新模型重开）
        const live = sessionLive(b.slug);
        const liveModel = live ? (getSession(b.slug)?.model || null) : null;
        return json(res, 200, { ok: true, model: b.model, live, liveModel, needReopen: live && liveModel && liveModel !== b.model });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/save-cover') {
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const m = String(body.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
        if (!m) return json(res, 400, { error: '图片数据无效' });
        const out = path.join(book.dir, 'cover.png');
        fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
        return json(res, 200, { ok: true, path: out });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/export-cover') {
      // 导出封面到系统"下载"文件夹（Tauri webview 里 <a download> 不工作，改走后端写盘）。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const m = String(body.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
        if (!m) return json(res, 400, { error: '图片数据无效' });
        const dl = path.join(os.homedir(), 'Downloads');
        try { fs.mkdirSync(dl, { recursive: true }); } catch {}
        const safe = String(book.title || 'cover').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);
        const out = path.join(dl, safe + '_封面.png');
        fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
        return json(res, 200, { ok: true, path: out });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/gen-cover-bg') {   // 调 Imagen 生成 AI 封面底图（落 cover_bg.png），返回 url 给前端 canvas
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const r = await generateCoverBg(book, { prompt: body.prompt, onLog: (e) => pushLog(book.slug, { ...e, source: 'cover' }) });
        return json(res, 200, { ok: true, url: '/api/book/cover-bg?book=' + encodeURIComponent(book.slug) + '&t=' + Date.now(), prompt: r.prompt, w: r.w, h: r.h });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/art-prompt') {   // 仅生成英文出图提示词（让用户可先看/改）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, { ok: true, prompt: await buildArtPromptAuto(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/gen-cover-chatgpt') {   // 用【已登录的 ChatGPT(Pro)】网页版生成封面底图（免费、慢，后台跑）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const profilePath = body.profilePath || (book.publish || {}).profilePath || '';
        if (!profilePath) return json(res, 400, { error: '请先选一个【已登录 ChatGPT】的浏览器账号' });
        const slug = book.slug;
        const cur = coverJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        coverJobs.set(slug, { status: 'running', msg: '正在打开 ChatGPT…' });
        const onLog = (e) => { const j = coverJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'cover' }); };
        generateCoverViaChatGPT(book, { prompt: body.prompt, profilePath, onLog })
          .then((r) => {
            coverJobs.set(slug, { status: 'done', url: '/api/book/cover-bg?book=' + encodeURIComponent(slug) + '&t=' + Date.now(), prompt: r.prompt, w: r.w, h: r.h, msg: '封面已生成' });
            pushLog(slug, { level: 'act', source: 'cover', msg: '✅ ChatGPT 封面底图已生成' });
          })
          .catch((e) => {
            coverJobs.set(slug, { status: 'error', error: e.message, msg: e.message });
            pushLog(slug, { level: 'error', source: 'cover', msg: 'ChatGPT 生成封面失败：' + e.message });
          });
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/grab-cover-chatgpt') {   // 手动【抓取封面】：从当前 ChatGPT 页把已生成好的图抓下来（不再生成，快）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const profilePath = body.profilePath || (book.publish || {}).profilePath || '';
        if (!profilePath) return json(res, 400, { error: '请先选一个【已登录 ChatGPT】的浏览器账号' });
        const slug = book.slug;
        const cur = coverJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        coverJobs.set(slug, { status: 'running', msg: '正在抓取当前 ChatGPT 页的图…' });
        const onLog = (e) => { const j = coverJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'cover' }); };
        grabCoverFromChatGPT(book, { profilePath, onLog })
          .then((r) => {
            coverJobs.set(slug, { status: 'done', url: '/api/book/cover-bg?book=' + encodeURIComponent(slug) + '&t=' + Date.now(), w: r.w, h: r.h, msg: '封面已抓取' });
            pushLog(slug, { level: 'act', source: 'cover', msg: '✅ 已抓取 ChatGPT 封面底图' });
          })
          .catch((e) => {
            coverJobs.set(slug, { status: 'error', error: e.message, msg: e.message });
            pushLog(slug, { level: 'error', source: 'cover', msg: '抓取封面失败：' + e.message });
          });
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/gen-cover-gemini') {   // 用【已登录的 Gemini】网页版生成封面底图（实测出图比 ChatGPT 快，十几秒～1分钟）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const profilePath = body.profilePath || (book.publish || {}).profilePath || '';
        if (!profilePath) return json(res, 400, { error: '请先选一个【已登录 Gemini】的浏览器账号' });
        const slug = book.slug;
        const cur = coverJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        coverJobs.set(slug, { status: 'running', msg: '正在打开 Gemini…' });
        const onLog = (e) => { const j = coverJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'cover' }); };
        generateCoverViaGemini(book, { prompt: body.prompt, profilePath, onLog })
          .then((r) => {
            coverJobs.set(slug, { status: 'done', url: '/api/book/cover-bg?book=' + encodeURIComponent(slug) + '&t=' + Date.now(), prompt: r.prompt, w: r.w, h: r.h, msg: '封面已生成' });
            pushLog(slug, { level: 'act', source: 'cover', msg: '✅ Gemini 封面底图已生成' });
          })
          .catch((e) => {
            coverJobs.set(slug, { status: 'error', error: e.message, msg: e.message });
            pushLog(slug, { level: 'error', source: 'cover', msg: 'Gemini 生成封面失败：' + e.message });
          });
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/grab-cover-gemini') {   // 手动【抓取封面】：从当前 Gemini 页把已生成好的图抓下来（不再生成，快）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const profilePath = body.profilePath || (book.publish || {}).profilePath || '';
        if (!profilePath) return json(res, 400, { error: '请先选一个【已登录 Gemini】的浏览器账号' });
        const slug = book.slug;
        const cur = coverJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        coverJobs.set(slug, { status: 'running', msg: '正在抓取当前 Gemini 页的图…' });
        const onLog = (e) => { const j = coverJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'cover' }); };
        grabCoverFromGemini(book, { profilePath, onLog })
          .then((r) => {
            coverJobs.set(slug, { status: 'done', url: '/api/book/cover-bg?book=' + encodeURIComponent(slug) + '&t=' + Date.now(), w: r.w, h: r.h, msg: '封面已抓取' });
            pushLog(slug, { level: 'act', source: 'cover', msg: '✅ 已抓取 Gemini 封面底图' });
          })
          .catch((e) => {
            coverJobs.set(slug, { status: 'error', error: e.message, msg: e.message });
            pushLog(slug, { level: 'error', source: 'cover', msg: '抓取封面失败：' + e.message });
          });
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/gen-cover-status') {   // 轮询 ChatGPT 生成/抓取封面进度
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = coverJobs.get(book.slug) || { status: 'idle' };
        return json(res, 200, { ok: true, ...j });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/push-fanqie-cover') {   // 把本地 cover.png 推到番茄换封面（autoSubmit:false 停在待提交）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { error: '该书未配番茄账号/bookId（先在发布里配好账号并选中番茄书籍）' });
        const coverPath = path.join(book.dir, 'cover.png');
        if (!fs.existsSync(coverPath)) return json(res, 400, { error: '还没有封面 cover.png，请先在「生成封面」里做好并点"保存到书"' });
        const autoSubmit = !!body.autoSubmit;
        const slug = book.slug;
        const cur = fanqieCoverJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        fanqieCoverJobs.set(slug, { status: 'running', msg: '开始…' });
        const onLog = (e) => { const j = fanqieCoverJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'fanqie' }); };
        // 半自动：番茄新版上传器只认真实文件框选图，自动化只能把弹窗打开到「本地上传」，最后人工选图确认。
        changeFanqieCover({ bookId: pc.bookId, coverPath, profilePath: pc.profilePath, autoSubmit, onLog })
          .then((r) => {
            if (r.ok) {
              const msg = r.semiManual ? (r.msg + '\ncover.png 路径：' + coverPath) : r.msg;
              fanqieCoverJobs.set(slug, { status: 'done', submitted: !!r.submitted, semiManual: !!r.semiManual, coverPath, msg });
              pushLog(slug, { level: 'act', source: 'fanqie', msg: '✅ ' + msg });
            } else { fanqieCoverJobs.set(slug, { status: 'error', error: r.error, msg: r.error }); pushLog(slug, { level: 'error', source: 'fanqie', msg: '番茄换封面失败：' + r.error }); }
          })
          .catch((e) => { fanqieCoverJobs.set(slug, { status: 'error', error: e.message, msg: e.message }); pushLog(slug, { level: 'error', source: 'fanqie', msg: '番茄换封面异常：' + e.message }); });
        return json(res, 200, { ok: true, started: true, autoSubmit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/push-fanqie-cover-status') {   // 轮询番茄换封面进度
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = fanqieCoverJobs.get(book.slug) || { status: 'idle' };
        return json(res, 200, { ok: true, ...j });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/fanqie/create-book') {   // 在番茄【创建一本新书】：填表→立即创建→抓回 bookId 并写入发布配置
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const profilePath = (body.profilePath || (book.publish || {}).profilePath || '').trim();
        if (!profilePath) return json(res, 400, { error: '请先选择 Unzoo 账号（发布弹窗顶部）' });
        const title = String(body.title || book.title || '').trim();
        const synopsis = String(body.synopsis || book.synopsis || '').trim();
        const mainCategory = String(body.mainCategory || '').trim();
        const channel = body.channel === '女频' ? '女频' : '男频';
        const signMode = body.signMode === '完本模式' ? '完本模式' : '连载模式';
        // 标签优先用请求里带的；没带就用书上存的（立项时 AI 选好的）——作者不用每次重挑
        const savedTags = (book.tags && book.tags.channel === channel) ? book.tags : null;
        const readTags = body.readTags || savedTags?.阅读标签 || null;
        const contentTags = body.contentTags || savedTags?.内容标签 || null;
        const hero = String(body.hero || '').trim();
        const hero2 = String(body.hero2 || '').trim();
        // 有本地封面就一并传（番茄建书默认自动生成封面，我们换成 cover.png）；没有则番茄用自动封面。可用 uploadCover:false 关掉。
        const _cp = path.join(book.dir, 'cover.png');
        const coverPath = (body.uploadCover !== false && fs.existsSync(_cp)) ? _cp : '';
        const autoSubmit = body.autoSubmit !== false;   // 默认全自动（用户已授权）
        if (!title) return json(res, 400, { error: '书名为空' });
        if (title.length > 15) return json(res, 400, { error: `书名「${title}」超过番茄上限(15字)` });
        if (!mainCategory) return json(res, 400, { error: '请选择主分类' });
        // 【频道与分类必须对得上】番茄的分类卡是按频道渲染的：拿男频的名字去女频弹窗里找，
        // 只会得到一句"标签弹窗里没找到主分类"，作者看到的是创建失败，不知道错在频道。
        // 病根是 UI 那个下拉切频道时纹丝不动（列表写死一套男频子集），这里再守一道。
        if (!isValidCategory(channel, mainCategory)) {
          return json(res, 400, { error: `「${mainCategory}」不是${channel}的主分类。${channel}可选：${FANQIE_CATEGORIES[channel].join('、')}` });
        }
        if (synopsis.length < 50) return json(res, 400, { error: `简介仅 ${synopsis.length} 字，番茄要求 50–500 字，请先在「作品简介」写好` });
        const slug = book.slug;
        const cur = fanqieCreateJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        fanqieCreateJobs.set(slug, { status: 'running', msg: '开始…' });
        const onLog = (e) => { const j = fanqieCreateJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'fanqie' }); };
        createFanqieBook({ profilePath, title, channel, signMode, mainCategory, readTags, contentTags, hero, hero2, synopsis, coverPath, autoSubmit, onLog })
          .then((r) => {
            if (r.ok && r.bookId) {
              try { setBookPublish(slug, { profilePath, bookId: r.bookId, bookName: title }); } catch {}
              const cvNote = coverPath ? (r.cover?.ok ? '，封面已上传' : '，封面待补传') : '';
              fanqieCreateJobs.set(slug, { status: 'done', bookId: r.bookId, cover: r.cover || null, msg: `✅ 已创建，bookId=${r.bookId}，已写入发布配置${cvNote}` });
              pushLog(slug, { level: 'act', source: 'fanqie', msg: `✅ 番茄已创建《${title}》 bookId=${r.bookId}（已回填发布配置${cvNote}）` });
            } else if (r.ok && r.semiManual) {
              fanqieCreateJobs.set(slug, { status: 'done', semiManual: true, msg: r.msg });
              pushLog(slug, { level: 'act', source: 'fanqie', msg: r.msg });
            } else {
              fanqieCreateJobs.set(slug, { status: 'error', error: r.error, msg: r.error });
              pushLog(slug, { level: 'error', source: 'fanqie', msg: '番茄创建作品失败：' + r.error });
            }
          })
          .catch((e) => { fanqieCreateJobs.set(slug, { status: 'error', error: e.message, msg: e.message }); pushLog(slug, { level: 'error', source: 'fanqie', msg: '番茄创建作品异常：' + e.message }); });
        return json(res, 200, { ok: true, started: true, autoSubmit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/fanqie/create-book-status') {   // 轮询番茄创建作品进度
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = fanqieCreateJobs.get(book.slug) || { status: 'idle' };
        return json(res, 200, { ok: true, ...j });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/name-experiment') {   // 书名实验生成器：批量出 N 个候选书名 + 每个一张不同画面封面（后台跑）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const slug = book.slug;
        const cur = nameExpJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        const count = Math.max(2, Math.min(10, Number(body.count) || 6));
        nameExpJobs.set(slug, { status: 'running', msg: '开始…' });
        const onLog = (e) => { const j = nameExpJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'nameexp' }); };
        generateNameExperiment(book, { count, cfg, onLog })
          .then((manifest) => { nameExpJobs.set(slug, { status: 'done', manifest, msg: `已生成 ${manifest.count} 个候选` }); pushLog(slug, { level: 'act', source: 'nameexp', msg: `✅ 书名实验：${manifest.count} 个候选书名+封面已生成` }); })
          .catch((e) => { nameExpJobs.set(slug, { status: 'error', error: e.message, msg: e.message }); pushLog(slug, { level: 'error', source: 'nameexp', msg: '书名实验生成失败：' + e.message }); });
        return json(res, 200, { ok: true, started: true, count });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/name-experiment-status') {   // 轮询进度；idle 时回读已存的清单
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = nameExpJobs.get(book.slug);
        if (j) return json(res, 200, { ok: true, ...j });
        const manifest = readNameExperiment(book);
        return json(res, 200, { ok: true, status: manifest ? 'done' : 'idle', manifest });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/push-name-experiment') {   // 把书名实验候选(书名+封面)推到番茄「多书名实验·实验配置」(设置别名)
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { error: '该书未配番茄账号/bookId（先在发布里配好账号并选中番茄书籍）' });
        const manifest = readNameExperiment(book);
        if (!manifest || !(manifest.items || []).length) return json(res, 400, { error: '还没有书名实验，请先点「🧪 书名实验」生成候选书名+封面' });
        // 组装 items：书名 + 对应封面绝对路径（experiment/NN.png）。可只推指定序号(body.pick=[1,3,...])。
        const pick = Array.isArray(body.pick) && body.pick.length ? new Set(body.pick.map(Number)) : null;
        const items = (manifest.items || [])
          .filter(it => it && it.title && (!pick || pick.has(it.i)))
          .map(it => {
            // 优先用【带书名】的封面(NN.titled.png，UI 推送前烤好的)，没有才退回无字底图(NN.png)
            let cover = '';
            if (it.bg) {
              const titled = path.join(book.dir, 'experiment', it.bg.replace(/\.png$/i, '') + '.titled.png');
              const bg = path.join(book.dir, 'experiment', it.bg);
              cover = fs.existsSync(titled) ? titled : (fs.existsSync(bg) ? bg : '');
            }
            return { title: String(it.title).trim(), coverPath: cover };
          });
        if (!items.length) return json(res, 400, { error: '没有可推的候选书名' });
        const autoSubmit = !!body.autoSubmit;   // 默认 false：填好停在实验配置，让用户核对后自己「开启实验」(不可逆)
        const slug = book.slug;
        const cur = nameExpPushJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        nameExpPushJobs.set(slug, { status: 'running', msg: '开始…' });
        const onLog = (e) => { const j = nameExpPushJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'nameexp' }); };
        pushNameExperiment({ bookId: pc.bookId, bookTitle: pc.bookName || book.title, items, profilePath: pc.profilePath, autoSubmit, onLog })
          .then((r) => {
            if (r.ok) {
              nameExpPushJobs.set(slug, { status: 'done', submitted: !!r.submitted, semiManual: !!r.semiManual, filled: r.filled || 0, msg: r.msg });
              pushLog(slug, { level: 'act', source: 'nameexp', msg: '✅ ' + r.msg });
            } else { nameExpPushJobs.set(slug, { status: 'error', error: r.error, msg: r.error }); pushLog(slug, { level: 'error', source: 'nameexp', msg: '推到番茄失败：' + r.error }); }
          })
          .catch((e) => { nameExpPushJobs.set(slug, { status: 'error', error: e.message, msg: e.message }); pushLog(slug, { level: 'error', source: 'nameexp', msg: '推到番茄异常：' + e.message }); });
        return json(res, 200, { ok: true, started: true, count: items.length, autoSubmit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/push-name-experiment-status') {   // 轮询「推到番茄」进度
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = nameExpPushJobs.get(book.slug) || { status: 'idle' };
        return json(res, 200, { ok: true, ...j });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/exp-cover-save') {   // 存 UI 合成好的【带书名】封面到 experiment/NN.titled.png（推番茄用）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { ok: false, error: '找不到书' });
        const file = path.basename(String(body.file || ''));   // 只取文件名防穿越
        if (!/^[\w.-]+\.titled\.png$/.test(file)) return json(res, 400, { ok: false, error: '文件名不合法（应为 NN.titled.png）' });
        const m = String(body.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
        if (!m) return json(res, 400, { ok: false, error: 'dataUrl 不是 png' });
        const dir = path.join(book.dir, 'experiment'); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), Buffer.from(m[1], 'base64'));
        return json(res, 200, { ok: true, file });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/config/update') {   // 保存设置（如 Gemini key / API 模型 key / 代理）
      try {
        const patch = stripMaskedKeys(body.patch || {});   // 去掉 UI 回传的 '***已设置***' 占位，避免把真 key 覆盖没
        const next = updateConfig(patch);
        return json(res, 200, { ok: true, config: maskConfig(next) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/set-style') {
      try { const b = setBookStyle(body.book, body.style); return json(res, 200, { ok: true, style: b.style }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/finale-check') {
      // 这本书【真的写完了吗】——只看落盘产物，不问模型，也不看 status。
      // 用处：已经被错标成「已完本」的书（如大乾女帝：标着完本、没有尾声、结尾是悬念），
      // 在这里能一眼看出差什么；也给 UI 在标完本前做预检。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const art = finaleArtifacts(book);
        return json(res, 200, { ok: true, status: book.status || '连载中', finished: art.ok, items: art.items, missing: art.missing, summary: finaleSummary(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/set-category') {
      // 作者自己改番茄频道/主分类。改过的标 by:'user'，之后 AI 不再覆盖。
      try { const b = setBookCategory(body.book, { channel: body.channel, mainCategory: body.mainCategory, by: 'user' }); return json(res, 200, { ok: true, category: b.category }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/set-romance') {   // 设定该书感情线档位（none|light|warm|bold），改完当场刷新写作规范
      try { const b = setBookRomance(body.book, body.romance); return json(res, 200, { ok: true, romance: b.romance }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/analyze-style') {
      // 对标书风格学习 → {name, rules} 文风指南（不落库，前端展示/可编辑后再 set-style 保存）。
      // 来源：body.sample=贴的文本；body.bookUrl / body.bookUrls[] / body.multi=番茄链接(Unzoo截图+claude视觉，可多本融合)。
      try {
        let prof;
        const urls = Array.isArray(body.bookUrls) ? body.bookUrls.map(u => String(u || '').trim()).filter(Boolean) : [];
        if (body.multi || urls.length || body.bookUrl) {
          const slug = slugOf(body.book || '');
          prof = await styleFromFanqieUrl({ profilePath: body.profilePath, bookUrl: body.bookUrl, bookUrls: urls, multi: !!body.multi, model: body.model, onLog: (e) => { try { pushLog(slug, { source: 'refstyle', ...e }); } catch {} } }, cfg);
        } else {
          prof = await analyzeStyleSample({ sample: body.sample, model: body.model }, cfg);
        }
        return json(res, 200, { ok: true, name: prof.name, rules: prof.rules });
      } catch (e) { return json(res, 400, { error: e.message, raw: e.raw || '' }); }
    }
    if (p === '/api/book/propose-titles') {
      try { const titles = await proposeTitles(body, cfg); return json(res, 200, { ok: true, titles }); }
      catch (e) { return json(res, 500, { error: e.message, raw: e.raw }); }
    }
    if (p === '/api/book/launch') {
      // AI 立项：建书 → 全卷大纲都搭好再开写
      let book;
      // 文风：'auto'/空 → 让 AI 据题材推荐
      let styleInput = body.style;
      if (styleInput === 'auto' || !styleInput) {
        try { styleInput = await recommendStyle({ theme: body.theme || body.genre, model: body.model || cfg.defaultModel }, cfg); }
        catch { styleInput = null; }
      }
      // 探索式(freehand)：只给写作手法、全书不出任何大纲，剧情由作者逐段给。必须在建书前定下来——
      // scaffold 要据它决定 bible 模板、是否铺卷01大纲模板、AGENTS.md 里的大纲闸。
      const freehand = body.freehand === true || body.discovery === true || body.planMode === 'discovery' || body.planMode === 'freehand';
      try { book = createBook({ title: body.title, genre: body.theme || body.genre, model: body.model, totalWords: body.words, volumes: body.volumes || '', style: styleInput, planMode: freehand ? 'freehand' : 'compass', romance: body.romance }, cfg); }
      catch (e) { return json(res, 400, { error: e.message }); }
      // 【建书时就把文风定下来】作者在立项弹窗里挑中的那段开头，落成本书第一份范本 + 手法卡。
      // 为什么非在这一步不可：没有范本时模型默认往书面语走（实测无范本 36.1 字/段，
      // 网文范本是 16.2，且整章用半角逗号）——那正是"写出来像记叙文"的来源。
      // 等作者写完几章再回头挂范本就晚了：前面几章已经定了调，后面还得向它们看齐。
      if (body.voiceRef && body.voiceRef.text) {
        try {
          await adoptCandidate(book, body.voiceRef, { model: body.model || book.model || cfg.defaultModel, cfg,
            onLog: (e) => pushLog(book.slug, { ...e, source: 'voice' }) });
          pushLog(book.slug, { level: 'act', source: 'voice', msg: `🖋️ 文风已锚定：《${body.voiceRef.name || '样章'}》已成为本书范本，全书向它看齐` });
        } catch (e) { pushLog(book.slug, { level: 'warn', source: 'voice', msg: '文风范本落盘失败：' + e.message }); }
      }
      // 【番茄主分类在这一步就定下来】原来它只活在发布弹窗那个下拉的默认值里——永远是第一项
      // 「历史脑洞」，作者不手动改就那样建到番茄上，而页面自己写着【主分类签约后不可改】。
      // 题材那句话现在就有，没道理等到发书那天再猜。后台跑，不挡立项（推断失败也只是少个建议）。
      (async () => {
        try {
          const c = await recommendCategory({ theme: body.theme || body.genre, title: body.title, model: body.model || cfg.defaultModel }, cfg);
          if (c.undecided || !c.mainCategory) {
            pushLog(book.slug, { level: 'warn', source: 'category', msg: '没能从题材判断番茄主分类 → 发书前请自己在发布弹窗里挑一个（主分类签约后不可改）' });
            return;
          }
          setBookCategory(book.slug, { channel: c.channel, mainCategory: c.mainCategory, by: 'ai', reason: c.reason });
          pushLog(book.slug, { level: 'act', source: 'category', msg: `🏷️ 番茄分类建议：${c.channel} · ${c.mainCategory}${c.reason ? '（' + c.reason + '）' : ''} —— 发书时自动带入，可改` });
          // 分类定了，接着把【阅读标签/内容标签】也选好——它们决定番茄怎么分发这本书，
          // 而原来建书时那两个框是空的，作者事后才发现要一个个手点。
          try {
            const t = await recommendFanqieTags({ theme: body.theme || body.genre, title: body.title, channel: c.channel, mainCategory: c.mainCategory, model: body.model || cfg.defaultModel }, cfg);
            if (t.parseFailed) {
              pushLog(book.slug, { level: 'warn', source: 'category', msg: `番茄标签没选成（模型输出解析不了）→ 建书时可在发布弹窗里自己挑，或事后在番茄补` });
            } else {
              setBookTags(book.slug, t, { channel: c.channel, by: 'ai' });
              const flat = [...Object.values(t.阅读标签).flat(), ...Object.values(t.内容标签).flat()];
              pushLog(book.slug, { level: 'act', source: 'category', msg: `🏷️ 番茄标签已选 ${flat.length} 个：${flat.join('、') || '（一个都没选中——题材太特别时会这样，可自己补）'}` });
              if (t.dropped.length) pushLog(book.slug, { level: 'warn', source: 'category', msg: `以下是模型自造/跨栏的，已丢弃：${t.dropped.join('、')}` });
            }
          } catch (e) { pushLog(book.slug, { level: 'warn', source: 'category', msg: '番茄标签推断失败：' + e.message + '（不影响写作）' }); }
        } catch (e) { pushLog(book.slug, { level: 'warn', source: 'category', msg: '番茄分类推断失败：' + e.message + '（发书时自己挑即可）' }); }
      })();
      // 立项时选择参与度；startWriting 会据 book.writeMode/reviewEvery 播种运行时审核开关
      if (body.participation != null) {
        try { setParticipation(book.slug, body.participation); } catch {}
      } else if (body.writeMode != null) {
        const mode = body.writeMode === 'review' ? 'review' : 'auto';
        const every = mode === 'review' ? Math.max(1, Math.floor(Number(body.reviewEvery) || 1)) : 0;
        try { setBookWriteMode(book.slug, mode, every || 1); } catch {}
      }
      // 网页版模型不能跑 CLI 立项（建 bible+大纲需要 agentic 本地 CLI）→ 用一个可用的本地 CLI 跑【只规划】的立项，
      // 正文之后由网页版引擎续写（book.model 仍是网页版模型，写作台点▶即走 web-write）。
      const isWebModel = getModel(body.model)?.kind === 'web';
      let launchModel = body.model || book.model || cfg.defaultModel;
      if (isWebModel) {
        launchModel = resolveGenModel(body.model);
        if (!launchModel) {
          pushLog(book.slug, { level: 'error', msg: '网页版模型不能跑 AI 立项，且未检测到可用的本地 CLI' });
          return json(res, 400, { error: '网页版模型不能跑 AI 立项（建 设定+大纲 需要本地 CLI）。请先装一个 CLI（qwen/gemini/codex），或用「手动创建」建书后直接用网页版写作。' });
        }
        pushLog(book.slug, { level: 'act', msg: `网页版模型立项：用本地 ${launchModel} 只搭 设定+大纲（不写正文），正文随后用网页版续写` });
      }
      // 探索式：立项只定"怎么写"（写作手法+主角名+故事概述），不出罗盘、不出任何大纲。否则走共创版粗罗盘立项。
      try { setBookPlanMode(book.slug, freehand ? 'freehand' : 'compass'); } catch {}
      const instruction = freehand
        ? buildFreehandKickoffInstruction(book, body.theme || body.genre, body.words, body.characters)
        : buildCompassKickoffInstruction(book, body.theme || body.genre, body.words, body.volumes, body.characters);
      if (freehand) pushLog(book.slug, { level: 'info', msg: '🌱 探索式立项：圣经只写【写作手法 + 主角名 + 故事概述】，不出全书大纲、不出卷大纲——剧情你一段一段给，AI 自拆 3–5 章' });
      // 【别清日志】旧重写端点每次开窗都清空，改造流水线跑起来之后这等于把自己的质检记录抹掉——
  // 2026-09-20 实测：第二轮一开窗，第一轮的质检结论就在界面上消失了，只能去翻落盘的报告。
  // 一次性重写仍然清（作者要看干净的进度）；流水线调用时传 keepLogs。
  if (!body.keepLogs) rtOf(book.slug).logs = [];
      try {
        const session = await startWriting({ book, model: launchModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, book: { ...book, stats: { chapters: 0, kb: 0 }, tokens: 0 }, instance: session.instance.id, pane: session.paneId, planOnly: isWebModel });
      } catch (e) { pushLog(book.slug, { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review') {
      const book = getBook(body.book);
      if (!book) return json(res, 400, { error: '找不到书：' + body.book });
      const instruction = buildReviewInstruction(book, body.range, body.dims, body.note);
      // 复检会【就地改正文】（逻辑硬伤直接改、文风直接润色），和重写/AI改名/删章一样是不可逆的，
      // 却一直没有存档点——《金丹》那本实证：一次全书复检把 103 章全改了一遍，而 chapters/ 从来没被
      // git 收过（初始提交发生在导入之前），36 万字改完没有任何东西可回退。gitSnapshot 走的是 add -A，
      // 开窗前调一次就把 chapters/ 一并收进去。
      try {
        const h = gitSnapshot(book.dir, `复检前存档：${body.range || '全书'}`);
        if (h) pushLog(book.slug, { level: 'info', msg: `已 git 存档：${h}（复检会就地改正文，不满意可回退到这里）` });
      } catch {}
      const running = listSessions().some(s => s.slug === book.slug);
      try {
        if (running) {
          // 已在写 → 穿插一条复检指令（排在当前批之后）
          const r = await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: `已穿插复检指令（范围 ${body.range || '全书'}）` });
          return json(res, 200, { ok: true, mode: 'inserted', ...r });
        }
        // 未在写 → 开一个会话专门做复检
        // ⚠️ 这行清空日志【在存档之后】，会把上面那句"已 git 存档：xxxxx"一起冲掉——
        // 存档明明成功了，界面上却一个字都看不到，作者以为没存（实测 cd3054e 那次就是这样）。
        // 清空是为了让新一轮的日志从头开始，那就清完再把存档那句补回去。
        const snapMsg = (rtOf(book.slug).logs || []).find(e => String(e.msg || '').startsWith('已 git 存档：'));
        rtOf(book.slug).logs = [];
        if (snapMsg) pushLog(book.slug, snapMsg);
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, mode: 'started', instance: session.instance.id, pane: session.paneId });
      } catch (e) { pushLog(book.slug, { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review-outline') {
      // 手动触发大纲审稿：换一个模型无头审指定范围(默认立项/全书；可传 scope='卷02')，写 reviews/大纲审稿-xxx.md。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const scope = body.scope || '立项';
        const r = await reviewOutline({ book, scope, cfg, authorModel: body.model || book.model || cfg.defaultModel, onLog: (e) => pushLog(book.slug, e) });
        try { snapshotOutline(book, scope); } catch {}   // 拍快照，供作者修订后核对
        // 若该书正在写作 → 顺手把修订指令穿插给作者
        if (body.inject && sessionLive(book.slug)) {
          const { buildReviseInstruction } = await import('./editor.mjs');
          try { await injectToBook(book.slug, buildReviseInstruction(book, scope, r.file), cfg); } catch {}
        }
        return json(res, 200, { ok: true, scope, editorModel: r.editorModel, file: path.basename(r.file), critique: r.critique });
      } catch (e) { pushLog(slugOf(body.book), { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/finale') {
      // 手动进入/退出收尾。on!==false=进入收尾(收束令冲刺)；on===false=退回连载中。进入且在写作时即刻穿插收束令。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const on = body.on !== false;
        const b = setBookStatus(book.slug, on ? '收尾中' : '连载中');
        if (on && sessionLive(book.slug)) {
          try { await injectToBook(book.slug, buildFinaleInstruction(book, { first: true }), cfg); pushLog(book.slug, { level: 'act', msg: '已进入收尾 → 穿插收束令' }); } catch {}
        }
        return json(res, 200, { ok: true, status: b.status, live: sessionLive(book.slug) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/ai-rename') {
      // AI 上下文改名：先 git 存档，再让 AI 通读全书、辨认角色所有叫法后一致改、不误伤、不写正文(confirmOnly)。有会话穿插，没会话开窗。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const from = String(body.from || '').trim(), to = String(body.to || '').trim();
        if (!from || !to) return json(res, 400, { error: '原名和新名都要填' });
        try { gitSnapshot(book.dir, `AI改名前存档：${from}→${to}`); } catch {}
        const instruction = buildRenameInstruction(book, from, to);
        if (sessionLive(book.slug)) {
          await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: `已让 AI 上下文改名：${from}→${to}（辨认所有叫法、不误伤、不写正文）` });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        return json(res, 200, { ok: true, mode: 'opened', instanceId: session.instance?.id });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rename-entity') {
      // 改名一键波及全书：角色名/地名/称呼 → 替换 设定+大纲+台账+索引+所有已写章节。preview 只统计。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const from = String(body.from || '').trim();
        if (!from) return json(res, 400, { error: '先填要改的原名' });
        if (body.preview) {
          const r = renameEntity(book.slug, from, body.to || '', true);
          return json(res, 200, { ok: true, preview: true, files: r.files, count: r.count });
        }
        const to = String(body.to || '').trim();
        if (!to) return json(res, 400, { error: '先填新名' });
        try { gitSnapshot(book.dir, `改名前存档：${from}→${to}`); } catch {}
        const r = renameEntity(book.slug, from, to, false);
        pushLog(book.slug, { level: 'act', msg: `已把「${from}」全书替换成「${to}」：${r.files} 个文件、${r.count} 处（含已写章节+大纲+设定；不满意可 git 回退）` });
        return json(res, 200, { ok: true, files: r.files, count: r.count });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/plan-volume') {
      // 本卷共创：让 AI 据【全书罗盘该卷走向 + 设定 + 上一卷卷末】拟这一卷的章级大纲草案，返回文本供作者审改（不落盘）。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        if (book.planMode === 'freehand') return json(res, 400, { error: '本书是【探索式】：全书不建任何大纲。请在「🤝 我来主笔」里一段一段给情节，AI 会据每段自拆 3–5 章。' });
        const volNum = Math.max(1, parseInt(body.volume, 10) || 1);
        let bibleBrief = '', compass = '', prevEnding = '';
        try { bibleBrief = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8').slice(0, 4000); } catch {}
        try {
          const od = path.join(book.dir, 'outlines');
          const cf = fs.readdirSync(od).find(f => /罗盘/.test(f));
          if (cf) compass = fs.readFileSync(path.join(od, cf), 'utf8').slice(0, 6000);
        } catch {}
        try {
          const cdir = path.join(book.dir, 'chapters'); const files = [];
          (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, e.name); if (e.isDirectory()) walk(p2); else if (/\.txt$/i.test(e.name)) files.push(p2); } })(cdir);
          files.sort((a, b) => (parseInt(path.basename(a)) || 0) - (parseInt(path.basename(b)) || 0));
          const last = files[files.length - 1]; if (last) prevEnding = fs.readFileSync(last, 'utf8').slice(-1200);
        } catch {}
        let cpv = 0; try { cpv = chaptersPerVol(book); } catch {}
        const authorDirection = String(body.direction || '').trim();   // 作者给的本卷走向（探索式主导架构；罗盘式可留空）
        const prompt = buildVolumePlanPrompt(book, volNum, { bibleBrief, compass, prevEnding, cpv, authorDirection });
        const model = resolveGenModel(body.model || book.model || cfg.defaultModel) || body.model || book.model || cfg.defaultModel;
        pushLog(book.slug, { level: 'act', msg: `本卷共创：AI 正在据罗盘拟【第 ${volNum} 卷】章级大纲草案…`, source: 'cowrite' });
        // 慢环境实测：一卷章级大纲约 231s，卡在旧的 240s 上限边缘→动辄超时"拟稿失败"。给到 600s 留足余量。
        const raw = runModelOnce(model, prompt, cfg, 600000) || '';
        const clean = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
        if (clean.length < 40) return json(res, 500, { error: 'AI 拟稿太短，请重试或换模型' });
        const rel = `outlines/卷${String(volNum).padStart(2, '0')}分章大纲.md`;
        return json(res, 200, { ok: true, volume: volNum, draft: clean, rel });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/revise-setting') {
      // 创作台：按作者大白话改【设定/角色】或【某卷大纲】，AI 只改对应文件、不写新正文。有会话穿插，没会话开窗。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const ask = String(body.instruction || '').trim();
        if (ask.length < 2) return json(res, 400, { error: '先用一句话说说你想怎么改' });
        const target = body.target === 'outline' ? 'outline' : 'bible';
        const instruction = buildReviseSettingInstruction(book, { target, scope: body.scope, instruction: ask });
        if (sessionLive(book.slug)) {
          await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: `已让 AI 按你的话改${target === 'outline' ? '大纲' : '设定/角色'}（不写新正文）` });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        return json(res, 200, { ok: true, mode: 'opened', instanceId: session.instance?.id });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rebuild-outline2') {
      // 【给已有大量正文的书重建大纲】分层归纳，不是"通读全书"。
      // 老的 rebuild-outline 指令第一步写着「通读 chapters/ 下所有已写章节」——
      // 《大乾女帝》523 章 145 万字，这件事做不到，所以它只能读个开头往下编。
      // 落盘证据：那本书 523 章，outlines/ 里只有一个 卷01分章大纲.md。
      // 现在：逐章摘要（可断点续、可增量）→ 按卷据摘要生成分章大纲。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const slug = book.slug;
        if (rtOf(slug).outlineRun && !rtOf(slug).outlineRun.stopped) return json(res, 200, { ok: true, already: true });
        const control = { stopped: false };
        rtOf(slug).outlineRun = control;
        const model = body.model || pickEditorModel(book.model || cfg.defaultModel, cfg);
        const onLog = (e) => pushLog(slug, { ...e, source: 'outline' });
        (async () => {
          try {
            pushLog(slug, { level: 'act', source: 'outline', msg: `开始重建大纲（用 ${model}）——先做逐章梗概，再按卷生成分章大纲。中途可停，已完成的会留下。` });
            await buildAllDigests(book, { model, cfg, onLog, control });
            if (!control.stopped) await rebuildVolumeOutlines(book, { model, cfg, onLog, control, only: body.volume || null });
            pushLog(slug, { level: 'act', source: 'outline', msg: control.stopped ? '大纲重建已停止（进度已保留）' : '✅ 大纲重建完成' });
          } catch (e) { pushLog(slug, { level: 'error', source: 'outline', msg: '大纲重建失败：' + e.message }); }
          finally { const st = rt.get(slug); if (st) st.outlineRun = null; }
        })();
        return json(res, 200, { ok: true, started: true, model, ...digestProgress(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/sign-diagnose') {
      // 签约诊断：番茄签约进度 + 定时乱序 + 客观指标 + 编辑视角评估 → 修改清单。只读。
      // 由来：王莽第二次签约被拒，拒信只有一句"质量暂未达到签约标准"。见 signrun.mjs。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        if (!book.publish?.bookId) return json(res, 400, { error: '这本书还没绑定番茄作品——先在发布设置里选账号和书' });
        const slug = book.slug;
        if (rtOf(slug).signRun) return json(res, 200, { ok: true, already: true });
        rtOf(slug).signRun = true;
        const onLog = (e) => pushLog(slug, { ...e, source: 'sign' });
        (async () => {
          try { await diagnoseSigning(book, { cfg, onLog }); }
          catch (e) { pushLog(slug, { level: 'error', source: 'sign', msg: '签约诊断失败：' + e.message }); }
          finally { const st = rt.get(slug); if (st) st.signRun = false; }
        })();
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rebuild-outline-stop') {
      try {
        const slug = slugOf(body.book);
        const c = rtOf(slug).outlineRun;
        if (c) { c.stopped = true; pushLog(slug, { level: 'warn', source: 'outline', msg: '已请求停止大纲重建——当前这一批跑完就停，已完成的梗概不会丢' }); }
        return json(res, 200, { ok: true, stopping: !!c });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rebuild-outline') {
      // 重建设定圣经+大纲（不写新正文）：导入/半成品书据已写正文逆向重建规划。有会话穿插，没会话开窗。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const instruction = buildRebuildOutlineInstruction(book);
        if (sessionLive(book.slug)) {
          await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已穿插指令：重建设定圣经 + 各卷大纲（不写新正文）' });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        return json(res, 200, { ok: true, mode: 'opened', instanceId: session.instance?.id });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/afterword') {
      // 手动让作者补写一章《完本感言 / 作者的话》（或简短尾声）——并非每本书完本时都自动写了，
      // 故给个手动入口：有写作会话就穿插这条指令，没会话就开窗注入。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const instruction = buildAfterwordInstruction(book);
        if (sessionLive(book.slug)) {
          await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已穿插指令：写《完本感言 / 尾声》' });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: true });
        return json(res, 200, { ok: true, mode: 'opened', instanceId: session.instance?.id });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review-ending') {
      // 手动跑一次完本审稿(不改状态)，看这本书是否已可完结。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const r = await reviewEnding({ book, cfg, authorModel: body.model || book.model || cfg.defaultModel, onLog: (e) => pushLog(book.slug, e) });
        return json(res, 200, { ok: true, pass: r.pass, editorModel: r.editorModel, file: path.basename(r.file), critique: r.body });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/status') {
      // 直接改状态：连载中 / 收尾中 / 已完本（手动收尾或撤销完本）。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const b = setBookStatus(book.slug, body.status);
        return json(res, 200, { ok: true, status: b.status });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/outline-reviews') {
      // 列出这本书 reviews/ 下【已有的大纲审稿报告】，好让作者随时拿来改大纲。
      // 为什么需要：审稿门的"逐条挑"只在【卷边界那一刻】存在，而那个待挑状态在内存里——
      // 引擎一重启就没了（2026-09-15 实证：王莽卷02 的报告好好躺在硬盘上，30KB，却没有入口能用它）。
      // 报告是文件，早就落盘了，没道理只有一次机会。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const dir = path.join(book.dir, 'reviews');
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => /^大纲审稿-.*\.md$/.test(f)); } catch {}
        const out = files.map(f => {
          const full = path.join(dir, f);
          let items = 0, verdict = '';
          try {
            const txt = fs.readFileSync(full, 'utf8');
            items = parseReviewItems(critiqueOf(txt)).length;
            const vm = txt.match(/【总评】\s*(.+)/);
            verdict = vm ? vm[1].trim().slice(0, 120) : '';
          } catch {}
          let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
          return { file: f, scope: (f.match(/^大纲审稿-(.+)\.md$/) || [])[1] || '', items, verdict, mtime };
        }).sort((a, b) => b.mtime - a.mtime);
        return json(res, 200, { ok: true, reviews: out });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/outline-review-load') {
      // 把一份【已有的】审稿报告重新摆回"待逐条挑"的状态：拆条 → setPending。
      // 之后就完全复用原来那套 UI 与 /api/book/review-decision，不另造一条流程。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const name = path.basename(String(body.file || ''));
        if (!/^大纲审稿-.*\.md$/.test(name)) return json(res, 400, { error: '只能加载 reviews/ 下的大纲审稿报告' });
        const full = path.join(book.dir, 'reviews', name);
        let txt = '';
        try { txt = fs.readFileSync(full, 'utf8'); } catch { return json(res, 400, { error: '读不到这份报告：' + name }); }
        const seenTxt = new Set();
        const items = parseReviewItems(critiqueOf(txt))
          .filter(x => { const k = x.text.trim(); if (seenTxt.has(k)) return false; seenTxt.add(k); return true; })
          .map((x, i) => ({ ...x, id: 'r' + i }));
        if (!items.length) return json(res, 400, { error: '这份报告里没解析出可挑的条目（格式可能不是【硬伤】/【隐患】/【建议】那种）' });
        const scope = (name.match(/^大纲审稿-(.+)\.md$/) || [])[1] || '全书';
        setPending(book.slug, { kind: 'outline', scope, file: full, critique: txt.slice(0, 6000), items });
        pushLog(book.slug, { level: 'act', source: 'editor', kind: 'pending-review', scope, file: name,
          msg: `⏸ 已载入《${name}》：${items.length} 条意见待你逐条挑（挑完自动改大纲）` });
        return json(res, 200, { ok: true, scope, file: name, items });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review-decision') {
      // 全局确认门的裁决：apply=true 应用审稿(作者据意见修订大纲)；否则跳过(不改，继续)。清除待确认 → autopilot 恢复。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const pend = getPending(book.slug);
        if (!pend) return json(res, 200, { ok: true, none: true });
        let instr;
        if (Array.isArray(body.items)) {
          // 逐条挑：只按用户选中的（可能手改过的）意见修订
          const picked = body.items.map(i => ({ text: String((i && (i.text ?? i)) || '').trim() })).filter(i => i.text);
          if (picked.length) {
            try { snapshotOutline(book, pend.scope); } catch {}
            instr = buildReviseFromItems(book, pend.scope, picked);
            pushLog(book.slug, { level: 'act', msg: `已挑定 ${picked.length} 条审稿意见（${pend.scope}）→ 作者只按这几条修订大纲` });
          } else {
            instr = `本次不采纳任何审稿意见、不修改大纲，请按既有大纲继续写【${pend.scope}】范围的正文。`;
            pushLog(book.slug, { level: 'act', msg: `未选任何意见（${pend.scope}）→ 不改大纲，继续` });
          }
        } else if (body.apply) {
          try { snapshotOutline(book, pend.scope); } catch {}
          instr = buildReviseInstruction(book, pend.scope, pend.file);
          pushLog(book.slug, { level: 'act', msg: `已采纳全部审稿意见（${pend.scope}）→ 作者据此修订大纲` });
        } else {
          instr = `本次不采纳主编审稿意见、不修改大纲，请按既有大纲继续写【${pend.scope}】范围的正文。`;
          pushLog(book.slug, { level: 'act', msg: `已跳过审稿意见（${pend.scope}）→ 不改大纲，继续` });
        }
        clearPending(book.slug);
        if (sessionLive(book.slug)) {
          try { await injectToBook(book.slug, instr, cfg); } catch {}
        } else {
          // 无状态模式没有长驻会话：把修订指令存为 resume，重启无状态循环 → 到卷口自动应用并接着写
          setResume(book.slug, instr);
          const smodel = book.model || cfg.defaultModel;
          const untilTarget = (book.targetChapters || 0) > 0;
          try { startStatelessRun(book, { model: smodel, batches: book.standards?.batchSize || 3, untilTarget, cfg }); pushLog(book.slug, { level: 'act', msg: '▶ 已按你的选择恢复写作（无状态）' }); }
          catch (e) { pushLog(book.slug, { level: 'warn', msg: '恢复写作失败：' + e.message }); }
        }
        return json(res, 200, { ok: true, applied: !!body.apply });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review-mode') {
      // 写作模式开关（提前/运行中均可）：mode='review' 逐批审核(半自动) | 'auto' 全自动。
      // 既持久化进 book(下次默认值/重启恢复)，又热更新运行时开关(立即生效，无需重开窗口)。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const mode = body.mode === 'review' ? 'review' : 'auto';
        const every = mode === 'review' ? Math.max(1, Math.floor(Number(body.reviewEvery) || 1)) : 0;
        setBookWriteMode(book.slug, mode, every || 1);
        setReviewEvery(book.slug, every);
        // 切回全自动时，若正卡在"逐批审核"暂停 → 放行让它自动续写下去
        const pend = getPending(book.slug);
        if (mode === 'auto' && pend && pend.kind === 'batch-review') {
          setResume(book.slug, getReviewDefault(book.slug) || cfg.autopilot?.continueText || '继续');
          clearPending(book.slug);
        }
        pushLog(book.slug, { level: 'act', msg: mode === 'review' ? `已切到【逐批审核】模式：每写 ${every} 批停下等你审核` : '已切到【全自动】模式：连续写作不再停顿' });
        return json(res, 200, { ok: true, writeMode: mode, reviewEvery: every });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/participation') {
      // 参与度开关（提前/运行中均可，立即生效）：auto 放手写 · 全自动 | volume 卷口把关 | chapter 盯着写
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const level = ['auto', 'volume', 'chapter'].includes(body.level) ? body.level : 'volume';
        setParticipation(book.slug, level);
        setReviewEvery(book.slug, level === 'chapter' ? 1 : 0);
        const label = { auto: '放手写 · 全自动', volume: '卷口把关 · 开新卷时停下让你定大纲', chapter: '盯着写 · 每批写完你先过' }[level];
        // 放宽参与度时，若正卡在某个门上 → 顺势放行，别把书晾着
        const pend = getPending(book.slug);
        if (pend && pend.kind === 'batch-review' && level !== 'chapter') {
          setResume(book.slug, getReviewDefault(book.slug) || cfg.autopilot?.continueText || '继续');
          clearPending(book.slug);
        } else if (pend && pend.kind === 'outline' && level === 'auto') {
          try { snapshotOutline(book, pend.scope); } catch {}
          if (sessionLive(book.slug)) { try { await injectToBook(book.slug, buildReviseInstruction(book, pend.scope, pend.file), cfg); } catch {} }
          clearPending(book.slug);
        }
        pushLog(book.slug, { level: 'act', msg: `已切到【${label}】` });
        return json(res, 200, { ok: true, participation: level });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review-continue') {
      // 逐批审核裁决：approve 批准继续(可附带本批要求) | stop 写完即停。清待确认 → autopilot 注入下一批。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const pend = getPending(book.slug);
        if (!pend || pend.kind !== 'batch-review') return json(res, 200, { ok: true, none: true });
        if (body.stop) {
          // 停止：清掉审核暂停，按既有"优雅停止"流程（写完当前态即关窗）
          clearPending(book.slug);
          const st = rt.get(book.slug); const ap = st?.session?.autopilot;
          if (ap && ap.running && !ap.draining) {
            ap.drain(() => { try { stopBook(book.slug); } catch {} const s = rt.get(book.slug); if (s?.streamer) s.streamer.stop(); if (s?.session?.autopilot) s.session.autopilot.stop('用户停止'); rt.delete(book.slug); broadcast(book.slug, 'stopped', { graceful: true }); });
          } else { try { stopBook(book.slug); } catch {} if (ap) ap.stop('用户停止'); rt.delete(book.slug); }
          pushLog(book.slug, { level: 'act', msg: '审核中选择【停止】→ 不再续写，关闭窗口' });
          return json(res, 200, { ok: true, stopped: true });
        }
        // 批准并继续：默认续写文案 +（可选）本批额外要求
        const base = getReviewDefault(book.slug) || cfg.autopilot?.continueText || '继续';
        const req = String(body.requirements || '').replace(/[\r\n]+/g, ' ').trim();
        const text = req
          ? `先严格执行我对下一批的【额外要求】：${req}。在满足该要求的前提下，${base}`
          : base;
        setResume(book.slug, text);
        clearPending(book.slug);   // autopilot 的恢复门据此注入 text 并推进批次号
        pushLog(book.slug, { level: 'act', msg: req ? `已批准并下达本批要求 → 继续：${req}` : '已批准 → 继续写下一批' });
        return json(res, 200, { ok: true, requirements: req });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/unzoo/profiles') {   // 列出 Unzoo 账号(权威路径)+已开番茄页，供发布账号下拉
      try { return json(res, 200, await listUnzooProfiles()); }
      catch (e) { return json(res, 200, { ok: false, error: e.message, profiles: [] }); }
    }
    if (p === '/api/fanqie/books') {   // 列出某番茄账号下全部书籍(title+bookId)，供"从番茄选书"
      try {
        const profilePath = body.profilePath;
        if (!profilePath) return json(res, 400, { ok: false, error: '缺少 profilePath' });
        const slug = body.book ? (getBook(body.book)?.slug) : null;
        const r = await getFanqieBooks({ profilePath, onLog: (e) => slug && pushLog(slug, { ...e, source: 'fanqie' }) });
        return json(res, 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message, books: [] }); }
    }
    if (p === '/api/fanqie/import-preview') {   // 从番茄导入前的只读预览：多少卷/多少章
      try {
        if (!body.profilePath || !body.bookId) return json(res, 400, { ok: false, error: '缺少 profilePath/bookId' });
        const r = await previewFanqieImport({ profilePath: body.profilePath, bookId: body.bookId });
        return json(res, 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/fanqie/import') {   // 从番茄拉整本到本地。后台跑，日志推 SSE 频道 __import_<bookId>
      try {
        if (!body.profilePath || !body.bookId) return json(res, 400, { error: '缺少 profilePath/bookId' });
        const logKey = '__import_' + body.bookId;
        const limit = Number(body.limit) || 0;
        rtOf(logKey).logs = [];
        importFromFanqie({ profilePath: body.profilePath, bookId: body.bookId, title: body.title, limit, onLog: (e) => pushLog(logKey, e) })
          .then(r => pushLog(logKey, { level: 'act', source: 'import', msg: `从番茄导入结束：《${r.title}》${r.volumes} 卷 / ${r.chapters} 章` }))
          .catch(e => pushLog(logKey, { level: 'error', source: 'import', msg: '从番茄导入异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, logKey });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/fanqie/volumes') {   // 只读：列出某书在番茄的现有卷（供卷管理 UI 展示）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { ok: false, error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { ok: false, error: '该书未配番茄账号/bookId（先在发布里配好）' });
        const r = await getFanqieVolumes({ profilePath: pc.profilePath, bookId: pc.bookId, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) });
        return json(res, 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/fanqie/update-book-info') {   // 改番茄的书名/简介（作品信息页 → 修改 → 立即修改）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { ok: false, error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { ok: false, error: '该书未配番茄账号/bookId' });
        const r = await updateFanqieBookInfo({
          bookId: pc.bookId, profilePath: pc.profilePath,
          title: body.title || '', intro: body.intro || '', autoSubmit: body.autoSubmit !== false,
          mainCategory: body.mainCategory || '', readTags: body.readTags || null, contentTags: body.contentTags || null,
          onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }),
        });
        // 番茄改成功了，本地也要跟上：简介直接同步，书名只记在发布配置里（本地改名是另一件事，得用改名功能）
        if (r.ok && body.intro) { try { setBookSynopsis(book.slug, body.intro); } catch {} }
        if (r.ok && body.title) { try { setBookPublish(book.slug, { bookName: body.title }); } catch {} }
        if (r.ok && body.mainCategory) { try { setBookCategory(book.slug, { channel: body.channel || '男频', mainCategory: body.mainCategory }); } catch {} }
        return json(res, 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/fanqie/rename-volume') {   // 改番茄卷名（只改副标题，"第N卷："前缀番茄自动加）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { ok: false, error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { ok: false, error: '该书未配番茄账号/bookId' });
        if (!body.newName) return json(res, 400, { ok: false, error: '缺少新卷名' });
        if (!body.num && !body.oldName) return json(res, 400, { ok: false, error: '缺少目标卷（num 或 oldName）' });
        const r = await renameFanqieVolume({
          profilePath: pc.profilePath, bookId: pc.bookId,
          num: body.num, oldName: body.oldName, newName: body.newName,
          onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }),
        });
        return json(res, r.ok ? 200 : 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/book/gen-vol-name') {   // 为某卷生成卷名(AI，从该卷正文/大纲/bible)，写回 bible 卷名清单
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { ok: false, error: '找不到书' });
        const num = parseInt(body.num, 10);
        if (!(num >= 1)) return json(res, 400, { ok: false, error: '卷号无效' });
        const r = await generateVolumeName(book, num, { cfg, force: body.force !== false, onLog: (e) => pushLog(book.slug, { ...e, source: 'volname' }) });
        return json(res, 200, r);
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/book/publish-config') {   // 保存番茄发布配置
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const b = setBookPublish(book.slug, body.publish || {});
        return json(res, 200, { ok: true, publish: b.publish });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/publish-preview') {   // 只读预览：番茄到第几章、将发哪些
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const r = await previewPublish(book, { onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) });
        return json(res, 200, r);
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/publish-stop') {   // 停止发布：请求中断在跑的发布器（下一章前优雅收尾）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const bid = (book.publish || {}).bookId;
        const hit = bid ? stopPublish(bid) : false;
        pushLog(book.slug, { level: 'act', source: 'fanqie', msg: hit ? '⏹ 已请求停止发布（发完当前章即停）' : '当前没有在跑的发布任务' });
        return json(res, 200, { ok: true, stopping: hit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/publish') {   // 真发：后台跑，日志推 SSE。limit 可只发前 N 章(首测)
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const limit = Number(body.limit) || 0;
        publishToFanqie(book, { limit, confirmRewrites: body.confirmRewrites === true, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'fanqie', msg: `番茄发布结束：新发 ${r.published || 0} 章${r.edited ? `、同步重写 ${r.edited} 章` : ''}，状态 ${r.status || '-'}${r.error ? '，错误 ' + r.error : ''}` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'fanqie', msg: '番茄发布异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, limit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/web-write') {   // 网页版写作：后台驱动 通义/ChatGPT/Claude 网页版写小说，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const adapterId = body.adapterId || (book.model || '').replace(/^web-/, '') || 'qwen';
        if (!getAdapter(adapterId)) return json(res, 400, { error: '未知网页适配器：' + adapterId + '（可选 qwen|doubao|chatgpt|claude）' });
        const batches = Math.max(1, Number(body.batches) || 1);
        // profilePath 优先取 body，其次 book.publish.profilePath
        const profilePath = body.profilePath || (book.publish || {}).profilePath || '';
        if (!profilePath) return json(res, 400, { error: '缺少 profilePath（需绑定已登录该聊天站点的 Unzoo 账号）' });
        const busyWeb = writingBusy(book.slug);
        if (busyWeb) return json(res, 409, { error: busyWeb + '，不能同时开始写作' });
        // 后台任务（不 await）也要登记运行态，否则共创那边查不到它、照样能并发写章。
        rtOf(book.slug).bgWrite = { kind: 'web', t: Date.now() };
        runWebWrite({ book, adapterId, batches, profilePath, cfg, onLog: (e) => pushLog(book.slug, { ...e, source: 'web' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'web', msg: `网页版写作结束：共 ${r.batches || 0} 批、新增 ${r.totalWrote || 0} 章` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'web', msg: '网页版写作异常：' + e.message }))
          .finally(() => { rtOf(book.slug).bgWrite = null; });
        return json(res, 200, { ok: true, started: true, adapterId, batches });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/api-write') {   // API 写作：直连智谱/DeepSeek/通义 API 写小说，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const provider = body.provider || (book.model || '').replace(/^api-/, '') || 'zhipu';
        if (!isApiProvider(provider)) return json(res, 400, { error: '未知 API 提供方：' + provider + '（可选 ' + Object.keys(API_PROVIDERS).join('|') + '）' });
        // 本地模型没有 key——改成探服务在不在，缺什么直接说清楚（别让用户点了没反应）。
        if (isKeylessProvider(provider)) {
          const probe = await probeText(cfg.api?.local?.baseUrl || 'http://127.0.0.1:11434/v1');
          if (!probe.ok) return json(res, 400, { error: '本地模型不可用：' + probe.error });
        } else if (!providerConfigured(provider, cfg)) {
          const nm = API_PROVIDERS[provider]?.name || provider;
          return json(res, 400, { error: `未配置 ${nm} 的 API Key。请在「设置 · API 模型」里填入后再写。` });
        }
        const batches = Math.max(1, Number(body.batches) || 1);
        const busyApi = writingBusy(book.slug);
        if (busyApi) return json(res, 409, { error: busyApi + '，不能同时开始写作' });
        rtOf(book.slug).bgWrite = { kind: 'api', t: Date.now() };
        runApiWrite({ book, provider, batches, cfg, onLog: (e) => pushLog(book.slug, { ...e, source: 'api' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'api', msg: `API 写作结束：共 ${r.batches || 0} 批、新增 ${r.totalWrote || 0} 章` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'api', msg: 'API 写作异常：' + e.message }))
          .finally(() => { rtOf(book.slug).bgWrite = null; });
        return json(res, 200, { ok: true, started: true, provider, batches });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/local/health') {   // 本地模型体检：显卡 + 文本服务 + 出图服务 + 按显存的选型建议
      try { return json(res, 200, { ok: true, ...(await localHealth(cfg)) }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/local/probe-image') {   // 单独探出图服务（设置页点「测试连接」用）
      try {
        const backend = body.backend === 'a1111' ? 'a1111' : 'comfy';
        const url = body.baseUrl || (backend === 'a1111' ? 'http://127.0.0.1:7860' : 'http://127.0.0.1:8188');
        return json(res, 200, { ok: true, ...(await probeImage(backend, url)) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/craft-options') {   // 重写弹窗要用的选项：侧重项 + 感情线档位（定义在后端，前端不重复维护一份）
      try {
        return json(res, 200, {
          ok: true,
          slants: Object.entries(STYLE_SLANTS).map(([id, v]) => ({ id, name: v.name, tip: v.tip })),
          romance: ROMANCE_LEVELS.map(r => ({ id: r.id, name: r.name, short: r.short })),
        });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    // —— 文风范本：本书文风的唯一来源 ——
    if (p === '/api/book/voice') {   // 列出本书的范本与手法卡
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, { ok: true, refs: listRefs(book), card: readCard(book), has: hasVoicePrint(book), tones: TONES });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-add') {   // 贴一段文字进来当范本
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        if (!String(body.text || '').trim()) return json(res, 400, { error: '内容是空的' });
        const f = addRef(book, body.name || '范本', body.text);
        return json(res, 200, { ok: true, file: f, refs: listRefs(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-adopt-chapter') {   // 把【已写的某一章】设为范本——书越写越像它自己
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const abs = path.join(book.dir, String(body.rel || ''));
        if (!body.rel || !fs.existsSync(abs)) return json(res, 400, { error: '找不到这一章' });
        const t = fs.readFileSync(abs, 'utf8').trim();
        const name = path.basename(abs).replace(/[.]txt$/i, '');
        const f = addRef(book, '本书-' + name, t);
        return json(res, 200, { ok: true, file: f, refs: listRefs(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-remove') {
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        removeRef(book, body.file);
        return json(res, 200, { ok: true, refs: listRefs(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-card') {   // 让模型读范本、自己总结手法卡
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        await deriveCard(book, { model, cfg });
        return json(res, 200, { ok: true, card: readCard(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-boot') {   // 冷启动：生成几个不同调性的开头供挑选
      try {
        // 【立项时书还没建】——所以允许只传 seed(书名/题材/简介)。
        // 这是"建书时就把文风定下来"的关键：先看到四种腔调，挑一个，再开写。
        const book = body.book ? getBook(body.book) : null;
        if (body.book && !book) return json(res, 400, { error: '找不到书' });
        const seed = book || { title: body.title, genre: body.genre || body.theme, synopsis: body.synopsis };
        if (!seed.title) return json(res, 400, { error: '先填书名，AI 才知道要写什么的开头' });
        const model = body.model || book?.model || cfg.defaultModel;
        const log = (e) => { if (book) pushLog(book.slug, { ...e, source: 'voice' }); };
        const cands = await draftCandidates({ seed, model, cfg, words: Number(body.words) || 700, onLog: log });
        if (!cands.length) return json(res, 500, { error: '四个候选都没生成出来，换个模型再试' });
        return json(res, 200, { ok: true, candidates: cands });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/voice-boot-adopt') {   // 选中某个候选 → 成为本书第一份范本
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        const f = await adoptCandidate(book, body.candidate, { model, cfg,
          onLog: (e) => pushLog(book.slug, { ...e, source: 'voice' }) });
        return json(res, 200, { ok: true, file: f, refs: listRefs(book), card: readCard(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/delete-reviews') {   // 删自检/审稿：它们会被回喂进写作提示词，跑偏的那份必须能清掉
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const rels = Array.isArray(body.rels) ? body.rels : (body.rel ? [body.rel] : []);
        // all:true → 清空整个 reviews/（写完一卷回头清账用）
        const targets = body.all ? listReviews(book).map(x => x.rel) : rels;
        if (!targets.length) return json(res, 400, { error: '没有要删的审稿文件' });
        const r = deleteReviews(book, targets, { onLog: (e) => pushLog(book.slug, { ...e, source: 'delete' }) });
        return json(res, 200, { ok: true, ...r, reviews: listReviews(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/reviews') {          // 列 reviews/ 下全部审稿文件（新的在前）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, { ok: true, reviews: listReviews(book) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/delete-chapters') {   // 删章：逐章把关的工作流里，删掉重来比在旧文上重写干净
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        if (sessionLive(book.slug)) return json(res, 409, { error: '这本书正在写作中，请先停止再删' });
        const rels = Array.isArray(body.rels) ? body.rels : (body.rel ? [body.rel] : []);
        if (!rels.length) return json(res, 400, { error: '没有指定要删的章节' });
        // 两道保险：git 存档 + 各章单独备份到书目录的 .deleted/
        let snapshot = '';
        try { snapshot = gitSnapshot(book.dir, '删除章节前存档') || ''; } catch {}
        const r = deleteChapters(book, rels, { onLog: (e) => pushLog(book.slug, { ...e, source: 'delete' }) });
        pushLog(book.slug, { level: 'act', source: 'delete', msg: `已删 ${r.count} 章（可从 .deleted/ 取回${snapshot ? '，或 git reset 到 ' + snapshot : ''}）` });
        return json(res, 200, { ok: true, ...r, snapshot });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/reflow-chapter') {   // 只重排段落，一个字不改（存量章节多半只是分得太碎）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        if (!isCowriteModel(model)) return json(res, 400, { error: `「${model}」不能用于重排` });
        if (!body.rel) return json(res, 400, { error: '缺少章节路径' });
        const r = await reflowChapter({ book, rel: body.rel, model, cfg,
          onLog: (e) => pushLog(book.slug, { ...e, source: 'reflow' }) });
        return json(res, 200, { ok: true, ...r });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rewrite-chapter') {   // 单章重写（后台跑）：换模型 / 改章名 / 重新指定情节；原文备份为同名 .bak
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        if (!isCowriteModel(model)) return json(res, 400, { error: `「${model}」不能用于重写。可用 claude/codex/gemini/qwen 这类 CLI，或任一 API 模型（含本地 Ollama）。` });
        if (!body.rel) return json(res, 400, { error: '缺少章节路径' });
        const key = book.slug;
        const cur = rewriteJobs.get(key);
        if (cur && cur.status === 'running') {
          return json(res, 200, { ok: true, started: true, already: true, rel: cur.rel, msg: cur.msg });
        }
        rewriteJobs.set(key, { status: 'running', rel: body.rel, model, msg: '准备中…', startedAt: Date.now() });
        const onLog = (e) => { const j = rewriteJobs.get(key); if (j) j.msg = e.msg; pushLog(key, { ...e, source: 'rewrite' }); };
        rewriteChapter({
          book, rel: body.rel, model, note: body.note || '', plot: body.plot || '',
          newTitle: body.newTitle || '', titleMode: body.titleMode || 'keep',
          slant: body.slant || '', romance: body.romance || null,
          polish: body.polish === true, critic: body.critic || '', cfg, onLog,
        })
          .then((r) => {
            rewriteJobs.set(key, { status: 'done', ...r, msg: `第 ${r.num} 章已重写（${r.before} → ${r.words} 字）` });
            pushLog(key, { level: 'act', source: 'rewrite', msg: `✅ 第 ${r.num} 章《${r.title}》重写完成（${r.before} → ${r.words} 字）` });
          })
          .catch((e) => {
            rewriteJobs.set(key, { status: 'error', error: e.message, msg: e.message });
            pushLog(key, { level: 'error', source: 'rewrite', msg: '重写失败：' + e.message });
          });
        return json(res, 200, { ok: true, started: true, rel: body.rel, model });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rewrite-chapter-status') {   // 轮询单章重写进度
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const j = rewriteJobs.get(book.slug);
        if (!j) return json(res, 200, { ok: true, status: 'idle' });
        // 取走结果后清掉，避免下次打开还看到上一次的完成态
        if (j.status === 'done' || j.status === 'error') rewriteJobs.delete(book.slug);
        return json(res, 200, { ok: true, ...j });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/cowrite-idea') {   // 共创模式·出主意：AI 据作者的问题给建议（不落盘，直接返回）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        if (!isCowriteModel(model)) return json(res, 400, { error: '共创模式请用 claude 或 codex（也可 gemini/qwen）。当前模型：' + model });
        if (!String(body.ask || '').trim()) return json(res, 400, { error: '请先写你想问的 / 想让 AI 出主意的点' });
        const r = await brainstorm({ book, model, ask: body.ask, cfg });
        return json(res, 200, { ok: true, ...r });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/cowrite-chapter') {   // 共创模式·写这一章：AI 按作者要求写一章并落盘（直接返回正文）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        if (!isCowriteModel(model)) return json(res, 400, { error: '共创模式请用 claude 或 codex（也可 gemini/qwen），或任一 API 模型（含本地 Ollama）。当前模型：' + model });
        const busy = writingBusy(book.slug);
        if (busy) return json(res, 409, { error: busy + '——两边会抢同一个章号、互相覆盖。请先点「停止」，等它停下来再共创。' });
        // API/本地模型开不了可见窗口 → 走无头模式：同样按作者要求写这一章并落盘，只是没有实时窗口。
        const writeOne = isCowriteWindowModel(model) ? writeChapterInWindow : writeChapterFromIntent;
        rtOf(book.slug).cowriteRun = { kind: 'chapter', t: Date.now() };
        try {
          const r = await writeOne({
            book, model, intent: body.intent, useLastEnding: body.useLastEnding !== false, redoLast: !!body.redoLast, romance: body.romance || null, cfg,
            onLog: (e) => pushLog(book.slug, { ...e, source: 'cowrite' }),
          });
          return json(res, 200, { ok: true, ...r });
        } finally { rtOf(book.slug).cowriteRun = null; }
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/cowrite-batch') {   // 探索式·按作者这一段情节连写：AI 自拆 3–5 章并逐章落盘
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const model = body.model || book.model || cfg.defaultModel;
        if (!isCowriteModel(model)) return json(res, 400, { error: '请用 claude 或 codex（也可 gemini/qwen）。当前模型：' + model });
        const busy = writingBusy(book.slug);
        if (busy) return json(res, 409, { error: busy + '——两边会抢同一个章号、互相覆盖。请先点「停止」，等它停下来再共创。' });
        rtOf(book.slug).cowriteRun = { kind: 'batch', t: Date.now() };
        try {
          const r = await writeChaptersFromPlot({
            book, model, plot: body.plot, useLastEnding: body.useLastEnding !== false, romance: body.romance || null, cfg,
            onLog: (e) => pushLog(book.slug, { ...e, source: 'cowrite' }),
          });
          return json(res, 200, { ok: true, ...r });
        } finally { rtOf(book.slug).cowriteRun = null; }
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/republish') {   // 重发修正：编辑替换 from..to 章（修发错内容）。limit 可只改前 N 章
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const from = Number(body.from) || 1, to = Number(body.to) || 0, limit = Number(body.limit) || 0;
        republishRange(book, { from, to, limit, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'fanqie', msg: `番茄重发结束：编辑 ${r.published || 0}/${r.attempted || 0} 章，状态 ${r.status || '-'}${r.error ? '，错误 ' + r.error : ''}` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'fanqie', msg: '番茄重发异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, from, to, limit });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/completion-report') {   // 完结就绪报告(B)：本地+番茄对账+硬指标清单
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const includeFanqie = body.includeFanqie !== false;
        const r = await getCompletionReport(book, { cfg, includeFanqie, onLog: (e) => pushLog(book.slug, { ...e, source: e.source || 'fanqie' }) });
        if (r.fanqie && r.fanqie.ok) {
          try { setBookFanqieStatus(book.slug, { status: r.fanqie.status, totalWords: r.fanqie.totalWords, lastChapterNum: r.fanqie.lastChapterNum, at: new Date().toISOString() }); } catch {}
        }
        const note = buildCompletionNote(book, r);
        return json(res, 200, { ...r, internalStatus: book.status || '连载中', note });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/finale-closure') {   // 完结终发布闭环(C)：发齐收尾章 + 对账。后台跑，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        runFinaleClosure(book, { cfg, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'fanqie', msg: `完结收口结束：发 ${r.published || 0} 章，就绪=${r.report?.ready ? '是' : '否'}` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'fanqie', msg: '完结收口异常：' + e.message }));
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/locate-completion') {   // 探测番茄"申请完结"入口(D)：只读，不提交。后台跑推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        locateCompletion(book, { onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) })
          .then(r => pushLog(book.slug, { level: r.found ? 'act' : 'warn', source: 'fanqie', msg: `完结入口探测结束：${r.note || r.error || '-'}` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'fanqie', msg: '探测完结入口异常：' + e.message }));
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rewrite' || p === '/api/book/reproject') {
      // 推倒重写：rewrite=范围重写 / reproject=整本重立项。真正的启动逻辑抽到了 startRewrite()，
      // 因为「改造流水线」(overhaul) 每一批都要走同一条路——两处各写一遍迟早会走样。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const r = await startRewrite(book, { ...body, reproject: p === '/api/book/reproject' }, cfg);
        return json(res, r.error ? 400 : 200, r);
      } catch (e) { pushLog(slugOf(body.book), { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    // ===== 改造一本书（救书流水线）=====
    // 诊断 → 分批改 → 指标质检 → 返工 → 阅读复核 → 只发改动章。详见 overhaul.mjs 顶部。
    if (p === '/api/book/diagnose') {   // 通用诊断（不依赖番茄签约页），产出 reviews/改造诊断.md
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const slug = book.slug;
        if (overhaulJobs.get(slug)?.status === 'running') return json(res, 200, { ok: false, error: '这本书正在改造中，先停了再诊断' });
        diagnoseBook(book, { cfg, sample: Number(body.sample) || 20, model: body.model || null, onLog: (e) => pushLog(slug, { ...e, source: 'diagnose' }) })
          .then(r => pushLog(slug, { level: r.ok ? 'act' : 'error', source: 'diagnose', msg: r.ok ? `诊断完成：必办 ${r.must.length} 条` : '诊断失败：' + r.error }))
          .catch(e => pushLog(slug, { level: 'error', source: 'diagnose', msg: '诊断异常：' + e.message }));
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/read-review') {
      // 阅读复核单独可跑：它本来只跟在改造流水线最后，引擎一断（2026-09-20 夜里断过两次）这一步就没了。
      // 而它恰恰是唯一能查出"空钩子/逻辑断/人物失格"的工序——指标闸永远查不出这些。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const slug = book.slug;
        const from = Number(body.from) || 1, to = Number(body.to) || 0;
        readReview(book, from, to, { cfg, model: body.model || null, chunk: Number(body.chunk) || 5, onLog: (e) => pushLog(slug, { ...e, source: 'readreview' }) })
          .then(r => {
            if (!r.ok) return pushLog(slug, { level: 'error', source: 'readreview', msg: '阅读复核失败：' + r.error });
            const fp = writeReadReport(book.dir, r, `${from}-${to || '末'}`);
            pushLog(slug, { level: 'act', source: 'readreview', msg: `阅读复核完成：${r.items.length} 处待处理 → ${path.basename(fp)}` });
          })
          .catch(e => pushLog(slug, { level: 'error', source: 'readreview', msg: '阅读复核异常：' + e.message }));
        return json(res, 200, { ok: true, started: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/apply-read-review') {
      // 按阅读复核的意见定点修：条目从 reviews/阅读复核-*.md 读回（复核与修常常隔着几小时甚至隔天）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const slug = book.slug;
        if (overhaulJobs.get(slug)?.status === 'running') return json(res, 200, { ok: false, error: '这本书正在改造中，先停了再修' });
        let items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) {
          const dir = path.join(book.dir, 'reviews');
          let files = []; try { files = fs.readdirSync(dir).filter(f => /^阅读复核.*\.md$/.test(f)); } catch {}
          files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
          if (!files.length) return json(res, 400, { error: '没有阅读复核报告，先点「让它读一遍挑毛病」' });
          items = parseReadReportFile(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
          pushLog(slug, { level: 'info', source: 'overhaul', msg: `复核意见取自 ${files[0]}（${items.length} 条）` });
        }
        const from = Number(body.from) || 0, to = Number(body.to) || 0;
        if (from || to) items = items.filter(i => (!from || i.num >= from) && (!to || i.num <= to));
        if (!items.length) return json(res, 400, { error: '这个范围里没有复核意见' });
        const job = { status: 'running', stop: false, startedAt: Date.now() };
        overhaulJobs.set(slug, job);
        runReadFix(book, {
          cfg, api: overhaulApi(book, cfg), items,
          batchSize: Number(body.batchSize) || 8,
          shouldStop: () => job.stop,
          onLog: (e) => pushLog(slug, { ...e, source: e.source || 'readfix' }),
        }).then(r => {
          job.status = r.ok ? 'done' : (r.stopped ? 'stopped' : 'error');
          pushLog(slug, { level: r.ok ? 'act' : 'warn', source: 'readfix', msg: r.ok ? '🎉 复核意见已逐批落实' : (r.stopped ? '定点修已停止（进度已保存）' : '定点修中止：' + r.error) });
        }).catch(e => { job.status = 'error'; pushLog(slug, { level: 'error', source: 'readfix', msg: '定点修异常：' + e.message }); });
        return json(res, 200, { ok: true, started: true, items: items.length });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/overhaul/start') {
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const slug = book.slug;
        if (overhaulJobs.get(slug)?.status === 'running') return json(res, 200, { ok: true, already: true, state: getOverhaulState(slug) });
        // 必办清单：优先用刚跑的通用诊断，没有就读签约诊断报告里的 [必改] 行
        let mustFix = Array.isArray(body.mustFix) ? body.mustFix : [];
        if (!mustFix.length) {
          for (const f of ['改造诊断.md', '签约诊断.md']) {
            try {
              const t = fs.readFileSync(path.join(book.dir, 'reviews', f), 'utf8');
              mustFix = [...t.matchAll(/^[-*\s]*\[?必改\]?[:：]?\s*(.+)$/gm)].map(m => m[1].trim()).slice(0, 40);
              if (mustFix.length) { pushLog(slug, { level: 'info', source: 'overhaul', msg: `必办清单取自 ${f}（${mustFix.length} 条）` }); break; }
            } catch {}
          }
        }
        const job = { status: 'running', stop: false, startedAt: Date.now() };
        overhaulJobs.set(slug, job);
        runOverhaul(book, {
          cfg, api: overhaulApi(book, cfg),
          from: Number(body.from) || 1, to: Number(body.to) || 0,
          batchSize: Number(body.batchSize) || 10,
          maxRounds: Number(body.maxRounds) || 2,
          readCheck: body.readCheck !== false,
          useReviews: body.useReviews !== false,
          std: body.std || {}, mustFix,
          mode: body.mode === 'rebuild' ? 'rebuild' : 'polish',
          shouldStop: () => job.stop,
          onLog: (e) => pushLog(slug, { ...e, source: e.source || 'overhaul' }),
        }).then(r => {
          job.status = r.ok ? 'done' : (r.stopped ? 'stopped' : 'error');
          pushLog(slug, { level: r.ok ? 'act' : 'warn', source: 'overhaul', msg: r.ok ? '🎉 改造完成，可以去发布了' : (r.stopped ? '改造已停止（进度已保存，可续跑）' : '改造中止：' + r.error) });
        }).catch(e => { job.status = 'error'; pushLog(slug, { level: 'error', source: 'overhaul', msg: '改造异常：' + e.message }); });
        return json(res, 200, { ok: true, started: true, mustFix: mustFix.length });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/overhaul/stop') {
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const job = overhaulJobs.get(book.slug);
        if (job) job.stop = true;
        // 批间才会停；作者要立刻停就连窗口一起收
        if (body.force) { try { await overhaulApi(book, cfg).stop(); } catch {} }
        pushLog(book.slug, { level: 'act', source: 'overhaul', msg: body.force ? '已请求立刻停止改造' : '已请求停止改造：本批做完就停（进度会保存）' });
        return json(res, 200, { ok: true, stopping: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/publish-changed') {
      // 只发【真正改动过】的章：靠 .studio/published-hashes.json 的指纹基线，不用人去数哪几章动了
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const pc = book.publish || {};
        if (!pc.profilePath || !pc.bookId) return json(res, 400, { error: '该书未配番茄账号/bookId' });
        const to = Number(body.to) || 0;
        const changed = changedChapters(book, { from: Number(body.from) || 1, to });
        if (!changed.length) return json(res, 200, { ok: true, changed: [], msg: '没有需要重发的章（正文与上次发布一致）' });
        if (body.dryRun) return json(res, 200, { ok: true, changed, dryRun: true });
        (async () => {
          for (const n of changed) {
            await republishRange(book, { from: n, to: n, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) });
          }
          pushLog(book.slug, { level: 'act', source: 'fanqie', msg: `只发改动章结束：共 ${changed.length} 章（第 ${changed.join('、')} 章）` });
        })().catch(e => pushLog(book.slug, { level: 'error', source: 'fanqie', msg: '只发改动章异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, changed });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/apply-review') {
      // 让作者按【已生成的审稿意见】去修订：kind=outline(大纲审稿→修订大纲) | ending(完本审稿→补写结局)。
      // 在写就穿插，没写就开窗专做这件事(不续写新章)。闭合"审完稿→落地修改"的环。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const kind = body.kind === 'ending' ? 'ending' : 'outline';
        let instruction;
        if (kind === 'ending') {
          instruction = buildEndingRenudgeInstruction(book, path.join(book.dir, 'reviews', '完本审稿.md'));
        } else {
          const scope = body.scope || '立项';
          const safe = String(scope).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);
          try { snapshotOutline(book, scope); } catch {}
          instruction = buildReviseInstruction(book, scope, path.join(book.dir, 'reviews', '大纲审稿-' + safe + '.md'));
        }
        if (sessionLive(book.slug)) {
          const r = await injectToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已让作者按审稿意见修订（穿插进当前窗口）' });
          await ensureAutopilot(book.slug, cfg);
          return json(res, 200, { ...r, mode: 'inserted' });
        }
        rtOf(book.slug).logs = [];
        const session = await startWriting({ book, model: book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg), onTerminalStop: mkTerminalStop(book.slug) });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, mode: 'started', instance: session.instance.id, pane: session.paneId });
      } catch (e) { pushLog(slugOf(body.book), { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/stateless-start') {   // 无状态省钱模式：每批全新无头进程 + 精准上下文包，后台跑，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const slug = book.slug;
        if (sessionLive(slug)) return json(res, 409, { error: '该书已有长驻写作窗口在跑，请先停止再用无状态模式（两种模式不要同时跑）' });
        // 原来只查自己这条路径（statelessRun），共创在跑时照样能启动 → 两边抢章号。改用统一判据。
        const busyNow = writingBusy(slug);
        if (busyNow) return json(res, 409, { error: busyNow + '，不能同时开始写作' });
        const model = body.model || book.model || cfg.defaultModel;
        if (body.model) { try { setBookModel(slug, body.model); } catch {} }
        // 【跑不了无头的模型，就别在这儿白跑一批】agy 的凭据不落盘，-p 每次都要人贴授权码（见 canRunHeadless）。
        // 作者点的是"放手让他写"，要的是【把书写出来】，不是"用无状态这条路写"——
        // 所以这里不报错、不空转，直接改用【有窗口】那条路（agy 在窗口里是通的，立项实测跑通过）。
        if (!canRunHeadless(model)) {
          const mm = getModel(model);
          if (mm && mm.kind !== 'web' && mm.kind !== 'api') {
            // 缘由交给 doWrite 去发：它开头会清空日志，在这儿 pushLog 等于白发（见 doWrite 上的注释）
            return await doWrite({ ...body, model }, cfg, res,
              { note: `「${mm.name}」没法无头跑（凭据不落盘，每次都要人贴授权码）→ 自动改用【窗口模式】开写` });
          }
          return json(res, 400, { error: `「${mm ? mm.name : model}」不是本地 CLI，用不了无状态模式。网页版请点写作台的 ▶（走网页版引擎），API 模型请用 API 写作。` });
        }
        if (body.participation != null) { try { setParticipation(slug, body.participation); } catch {} }
        const untilTarget = body.untilTarget === true || (book.targetChapters > 0 && body.batches == null);
        const batches = Math.max(1, parseInt(body.batches, 10) || 1);
        const out = startStatelessRun(book, { model, batches, untilTarget, cfg });
        return json(res, 200, out);
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/write') return await doWrite(body, cfg, res);
    if (p === '/api/send') {
      const slug = slugOf(body.book);
      const task = body.task || '';
      const wantModel = body.model || null;
      // 带了模型就先持久化到 book.model（卡片/下次默认值/resume 全跟上）
      if (wantModel) { try { setBookModel(slug, wantModel); } catch {} }
      try {
        if (sessionLive(slug)) {
          const liveModel = getSession(slug)?.model || null;
          const targetModel = wantModel || getBook(slug)?.model || null;
          // 选了与正在跑的窗口【不同】的模型 → 运行中的 agent 换不了模型，停旧窗口、用新模型重开
          if (targetModel && liveModel && targetModel !== liveModel) {
            pushLog(slug, { level: 'act', msg: `模型已切换（${liveModel} → ${targetModel}）→ 停止旧窗口并用新模型重开` });
            try { stopBook(slug); } catch {}
            const st = rt.get(slug); if (st?.session?.autopilot) st.session.autopilot.stop('切换模型'); if (st?.streamer) st.streamer.stop();
            rt.delete(slug);
            const session = await resumeWriting(slug, cfg, task, targetModel);
            return json(res, 200, { ok: true, mode: 'switched', model: targetModel, instance: session.instance.id, pane: session.paneId });
          }
          // 窗口还活着且模型一致 → 直接穿插，并确保有人监控（插完还能自动续）
          const r = await injectToBook(slug, task, cfg);
          pushLog(slug, { level: 'act', msg: '穿插指令：' + task });
          await ensureAutopilot(slug, cfg);
          return json(res, 200, { ...r, mode: 'inserted' });
        }
        // 已停止/窗口已关 → 打开 Unterm 重新继续，并把这条指令作为额外要求带上
        const session = await resumeWriting(slug, cfg, task, wantModel);
        return json(res, 200, { ok: true, mode: 'resumed', instance: session.instance.id, pane: session.paneId });
      } catch (e) {
        // 直接穿插失败（pane 死了等）也兜底为重开继续
        try {
          const session = await resumeWriting(slug, cfg, task, wantModel);
          return json(res, 200, { ok: true, mode: 'resumed', instance: session.instance.id, pane: session.paneId });
        } catch (e2) { pushLog(slug, { level: 'error', msg: e2.message }); return json(res, 500, { error: e2.message }); }
      }
    }
    if (p === '/api/stop') {
      const slug = slugOf(body.book);
      const st = rt.get(slug);
      // 无状态写作：置停止标志，循环会在【当前批次写完后】于批间安全停止（不杀进程、不丢半章）。
      if (st?.statelessRun && !st.statelessRun.stopped) {
        st.statelessRun.stopped = true;
        pushLog(slug, { level: 'act', msg: '已请求停止无状态写作：当前批次写完即停（不会丢失半章）' });
        return json(res, 200, { ok: true, mode: 'draining', stateless: true });
      }
      const ap = st?.session?.autopilot;
      // 第一次停止(且在写、未在 draining、非 force) → 优雅停止：写完当前批次再关窗。
      if (ap && ap.running && !ap.draining && body.force !== true) {
        ap.drain(() => {
          try { stopBook(slug); } catch {}
          const s = rt.get(slug); if (s?.streamer) s.streamer.stop();
          rt.delete(slug);
          pushLog(slug, { level: 'act', msg: '当前批次已完成 → 已关闭窗口' });
          broadcast(slug, 'stopped', { graceful: true });
        });
        pushLog(slug, { level: 'act', msg: '已请求优雅停止：写完当前批次后自动关闭（再点一次=立即停止）' });
        return json(res, 200, { ok: true, mode: 'draining' });
      }
      // force / 没有 autopilot / 已在 draining → 立即停
      const r = stopBook(slug);
      if (ap) ap.stop('用户停止'); if (st?.streamer) st.streamer.stop();
      rt.delete(slug);
      return json(res, 200, { ...r, mode: 'stopped' });
    }
    // ⚠️ 保存后回传的也必须遮蔽。以前这里直接返回 updateConfig 的结果，
    // 于是【每次在设置页点保存，所有 API key 都明文回到前端】——GET 那条早就遮了，POST 这条漏了。
    if (p === '/api/config') { const out = updateConfig(body.patch || body); return json(res, 200, maskConfig(out)); }
    return json(res, 404, { error: 'not found' });
  }
  json(res, 405, { error: 'method not allowed' });
}

// 开一轮「范围重写」：在写就穿插指令，没写就开窗（只应答、干完收窗，不许续写新章）。
// 抽出来是因为改造流水线每一批都要走这条路——两处各写一份迟早走样。
async function startRewrite(book, body, cfg) {
  const isRe = !!body.reproject;
  const autoScope = !isRe && !String(body.range || '').trim();
  if (autoScope && body.useReviews === false) {
    return { error: '要么填重写范围（如 001-008 或 卷01），要么勾上「按复检报告重写」让它自己从报告里找出问题章节。' };
  }
  const hash = gitSnapshot(book.dir, isRe ? '整本重立项前存档'
    : (autoScope ? '按复检报告重写前存档' : '重写' + (body.range || '') + '前存档'));
  const instruction = isRe ? buildReprojectInstruction(book, body.note)
    : buildRewriteInstruction(book, body.range, body.note, { useReviews: body.useReviews !== false });
  // 只有【窗口在且 AI 真的在跑】才穿插指令；AI 已退到命令行时绝不能把指令打进 shell。
  if (sessionLive(book.slug) && await sessionAgentAlive(book.slug, cfg)) {
    const r = await injectToBook(book.slug, instruction, cfg);
    pushLog(book.slug, { level: 'act', msg: (isRe ? '整本重立项' : '范围重写：' + body.range) + ' 指令已穿插' + (hash ? '（已存档 ' + hash + '）' : '') });
    await ensureAutopilot(book.slug, cfg);
    return { ...r, mode: 'inserted', snapshot: hash };
  }
  rtOf(book.slug).logs = [];
  // 【重写开的窗口只应答、干完就收，不许自动"续写下一批"】2026-09-19 踩过：漏了这个开关，
  // 一个"改前 19 章"的任务变成改完又往后多写了 14 章新章。
  const session = await startWriting({
    book, model: book.model || cfg.defaultModel, instruction, cfg,
    onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg),
    onTerminalStop: mkTerminalStop(book.slug), autopilotConfirmOnly: !isRe,
  });
  rtOf(book.slug).session = session;
  pushLog(book.slug, { level: 'act', msg: (isRe ? '整本重立项' : '范围重写：' + body.range) + ' 已开窗' + (hash ? '（已存档 ' + hash + '，可回退）' : '') + (isRe ? '' : '——改完这个范围就收窗，不会接着续写新章') });
  return { ok: true, mode: 'started', instance: session.instance.id, snapshot: hash };
}

// 改造流水线要用的一组动作，注入给 overhaul.runOverhaul（测试里换成假的即可）
function overhaulApi(book, cfg) {
  const slug = book.slug;
  return {
    live: async () => sessionLive(slug),
    stop: async () => { try { const st = rt.get(slug); st?.session?.autopilot?.stop('改造流水线停止'); stopBook(slug); st?.streamer?.stop(); rt.delete(slug); } catch {} },
    rewrite: async (b) => startRewrite(getBook(slug) || book, { ...b, keepLogs: true }, cfg),
    killAgents: async () => { try { return killBookAgents((getBook(slug) || book).dir); } catch { return 0; } },
    // 撞没撞模型额度：看这段时间的日志（autopilot 会把"用量/速率上限"写进来）
    hitQuota: async (since) => (rtOf(slug).logs || []).some(e => e.t >= since && /用量|速率上限|quota/i.test(String(e.msg || ''))),
    // 额度什么时候恢复：agy 窗口里写着「Resets in 6m8s」，读屏幕拿准确值，读不到给 15 分钟
    quotaResetMs: async () => {
      try {
        const sess = getSession(slug);
        if (!sess) return 15 * 60000;
        const mcp = await connectInstance({ id: sess.instanceId, mcp_port: sess.mcp_port, auth_token: sess.auth_token }, {});
        const t = String(await mcp.screenText(sess.pane) || '');
        try { mcp.close(); } catch {}
        const m = [...t.matchAll(/Resets in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/g)].pop();
        if (m) return (((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000) + 90000;
      } catch {}
      return 15 * 60000;
    },
  };
}

function bootstrap(cfg) {
  return {
    config: cfg,
    models: detectAllCached(),
    instances: listInstances().map(i => ({ id: i.id, version: i.version, mcp_port: i.mcp_port, cwd: i.cwd })),
    books: withUsage(listBooksWithStats()),
    sessions: sessionsInfo(),
    usage: loadUsage(),
  };
}
// 真实日志优先：codex + claude 各自官方会话日志按书目录求和（不再张冠李戴/漏算）；
// 都没有(如纯 gemini 书)才回退到屏幕抓取的粗估。返回值是"总处理token(含输入/缓存/推理/输出)"。
function bookTokens(book) {
  if (!book) return 0;
  return memo('tokens:' + book.dir, 120000, () => {
    const real = codexTokensForDir(book.dir) + claudeTokensForDir(book.dir);
    return real || bookUsage(book.slug) || 0;
  });
}

// 【短时缓存：别让书架轮询把事件循环堵死】
// 2026-09-20 实测：书架页开着时界面每 5 秒拉一次 bootstrap，里面同步统计 12 本书的 token（翻 codex/claude
// 全部会话日志，≈5s）+ 探测模型（≈1s），书架状态再跑一遍全书架体检（≈6s）——每 5 秒要干 12 秒的同步活，
// 引擎永远追不上：连 /api/config 都要 10–20 秒才回。窗口模式下 MCP 回包全被延误，
// 开 tab 的 create 超时后被当成失败重开 → 同一本书开出两个 tab、两个 agy 抢着改。
// 这些数都不需要秒级新鲜：token 两分钟、模型一分钟、体检计数一分钟。
const _memo = new Map();
function memo(key, ttlMs, fn) {
  const hit = _memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = fn();
  _memo.set(key, { at: Date.now(), v });
  return v;
}
const detectAllCached = () => memo('models', 60000, detectAll);
function withUsage(books) { return books.map(b => ({ ...b, tokens: bookTokens(b) })); }
function sessionsInfo() {
  const out = listSessions().map(s => ({ ...s, tokens: bookTokens(getBook(s.slug)), running: rt.has(s.slug) }));
  // 无状态写作没有 Unterm 会话，但也要让前端看到"写作中"（可显示状态/可停止）。
  const seen = new Set(out.map(s => s.slug));
  for (const [slug, st] of rt) {
    if (st?.statelessRun && !st.statelessRun.stopped && !seen.has(slug)) {
      const b = getBook(slug);
      if (b) out.push({ slug, title: b.title, model: b.model, mode: 'stateless', running: true, tokens: bookTokens(b) });
    }
  }
  return out;
}

// 这本书是否还有“活着的 Unterm 窗口”：会话在册 且 其实例仍在运行实例列表里。
function sessionLive(slug) {
  const sess = getSession(slug);
  return !!(sess && instanceIds().has(sess.instanceId));
}

// 这本书当前有没有【正在写正文】的活儿在跑？返回空串=空闲，否则返回一句人话说明。
//
// 为什么必须有这个：三条写作路径都按「当前最高章号 +1」取号并往 chapters/ 落盘，
// 同时跑两条就会【抢同一个章号、互相覆盖】，台账和索引也会各写各的。
// 无状态写作自己早有互斥（startStatelessRun 前查 statelessRun），长驻窗口有 autopilot 看着，
// 唯独【共创】三个端点一道守卫都没有——用户可以在自动写作跑着的时候直接开共创写章。
// 这里把三条路径的运行态收成一个判据，两边都用它，避免各查各的再次漏掉某一条。
//
// 长驻这条只认 autopilot.running，不认 sessionLive：窗口开着但没在自动续写（用户只是开着看）
// 不该拦住共创——那是共创最自然的用法。
function writingBusy(slug) {
  const st = rtOf(slug);
  if (st.statelessRun && !st.statelessRun.stopped) return '这本书的「放手让它写」正在跑';
  if (st.cowriteRun) return '这本书的共创正在写（上一段情节还没写完）';
  if (st.bgWrite) return `这本书的${st.bgWrite.kind === 'web' ? '网页版' : 'API'}写作正在跑`;
  if (st.session?.autopilot?.running) return '这本书的长驻写作窗口正在自动续写';
  return '';
}
// 确保本进程在监控这本书：窗口活着但没人 autopilot（如另起进程/重启后）就重新挂上，保证插完指令还能自动续。
async function ensureAutopilot(slug, cfg) {
  const st = rt.get(slug);
  if (st?.session?.autopilot) return false;
  try {
    const h = await attachAutopilot(slug, cfg, (e) => pushLog(slug, e), mkFresh(slug, cfg), mkTerminalStop(slug));
    rtOf(slug).session = { ...(st?.session || {}), autopilot: h.autopilot, mcp: h.mcp };
    pushLog(slug, { level: 'act', msg: '已重新接管监控（autopilot）' });
    return true;
  } catch (e) { pushLog(slug, { level: 'warn', msg: '重新挂监控失败：' + e.message }); return false; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 省 token：autopilot 判定“上下文快满”时回调这里——停旧会话/窗口，再用 ledger 重开新窗口续写。
async function freshRestart(slug, cfg, reason = '') {
  try {
    const st = rt.get(slug);
    try { st?.session?.autopilot?.stop?.('fresh-restart'); } catch {}
    try { st?.streamer?.stop?.(); } catch {}
    try { stopBook(slug); } catch {}            // 杀旧窗口 + 注销会话
    await sleep(1500);
    pushLog(slug, { level: 'act', msg: `♻️ ${reason || '上下文较大'} → 重开新会话续写（省 token，靠 continuity_ledger 重建上下文）` });
    await resumeWriting(slug, cfg, '', getBook(slug)?.model || null);
    pushLog(slug, { level: 'act', msg: '✅ 新会话已开，继续写作' });
  } catch (e) { pushLog(slug, { level: 'error', msg: '重开新会话失败：' + e.message }); }
}
const mkFresh = (slug, cfg) => (reason) => freshRestart(slug, cfg, reason);

// 重新打开 Unterm 并从已写内容继续；instruction 默认走 resume 续写，可叠加用户本次的额外要求。
async function resumeWriting(slug, cfg, extraTask = '', model = null) {
  const book = getBook(slug);
  if (!book) throw new Error('找不到书：' + slug);
  if (getSession(slug)) { try { removeSession(slug); } catch {} }
  rt.delete(slug);
  let instruction = buildResumeInstruction(book);
  if (extraTask) instruction += '；另外，本次还需：' + String(extraTask).replace(/[\r\n]+/g, ' ');
  const useModel = model || book.model || cfg.defaultModel;
  pushLog(slug, { level: 'act', msg: `会话已停止 → 用 ${useModel} 重新打开 Unterm 并继续写作…` });
  const session = await startWriting({ book, model: useModel, instruction, cfg, onLog: (e) => pushLog(slug, e), onFreshRestart: mkFresh(slug, cfg), onTerminalStop: mkTerminalStop(slug) });
  rtOf(slug).session = session;
  return session;
}

// opts.note：调用方想让作者看见的【开写缘由】（例：从无状态自动改道到窗口模式）。
// 【必须从这儿走，不能在调用前 pushLog】血泪（2026-09-17 王莽）：无状态入口先 pushLog 了
// 「Antigravity 没法无头跑 → 自动改用窗口模式」，转头 doWrite 开头一句 rtOf(slug).logs = []
// 把它连同一切当场抹掉——作者点完写作，日志里第一条是「确保 profile」，
// 没有任何一个字解释为什么模式变了，看起来就是"点了没反应"。
// 缘由得在【清空之后】补，不能在之前发。
async function doWrite(body, cfg, res, opts = {}) {
  const book = getBook(body.book);
  if (!book) return json(res, 400, { error: '找不到书：' + body.book });
  // 长驻续写：此刻 autopilot 还没起来，writingBusy 认不出"自己"，但认得出共创/无状态/后台写作在跑。
  const busyDo = writingBusy(book.slug);
  if (busyDo) return json(res, 409, { error: busyDo + '，不能同时开始写作' });
  const model = body.model || book.model || cfg.defaultModel;
  // 带了模型就持久化（卡片/下次默认值/resume 全跟上）
  if (body.model) { try { setBookModel(book.slug, body.model); } catch {} }
  // 开写前选择参与度（放手写/卷口把关/盯着写）：持久化 + 立即热生效（含已在跑的窗口）
  if (body.participation != null) {
    try { setParticipation(book.slug, body.participation); } catch {}
    setReviewEvery(book.slug, body.participation === 'chapter' ? 1 : 0);
  } else if (body.writeMode != null) {
    const mode = body.writeMode === 'review' ? 'review' : 'auto';
    const every = mode === 'review' ? Math.max(1, Math.floor(Number(body.reviewEvery) || 1)) : 0;
    try { setBookWriteMode(book.slug, mode, every || 1); } catch {}
    setReviewEvery(book.slug, every);
  }
  // 【必须把起点写死在指令里】血泪（《大宋第一女帝：我成了李清照》）：这条指令原来只写
  // "请阅读 AGENTS.md 与 novel_bible.md，续写下一批 3 章并自检"，【一个字都没说从第几章开始】。
  // 第一次点没问题（本来就从 001 起）；但会话死掉后再点一次「开始写作」，新窗口的 agent 上下文是空的，
  // 读完 bible 就"续写下一批"——它眼里的下一批就是 001，于是从头重写了一遍：
  // 那本书里 001红烛未剪/002火印 与 001新妇不睡/002西壁第三格 是同一场新婚夜的两个版本，
  // chapter_index.md 里两个 001、两个 002 并排登记成"已写"，谁都没发现撞号。
  // 导入的书走 buildResumeInstruction 一直是对的（它明写"确认当前最新章号、从最新章节之后接着写、
  // 不要重写已写章节"）——新书这条落了这一段，补上，并且把【服务端算出来的真实最高章号】直接告诉它。
  const already = bookStats(book);
  const nextNum = (already?.maxChapter || 0) + 1;
  const batchN = book.standards?.batchSize || 3;
  const instruction = body.task || (book.imported
    ? buildResumeInstruction(book)
    : (already?.maxChapter > 0
      ? `继续写《${book.title}》。本书【已经写到第 ${String(already.maxChapter).padStart(3, '0')} 章】，`
        + `你要写的是【第 ${String(nextNum).padStart(3, '0')} 章起的下一批 ${batchN} 章】。`
        + `动笔前先重建上下文：读 chapter_index.md 与 continuity_ledger.md，再读最近 2 章正文与本卷 outlines/ 中对应章号段的分章大纲，`
        + `确认最新章号、主角处境、未回收伏笔、欠债与伤势。`
        + `⚠️【严禁重写或改动任何已写章节、严禁重复使用已有章号】——新章一律从第 ${String(nextNum).padStart(3, '0')} 章往后编号；`
        + `取章名前先在 chapter_index.md 全表检索，确保不与已有章名重复。`
        + `写完把新章登记进 chapter_index.md、更新 continuity_ledger.md，并做常规批次自检。`
        + `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范。`
      : `请阅读 AGENTS.md 写作规范与 novel_bible.md，从第 001 章开始写第一批 ${batchN} 章并自检。`));
  const slug = book.slug;
  // 开写缘由：只要发得出去就发（下面清空日志的那条路径会在清空之后再补一次）
  const sayNote = () => { if (opts.note) pushLog(slug, { level: 'act', msg: opts.note }); };
  // 已有活窗口 → 不再开第二个：直接把指令插进去并确保监控（点“写作”=继续处理）
  if (sessionLive(slug)) {
    const liveModel = getSession(slug)?.model || null;
    // 选了与正在跑的窗口不同的模型 → 停旧窗口，落到下面用新模型重开（运行中的 agent 换不了模型）
    if (model && liveModel && model !== liveModel) {
      pushLog(slug, { level: 'act', msg: `模型已切换（${liveModel} → ${model}）→ 停止旧窗口并用新模型重开` });
      try { stopBook(slug); } catch {}
      const st = rt.get(slug); if (st?.session?.autopilot) st.session.autopilot.stop('切换模型'); if (st?.streamer) st.streamer.stop();
      rt.delete(slug);
    } else {
      try {
        const r = await injectToBook(slug, instruction, cfg);
        sayNote();
        pushLog(slug, { level: 'act', msg: '窗口已在运行 → 直接续写指令已送达' });
        await ensureAutopilot(slug, cfg);
        return json(res, 200, { ...r, mode: 'inserted' });
      } catch { /* 窗口其实已死 → 落到下面重开 */ if (getSession(slug)) { try { removeSession(slug); } catch {} } rt.delete(slug); }
    }
  }
  rtOf(slug).logs = [];
  sayNote();   // ← 必须在清空之后：清空之前发的任何解释都会被上面这一行吃掉
  try {
    const session = await startWriting({
      book, model, instruction, cfg,
      onLog: (e) => pushLog(slug, e),
      onFreshRestart: mkFresh(slug, cfg),
    });
    rtOf(slug).session = session;
    // 把落章播报的水位定在【点写作这一刻】，而不是等看门狗 20 秒后自己去认：
    // 否则这中间落的章会被当成"开写前就有的"，第一章永远播不出来。
    _chapHigh.set(slug, already?.maxChapter || 0);
    return json(res, 200, { ok: true, instance: session.instance.id, pane: session.paneId });
  } catch (e) {
    pushLog(slug, { level: 'error', msg: e.message });
    return json(res, 500, { error: e.message });
  }
}

// SSE：实时屏幕镜像 + 日志
function sseStream(u, res) {
  const slug = u.searchParams.get('book');
  if (!slug) { res.writeHead(400); return res.end('book required'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  const r = rtOf(slug);
  r.clients.add(res);
  // 补发最近日志
  for (const e of r.logs.slice(-50)) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  // 启动屏幕镜像（多个客户端共享一个）。无状态模式无 Unterm 窗口可镜像 → 跳过，避免噪音。
  if (!r.streamer && sessionLive(slug)) {
    const cfg = loadConfig();
    streamBook(slug, cfg, (txt) => broadcast(slug, 'screen', { text: txt }), { intervalMs: 1000 })
      .then(h => { r.streamer = h; })
      .catch(e => pushLog(slug, { level: 'warn', msg: '镜像启动失败：' + e.message }));
  }
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
  res.on('close', () => {
    clearInterval(ka); r.clients.delete(res);
    if (r.clients.size === 0 && r.streamer) { r.streamer.stop(); r.streamer = null; }
  });
}

// 静态文件（前端）
// 静态资源：必须【每次回源验证】。
// 病根：原来一个缓存头都不发，浏览器就按启发式缓存把 index.html / app.js 存下来——
// 改完前端用户那边还在跑旧的，表现成「点了按钮没反应」（实测：发布弹窗在新代码里能正常打开，
// 用户浏览器里点却没动静，因为加载的是缓存里的旧 app.js）。这种 bug 最坑人的地方在于
// 开发机上永远复现不出来。
// 修法：no-cache（不是 no-store——仍允许缓存，但每次必须带 ETag 回来问一次）+ 基于
// mtime/size 的弱 ETag；没变就 304 空响应，几乎不费流量；变了立刻拿到新文件。
function serveStatic(p, res, req) {
  let rel = p === '/' ? '/index.html' : p;
  const file = path.join(UI_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  const st = fs.statSync(file);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'ETag': etag,
  };
  if (req && req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers); return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function slugOf(idOrSlug) { const b = getBook(idOrSlug); return b ? b.slug : idOrSlug; }
// 对外返回配置时【隐藏 API Key 明文】，只暴露「是否已设置」。含 Gemini 与三家 API 模型的 key。
function maskConfig(cfg) {
  const api = cfg.api || {};
  const maskApi = {};
  // ⚠️ 这份名单必须覆盖所有【需要 key】的 provider，漏一个那家的 key 就会明文回传前端。
  // 从 API_PROVIDERS 推导，避免以后加 provider 时又漏（local 无 key，跳过）。
  for (const prov of Object.keys(API_PROVIDERS).filter(k => k !== 'local')) {
    const one = api[prov] || {};
    maskApi[prov] = { ...one, apiKey: one.apiKey ? '***已设置***' : '', hasKey: !!one.apiKey };
  }
  return {
    ...cfg,
    gemini: { ...cfg.gemini, apiKey: cfg.gemini?.apiKey ? '***已设置***' : '', hasKey: !!cfg.gemini?.apiKey },
    api: { ...api, ...maskApi },
  };
}

// 去掉 patch 里等于掩码占位（'***已设置***'）的 apiKey——UI GET 拿到的是掩码，回传时不能用它覆盖真 key。
function stripMaskedKeys(patch) {
  const MASK = '***已设置***';
  const out = JSON.parse(JSON.stringify(patch || {}));
  if (out.gemini && out.gemini.apiKey === MASK) delete out.gemini.apiKey;
  if (out.api) {
    for (const prov of Object.keys(out.api)) {
      if (out.api[prov] && typeof out.api[prov] === 'object' && out.api[prov].apiKey === MASK) delete out.api[prov].apiKey;
      // 顺带去掉只读的 hasKey 别写进配置
      if (out.api[prov] && typeof out.api[prov] === 'object') delete out.api[prov].hasKey;
    }
  }
  return out;
}

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}


