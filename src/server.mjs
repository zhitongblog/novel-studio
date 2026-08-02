// 引擎服务层：HTTP REST + SSE。作为长驻进程托管所有写作会话与 autopilot，
// 给 Tauri/网页前端提供接口。复用全部既有模块，不重写编排逻辑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, updateConfig } from './config.mjs';
import { CONFIG_DIR } from './paths.mjs';
import { listBooksWithStats, createBook, getBook, importBook, setBookStyle, deleteBook, detectTitleFromDir, setBookTarget, setBookModel, setBookSynopsis, setBookStatus, renameBook, setBookPublish, setBookFanqieStatus, setBookWriteMode, setParticipation, participationOf, bookStats, plannedTotalChapters, plannedVolumes, currentVolume } from './books.mjs';
import { STYLES } from './styles.mjs';
import { recommendStyle } from './planner.mjs';
import { detectAll, getModel } from './models.mjs';
import { listInstances, instanceIds, findUntermExe, findUntermCli, untermVersion, readProxyConfig } from './unterm.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { startWriting } from './writer.mjs';
import { runStateless } from './statelessWriter.mjs';
import { runWebWrite, getAdapter } from './webwriter.mjs';
import { runApiWrite, isApiProvider } from './apiwriter.mjs';
import { API_PROVIDERS, providerConfigured } from './apichat.mjs';
import { brainstorm, writeChapterInWindow, isCowriteModel, COWRITE_MODELS } from './cowrite.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { listSessions, sendToBook, stopBook, streamBook, attachAutopilot, sessionAgentAlive } from './attach.mjs';
import { loadUsage, bookUsage, codexTokensForDir, claudeTokensForDir } from './usage.mjs';
import { proposeTitles, buildKickoffInstruction, buildResumeInstruction, buildReviewInstruction, generateSynopsis, buildFinaleInstruction, buildRewriteInstruction, buildReprojectInstruction, buildAfterwordInstruction, buildRebuildOutlineInstruction, buildReviseSettingInstruction, resolveGenModel, analyzeStyleSample } from './planner.mjs';
import { styleFromFanqieUrl } from './refstyle.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { reviewOutline, snapshotOutline, reviewEnding, buildReviseInstruction, buildReviseFromItems, buildEndingRenudgeInstruction } from './editor.mjs';
import { getPending, clearPending, setReviewEvery, getReviewEvery, getReviewDefault, setResume } from './pending.mjs';
import { listBookFiles, readBookFile, saveBookFile, renumberGlobalChapters } from './files.mjs';
import { previewPublish, publishToFanqie, republishRange } from './publish.mjs';
import { generateVolumeName, existingVolName } from './volname.mjs';
import { listProfiles as listUnzooProfiles, getFanqieBooks, getFanqieVolumes, renameFanqieVolume, stopPublish, changeFanqieCover, createFanqieBook, pushNameExperiment } from './fanqie.mjs';
import { getCompletionReport, runFinaleClosure, locateCompletion, buildCompletionNote } from './finale.mjs';
import { previewFanqieImport, importFromFanqie } from './import_fanqie.mjs';
import { generateCoverBg, buildArtPrompt } from './imagegen.mjs';
import { generateNameExperiment, readNameExperiment } from './nameexp.mjs';
import { generateCoverViaChatGPT, grabCoverFromChatGPT, buildChatGptCoverPrompt } from './covergen_web.mjs';

const UI_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'ui');

// ChatGPT 网页版生成封面是慢活（2~4 分钟）→ 后台跑，前端轮询状态。slug -> {status,url,error,msg}
const coverJobs = new Map();
// 推送封面到番茄（换封面）后台任务。slug -> {status,submitted,error,msg}
const fanqieCoverJobs = new Map();
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
    process.on('uncaughtException', (e) => { try { console.error('[engine] uncaughtException(已忽略保活):', e?.stack || e?.message || e); } catch {} });
    process.on('unhandledRejection', (e) => { try { console.error('[engine] unhandledRejection(已忽略保活):', e?.message || e); } catch {} });
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
      return serveStatic(p, res);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Novel Studio engine 已启动: http://127.0.0.1:${port}`);
    setTimeout(reattachLiveSessions, 1500);
    setTimeout(() => { resumeStatelessRuns().catch(e => console.error('[engine] resumeStatelessRuns:', e?.message || e)); }, 2500);
    startOrphanWatchdog();
  });
  return server;
}

