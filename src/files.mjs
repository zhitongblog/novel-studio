// 内容阅读/工作台：列出一本书的可读文件树、读单个文件、保存编辑。带路径越界校验。
import fs from 'node:fs';
import path from 'node:path';
import { bookStats, plannedTotalChapters, plannedVolumes, currentVolume } from './books.mjs';

// 把 rel 解析成绝对路径并确保不越出 book.dir（防路径穿越）。
function safeAbs(book, rel) {
  const base = path.resolve(book.dir);
  const abs = path.resolve(book.dir, String(rel || ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('非法路径');
  return abs;
}
function kbOf(p) { try { return Math.round(fs.statSync(p).size / 1024 * 10) / 10; } catch { return 0; } }
function mtimeOf(p) { try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; } }

// 文件树：设定/大纲/台账/索引/简介 + 各卷章节 + 审稿复检报告 + 进度。
export function listBookFiles(book) {
  const dir = book.dir;
  const meta = [];
  for (const [label, rel] of [['设定圣经', 'novel_bible.md'], ['连贯性台账', 'continuity_ledger.md'], ['章节索引', 'chapter_index.md'], ['简介', '简介.txt']]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) meta.push({ label, rel, kb: kbOf(p) });
  }
  const outlines = [];
  try { for (const f of fs.readdirSync(path.join(dir, 'outlines')).filter(f => f.endsWith('.md')).sort()) outlines.push({ name: f.replace(/\.md$/, ''), rel: 'outlines/' + f, kb: kbOf(path.join(dir, 'outlines', f)) }); } catch {}
  const reviews = [];
  try {
    const rd = path.join(dir, 'reviews');
    for (const f of fs.readdirSync(rd).filter(f => f.endsWith('.md'))) reviews.push({ name: f.replace(/\.md$/, ''), rel: 'reviews/' + f, kb: kbOf(path.join(rd, f)), mtime: mtimeOf(path.join(rd, f)) });
    reviews.sort((a, b) => b.mtime - a.mtime);
  } catch {}
  const volumes = [];
  try {
    const cdir = path.join(dir, 'chapters');
    for (const v of fs.readdirSync(cdir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      const chs = [];
      try { for (const f of fs.readdirSync(path.join(cdir, v)).filter(f => /\.txt$/i.test(f))) chs.push({ name: f.replace(/\.txt$/i, ''), rel: 'chapters/' + v + '/' + f, num: parseInt((f.match(/^\d+/) || [])[0] || '0', 10), kb: kbOf(path.join(cdir, v, f)) }); } catch {}
      chs.sort((a, b) => a.num - b.num);
      volumes.push({ vol: v, chapters: chs });
    }
  } catch {}
  const dups = findDuplicateChapterNames(book);
  const st = bookStats(book);
  const target = plannedTotalChapters(book);
  const progress = {
    chapters: st.chapters || 0, kb: st.kb || 0, target,
    vol: currentVolume(book), totalVol: plannedVolumes(book), status: book.status || '连载中',
    pct: target > 0 ? Math.min(100, Math.round((st.chapters || 0) / target * 100)) : 0,
    dupCount: dups.length,
  };
  return { meta, outlines, reviews, volumes, progress, dups };
}

// 全局重编号：把每卷独立编号(每卷001起)的章节，统一改成【全书连续编号 001…N】，并重建 chapter_index.md。
// 卷简介(_卷简介.txt)移到 outlines/；非 NNN 开头的杂项(README 等)移出 chapters/。保留原文件名分隔符与章名。
// 两阶段改名避免同卷内目标与现有冲突。返回 { chapters, renamed, vols, intros, strays }。
export function renumberGlobalChapters(book) {
  const dir = book.dir, cdir = path.join(dir, 'chapters'), odir = path.join(dir, 'outlines');
  if (!fs.existsSync(cdir)) throw new Error('没有 chapters 目录');
  fs.mkdirSync(odir, { recursive: true });
  const vols = fs.readdirSync(cdir, { withFileTypes: true }).filter(e => e.isDirectory() && /卷\s*0*\d+/.test(e.name)).map(e => e.name)
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  let g = 0, renamed = 0, intros = 0, strays = 0; const rows = [], moves = [];
  for (const v of vols) {
    const vp = path.join(cdir, v);
    let all = []; try { all = fs.readdirSync(vp); } catch {}
    for (const f of all) {
      if (!/\.txt$/i.test(f)) continue;
      if (/^_/.test(f)) {   // _卷简介.txt 等 → 移到 outlines
        try { fs.renameSync(path.join(vp, f), path.join(odir, v + (f === '_卷简介.txt' ? '简介.txt' : f))); intros++; } catch {}
        continue;
      }
      if (!/^\d+/.test(f)) {  // 非章节杂项(README 等) → 移出 chapters 到书根
        try { fs.renameSync(path.join(vp, f), path.join(dir, '杂项_' + f)); strays++; } catch {}
      }
    }
    const files = fs.readdirSync(vp).filter(f => /^\d+/.test(f) && /\.txt$/i.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const f of files) {
      g++;
      const m = f.match(/^(\d+)([_\-]?)(.*)\.txt$/i);
      const sep = m ? m[2] : '_', name = m ? m[3] : f.replace(/\.txt$/i, '');
      const ng = String(g).padStart(3, '0'), nf = ng + sep + name + '.txt';
      if (nf !== f) moves.push([path.join(vp, f), path.join(vp, nf)]);
      rows.push([ng, name, v, 'chapters/' + v + '/' + nf]);
    }
  }
  for (const [s, t] of moves) { try { fs.renameSync(s, t + '.tmp'); } catch {} }
  for (const [s, t] of moves) { try { fs.renameSync(t + '.tmp', t); renamed++; } catch {} }
  let idx = `# 《${book.title}》章节索引（chapter_index.md）\n\n> 全书章号已统一为【全局连续编号】001–${String(g).padStart(3, '0')}。\n\n| 全局章号 | 章名 | 卷 | 路径 | 状态 |\n|---|---|---|---|---|\n`;
  for (const r of rows) idx += `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | 已写 |\n`;
  fs.writeFileSync(path.join(dir, 'chapter_index.md'), idx, 'utf8');
  return { chapters: g, renamed, vols: vols.length, intros, strays };
}

// 代码兜底：扫全书章节文件名，找出【重复的章名】（去掉章号前缀后比对）。返回 [{name, files:[...]}]。
export function findDuplicateChapterNames(book) {
  const cdir = path.join(book.dir, 'chapters');
  const byName = new Map();
  try {
    for (const v of fs.readdirSync(cdir, { withFileTypes: true })) {
      if (!v.isDirectory()) continue;
      let files = []; try { files = fs.readdirSync(path.join(cdir, v.name)); } catch {}
      for (const f of files) {
        if (!/\.txt$/i.test(f)) continue;
        const name = f.replace(/^\d+[_\-]?/, '').replace(/\.txt$/i, '').trim();
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(v.name + '/' + f);
      }
    }
  } catch {}
  const dups = [];
  for (const [name, files] of byName) if (files.length > 1) dups.push({ name, files });
  return dups;
}

export function readBookFile(book, rel) {
  const abs = safeAbs(book, rel);
  return { rel, content: fs.readFileSync(abs, 'utf8'), kb: kbOf(abs) };
}

export function saveBookFile(book, rel, content) {
  const abs = safeAbs(book, rel);
  if (!/\.(txt|md)$/i.test(abs)) throw new Error('只允许编辑 .txt / .md 文件');
  fs.writeFileSync(abs, String(content == null ? '' : content), 'utf8');
  return { ok: true, kb: kbOf(abs) };
}
