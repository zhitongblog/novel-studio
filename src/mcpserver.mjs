// Novel Studio 的 MCP stdio server：把"管理书 + 启动写作"暴露为 MCP tools，
// 供 Claude Code / 其它 MCP 客户端直接调用。零依赖，行分隔 JSON-RPC over stdio。
import { loadConfig } from './config.mjs';
import { listBooksWithStats, createBook, getBook } from './books.mjs';
import { detectAll } from './models.mjs';
import { listInstances } from './unterm.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, stopBook, streamBook } from './attach.mjs';
import { loadUsage, bookUsage } from './usage.mjs';

const TOOLS = [
  { name: 'novel_list_books', description: '列出所有已登记的书及章节统计', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_create_book', description: '新建一本书（注册 + 生成项目骨架 + 绑定 unterm profile）', inputSchema: {
    type: 'object', required: ['title'],
    properties: {
      title: { type: 'string', description: '书名' },
      genre: { type: 'string', description: '类型/卖点' },
      model: { type: 'string', enum: ['codex', 'claude', 'gemini'] },
      totalWords: { type: 'string' }, volumes: { type: 'string' },
      chaptersPerVolume: { type: 'string' }, batchSize: { type: 'number' },
    } } },
  { name: 'novel_start_writing', description: '为指定书开一个绑定 profile 的 Unterm 实例、开代理、启动选定模型并注入写作指令，随后 autopilot 自动监控应答。', inputSchema: {
    type: 'object', required: ['book'],
    properties: {
      book: { type: 'string', description: '书名或 slug' },
      model: { type: 'string', enum: ['codex', 'claude', 'gemini'] },
      task: { type: 'string', description: '写作指令，如"续写5章并自检"' },
    } } },
  { name: 'novel_models', description: '检测 codex/claude/gemini 三个 CLI 的可用性', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_instances', description: '列出运行中的 Unterm 实例', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_list_sessions', description: '列出运行中的写作会话', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_send_instruction', description: '中途穿插一条指令到正在写作的窗口（注入按键）', inputSchema: {
    type: 'object', required: ['book', 'task'],
    properties: { book: { type: 'string', description: '书名或 slug' }, task: { type: 'string', description: '要穿插的指令' } } } },
  { name: 'novel_peek_screen', description: '读取某本书写作窗口当前屏幕内容（一帧镜像）', inputSchema: {
    type: 'object', required: ['book'], properties: { book: { type: 'string' } } } },
  { name: 'novel_stop_writing', description: '停止并关闭某本书的写作窗口', inputSchema: {
    type: 'object', required: ['book'], properties: { book: { type: 'string' } } } },
  { name: 'novel_usage', description: 'Token 用量统计（可选指定 book，否则返回全部）', inputSchema: {
    type: 'object', properties: { book: { type: 'string' } } } },
];

function slugOf(idOrSlug) { const b = getBook(idOrSlug); return b ? b.slug : idOrSlug; }

async function dispatch(name, args) {
  const cfg = loadConfig();
  if (name === 'novel_list_books') return listBooksWithStats().map(b => ({ title: b.title, slug: b.slug, model: b.model, profile: b.profile, chapters: b.stats.chapters, kb: b.stats.kb, dir: b.dir }));
  if (name === 'novel_models') return detectAll();
  if (name === 'novel_instances') return listInstances().map(i => ({ id: i.id, version: i.version, mcp_port: i.mcp_port, cwd: i.cwd }));
  if (name === 'novel_list_sessions') return listSessions().map(s => ({ title: s.title, slug: s.slug, model: s.model, instance: s.instanceId, pane: s.pane, pid: s.pid, startedAt: s.startedAt }));
  if (name === 'novel_send_instruction') { const r = await sendToBook(slugOf(args.book), args.task, cfg); return { ok: true, ...r }; }
  if (name === 'novel_stop_writing') return stopBook(slugOf(args.book));
  if (name === 'novel_usage') {
    if (args.book) { const slug = slugOf(args.book); return { book: slug, total: bookUsage(slug) }; }
    return loadUsage();
  }
  if (name === 'novel_peek_screen') {
    let frame = '';
    const h = await streamBook(slugOf(args.book), cfg, (txt) => { frame = txt; }, { intervalMs: 300 });
    await new Promise(r => setTimeout(r, 700));
    h.stop();
    return { screen: frame };
  }
  if (name === 'novel_create_book') { const b = createBook(args, cfg); return { ok: true, title: b.title, dir: b.dir, profile: b.profile }; }
  if (name === 'novel_start_writing') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const model = args.model || book.model || cfg.defaultModel;
    const instruction = args.task || `请阅读 AGENTS.md 写作规范与 novel_bible.md，续写下一批 ${book.standards?.batchSize || 5} 章并自检。`;
    const logs = [];
    const sess = await startWriting({ book, model, instruction, cfg, onLog: (e) => logs.push(e.msg) });
    return { ok: true, instance: sess.instance.id, mcp_port: sess.instance.mcp_port, pane: sess.paneId, autopilot: !!cfg.autopilot.enabled, logs };
  }
  throw new Error('未知 tool：' + name);
}

export function runMcpServer() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) handle(line);
    }
  });
  // 保持存活；客户端断开 stdin 时退出
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));

  async function handle(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result, error) => {
      if (id == null) return; // 通知无需回复
      process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
    };
    try {
      if (method === 'initialize') {
        return reply({ protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'novel-studio', version: '1.0.0' } });
      }
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        const out = await dispatch(params.name, params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      }
      if (method === 'ping') return reply({});
      if (method && method.startsWith('notifications/')) return; // 忽略
      return reply(null, { code: -32601, message: 'Unknown method: ' + method });
    } catch (e) {
      return reply(null, { code: -32603, message: e.message });
    }
  }
}