// 引擎(重)启动时，把 autopilot 重新挂到仍在运行的写作会话上，避免重启后会话失去监控。
async function reattachLiveSessions() {
  const cfg = loadConfig();
  for (const s of listSessions()) {
    if (rt.get(s.slug)?.session?.autopilot?.running) continue;   // 只有【活着的】autopilot 才跳过
    try {
      const h = await attachAutopilot(s.slug, cfg, (e) => pushLog(s.slug, e), mkFresh(s.slug, cfg));
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
    for (const s of listSessions()) {
      let st = rt.get(s.slug);
      const ap = st?.session?.autopilot;
      // ⚠️ 关键：不能只看 autopilot【对象是否存在】，要看它【是否还活着(running)】。
      // 之前 bug：autopilot 在会话慢启动/启动报错时 stop() 掉了(running=false)，但对象还挂在 rt.session 上，
      // 看门狗以为"有人盯着"就不补挂 → 窗口其实无人应答、卡在 Yes/No 门里没人点(圣女 csld 卡死的根因)。
      if (!ap || !ap.running) {
        try { st?.session?.mcp?.close?.(); } catch {}                 // 清掉停掉的旧连接，避免泄漏
        try {
          const h = await attachAutopilot(s.slug, cfg, (e) => pushLog(s.slug, e), mkFresh(s.slug, cfg));
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
    try { await sendToBook(slug, buildReviseInstruction(book, scope, reviewFile), cfg); pushLog(slug, { level: 'act', msg: `🐕 看门狗：${scope}审稿已在 → 已催作者据此修订并继续写作` }); } catch {}
    return;
  }
  if (handled.has(scope + ':gen')) return;   // 正在生成，勿重入
  handled.add(scope + ':gen');
  pushLog(slug, { level: 'act', msg: `🐕 看门狗：检测到卡在【${scope}大纲审稿门】→ 自动生成审稿（codex）并放行…` });
  try {
    const r = await reviewOutline({ book, scope, cfg, authorModel: book.model || cfg.defaultModel, onLog: (e) => pushLog(slug, { ...e, source: 'editor' }) });
    await sendToBook(slug, buildReviseInstruction(book, scope, r.file), cfg);
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
    if (p === '/api/config') return json(res, 200, maskConfig(cfg));
    if (p === '/api/logs') { const slug = u.searchParams.get('book'); return json(res, 200, rtOf(slug).logs); }
    return json(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    if (p === '/api/book/create') {
      const b = createBook(body, cfg);
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
        const r = generateCoverBg(book, { prompt: body.prompt });
        return json(res, 200, { ok: true, url: '/api/book/cover-bg?book=' + encodeURIComponent(book.slug) + '&t=' + Date.now(), prompt: r.prompt, w: r.w, h: r.h });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/art-prompt') {   // 仅生成英文出图提示词（让用户可先看/改）
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        return json(res, 200, { ok: true, prompt: buildArtPrompt(book) });
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
        const hero = String(body.hero || '').trim();
        const hero2 = String(body.hero2 || '').trim();
        // 有本地封面就一并传（番茄建书默认自动生成封面，我们换成 cover.png）；没有则番茄用自动封面。可用 uploadCover:false 关掉。
        const _cp = path.join(book.dir, 'cover.png');
        const coverPath = (body.uploadCover !== false && fs.existsSync(_cp)) ? _cp : '';
        const autoSubmit = body.autoSubmit !== false;   // 默认全自动（用户已授权）
        if (!title) return json(res, 400, { error: '书名为空' });
        if (title.length > 15) return json(res, 400, { error: `书名「${title}」超过番茄上限(15字)` });
        if (!mainCategory) return json(res, 400, { error: '请选择主分类' });
        if (synopsis.length < 50) return json(res, 400, { error: `简介仅 ${synopsis.length} 字，番茄要求 50–500 字，请先在「作品简介」写好` });
        const slug = book.slug;
        const cur = fanqieCreateJobs.get(slug);
        if (cur && cur.status === 'running') return json(res, 200, { ok: true, started: true, already: true });
        fanqieCreateJobs.set(slug, { status: 'running', msg: '开始…' });
        const onLog = (e) => { const j = fanqieCreateJobs.get(slug); if (j) j.msg = e.msg; pushLog(slug, { ...e, source: 'fanqie' }); };
        createFanqieBook({ profilePath, title, channel, mainCategory, hero, hero2, synopsis, coverPath, autoSubmit, onLog })
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
      try { book = createBook({ title: body.title, genre: body.theme || body.genre, model: body.model, totalWords: body.words, style: styleInput }, cfg); }
      catch (e) { return json(res, 400, { error: e.message }); }
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
      const instruction = buildKickoffInstruction(book, body.theme || body.genre, body.words, { planOnly: isWebModel });
      rtOf(book.slug).logs = [];
      try {
        const session = await startWriting({ book, model: launchModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, book: { ...book, stats: { chapters: 0, kb: 0 }, tokens: 0 }, instance: session.instance.id, pane: session.paneId, planOnly: isWebModel });
      } catch (e) { pushLog(book.slug, { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review') {
      const book = getBook(body.book);
      if (!book) return json(res, 400, { error: '找不到书：' + body.book });
      const instruction = buildReviewInstruction(book, body.range, body.dims, body.note);
      const running = listSessions().some(s => s.slug === book.slug);
      try {
        if (running) {
          // 已在写 → 穿插一条复检指令（排在当前批之后）
          const r = await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: `已穿插复检指令（范围 ${body.range || '全书'}）` });
          return json(res, 200, { ok: true, mode: 'inserted', ...r });
        }
        // 未在写 → 开一个会话专门做复检
        rtOf(book.slug).logs = [];
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
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
          try { await sendToBook(book.slug, buildReviseInstruction(book, scope, r.file), cfg); } catch {}
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
          try { await sendToBook(book.slug, buildFinaleInstruction(book, { first: true }), cfg); pushLog(book.slug, { level: 'act', msg: '已进入收尾 → 穿插收束令' }); } catch {}
        }
        return json(res, 200, { ok: true, status: b.status, live: sessionLive(book.slug) });
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
          await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: `已让 AI 按你的话改${target === 'outline' ? '大纲' : '设定/角色'}（不写新正文）` });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
        return json(res, 200, { ok: true, mode: 'opened', instanceId: session.instance?.id });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/rebuild-outline') {
      // 重建设定圣经+大纲（不写新正文）：导入/半成品书据已写正文逆向重建规划。有会话穿插，没会话开窗。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const instruction = buildRebuildOutlineInstruction(book);
        if (sessionLive(book.slug)) {
          await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已穿插指令：重建设定圣经 + 各卷大纲（不写新正文）' });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
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
          await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已穿插指令：写《完本感言 / 尾声》' });
          return json(res, 200, { ok: true, mode: 'inserted' });
        }
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
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
          try { await sendToBook(book.slug, instr, cfg); } catch {}
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
          if (sessionLive(book.slug)) { try { await sendToBook(book.slug, buildReviseInstruction(book, pend.scope, pend.file), cfg); } catch {} }
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
        publishToFanqie(book, { limit, onLog: (e) => pushLog(book.slug, { ...e, source: 'fanqie' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'fanqie', msg: `番茄发布结束：已发 ${r.published || 0} 章，状态 ${r.status || '-'}${r.error ? '，错误 ' + r.error : ''}` }))
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
        runWebWrite({ book, adapterId, batches, profilePath, cfg, onLog: (e) => pushLog(book.slug, { ...e, source: 'web' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'web', msg: `网页版写作结束：共 ${r.batches || 0} 批、新增 ${r.totalWrote || 0} 章` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'web', msg: '网页版写作异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, adapterId, batches });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/api-write') {   // API 写作：直连智谱/DeepSeek/通义 API 写小说，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书' });
        const provider = body.provider || (book.model || '').replace(/^api-/, '') || 'zhipu';
        if (!isApiProvider(provider)) return json(res, 400, { error: '未知 API 提供方：' + provider + '（可选 zhipu|deepseek|dashscope）' });
        if (!providerConfigured(provider, cfg)) {
          const nm = API_PROVIDERS[provider]?.name || provider;
          return json(res, 400, { error: `未配置 ${nm} 的 API Key。请在「设置 · API 模型」里填入后再写。` });
        }
        const batches = Math.max(1, Number(body.batches) || 1);
        runApiWrite({ book, provider, batches, cfg, onLog: (e) => pushLog(book.slug, { ...e, source: 'api' }) })
          .then(r => pushLog(book.slug, { level: 'act', source: 'api', msg: `API 写作结束：共 ${r.batches || 0} 批、新增 ${r.totalWrote || 0} 章` }))
          .catch(e => pushLog(book.slug, { level: 'error', source: 'api', msg: 'API 写作异常：' + e.message }));
        return json(res, 200, { ok: true, started: true, provider, batches });
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
        if (!isCowriteModel(model)) return json(res, 400, { error: '共创模式请用 claude 或 codex（也可 gemini/qwen）。当前模型：' + model });
        const r = await writeChapterInWindow({
          book, model, intent: body.intent, useLastEnding: body.useLastEnding !== false, redoLast: !!body.redoLast, cfg,
          onLog: (e) => pushLog(book.slug, { ...e, source: 'cowrite' }),
        });
        return json(res, 200, { ok: true, ...r });
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
      // 推倒重写：rewrite=范围重写 / reproject=整本重立项。先 git 存档(可回退)；在写穿插、没写开窗。
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const isRe = p === '/api/book/reproject';
        if (!isRe && !String(body.range || '').trim()) return json(res, 400, { error: '请填重写范围（如 001-008 或 卷01）' });
        const hash = gitSnapshot(book.dir, isRe ? '整本重立项前存档' : ('重写' + (body.range || '') + '前存档'));
        const instruction = isRe ? buildReprojectInstruction(book, body.note) : buildRewriteInstruction(book, body.range, body.note);
        // 只有【窗口在且 AI 真的在跑】才穿插指令；若 AI 已退出到命令行（只剩 shell 提示符），
        // 绝不能把指令打进命令行——改为开新窗口重启 AI（治"没打开 ai 就给命令行发命令"）。
        if (sessionLive(book.slug) && await sessionAgentAlive(book.slug, cfg)) {
          const r = await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: (isRe ? '整本重立项' : '范围重写：' + body.range) + ' 指令已穿插' + (hash ? '（已存档 ' + hash + '）' : '') });
          await ensureAutopilot(book.slug, cfg);
          return json(res, 200, { ...r, mode: 'inserted', snapshot: hash });
        }
        rtOf(book.slug).logs = [];
        const session = await startWriting({ book, model: book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
        rtOf(book.slug).session = session;
        pushLog(book.slug, { level: 'act', msg: (isRe ? '整本重立项' : '范围重写：' + body.range) + ' 已开窗' + (hash ? '（已存档 ' + hash + '，可回退）' : '') });
        return json(res, 200, { ok: true, mode: 'started', instance: session.instance.id, snapshot: hash });
      } catch (e) { pushLog(slugOf(body.book), { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
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
          const r = await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: '已让作者按审稿意见修订（穿插进当前窗口）' });
          await ensureAutopilot(book.slug, cfg);
          return json(res, 200, { ...r, mode: 'inserted' });
        }
        rtOf(book.slug).logs = [];
        const session = await startWriting({ book, model: book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e), onFreshRestart: mkFresh(book.slug, cfg) });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, mode: 'started', instance: session.instance.id, pane: session.paneId });
      } catch (e) { pushLog(slugOf(body.book), { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/stateless-start') {   // 无状态省钱模式：每批全新无头进程 + 精准上下文包，后台跑，日志推 SSE
      try {
        const book = getBook(body.book); if (!book) return json(res, 400, { error: '找不到书：' + body.book });
        const slug = book.slug;
        if (sessionLive(slug)) return json(res, 409, { error: '该书已有长驻写作窗口在跑，请先停止再用无状态模式（两种模式不要同时跑）' });
        if (rtOf(slug).statelessRun && !rtOf(slug).statelessRun.stopped) return json(res, 409, { error: '无状态写作已在进行中' });
        const model = body.model || book.model || cfg.defaultModel;
        if (body.model) { try { setBookModel(slug, body.model); } catch {} }
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
          const r = await sendToBook(slug, task, cfg);
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
    if (p === '/api/config') { const out = updateConfig(body.patch || body); return json(res, 200, out); }
    return json(res, 404, { error: 'not found' });
  }
  json(res, 405, { error: 'method not allowed' });
}

function bootstrap(cfg) {
  return {
    config: cfg,
    models: detectAll(),
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
  const real = codexTokensForDir(book.dir) + claudeTokensForDir(book.dir);
  return real || bookUsage(book.slug) || 0;
}
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
// 确保本进程在监控这本书：窗口活着但没人 autopilot（如另起进程/重启后）就重新挂上，保证插完指令还能自动续。
async function ensureAutopilot(slug, cfg) {
  const st = rt.get(slug);
  if (st?.session?.autopilot) return false;
  try {
    const h = await attachAutopilot(slug, cfg, (e) => pushLog(slug, e), mkFresh(slug, cfg));
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
  const session = await startWriting({ book, model: useModel, instruction, cfg, onLog: (e) => pushLog(slug, e), onFreshRestart: mkFresh(slug, cfg) });
  rtOf(slug).session = session;
  return session;
}

async function doWrite(body, cfg, res) {
  const book = getBook(body.book);
  if (!book) return json(res, 400, { error: '找不到书：' + body.book });
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
  const instruction = body.task || (book.imported
    ? buildResumeInstruction(book)
    : `请阅读 AGENTS.md 写作规范与 novel_bible.md，续写下一批 ${book.standards?.batchSize || 3} 章并自检。`);
  const slug = book.slug;
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
        const r = await sendToBook(slug, instruction, cfg);
        pushLog(slug, { level: 'act', msg: '窗口已在运行 → 直接续写指令已送达' });
        await ensureAutopilot(slug, cfg);
        return json(res, 200, { ...r, mode: 'inserted' });
      } catch { /* 窗口其实已死 → 落到下面重开 */ if (getSession(slug)) { try { removeSession(slug); } catch {} } rt.delete(slug); }
    }
  }
  rtOf(slug).logs = [];
  try {
    const session = await startWriting({
      book, model, instruction, cfg,
      onLog: (e) => pushLog(slug, e),
      onFreshRestart: mkFresh(slug, cfg),
    });
    rtOf(slug).session = session;
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
function serveStatic(p, res) {
  let rel = p === '/' ? '/index.html' : p;
  const file = path.join(UI_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function slugOf(idOrSlug) { const b = getBook(idOrSlug); return b ? b.slug : idOrSlug; }
// 对外返回配置时【隐藏 API Key 明文】，只暴露「是否已设置」。含 Gemini 与三家 API 模型的 key。
function maskConfig(cfg) {
  const api = cfg.api || {};
  const maskApi = {};
  for (const prov of ['zhipu', 'deepseek', 'dashscope']) {
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
