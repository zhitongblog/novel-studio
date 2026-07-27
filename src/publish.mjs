// 番茄发布编排：把 Novel Studio 已写章节，按【全局章号】与番茄后台对齐，只发"番茄还没有的新章"
// （重写过的旧章用 edit 模式去番茄找到对应章覆盖）。底层发布/编辑流程在 src/fanqie.mjs（移植自番茄发布器）。
import fs from 'node:fs';
import path from 'node:path';
import { publishBook, getFanqieMaxChapter, getFanqieVolumes, createFanqieVolumes, numToCn } from './fanqie.mjs';
import { setBookPublish } from './books.mjs';

// —— 排期起始日 ——
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function fmtYMD(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// 规则：读番茄最新章日期(latestDateStr)，晚于今天→以它为起点；今天或更早→从今天起。
// 用户手动设了更晚的日期(manualStr)则尊重其更晚者。返回 Date(当天0点)。
function computeScheduleStart(latestDateStr, manualStr) {
  const today = startOfDay(new Date());
  let floor = today;
  if (latestDateStr) {
    const d = new Date(String(latestDateStr).replace(' ', 'T'));
    if (!isNaN(d.getTime()) && startOfDay(d).getTime() > today.getTime()) floor = startOfDay(d);
  }
  let start = floor;
  if (manualStr) {
    const m = new Date(String(manualStr).replace(' ', 'T'));
    if (!isNaN(m.getTime()) && startOfDay(m).getTime() > floor.getTime()) start = startOfDay(m);
  }
  return start;
}
// 是否需要走"预约排期"：每日限量 / 番茄已排到未来(需接续) / 用户手动指定了日期。返回 {scheduled, start, reason}。
function resolveSchedule(pc, latestDateStr) {
  const today = startOfDay(new Date());
  const latestFuture = !!latestDateStr && (() => { const d = new Date(String(latestDateStr).replace(' ', 'T')); return !isNaN(d.getTime()) && startOfDay(d).getTime() > today.getTime(); })();
  const isDaily = pc.chaptersPerDay && pc.chaptersPerDay !== 'max';
  if (!isDaily && !latestFuture && !pc.scheduledStartDate) return { scheduled: false, start: '', reason: 'immediate' };
  const start = computeScheduleStart(latestDateStr, pc.scheduledStartDate);
  const reason = latestFuture ? `接续番茄已排期到 ${latestDateStr}` : (pc.scheduledStartDate ? '按设置' : '从今天起');
  return { scheduled: true, start: fmtYMD(start), reason };
}

// 图书卷目录名 → 番茄新建卷用的卷名。"卷14" → "第十四卷"；"卷14_少年游" → "第十四卷：少年游"。
function volDisplayName(vol) {
  const m = String(vol).match(/卷\s*0*(\d+)(?:[_\-．.、:：]\s*(.+))?$/);
  if (!m) return String(vol);
  const num = parseInt(m[1], 10);
  const sub = (m[2] || '').trim();
  return `第${numToCn(num)}卷` + (sub ? `：${sub}` : '');
}

// 从书的 outlines/ 里取某卷的【卷名/副标题】。番茄要求分卷有名字，而作者常只把卷目录命名为"卷03"（无副标题），
// 真正的卷名往往写在大纲文件名里（如 outlines/卷03静海旧火分章大纲.md → "静海旧火"）或大纲 H1 标题里。
// 返回副标题字符串（无则 ''）。
export function outlineVolSubtitle(book, volNum) {
  if (!book?.dir || !volNum) return '';
  const odir = path.join(book.dir, 'outlines');
  let files = [];
  try { files = fs.readdirSync(odir).filter(f => /\.md$/i.test(f)); } catch { return ''; }
  const pad = String(volNum).padStart(2, '0');
  // 找文件名以 卷NN / 卷N 开头的那个大纲
  const hit = files.find(f => new RegExp(`^卷\\s*0*${volNum}(?!\\d)`).test(f));
  if (!hit) return '';
  // ① 从文件名抽：卷03静海旧火分章大纲.md → 去掉"卷03"前缀与"(分章)?大纲"后缀 → "静海旧火"
  let sub = hit.replace(/\.md$/i, '')
    .replace(new RegExp(`^卷\\s*0*${volNum}\\s*`), '')
    .replace(/[_\-．.、:：]\s*/, '')
    .replace(/(分章)?大纲$/, '')
    .trim();
  if (sub) return sub.slice(0, 16);   // 番茄副标题 maxlength 16
  // ② 文件名没有 → 读 H1：# 《书名》卷03 静海旧火 分章大纲 → "静海旧火"
  try {
    const first = fs.readFileSync(path.join(odir, hit), 'utf8').split(/\r?\n/)[0] || '';
    const m = first.match(new RegExp(`卷\\s*0*${volNum}\\s+(.+?)\\s*(分章)?大纲`));
    if (m && m[1]) return m[1].trim().slice(0, 16);
  } catch {}
  return '';
}

// 从 novel_bible.md 取某卷卷名。立项常把卷名写在 bible 的"节奏与格局承诺"里，格式如
// "卷01《煤山夺命》：…" 或 "卷01：煤山夺命"。这是卷名最常落的地方（比大纲文件名更常有）。
export function bibleVolSubtitle(book, volNum) {
  if (!book?.dir || !volNum) return '';
  let bible = ''; try { bible = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8'); } catch { return ''; }
  const cn = numToCn(volNum);   // 卷号中文形（4→四），兼容"第四卷：xxx"这种中文数字写法
  // 覆盖常见几种卷名写法：卷01《xxx》 / 第一卷《xxx》 / 卷01：xxx / 第四卷：xxx / ### 第N卷：xxx
  const pats = [
    `卷\\s*0*${volNum}(?!\\d)\\s*《([^》]{1,16})》`,
    `第\\s*(?:${volNum}|${cn})\\s*卷\\s*《([^》]{1,16})》`,
    `卷\\s*0*${volNum}(?!\\d)\\s*[:：]\\s*([^\\n，,。；：#]{1,16})`,
    `第\\s*(?:${volNum}|${cn})\\s*卷\\s*[:：]\\s*([^\\n，,。；：#]{1,16})`,
  ];
  for (const p of pats) { const m = bible.match(new RegExp(p)); if (m && m[1]) return m[1].trim().slice(0, 16); }
  return '';
}

// 给某本地卷目录名生成【番茄用的完整卷名】：卷名来源优先级 = 目录名副标题 → 大纲文件名 → bible。
// 都没有则退回"第N卷"（会在建卷时被安全拦下并提示起名，不再默默卡住）。
function volDisplayNameForBook(book, vol) {
  const base = volDisplayName(vol);                 // "第三卷" 或 "第三卷：xxx"
  if (base.includes('：')) return base;             // 目录名已带副标题
  const num = bookVolNum(vol);
  const sub = outlineVolSubtitle(book, num) || bibleVolSubtitle(book, num);   // 大纲文件名 → bible
  return sub ? `${base}：${sub}` : base;
}

// 把图书的卷(chapters/卷NN 目录名)按出现顺序去重 → [vol…]。
function orderedBookVolumes(allChapters) {
  const seen = new Set(), out = [];
  for (const c of allChapters) { if (c.vol && !seen.has(c.vol)) { seen.add(c.vol); out.push(c.vol); } }
  return out;
}

// 中文/阿拉伯数字 → 整数（1~99，够卷号用）。无法解析返回 null。
function cnNum(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : d[a];
    const units = b === '' ? 0 : d[b];
    if (tens == null || units == null) return null;
    return tens * 10 + units;
  }
  return s.length === 1 && d[s] != null ? d[s] : null;
}
// 图书卷目录名 "卷01"/"卷01_常山雪" → 卷号 1
export function bookVolNum(vol) { const m = String(vol).match(/卷\s*0*(\d+)/) || String(vol).match(/0*(\d+)/); return m ? parseInt(m[1], 10) : null; }
// 番茄卷名 "第十三卷：九州雷震"/"第1卷" → 卷号
function fanqieVolNum(name) { const m = String(name).match(/第\s*([0-9一二三四五六七八九十两]+)\s*卷/); return m ? cnNum(m[1]) : null; }

// 建立 图书卷 → 番茄卷名 的映射（【按卷号】匹配，不靠顺序——番茄卷下拉是倒序且用中文数字）。
// 预检番茄是否已有对应卷。返回 { ok, map:{图书vol:番茄卷名}, missing:[图书vol…], fanqieVolumes, single } 或 { ok:false, error }。
async function buildVolumeMap(book, allChapters, pc, onLog) {
  const bookVols = orderedBookVolumes(allChapters);
  const fv = await getFanqieVolumes({ profilePath: pc.profilePath, bookId: pc.bookId, onLog });
  if (!fv.ok) return { ok: false, error: fv.error || '读取番茄卷列表失败', pageInvalid: fv.pageInvalid };
  // 番茄卷号 → 卷名
  const byNum = new Map();
  for (const name of fv.volumes) { const n = fanqieVolNum(name); if (n != null && !byNum.has(n)) byNum.set(n, name); }
  const map = {}, missing = [];
  for (const v of bookVols) {
    const n = bookVolNum(v);
    if (n != null && byNum.has(n)) map[v] = byNum.get(n);
    else missing.push(v);
  }
  return { ok: true, single: false, map, missing, fanqieVolumes: fv.volumes };
}

// 清洗章节正文为「番茄纯文本」：去 HTML 标签(<p>/<br>等)、去开头重复的标题行、规整段落。
// 有的书正文存成 `标题\n<p>　　段落</p><p>…</p>` 格式，直接发会把标签当文字发出去（已踩坑）。
// 同时兼容【全角尖括号】＜p＞（番茄会把 < 转成全角防注入，本地若有也要清）。
export function cleanChapterText(raw, title) {
  // 先把全角尖括号 ＜＞ 归一成半角，统一处理
  let s = String(raw || '').replace(/＜/g, '<').replace(/＞/g, '>');
  if (/<\s*p[\s>\/]/i.test(s) || /<\s*br/i.test(s)) {
    // 提取每个 <p>…</p> 的文本作为一段；没有 <p> 包裹的(如开头标题行)自然丢弃
    const paras = [...s.matchAll(/<\s*p[^>]*>([\s\S]*?)<\s*\/\s*p\s*>/gi)]
      .map(m => m[1].replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
      .filter(Boolean);
    if (paras.length) s = paras.join('\n');
    else s = s.replace(/<[^>]+>/g, '');   // 兜底：没匹配到 <p> 就直接剥标签
  }
  // 去掉残留标签 + 开头与标题完全相同的首行
  s = s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  const lines = s.split(/\r?\n/);
  const t = String(title || '').replace(/^第\d+章\s*/, '').trim();
  if (t && lines.length && lines[0].trim() === t) lines.shift();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 读 book.dir/chapters/ 的全局编号正文章节 → [{num,title,content,vol}]，按 num 升序。可选 fromNum 起。
export function loadPublishChapters(book, { fromNum = 1 } = {}) {
  const cdir = path.join(book.dir, 'chapters');
  const out = [];
  let vols = [];
  try { vols = fs.readdirSync(cdir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  for (const v of vols) {
    let files = [];
    try { files = fs.readdirSync(path.join(cdir, v)).filter(f => /^\d+/.test(f) && /\.txt$/i.test(f) && !/^_/.test(f)); } catch {}
    for (const f of files) {
      const m = f.match(/^(\d+)[_\-]?(.*)\.txt$/i);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < fromNum) continue;
      const name = (m[2] || '').trim();
      let content = '', mtime = 0;
      const fp = path.join(cdir, v, f);
      try { content = fs.readFileSync(fp, 'utf8'); } catch {}
      try { mtime = fs.statSync(fp).mtimeMs; } catch {}
      const title = `第${num}章 ${name}`;
      out.push({ num, title, content: cleanChapterText(content, title), vol: v, mtime });
    }
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

// 预览：番茄到第几章、本地到第几章、将发哪些（只读，不发）。
export async function previewPublish(book, { onLog = () => {} } = {}) {
  const pc = book.publish || {};
  if (!pc.profilePath) throw new Error('未配置番茄账号(Unzoo profilePath)');
  if (!pc.bookId) throw new Error('未配置番茄 bookId');
  const fm = await getFanqieMaxChapter({ profilePath: pc.profilePath, bookId: pc.bookId, onLog });
  if (fm.pageInvalid || fm.error) {
    return { ok: false, blocked: true, reason: fm.error || '番茄页面无效', fanqieMax: null, localMax: loadPublishChapters(book).length, newCount: 0 };
  }
  const fanqieMax = fm.maxChapter || 0;
  const all = loadPublishChapters(book);
  // 🛡️兜底：这本以前发布过(lastPublishAt>0)，番茄却读到 0 章 → 几乎必是读取异常/页面没加载完，
  // 绝不从第1章把已发章重发 → 阻断并提示重试。
  if (fanqieMax === 0 && (pc.lastPublishAt || 0) > 0) {
    return { ok: false, blocked: true, reason: '该书之前发布过，这次却读到番茄 0 章——疑似页面未加载完/读取异常，已中止以防从第1章重复发布，请重试', fanqieMax: 0, localMax: all.length ? all[all.length - 1].num : 0, newCount: 0 };
  }
  const localMax = all.length ? all[all.length - 1].num : 0;
  const newCh = all.filter(c => c.num > fanqieMax);
  // 重写章：番茄已有(num≤fanqieMax)但本地正文在上次发布之后被改动 → 需 edit 同步
  const lastAt = pc.lastPublishAt || 0;
  const rewritten = lastAt ? all.filter(c => c.num <= fanqieMax && c.mtime > lastAt) : [];
  // 多卷预览：matchVolumes 开时给出 图书卷→番茄卷 映射；本批新章涉及的缺卷会【自动新建】
  let volumes = null;
  if (pc.matchVolumes) {
    const vm = await buildVolumeMap(book, all, pc, onLog);
    if (!vm.ok) volumes = { error: vm.error };
    else if (vm.single) volumes = { single: true };
    else {
      const neededVols = [...new Set(newCh.map(c => c.vol))];
      const willCreate = vm.missing.filter(v => neededVols.includes(v)).map(v => volDisplayName(v));
      volumes = { map: vm.map, missing: vm.missing, willCreate, fanqieVolumes: vm.fanqieVolumes };
    }
  }
  const sched = resolveSchedule(pc, fm.latestDate);
  return {
    ok: true, fanqieMax, approx: !!fm.approx, localMax,
    newCount: newCh.length, from: newCh[0]?.num || null, to: newCh[newCh.length - 1]?.num || null,
    titles: newCh.slice(0, 5).map(c => c.title),
    rewrittenCount: rewritten.length, rewrittenNums: rewritten.slice(0, 8).map(c => c.num),
    syncRewrites: !!pc.syncRewrites,
    matchVolumes: !!pc.matchVolumes, volumes,
    fanqieLatestDate: fm.latestDate || '', scheduleStart: sched.start, scheduled: sched.scheduled, scheduleReason: sched.reason,
  };
}

// 重发修正：把番茄上【已存在】的 from..to 章，用本地(已清洗)正文【编辑替换】。修"发错内容"用。
// limit>0 时只改前 N 章（先试1章再全改）。
export async function republishRange(book, { from, to, limit = 0, onLog = () => {} } = {}) {
  const pc = book.publish || {};
  if (!pc.profilePath) throw new Error('未配置番茄账号(Unzoo profilePath)');
  if (!pc.bookId) throw new Error('未配置番茄 bookId');
  let chs = loadPublishChapters(book).filter(c => c.num >= from && c.num <= to).map(c => ({ ...c, mode: 'edit' }));
  if (limit > 0) chs = chs.slice(0, limit);
  if (!chs.length) { onLog({ level: 'info', msg: `第 ${from}-${to} 章本地为空，无可重发` }); return { ok: true, edited: 0 }; }
  onLog({ level: 'act', msg: `编辑替换番茄第 ${chs[0].num}–${chs[chs.length - 1].num} 章（共 ${chs.length} 章，用清洗后正文）…` });
  const config = { editMode: true, bookId: pc.bookId, intervalSeconds: pc.intervalSeconds || 3 };
  const r = await publishBook({ profilePath: pc.profilePath, bookId: pc.bookId, bookName: pc.bookName || book.title, chapters: chs, config, onLog });
  return { ok: !!r.ok, attempted: chs.length, ...r };
}

// 真发：把番茄还没有的新章发到番茄（按 per-book 配置：账号/书/卷开关/每日数/预约）。limit 可只发前 N 章（首测用）。
export async function publishToFanqie(book, { limit = 0, onLog = () => {} } = {}) {
  const pc = book.publish || {};
  if (!pc.profilePath) throw new Error('未配置番茄账号(Unzoo profilePath)');
  if (!pc.bookId) throw new Error('未配置番茄 bookId');
  onLog({ level: 'act', msg: '读取番茄当前最大章号…' });
  const fm = await getFanqieMaxChapter({ profilePath: pc.profilePath, bookId: pc.bookId, onLog });
  if (fm.pageInvalid || fm.error) {
    onLog({ level: 'error', msg: `⛔ 已中止发布：无法确认番茄当前章号（${fm.error || '页面无效'}）。请确认该账号能正常打开番茄章节管理页后再发，避免重复发布。` });
    return { ok: false, blocked: true, reason: fm.error || '番茄页面无效', published: 0 };
  }
  const fanqieMax = fm.maxChapter || 0;
  const all = loadPublishChapters(book);
  // 🛡️兜底：以前发布过却读到番茄 0 章 → 疑似读取异常，绝不从第1章重发，直接中止提示重试。
  if (fanqieMax === 0 && (pc.lastPublishAt || 0) > 0) {
    onLog({ level: 'error', msg: '⛔ 已中止发布：该书之前发布过，这次却读到番茄 0 章（疑似页面未加载完/读取异常）。请重试，避免从第1章重复发布。' });
    return { ok: false, blocked: true, reason: '以前发布过却读到 0 章，已中止防重复发布，请重试', published: 0 };
  }
  onLog({ level: 'info', msg: `番茄已发到第 ${fanqieMax} 章${fm.approx ? '(近似)' : ''}` });
  let newCh = all.filter(c => c.num > fanqieMax).map(c => ({ ...c, mode: 'new' }));
  // 重写章同步(可选)：把上次发布后改动过的旧章，用 edit 模式找番茄对应章覆盖。
  const lastAt = pc.lastPublishAt || 0;
  let editCh = (pc.syncRewrites && lastAt)
    ? all.filter(c => c.num <= fanqieMax && c.mtime > lastAt).map(c => ({ ...c, mode: 'edit' }))
    : [];
  if (limit > 0) { newCh = newCh.slice(0, limit); editCh = []; }   // 试发只走新章
  if (!newCh.length && !editCh.length) { onLog({ level: 'info', msg: '番茄已是最新，无新章/无重写章可发' }); return { ok: true, published: 0, fanqieMax }; }
  // 多卷映射(matchVolumes 开)：把每章按其图书卷映射到番茄对应卷名；番茄缺卷则【自动新建】(只建恰好缺的、绝不多建)
  if (pc.matchVolumes) {
    onLog({ level: 'act', msg: '读取番茄卷列表并按卷映射…' });
    let vm = await buildVolumeMap(book, all, pc, onLog);
    if (!vm.ok) {
      onLog({ level: 'error', msg: `⛔ 已中止：${vm.error}` });
      return { ok: false, blocked: true, reason: vm.error, published: 0 };
    }
    if (vm.single) {
      onLog({ level: 'info', msg: '番茄是单卷书，忽略分卷，直接追加发布' });
    } else {
      // 尝试自动新建【本批涉及且番茄缺】的卷（只建恰好缺的、绝不多建）。
      const neededVols = [...new Set([...editCh, ...newCh].map(c => c.vol))];
      // 缺卷里【没卷名】的（目录名/大纲/bible 都取不到副标题）→ 先用 AI 自动起名并写回 bible，
      // 免得番茄"分卷必须有名字"把整卷卡住（用户嫌不好可到卷管理手动改）。动态 import 避免与 volname 循环依赖。
      const nameless = vm.missing.filter(v => neededVols.includes(v) && !volDisplayNameForBook(book, v).includes('：'));
      if (nameless.length) {
        onLog({ level: 'act', msg: `缺卷没卷名，自动起名：${nameless.join('、')}` });
        try {
          const { generateVolumeName } = await import('./volname.mjs');
          const { loadConfig } = await import('./config.mjs');
          const cfg = loadConfig();
          for (const v of nameless) {
            const n = bookVolNum(v); if (n == null) continue;
            try { const gr = await generateVolumeName(book, n, { cfg, onLog }); if (!gr.ok) onLog({ level: 'warn', msg: `第${n}卷自动起名失败：${gr.error}` }); }
            catch (e) { onLog({ level: 'warn', msg: `第${n}卷起名异常：${e.message || e}` }); }
          }
        } catch (e) { onLog({ level: 'warn', msg: '自动起卷名模块加载失败：' + (e.message || e) }); }
      }
      const toCreate = vm.missing.filter(v => neededVols.includes(v))
        .map(v => ({ num: bookVolNum(v), name: volDisplayNameForBook(book, v) }))   // 卷名优先从大纲补/上面已自动生成，避免空副标题卡住
        .filter(x => x.num != null)
        .sort((a, b) => a.num - b.num);
      if (toCreate.length) {
        onLog({ level: 'act', msg: `番茄缺卷，尝试自动新建：${toCreate.map(x => x.name).join('、')}` });
        const cr = await createFanqieVolumes({ profilePath: pc.profilePath, bookId: pc.bookId, volumes: toCreate, onLog });
        if (cr.created && cr.created.length) onLog({ level: 'info', msg: `已新建卷：${cr.created.join('、')}` });
        // ⚠️建卷失败【不再整体中止】：能建的建了，建不出的（如卷目录无名→空副标题被番茄拒）下面按
        // "截断到已存在卷"处理——先把番茄已有卷的章发出去，缺卷的章暂缓，不让一个缺卷拖垮整批。
        if (!cr.ok) onLog({ level: 'warn', msg: `部分卷未能自动新建（${cr.error}）。番茄要求分卷有名字、卷不可删——本次先发"番茄已有卷"的章，缺卷的章暂缓。` });
        vm = await buildVolumeMap(book, all, pc, onLog);
        if (!vm.ok) { onLog({ level: 'error', msg: '⛔ 建卷后重读卷列表失败：' + vm.error }); return { ok: false, blocked: true, reason: vm.error, published: 0 }; }
      }
      // ⚠️按章号顺序截断：发到【第一个番茄仍缺卷】的章之前为止。番茄章号全局连续、卷按序排，
      // 缺卷之后的章必须等该卷建好才能发（否则乱序/发错卷）；已有卷的章照常发，缺卷的章暂缓（不阻断）。
      let deferReason = '';
      const trimToExisting = (list) => {
        const out = [];
        for (const c of list) {
          if (vm.map[c.vol]) out.push(c);
          else { deferReason = `番茄缺卷「${volDisplayName(c.vol)}」（本地卷目录无副标题、番茄要求分卷命名）→ 从第${c.num}章起暂缓。请在「📚番茄卷管理」手动建好该卷、或给本地卷目录加个名字（如“卷03_xxx”）后再续发。`; break; }
        }
        return out;
      };
      const newTrimmed = trimToExisting(newCh);   // editCh 是已发布旧章、卷必存在；主要截断 newCh
      const deferredCount = newCh.length - newTrimmed.length;
      newCh = newTrimmed;
      if (deferReason) onLog({ level: 'warn', msg: `⚠️ ${deferReason}（本次暂缓 ${deferredCount} 章）` });
      if (!newCh.length && !editCh.length) {
        onLog({ level: 'error', msg: '⛔ 最近要发的章都落在番茄缺的卷里，无可发章。请先建好该卷再发。' });
        return { ok: false, blocked: true, reason: deferReason || '番茄缺卷', published: 0 };
      }
      for (const c of [...editCh, ...newCh]) c.volumeText = vm.map[c.vol] || '';
      onLog({ level: 'info', msg: '卷映射：' + [...new Set([...editCh, ...newCh].map(c => c.vol))].map(v => `${v}→${vm.map[v]}`).join('，') });
    }
  }
  // 先同步重写章(edit)，再追加新章(new)——顺序固定，避免错位
  const chapters = [...editCh, ...newCh];
  if (editCh.length) onLog({ level: 'act', msg: `同步 ${editCh.length} 个重写章(edit)：第 ${editCh.map(c => c.num).join('、')} 章` });
  if (newCh.length) onLog({ level: 'act', msg: `追加第 ${newCh[0].num}–${newCh[newCh.length - 1].num} 章新章（共 ${newCh.length} 章）…` });
  // 排期起始日：自动接续番茄已排期（晚于今天→用它；否则→今天；手动更晚者优先）
  const sched = resolveSchedule(pc, fm.latestDate);
  if (sched.scheduled) onLog({ level: 'info', msg: `📅 排期起始日：${sched.start}（${sched.reason}）` });
  else onLog({ level: 'info', msg: '📅 立即发布（番茄无未来排期、未设每日限量）' });
  const config = {
    chaptersPerDay: pc.chaptersPerDay || 'max',
    scheduledStartDate: sched.start,
    scheduledTime: pc.scheduledTime || '',
    intervalSeconds: pc.intervalSeconds || 3,
    matchVolumes: !!pc.matchVolumes,
    useAI: !!pc.useAI,
    bookId: pc.bookId,
  };
  const r = await publishBook({ profilePath: pc.profilePath, bookId: pc.bookId, bookName: pc.bookName || book.title, chapters, config, onLog });
  // 发布成功后记账：记录本次发布时间(用于下次识别重写章)与已发到的章号
  if (r.ok) {
    try {
      const newMax = Math.max(fanqieMax, r.lastChapter || 0, ...(newCh.map(c => c.num)));
      setBookPublish(book.slug, { lastPublishAt: Date.now(), publishedMax: newMax });
    } catch {}
  }
  return { ok: !!r.ok, fanqieMax, attempted: chapters.length, edited: editCh.length, ...r };
}
