// 高层"书"操作：创建（注册 + scaffold + profile）、列表带统计
import fs from 'node:fs';
import path from 'node:path';
import { loadBooks, upsertBook, getBook, slugify, newId, removeBook } from './store.mjs';
import { scaffoldBook, refreshContext } from './scaffold.mjs';
import { ensureProfile, cli, closeWindow } from './unterm.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { getStyle } from './styles.mjs';
import { resolveRomance, DEFAULT_ROMANCE } from './romance.mjs';

// 删除一本书：停会话、删 profile、移出书架；可选连磁盘文件夹一起删（危险）
export function deleteBook(slugOrId, { deleteFiles = false } = {}) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  // 收窗：先关 pane 再杀窗口进程（0.65 起 agent 不挂在窗口进程下）。不 await，删书流程照常同步返回。
  try {
    const s = getSession(b.slug);
    if (s) {
      closeWindow({ id: s.instanceId, mcp_port: s.mcp_port, auth_token: s.auth_token, pid: s.pid, pane: s.pane }).catch(() => {});
      removeSession(b.slug);
    }
  } catch {}
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

// 写作模式：'auto'(全自动) | 'review'(逐批审核·半自动)。review 时 reviewEvery=每几批停下等审核(默认1)。
// 持久化进 book.writeMode/book.reviewEvery：作为开写默认值、并在重启后恢复。运行时的实时开关另存内存(pending store)。
export function setBookWriteMode(slugOrId, mode, reviewEvery) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const m = mode === 'review' ? 'review' : 'auto';
  b.writeMode = m;
  if (m === 'review') b.reviewEvery = Math.max(1, Math.floor(Number(reviewEvery) || 1));
  else delete b.reviewEvery;
  upsertBook(b);
  return b;
}

// 规划模式：
//   'compass'   全书粗罗盘（默认）：AI 先出每卷一句话走向，之后逐卷共创章级大纲
//   'freehand'  探索式·只给手法：bible 只有写作手法+主角名+故事概述，全书无任何大纲，
//               作者逐段给情节、AI 自拆 3–5 章（见 cowrite.writeChaptersFromPlot）
//   'discovery' 旧版探索式（保留兼容：老书仍走"逐卷共创大纲"）
// 影响立项指令、AGENTS.md 里的大纲闸、以及写作台是否显示「🧭 本卷大纲」。
export function setBookPlanMode(slugOrId, mode) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.planMode = ['discovery', 'freehand'].includes(mode) ? mode : 'compass';
  upsertBook(b);
  return b;
}

// 参与度（用户视角的一个开关，派生底层的 writeMode/reviewEvery/大纲门）：
//   'auto'    放手写 · 全自动——不停，卷口大纲也自动采纳修订
//   'volume'  卷口把关——平时自动写，只在【开新卷/立项的大纲】处停下让你定（推荐默认）
//   'chapter' 盯着写——每批写完都停下等你过目
export function setParticipation(slugOrId, level) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const lv = ['auto', 'volume', 'chapter'].includes(level) ? level : 'volume';
  b.participation = lv;
  b.writeMode = lv === 'chapter' ? 'review' : 'auto';
  if (lv === 'chapter') b.reviewEvery = 1; else delete b.reviewEvery;
  b.outlineApprove = lv !== 'auto';     // 卷口大纲门是否停下等你逐条挑
  upsertBook(b);
  return b;
}
// 读一本书的参与度；旧书没存过 → 从 writeMode 兜底(review→chapter，否则 volume)。
export function participationOf(bookOrSlug) {
  const b = typeof bookOrSlug === 'string' ? getBook(bookOrSlug) : bookOrSlug;
  if (!b) return 'volume';
  if (b.participation) return b.participation;
  return b.writeMode === 'review' ? 'chapter' : 'volume';
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

// 设置一本书的连载状态：'连载中'(默认/清空) | '收尾中' | '已完本'。已完本时记 completedAt。
export function setBookStatus(slugOrId, status) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const allowed = ['连载中', '收尾中', '已完本'];
  if (!allowed.includes(status)) throw new Error('未知状态：' + status);
  b.status = status;
  if (status === '已完本') b.completedAt = new Date().toISOString();
  if (status === '连载中') { delete b.completedAt; }
  upsertBook(b);
  return b;
}

