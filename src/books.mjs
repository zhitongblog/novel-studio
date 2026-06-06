// 高层"书"操作：创建（注册 + scaffold + profile）、列表带统计
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBooks, upsertBook, getBook, slugify, newId, removeBook } from './store.mjs';
import { scaffoldBook, refreshContext } from './scaffold.mjs';
import { ensureProfile, cli } from './unterm.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { getStyle } from './styles.mjs';

// 删除一本书：停会话、删 profile、移出书架；可选连磁盘文件夹一起删（危险）
export function deleteBook(slugOrId, { deleteFiles = false } = {}) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  try { const s = getSession(b.slug); if (s) { spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F']); removeSession(b.slug); } } catch {}
  try { if (b.profile) cli(['profile', 'delete', b.profile, '--yes']); } catch {}
  removeBook(b.slug);
  let filesDeleted = false;
  if (deleteFiles && b.dir) {
    try { fs.rmSync(b.dir, { recursive: true, force: true }); filesDeleted = true; } catch {}
  }
  return { ok: true, title: b.title, slug: b.slug, filesDeleted };
}

// 把文风输入(id / {id,tweak} / 自定义{name,rules})解析成自包含对象
export function resolveStyle(input) {
  if (!input) return null;
  if (typeof input === 'string') { const s = getStyle(input); return s ? { id: s.id, name: s.name, short: s.short, rules: s.rules } : null; }
  const base = input.id ? getStyle(input.id) : null;
  if (base) return { id: base.id, name: base.name, short: base.short, rules: base.rules, tweak: input.tweak || input.reason || '' };
  if (input.rules) return { id: input.id || 'custom', name: input.name || '自定义', short: input.short || '', rules: input.rules, tweak: input.tweak || '' };
  return null;
}

// 设定"目标章节数上限"（0=不限）。autopilot 写到这个章数就停。
export function setBookTarget(slugOrId, n) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.targetChapters = Math.max(0, Math.floor(Number(n) || 0));
  upsertBook(b);
  return b;
}

// 设定/更换一本书默认使用的模型（codex|claude|gemini），持久化进 book.model。
// 这样卡片、续写(resume)、下次打开的默认值都会跟上选择；运行中的旧窗口需停掉重开才换。
export function setBookModel(slugOrId, model) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  if (!model) throw new Error('未指定模型');
  b.model = String(model);
  upsertBook(b);
  return b;
}

// 存一本书的简介（约150字推广文案），同时落一份 简介.txt 方便直接复制出去。
export function setBookSynopsis(slugOrId, text) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.synopsis = String(text || '').trim();
  b.synopsisAt = new Date().toISOString();
  upsertBook(b);
  try { fs.writeFileSync(path.join(b.dir, '简介.txt'), b.synopsis, 'utf8'); } catch {}
  return b;
}

// 设定/更换一本书的文风，并重写其写作规范文件
export function setBookStyle(slugOrId, styleInput) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.style = resolveStyle(styleInput);
  upsertBook(b);
  refreshContext(b);
  return b;
}

// 从文件夹已有文件里探测书名：优先 novel_bible.md / chapter_index.md 里的《书名》，否则用文件夹名
export function detectTitleFromDir(dir) {
  for (const f of ['novel_bible.md', 'chapter_index.md']) {
    try {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 400);
      const m = head.match(/[《【]([^》】\n]{1,40})[》】]/);
      if (m && m[1].trim()) return m[1].trim();
    } catch {}
  }
  // 退而求其次：找最像书名的 .md 标题
  try {
    const bible = fs.readFileSync(path.join(dir, 'novel_bible.md'), 'utf8').slice(0, 200);
    const h = bible.match(/^#\s*(.{1,40})/m);
    if (h) return h[1].replace(/设定圣经.*$/, '').replace(/[《》]/g, '').trim();
  } catch {}
  return path.basename(dir);
}

// 非正文的元文件名（归档时排除，不当作章节）
const META_FILES = new Set([
  'novel_bible.md', 'chapter_index.md', 'continuity_ledger.md',
  'agents.md', 'claude.md', 'gemini.md', 'readme.md', '主线伏笔表.md',
]);
// 检测"已分章但平铺在目录根下、不在 chapters/ 里"的导入布局：
// 根目录有 ≥2 个非元文件的 .txt/.md，且 chapters/ 下还没有正文 → 需要先归档。
function detectFlatChapters(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  const chaptersDir = path.join(dir, 'chapters');
  let chaptersHasText = false;
  if (fs.existsSync(chaptersDir)) {
    const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true })
      .some(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(txt|md)$/i.test(e.name)); } catch { return false; } };
    chaptersHasText = walk(chaptersDir);
  }
  if (chaptersHasText) return false;  // 已是结构化章节，无需归档
  const flat = entries.filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name) && !META_FILES.has(e.name.toLowerCase()));
  return flat.length >= 2;
}

