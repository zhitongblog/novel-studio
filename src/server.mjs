// 引擎服务层：HTTP REST + SSE。作为长驻进程托管所有写作会话与 autopilot，
// 给 Tauri/网页前端提供接口。复用全部既有模块，不重写编排逻辑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, updateConfig } from './config.mjs';
import { listBooksWithStats, createBook, getBook, importBook, setBookStyle, deleteBook, detectTitleFromDir, setBookTarget, setBookModel, setBookSynopsis } from './books.mjs';
import { STYLES } from './styles.mjs';
import { recommendStyle } from './planner.mjs';
import { detectAll } from './models.mjs';
import { listInstances, instanceIds } from './unterm.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, stopBook, streamBook, attachAutopilot } from './attach.mjs';
import { loadUsage, bookUsage, codexTokensForDir, claudeTokensForDir } from './usage.mjs';
import { proposeTitles, buildKickoffInstruction, buildResumeInstruction, buildReviewInstruction, generateSynopsis } from './planner.mjs';
import { reviewOutline, snapshotOutline } from './editor.mjs';
import { generateCoverBg, buildArtPrompt } from './imagegen.mjs';

const UI_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'ui');

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

export function runServer(port = 8787) {
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
  });
  return server;
}

// 引擎(重)启动时，把 autopilot 重新挂到仍在运行的写作会话上，避免重启后会话失去监控。
async function reattachLiveSessions() {
  const cfg = loadConfig();
  for (const s of listSessions()) {
    if (rt.get(s.slug)?.session) continue;
    try {
      const h = await attachAutopilot(s.slug, cfg, (e) => pushLog(s.slug, e));
      rtOf(s.slug).session = { autopilot: h.autopilot, mcp: h.mcp, reattached: true };
      pushLog(s.slug, { msg: '引擎启动 → 已重新挂载 autopilot 继续监控' });
    } catch (e) { /* 会话可能已死，listSessions 会自动清理 */ }
  }
}

async function api(p, req, res, u) {
  const cfg = loadConfig();
  if (req.method === 'GET') {
    if (p === '/api/book/cover') {
      const book = getBook(u.searchParams.get('book'));
      const f = book && path.join(book.dir, 'cover.png');
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('no cover'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/book/cover-bg') {   // AI 生成的封面底图（未叠字），给前端 canvas 当背景
      const book = getBook(u.searchParams.get('book'));
      const f = book && path.join(book.dir, 'cover_bg.png');
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('no bg'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/bootstrap') return json(res, 200, bootstrap(cfg));
    if (p === '/api/books') return json(res, 200, withUsage(listBooksWithStats()));
    if (p === '/api/sessions') return json(res, 200, sessionsInfo());
    if (p === '/api/usage') {
      const books = {};
      for (const b of listBooksWithStats()) { const t = bookTokens(b); if (t) books[b.slug] = { total: t, sessions: {} }; }
      return json(res, 200, { books });
    }
    if (p === '/api/models') return json(res, 200, detectAll());
    if (p === '/api/styles') return json(res, 200, STYLES);
    if (p === '/api/config') return json(res, 200, { ...cfg, gemini: { ...cfg.gemini, apiKey: cfg.gemini?.apiKey ? '***已设置***' : '', hasKey: !!cfg.gemini?.apiKey } });
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
    if (p === '/api/config/update') {   // 保存设置（如 Gemini key / 代理）
      try { const next = updateConfig(body.patch || {}); const safe = { ...next, gemini: { ...next.gemini, apiKey: next.gemini?.apiKey ? '***已设置***' : '' } }; return json(res, 200, { ok: true, config: safe }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/book/set-style') {
      try { const b = setBookStyle(body.book, body.style); return json(res, 200, { ok: true, style: b.style }); }
      catch (e) { return json(res, 400, { error: e.message }); }
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
      const instruction = buildKickoffInstruction(book, body.theme || body.genre, body.words);
      rtOf(book.slug).logs = [];
      try {
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e) });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, book: { ...book, stats: { chapters: 0, kb: 0 }, tokens: 0 }, instance: session.instance.id, pane: session.paneId });
      } catch (e) { pushLog(book.slug, { level: 'error', msg: e.message }); return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/book/review') {
      const book = getBook(body.book);
      if (!book) return json(res, 400, { error: '找不到书：' + body.book });
      const instruction = buildReviewInstruction(book, body.range, body.dims);
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
        const session = await startWriting({ book, model: body.model || book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e) });
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
      const r = stopBook(slug);
      const st = rt.get(slug); if (st?.session?.autopilot) st.session.autopilot.stop('用户停止'); if (st?.streamer) st.streamer.stop();
      rt.delete(slug);
      return json(res, 200, r);
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
function sessionsInfo() { return listSessions().map(s => ({ ...s, tokens: bookTokens(getBook(s.slug)), running: rt.has(s.slug) })); }

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
    const h = await attachAutopilot(slug, cfg, (e) => pushLog(slug, e));
    rtOf(slug).session = { ...(st?.session || {}), autopilot: h.autopilot, mcp: h.mcp };
    pushLog(slug, { level: 'act', msg: '已重新接管监控（autopilot）' });
    return true;
  } catch (e) { pushLog(slug, { level: 'warn', msg: '重新挂监控失败：' + e.message }); return false; }
}
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
  const session = await startWriting({ book, model: useModel, instruction, cfg, onLog: (e) => pushLog(slug, e) });
  rtOf(slug).session = session;
  return session;
}

async function doWrite(body, cfg, res) {
  const book = getBook(body.book);
  if (!book) return json(res, 400, { error: '找不到书：' + body.book });
  const model = body.model || book.model || cfg.defaultModel;
  // 带了模型就持久化（卡片/下次默认值/resume 全跟上）
  if (body.model) { try { setBookModel(book.slug, body.model); } catch {} }
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
  // 启动屏幕镜像（多个客户端共享一个）
  if (!r.streamer) {
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
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