// 记录番茄平台侧状态快照（供书卡显示"内部 + 番茄"双状态、对账用）。snap={status,totalWords,lastChapterNum,at}。
export function setBookFanqieStatus(slugOrId, snap) {
  const b = getBook(slugOrId);
  if (!b) return null;
  b.fanqie = { ...(b.fanqie || {}), ...(snap || {}) };
  upsertBook(b);
  return b;
}

// 中途改书名并全书生效：改 book.title，重写所有 meta 文件里的《旧名》→《新名》，重生成上下文(AGENTS等)。
// 保留 slug / profile / 目录不变 —— 避免迁移 usage/sessions/token日志、避免破坏正在引用的路径。
// 不动 chapters/ 正文(按规范正文里本就不含书名)。返回 { book, touched }。
export function renameBook(slugOrId, newTitle) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const nt = String(newTitle || '').trim();
  if (!nt) throw new Error('新书名不能为空');
  if (nt === b.title) return { book: b, touched: 0 };
  if (loadBooks().some(x => x.id !== b.id && x.title === nt)) throw new Error('已有同名书：' + nt);
  const old = b.title;
  // 收集要改写的 meta 文件（不含 chapters/ 正文）
  const files = ['novel_bible.md', 'chapter_index.md', 'continuity_ledger.md', '简介.txt'];
  try { for (const f of fs.readdirSync(path.join(b.dir, 'outlines'))) if (f.endsWith('.md')) files.push(path.join('outlines', f)); } catch {}
  let touched = 0;
  for (const rel of files) {
    const fp = path.join(b.dir, rel);
    try {
      const c = fs.readFileSync(fp, 'utf8');
      if (old && c.includes(old)) { fs.writeFileSync(fp, c.split(old).join(nt), 'utf8'); touched++; }
    } catch {}
  }
  b.title = nt;
  if (b.synopsis && old && b.synopsis.includes(old)) b.synopsis = b.synopsis.split(old).join(nt);
  upsertBook(b);
  try { refreshContext(b); } catch {}   // 重写 AGENTS.md/CLAUDE.md/GEMINI.md 带新书名
  try { if (b.synopsis) fs.writeFileSync(path.join(b.dir, '简介.txt'), b.synopsis, 'utf8'); } catch {}
  return { book: b, touched };
}

// 全书替换一个词（角色名/地名/称呼等）——【会波及全书】：改 bible/大纲/台账/索引 + 所有已写章节正文。
// dry=true 只统计不改（预览用）。调用方负责改前 git 存档以便回退。返回 {files, count}。
export function renameEntity(slugOrId, from, to, dry = false) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const f = String(from || ''), t = String(to || '');
  if (!f.trim()) throw new Error('原名不能为空');
  if (!dry && !t.trim()) throw new Error('新名不能为空');
  if (f === t) return { book: b, files: 0, count: 0 };
  const rels = ['novel_bible.md', 'chapter_index.md', 'continuity_ledger.md', '简介.txt'];
  try { for (const x of fs.readdirSync(path.join(b.dir, 'outlines'))) if (x.endsWith('.md')) rels.push(path.join('outlines', x)); } catch {}
  const cdir = path.join(b.dir, 'chapters');
  (function walk(d) { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.txt$/i.test(e.name)) rels.push(path.relative(b.dir, p)); } } catch {} })(cdir);
  let files = 0, count = 0;
  for (const rel of rels) {
    const fp = path.join(b.dir, rel);
    try {
      const c = fs.readFileSync(fp, 'utf8');
      const n = c.split(f).length - 1;
      if (n > 0) { count += n; files++; if (!dry) fs.writeFileSync(fp, c.split(f).join(t), 'utf8'); }
    } catch {}
  }
  if (!dry) { try { refreshContext(b); } catch {} }
  return { book: b, files, count };
}