// 导入一个已有(可能写了一半)的文件夹，注册成"正在写作的书"，可继续写。
// scaffoldBook 是安全的：只补缺失的结构/上下文/git，不覆盖已有 novel_bible.md / chapter_index.md / 章节。
export function importBook(opts, cfg) {
  const dir = path.resolve(opts.dir || '');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在：' + (opts.dir || ''));
  const flatImport = detectFlatChapters(dir);   // 在 scaffold 建空 chapters/ 之前先判定
  const title = (opts.title || detectTitleFromDir(dir)).trim();
  const books = loadBooks();
  if (books.some(b => path.resolve(b.dir).toLowerCase() === dir.toLowerCase())) throw new Error('该目录已在书架里');
  if (books.some(b => b.title === title)) throw new Error('同名书已存在：' + title + '（可改个标题再导入）');
  const slug = slugify(title);
  const book = {
    id: newId(), title, slug, dir, profile: 'book-' + slug,
    genre: opts.genre || '（导入）', model: opts.model || cfg.defaultModel,
    createdAt: new Date().toISOString(), imported: true, flatImport,
    standards: {
      totalWords: opts.totalWords || '', volumes: '', chaptersPerVolume: '',
      batchSize: opts.batchSize || 3, targetCharsLo: 3000, targetCharsHi: 3600, minChars: 3000, system: '',
    },
  };
  scaffoldBook(book);          // 补缺失结构 + 写三模型上下文 + git init（受信）
  upsertBook(book);
  try { ensureProfile(book.profile); } catch {}
  return book;
}

export function createBook(opts, cfg) {
  const title = (opts.title || '').trim();
  if (!title) throw new Error('书名不能为空');
  if (loadBooks().some(b => b.title === title)) throw new Error('同名书已存在：' + title);

  const slug = slugify(title);
  const dir = opts.dir || path.join(cfg.workspace, slug);
  const profile = 'book-' + slug;
  const book = {
    id: newId(),
    title,
    slug,
    dir,
    profile,
    genre: opts.genre || '',
    model: opts.model || cfg.defaultModel,
    style: resolveStyle(opts.style),   // { id, name, short, rules, tweak } 或 null
    createdAt: new Date().toISOString(),
    standards: {
      totalWords: opts.totalWords || '',
      volumes: opts.volumes || '',
      chaptersPerVolume: opts.chaptersPerVolume || '',
      batchSize: opts.batchSize || 3,
      targetCharsLo: opts.targetCharsLo || 3000,
      targetCharsHi: opts.targetCharsHi || 3600,
      minChars: opts.minChars || 3000,
      system: opts.system || '',
    },
  };
  scaffoldBook(book);
  upsertBook(book);
  // 预创建 profile（best-effort，失败不阻断；写作前还会再确保一次）
  try { ensureProfile(profile); } catch {}
  return book;
}

// 统计一本书：章节数、字节、卷列表、最大全局章号
export function bookStats(book) {
  const chaptersDir = path.join(book.dir, 'chapters');
  let chapters = 0, bytes = 0, maxChapter = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.txt')) {
        chapters++;
        const m = e.name.match(/^(\d{1,4})/);
        if (m) maxChapter = Math.max(maxChapter, parseInt(m[1], 10));
        try { bytes += fs.statSync(p).size; } catch {}
      }
    }
  };
  walk(chaptersDir);
  // 卷列表 = chapters/ 下的子目录名（按名称排序）
  let volumes = [];
  try {
    volumes = fs.readdirSync(chaptersDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {}
  let cover = false, coverMtime = 0, coverBg = false, coverBgMtime = 0;
  try { const cs = fs.statSync(path.join(book.dir, 'cover.png')); cover = true; coverMtime = Math.floor(cs.mtimeMs); } catch {}
  try { const cs = fs.statSync(path.join(book.dir, 'cover_bg.png')); coverBg = true; coverBgMtime = Math.floor(cs.mtimeMs); } catch {}
  return { chapters, kb: Math.round(bytes / 1024), volumes, maxChapter, cover, coverMtime, coverBg, coverBgMtime };
}

export function listBooksWithStats() {
  return loadBooks().map(b => ({ ...b, stats: bookStats(b) }));
}

export { getBook };
