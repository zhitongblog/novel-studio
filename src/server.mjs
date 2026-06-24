// 引擎服务层：HTTP REST + SSE。作为长驻进程托管所有写作会话与 autopilot，
// 给 Tauri/网页前端提供接口。复用全部既有模块，不重写编排逻辑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, updateConfig } from './config.mjs';
import { listBooksWithStats, createBook, getBook, importBook, setBookStyle, deleteBook, detectTitleFromDir, setBookTarget, setBookModel, setBookSynopsis, setBookStatus, renameBook, setBookPublish, setBookFanqieStatus, setBookWriteMode } from './books.mjs';
import { STYLES } from './styles.mjs';
import { recommendStyle } from './planner.mjs';
import { detectAll } from './models.mjs';
import { listInstances, instanceIds, findUntermExe, findUntermCli, readProxyConfig } from './unterm.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, stopBook, streamBook, attachAutopilot } from './attach.mjs';
import { loadUsage, bookUsage, codexTokensForDir, claudeTokensForDir } from './usage.mjs';
import { proposeTitles, buildKickoffInstruction, buildResumeInstruction, buildReviewInstruction, generateSynopsis, buildFinaleInstruction, buildRewriteInstruction, buildReprojectInstruction } from './planner.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { reviewOutline, snapshotOutline, reviewEnding, buildReviseInstruction, buildEndingRenudgeInstruction } from './editor.mjs';
import { getPending, clearPending, setReviewEvery, getReviewEvery, getReviewDefault, setResume } from './pending.mjs';
import { listBookFiles, readBookFile, saveBookFile, renumberGlobalChapters } from './files.mjs';
import { previewPublish, publishToFanqie, republishRange } from './publish.mjs';
import { listProfiles as listUnzooProfiles, getFanqieBooks } from './fanqie.mjs';
import { getCompletionReport, runFinaleClosure, locateCompletion, buildCompletionNote } from './finale.mjs';
import { previewFanqieImport, importFromFanqie } from './import_fanqie.mjs';
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
    if (p === '/api/book/pending') {   // 写作台重开时恢复"待确认审稿/审核"动作条
      const slug = slugOf(u.searchParams.get('book') || '');
      const pend = getPending(slug);
      const reviewEvery = getReviewEvery(slug);
      const base = { reviewEvery, writeMode: reviewEvery > 0 ? 'review' : 'auto' };
      if (!pend) return json(res, 200, { pending: false, ...base });
      return json(res, 200, {
        pending: true, kind: pend.kind || 'outline', scope: pend.scope,
        file: path.basename(pend.file || ''), critique: pend.critique || '',
        chapters: pend.chapters, n: pend.n, ...base,
      });
    }
    if (p === '/api/env') {   // 环境自检：unterm 路径 + 模型 + 代理 + 实例 + 书库（供环境页展示与操作）
      const proxy = readProxyConfig();
      return json(res, 200, {
        platform: process.platform,
        untermExe: findUntermExe() || '',
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
      // 立项时选择写作模式（全自动 / 逐批审核）；startWriting 会据 book.writeMode 播种运行时审核开关
      if (body.writeMode != null) {
        const mode = body.writeMode === 'review' ? 'review' : 'auto';
        const every = mode === 'review' ? Math.max(1, Math.floor(Number(body.reviewEvery) || 1)) : 0;
        try { setBookWriteMode(book.slug, mode, every || 1); } catch {}
      }
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
        if (body.apply) {
          try { snapshotOutline(book, pend.scope); } catch {}
          instr = buildReviseInstruction(book, pend.scope, pend.file);
          pushLog(book.slug, { level: 'act', msg: `已采纳审稿意见（${pend.scope}）→ 作者据此修订大纲` });
        } else {
          instr = `本次不采纳主编审稿意见、不修改大纲，请按既有大纲继续写【${pend.scope}】范围的正文。`;
          pushLog(book.slug, { level: 'act', msg: `已跳过审稿意见（${pend.scope}）→ 不改大纲，继续` });
        }
        clearPending(book.slug);
        if (sessionLive(book.slug)) { try { await sendToBook(book.slug, instr, cfg); } catch {} }
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
        if (sessionLive(book.slug)) {
          const r = await sendToBook(book.slug, instruction, cfg);
          pushLog(book.slug, { level: 'act', msg: (isRe ? '整本重立项' : '范围重写：' + body.range) + ' 指令已穿插' + (hash ? '（已存档 ' + hash + '）' : '') });
          await ensureAutopilot(book.slug, cfg);
          return json(res, 200, { ...r, mode: 'inserted', snapshot: hash });
        }
        rtOf(book.slug).logs = [];
        const session = await startWriting({ book, model: book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e) });
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
        const session = await startWriting({ book, model: book.model || cfg.defaultModel, instruction, cfg, onLog: (e) => pushLog(book.slug, e) });
        rtOf(book.slug).session = session;
        return json(res, 200, { ok: true, mode: 'started', instance: session.instance.id, pane: session.paneId });
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
      const st = rt.get(slug);
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
  // 开写前选择写作模式（全自动 / 逐批审核）：持久化 + 立即热生效（含已在跑的窗口）
  if (body.writeMode != null) {
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