// 改名不简单：一个角色有多种叫法。据 旧名→新名 推导候选替换对(全名/单名/姓+称呼/称呼+姓/姓X)。
// 【不含】裸姓单字替换——那会误伤村名(陈家洼)和其他同姓角色，故只给"姓+称呼"这类明确指向本角色的组合，由用户勾选确认。
export function suggestRenamePairs(oldName, newName) {
  const on = String(oldName || '').trim(), nn = String(newName || '').trim();
  const out = [];
  if (!on || !nn || on === nn) return out;
  const push = (f, t, kind) => { if (f && t && f !== t && !out.some(x => x.from === f)) out.push({ from: f, to: t, kind }); };
  push(on, nn, '全名');
  const oSur = on[0], oGiven = on.slice(1), nSur = nn[0], nGiven = nn.slice(1);
  if (oGiven && nGiven) push(oGiven, nGiven, '单名');
  if (oSur && nSur && oSur !== nSur) {
    for (const s of ['老师', '先生', '总', '老板', '哥', '姐', '爷', '叔', '工', '董', '局长', '处长', '科长', '经理']) push(oSur + s, nSur + s, '称呼');
    for (const p of ['老', '小', '大', '阿']) push(p + oSur, p + nSur, '称呼');
    push('姓' + oSur, '姓' + nSur, '姓氏');
  }
  return out;
}

// 收集本书要参与替换的所有文件(设定/大纲/台账/索引/简介 + 所有已写章节)。
function renameTargetRels(dir) {
  const rels = ['novel_bible.md', 'chapter_index.md', 'continuity_ledger.md', '简介.txt'];
  try { for (const x of fs.readdirSync(path.join(dir, 'outlines'))) if (x.endsWith('.md')) rels.push(path.join('outlines', x)); } catch {}
  (function walk(d) { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.txt$/i.test(e.name)) rels.push(path.relative(dir, p)); } } catch {} })(path.join(dir, 'chapters'));
  return rels;
}

// 多对一起替换(角色改名的正确姿势)。dry=true 只逐对统计命中。apply 时按 from 长度降序替换(先全名后单名，避免"守一"先换掉导致"陈守一"匹配不上)。
export function applyRenamePairs(slugOrId, pairs, dry = false) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  const list = (pairs || []).filter(p => p && p.from && p.to && p.from !== p.to)
    .sort((a, b2) => b2.from.length - a.from.length);
  const per = list.map(p => ({ from: p.from, to: p.to, count: 0 }));
  if (!list.length) return { files: 0, count: 0, per };
  const rels = renameTargetRels(b.dir);
  let filesTouched = 0, total = 0;
  for (const rel of rels) {
    const fp = path.join(b.dir, rel);
    try {
      let c = fs.readFileSync(fp, 'utf8');
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const n = c.split(list[i].from).length - 1;
        if (n > 0) { per[i].count += n; total += n; if (!dry) { c = c.split(list[i].from).join(list[i].to); changed = true; } }
      }
      if (changed) { fs.writeFileSync(fp, c, 'utf8'); filesTouched++; }
    } catch {}
  }
  if (!dry) { try { refreshContext(b); } catch {} }
  return { files: filesTouched, count: total, per };
}

// 番茄发布配置：account(Unzoo profilePath)、番茄 bookId/书名、是否按卷建卷、每日发布数、预约起始日期/时间、间隔、自动发布开关、预设触发章数。
export function setBookPublish(slugOrId, patch) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.publish = { ...(b.publish || {}), ...(patch || {}) };
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

// 设定/更换一本书的感情线档位（none | light | warm | bold，或自定义 {name,rules}）。
// 改完立刻 refreshContext——写作规范(AGENTS.md 等)要当场跟上，否则下一批还按旧档位写。
export function setBookRomance(slugOrId, romanceInput) {
  const b = getBook(slugOrId);
  if (!b) throw new Error('找不到书：' + slugOrId);
  b.romance = resolveRomance(romanceInput);
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
  'agents.md', 'claude.md', 'gemini.md', 'qwen.md', 'readme.md', '主线伏笔表.md',
]);
// 不是章节的文件名前缀（设定/笔记/方案/简介一类）。白名单挡不住新出现的文件——
// 历史 bug：`简介.txt` 被当章节归进 chapters/，补进白名单后，换成 `重写方案-011起.md`
// 又被吞了一次（还带着 011 这个章号数字）。所以改成【正向判定 + 前缀否定】双保险。
const NON_CHAPTER_NAME = /^(简介|梗概|大纲|细纲|设定|方案|计划|笔记|说明|备注|人物|台账|素材|参考|重写|封面|发布|待办|todo|note|draft|review)/i;
// 一个平铺文件像不像正文章节：非元文件、非设定笔记类命名、且带章号数字（章节一定有章号）。
function looksLikeChapterFile(name) {
  if (META_FILES.has(name.toLowerCase())) return false;
  if (NON_CHAPTER_NAME.test(name)) return false;
  return /\d/.test(name);
}
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
  const flat = entries.filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name) && looksLikeChapterFile(e.name));
  return flat.length >= 2;
}

// 卷目录名：优先复用 chapters/ 下【已存在】的该卷目录——它可能带卷名（「卷01县城开张」）。
// 历史 bug：写作指令里硬拼 `卷` + 卷号，于是带卷名的书每次开写都往 chapters/卷01/ 落盘，
// 跟已有的 chapters/卷01县城开张/ 分叉成两个卷目录（之前只手工并过目录，没修生成侧）。
export function volumeDirName(bookDir, volNum = 1) {
  const pad = '卷' + String(volNum).padStart(2, '0');
  try {
    const hit = fs.readdirSync(path.join(bookDir, 'chapters'), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(pad))
      .sort((a, b) => b.name.length - a.name.length)[0];   // 带卷名的更具体，优先
    if (hit) return hit.name;
  } catch {}
  return pad;
}

// 确定性归档：把根目录下平铺的正文 .txt/.md（排除元文件）批量移进 chapters/卷01/。
// 由代码做这件体力活（瞬间完成、绝不漏、幂等可重复跑），AI 只负责重建索引/bible/台账。
// 自然排序按文件名里的数字；目标重名不覆盖（加 _dup 后缀）。返回 {moved, names}。
export function archiveFlatChapters(dir, volume = '卷01') {
  if (!dir || !fs.existsSync(dir)) return { moved: 0, names: [] };
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { moved: 0, names: [] }; }
  const flats = ents.filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name) && looksLikeChapterFile(e.name));
  if (!flats.length) return { moved: 0, names: [] };
  const volDir = path.join(dir, 'chapters', volume);
  try { fs.mkdirSync(volDir, { recursive: true }); } catch {}
  flats.sort((a, b) => {
    const na = parseInt((a.name.match(/\d+/) || [])[0] || '0', 10);
    const nb = parseInt((b.name.match(/\d+/) || [])[0] || '0', 10);
    return na - nb || a.name.localeCompare(b.name, 'zh');
  });
  const moved = [];
  for (const e of flats) {
    const src = path.join(dir, e.name);
    let dst = path.join(volDir, e.name);
    if (fs.existsSync(dst)) { const ext = path.extname(e.name); dst = path.join(volDir, e.name.slice(0, -ext.length) + '_dup' + ext); }
    try { fs.renameSync(src, dst); moved.push(e.name); } catch {}
  }
  return { moved: moved.length, names: moved };
}

// 简单中文数字→整数（支持 一~九十九、十/十二/二十/二十三、约/共前缀）。纯数字直接 parse。
function cnToInt(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : (d[a] || 0);
    const ones = b === '' ? 0 : (d[b] || 0);
    return tens * 10 + ones;
  }
  return d[s] || 0;
}
function readBible(dir) { try { return fs.readFileSync(path.join(dir, 'novel_bible.md'), 'utf8'); } catch { return ''; } }

// 规划总卷数：standards.volumes，否则 bible「卷数：N」(支持中文数字)。未知 0。
export function plannedVolumes(book) {
  const sv = parseInt(book?.standards?.volumes, 10);
  if (sv > 0) return sv;
  const m = readBible(book.dir).match(/卷数[：:]\s*[约共]?\s*([0-9一二三四五六七八九十两]+)/);
  return m ? cnToInt(m[1]) : 0;
}
// 每卷约章数：standards.chaptersPerVolume，否则 bible「每卷约章数：N」。未知 0。
function chaptersPerVol(book) {
  const c = parseInt(book?.standards?.chaptersPerVolume, 10);
  if (c > 0) return c;
  const m = readBible(book.dir).match(/每卷约?章数[：:]\s*[约]?\s*([0-9一二三四五六七八九十百两]+)/);
  return m ? cnToInt(m[1]) : 0;
}
// 规划总章数（判断是否临近结尾的可靠口径）：目标章数 ＞ bible「全书章数」＞ 卷数×每卷章数。未知 0。
export function plannedTotalChapters(book) {
  const t = parseInt(book?.targetChapters, 10);
  if (t > 0) return t;
  const m = readBible(book.dir).match(/全书章数[：:]\s*[约]?\s*([0-9一二三四五六七八九十百千两]+)/);
  if (m) { const n = cnToInt(m[1]); if (n > 0) return n; }
  const pv = plannedVolumes(book), cpv = chaptersPerVol(book);
  return (pv > 0 && cpv > 0) ? pv * cpv : 0;
}
export { chaptersPerVol };
// 当前所在卷：取【有章节的最高卷号】。对"全局连续编号"和"每卷独立编号(如赵云每卷001-040)"都正确，
// 也避开空卷目录(0 章不计)。比"最大章号所在卷"可靠——后者在每卷独立编号时会误判成卷01。
export function currentVolume(book) {
  try {
    const cdir = path.join(book.dir, 'chapters');
    let mx = 0;
    for (const e of fs.readdirSync(cdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const vm = e.name.match(/卷\s*0*(\d+)/); if (!vm) continue;
      const vol = parseInt(vm[1], 10);
      let has = false;
      try { has = fs.readdirSync(path.join(cdir, e.name)).some(f => /\.txt$/i.test(f)); } catch {}
      if (has && vol > mx) mx = vol;
    }
    return mx;
  } catch { return 0; }
}

// 导入归档·卷名文件夹版：把根目录下"卷名文件夹"(如 01_常山雪 / 卷03 / 第5卷，内含 .txt)整体迁进 chapters/卷NN/。
// 配合 archiveFlatChapters(平铺单文件)，覆盖用户常见的两种非标准导入结构。幂等。
export function archiveVolumeFolders(dir) {
  if (!dir || !fs.existsSync(dir)) return { moved: 0, vols: 0 };
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { moved: 0, vols: 0 }; }
  const SKIP = new Set(['chapters', 'outlines', 'reviews', '.git', '.studio', 'node_modules']);
  let moved = 0, vols = 0;
  for (const e of ents) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const m = e.name.match(/^0*(\d+)[ _\-．.、]/) || e.name.match(/^(?:卷|第)\s*0*(\d+)/);
    if (!m) continue;
    const src = path.join(dir, e.name);
    let files = [];
    try { files = fs.readdirSync(src).filter(f => /\.txt$/i.test(f) && !META_FILES.has(f.toLowerCase())); } catch {}
    if (!files.length) continue;
    const dst = path.join(dir, 'chapters', '卷' + String(parseInt(m[1], 10)).padStart(2, '0'));
    try { fs.mkdirSync(dst, { recursive: true }); } catch {}
    for (const f of files) {
      let target = path.join(dst, f);
      if (fs.existsSync(target)) { const ext = path.extname(f); target = path.join(dst, f.slice(0, -ext.length) + '_dup' + ext); }
      try { fs.renameSync(path.join(src, f), target); moved++; } catch {}
    }
    try { if (fs.readdirSync(src).length === 0) fs.rmdirSync(src); } catch {}
    vols++;
  }
  return { moved, vols };
}

// 清除一本书的 flatImport 标记（归档已由代码处理完，停止续写指令里的归档噪音）。
export function clearFlatImport(slugOrId) {
  const b = getBook(slugOrId);
  if (b && b.flatImport) { b.flatImport = false; upsertBook(b); }
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
  // 非标准导入结构 → 代码立刻归位进 chapters/（两种：平铺单文件 + 卷名文件夹），AI 只剩重建索引。
  try { archiveFlatChapters(dir); } catch {}
  try { archiveVolumeFolders(dir); } catch {}
  book.flatImport = false;     // 体力活已由代码完成，不再下"AI 去搬文件"的指令
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
    // 感情线档位（none/light/warm/bold）：建书时选一次，之后每次生成写作规范都带着。
    // 不选就走推荐档 warm——留空等于把分寸交给模型自由裁量，那正是感情线被写丢的原因。
    romance: resolveRomance(opts.romance || DEFAULT_ROMANCE),
    // 规划模式要在 scaffold 之前定下来：freehand 的骨架不铺大纲模板、bible 模板也只有手法三节
    planMode: ['discovery', 'freehand'].includes(opts.planMode) ? opts.planMode : 'compass',
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
