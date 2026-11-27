// 排版矫正闸（确定性、不靠模型自觉）：治「……」雪球 + 逐句换行。
//
// 病根：无状态写作每批把「上一章」当上下文喂回去，模型照着自己上一章的排版 tic 放大——
// 「……」当节拍分隔符插在每个短句之间、每句单独成段（字/段 掉到 7）。规则(skill.mjs)是说教，
// 压不住自我模仿。唯一可靠治法：每章写完后用代码强制矫正，病章还没变成下一章上下文就已清干净。
//
// 矫正做两件事，都不丢正文：
//   1) 删掉「只有省略号的独立段」（纯节拍 tic，无内容）；行内「……」→「。」并规整标点。
//   2) 把过度碎片化的叙述段合并成正常段落（对话段保持独立成段）。
// 目标画像 = 本书最干净的 025 章（字/段≈23、……=0）。对已规整的章近似幂等。

import fs from 'node:fs';
import path from 'node:path';

// 一段是否「只有省略号/点」（节拍分隔 tic，删之）
const isEllipsisOnly = (s) => /^[…\.。·\s]+$/.test(s) && /[…。]/.test(s);
// 一段是否含对话（保持独立成段，不并进叙述）
const hasDialogue = (s) => /[「」『』“”"]/.test(s);

// 行内标点规整：消除叠标点。不改字。
// killEllipsis：省略号是不是"tic"要看这本书的范本用不用它——
// 范本里省略号密的书，把它全换成句号就是在改这本书的语气。
function normPunct(s, killEllipsis = true) {
  return (killEllipsis ? s.replace(/…+/g, '。') : s)
    .replace(/[*＊]+/g, '')
    .replace(/`([^`\n]+)`/g, '$1').replace(/`/g, '')
    .replace(/~~([^~\n]+)~~/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/。{2,}/g, '。')
    .replace(/，。/g, '。').replace(/。，/g, '。')
    .replace(/、。/g, '。')
    .replace(/？。/g, '？').replace(/！。/g, '！')
    .replace(/。([」』”"])/g, '。$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ── 一键清除 AI 痕迹（确定性净化：专治正文 .txt 里的 * 号、Markdown 标记、章尾套壳、机械分割线与解释腔套话） ──
// 返回 { text, changed, stats: { stars, headings, dividers, endTags, slopPhrases, stackedPunct, total } }
export function cleanAiTraces(raw) {
  const orig = String(raw || '').replace(/\r\n/g, '\n');
  let s = orig;

  // 统计各类 AI 痕迹数量
  const codeFences = (s.match(/^\s*```[a-zA-Z0-9_-]*\s*$/gm) || []).length;
  const headings = (s.match(/^\s*#{1,6}\s+/gm) || []).length
    + (/^\s*第\s*[0-9零一二三四五六七八九十百千]+\s*[章节回][^\n。！？]{0,40}\n+/.test(s) ? 1 : 0);
  const dividers = (s.match(/^\s*([-_]{3,}|—{3,}|─{3,}|={3,}|[*＊\s]{3,})\s*$/gm) || []).length;
  const endTags = (s.match(/^\s*[（(【［\-—]*\s*(本章完|全章完|本集完|未完待续)\s*[）)】］\-—。！!]*\s*$/gm) || []).length
    + (s.match(/[（(【［]\s*(本章完|全章完|本集完|未完待续)\s*[）)】］]\s*$/g) || []).length;

  // 1. 清除代码块围栏 ```
  s = s.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '');
  // 2. 清除 AI 寒暄开场白（若模型误吐在文件开头）
  s = s.replace(/^\s*(好的[，,。！]?|以下是[^\n]*正文[：:]*|这是为您[^\n]*)\n+/i, '');
  // 3. 清除行首 Markdown # 标题符与首行重复章名
  s = s.replace(/^\s*#{1,6}\s+/gm, '');
  s = s.replace(/^\s*第\s*[0-9零一二三四五六七八九十百千]+\s*[章节回][^\n。！？]{0,40}\n+/, '');
  // 4. 清除独立成行的机械分割线（--- / *** / === / ———）
  s = s.replace(/^\s*([-_]{3,}|—{3,}|─{3,}|={3,}|[*＊]{3,})\s*$/gm, '');
  // 5. 清除（本章完）/【本章完】/（未完待续）等章尾套壳标记
  s = s.replace(/^\s*[（(【［\-—]*\s*(本章完|全章完|本集完|未完待续)\s*[）)】］\-—。！!]*\s*$/gm, '');
  s = s.replace(/[（(【［]\s*(本章完|全章完|本集完|未完待续)\s*[）)】］]\s*$/g, '');

  // 6. 清除全部 * 号 / ＊ 号（含 **加粗**、*斜体* 及散落星号）、行内 Markdown 符号（`、~~、__）与番茄禁用的非常规装饰符
  const stars = (s.match(/[*＊]+/g) || []).length;
  const inlineMd = (s.match(/`|~~|__/g) || []).length;
  const decorSyms = (s.match(/[△★♥♛√◆●▲■☆♡♦♣♠✦✧]+/g) || []).length;
  s = s.replace(/[*＊]+/g, '');
  s = s.replace(/[△★♥♛√◆●▲■☆♡♦♣♠✦✧]+/g, '');
  s = s.replace(/`([^`\n]+)`/g, '$1').replace(/`/g, '');
  s = s.replace(/~~([^~\n]+)~~/g, '$1').replace(/__([^_\n]+)__/g, '$1');

  // 7. 清除典型 AI 解释腔前缀与机械神态套话
  const slopRe = /(^|[。！？\n\s])(不得不说|值得一提的是|显而易见|总而言之|换句话说|某种程度上)[，,]\s*/g;
  const slopPhrases = (s.match(slopRe) || []).length;
  s = s.replace(slopRe, '$1');

  // 8. 规整叠标点与多余空行
  const punctRe = /。{2,}|，。|。，|、。|？。|！。/g;
  const stackedPunct = (s.match(punctRe) || []).length;
  s = s
    .replace(/。{2,}/g, '。')
    .replace(/，。/g, '。').replace(/。，/g, '。')
    .replace(/、。/g, '。')
    .replace(/？。/g, '？').replace(/！。/g, '！')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';

  const total = stars + codeFences + headings + dividers + endTags + inlineMd + decorSyms + slopPhrases + stackedPunct;
  const changed = s.trim() !== orig.trim();
  return {
    text: s,
    changed,
    stats: {
      stars,
      headings: headings + codeFences,
      dividers,
      endTags,
      inlineMd,
      slopPhrases,
      stackedPunct,
      total,
    },
  };
}

// 净化单个章节文件；changed 才写盘
export function cleanFileAiTraces(fp) {
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return { file: fp, changed: false, error: 'read' }; }
  const r = cleanAiTraces(raw);
  if (r.changed) {
    try { fs.writeFileSync(fp, r.text, 'utf8'); } catch { return { file: fp, changed: false, error: 'write' }; }
  }
  return { file: path.basename(fp), changed: r.changed, ...r.stats };
}

// 一键清除整本书（或指定章号区间）的 AI 痕迹
export function cleanBookAiTraces(bookDir, { from = 1, to = 0, onLog = () => {} } = {}) {
  const files = chapterFilesInRange(bookDir, from, to);
  let touched = 0;
  let stars = 0, headings = 0, dividers = 0, endTags = 0, inlineMd = 0, slopPhrases = 0, stackedPunct = 0, total = 0;
  const touchedNums = [];
  for (const { num, path: fp } of files) {
    const r = cleanFileAiTraces(fp);
    if (r.changed) {
      touched++;
      touchedNums.push(num);
      stars += r.stars || 0;
      headings += r.headings || 0;
      dividers += r.dividers || 0;
      endTags += r.endTags || 0;
      inlineMd += r.inlineMd || 0;
      slopPhrases += r.slopPhrases || 0;
      stackedPunct += r.stackedPunct || 0;
      total += r.total || 0;
    }
  }
  if (touched > 0) {
    const parts = [];
    if (stars) parts.push(`* 号 ${stars} 处`);
    if (endTags) parts.push(`章尾套壳 ${endTags} 处`);
    if (dividers) parts.push(`机械分割线 ${dividers} 处`);
    if (headings) parts.push(`标题/围栏 ${headings} 处`);
    if (inlineMd) parts.push(`Markdown符 ${inlineMd} 处`);
    if (slopPhrases) parts.push(`解释腔套话 ${slopPhrases} 处`);
    if (stackedPunct) parts.push(`叠标点 ${stackedPunct} 处`);
    onLog({
      level: 'info',
      msg: `🧹 一键清除AI痕迹完成：共扫描 ${files.length} 章，净化 ${touched} 章（清除 ${parts.join('、') || '格式杂项'}）`,
    });
  } else {
    onLog({ level: 'info', msg: `🧹 一键清除AI痕迹：扫描 ${files.length} 章，全部干净无残留` });
  }
  return {
    files: files.length,
    touched,
    touchedNums,
    stats: { stars, headings, dividers, endTags, inlineMd, slopPhrases, stackedPunct, total },
  };
}

// 核心：把整章正文矫正。返回 { text, changed, stats:{ellBefore, cplBefore, cplAfter} }
export function deslopText(raw, { mergeUnder = 35, killEllipsis = true } = {}) {
  const pre = cleanAiTraces(raw);
  const src = pre.text;
  const origRaw = String(raw || '').replace(/\r\n/g, '\n');
  const blocks = src.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

  const ellBefore = (origRaw.match(/…+/g) || []).length;
  const lb = origRaw.split('\n').filter(l => l.trim());
  const charsAll = origRaw.replace(/\s/g, '').length;
  const cplBefore = Math.round(charsAll / Math.max(1, lb.length));

  const paras = [];
  let cur = '';
  const flush = () => { if (cur) { paras.push(cur); cur = ''; } };
  for (const b of blocks) {
    if (isEllipsisOnly(b)) continue;                 // 删纯省略号段（tic）
    if (hasDialogue(b)) { flush(); paras.push(normPunct(b, killEllipsis)); continue; }  // 对话独立成段
    const n = normPunct(b, killEllipsis);
    if (!n) continue;
    if (!cur) cur = n;
    else if (cur.length < mergeUnder) cur += n;       // 上段仍短 → 并入（治碎片化）
    else { flush(); cur = n; }
  }
  flush();

  const text = paras.join('\n\n') + '\n';
  const outLines = text.split('\n').filter(l => l.trim());
  const cplAfter = Math.round(text.replace(/\s/g, '').length / Math.max(1, outLines.length));
  const changed = text.trim() !== origRaw.trim();
  return { text, changed, stats: { ellBefore, cplBefore, cplAfter, starsBefore: pre.stats.stars } };
}

// 病判定：给上层决定「是否已相对干净、可跳过」——但闸默认对每章都跑（幂等），此函数仅供日志/阈值。
export function isSick(raw) {
  const src = String(raw || '');
  const ell = (src.match(/…+/g) || []).length;
  const lines = src.split('\n').filter(l => l.trim());
  const cpl = src.replace(/\s/g, '').length / Math.max(1, lines.length);
  return ell > 6 || cpl < 12;
}

// 矫正单个文件；changed 才写盘。返回 { file, changed, ...stats }
export function deslopFile(fp, opt = {}) {
  let raw; try { raw = fs.readFileSync(fp, 'utf8'); } catch { return { file: fp, changed: false, error: 'read' }; }
  const r = deslopText(raw, opt);
  if (r.changed) { try { fs.writeFileSync(fp, r.text, 'utf8'); } catch { return { file: fp, changed: false, error: 'write' }; } }
  return { file: path.basename(fp), changed: r.changed, ...r.stats };
}

// 找 chapters/卷*/NNN*.txt 里章号在 [from,to] 的文件（to=0→到最大）
export function chapterFilesInRange(bookDir, from, to = 0) {
  const cdir = path.join(bookDir, 'chapters');
  const out = [];
  let vols = []; try { vols = fs.readdirSync(cdir); } catch { return out; }
  for (const v of vols) {
    const vd = path.join(cdir, v);
    let files = []; try { if (!fs.statSync(vd).isDirectory()) continue; files = fs.readdirSync(vd); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.txt')) continue;
      const m = f.match(/(\d+)/); if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < from) continue;
      if (to > 0 && num > to) continue;
      out.push({ num, path: path.join(vd, f) });
    }
  }
  return out.sort((a, b) => a.num - b.num);
}

// 从这本书的范本量出【矫正参数】。
//
// 【为什么必须这样，以及这道闸原来错在哪】
// 原来 mergeUnder 写死 35：任何不到 35 字的叙述段都并进上一段。
// 实测把这本书自己的范本喂进去 —— 21.5 字/段 直接变成 34.2 字/段。
// 也就是说，**这道闸会把作者亲手选定的范本判成"碎片化"并合并掉**。
// 而它不是建议，是【直接改磁盘】：模型照着范本写出 20 字/段，落盘后被推到 55.7。
// 这就是"注入了范本却毫无效果"的真凶——不在模型那边，在落盘这一步。
//
// 现在：有范本 → 阈值从范本量，只兜底真正退化的碎片（低于范本段厚的四成）；
// 省略号也一样，范本自己用得多就别当 tic 删。没范本才退回写死的默认值。
function deslopOptsFor(bookDir) {
  const dir = path.join(bookDir, 'style_refs');
  let text = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(txt|md)$/i.test(f)) text += fs.readFileSync(path.join(dir, f), 'utf8') + '\n';
    }
  } catch { return { mergeUnder: 35, killEllipsis: true, ref: null }; }
  const body = text.replace(/\s/g, '');
  if (body.length < 300) return { mergeUnder: 35, killEllipsis: true, ref: null };
  const ps = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const avg = ps.map(x => x.replace(/\s/g, '').length).reduce((a, b) => a + b, 0) / (ps.length || 1);
  const ellPer1k = ((text.match(/…+/g) || []).length / body.length) * 1000;
  return {
    mergeUnder: Math.max(6, Math.round(avg * 0.4)),   // 范本 21.5 → 8：只并真正的碎渣
    killEllipsis: ellPer1k < 1.5,                     // 范本自己每千字用不到 1.5 个才当 tic 删
    ref: { avgPara: +avg.toFixed(1), ellPer1k: +ellPer1k.toFixed(1) },
  };
}

// 矫正一段章号区间；供【写后强制闸】与手动清洗共用。onLog 逐章报改动。
export function deslopRange(bookDir, from, to = 0, onLog = () => {}) {
  const files = chapterFilesInRange(bookDir, from, to);
  const opt = deslopOptsFor(bookDir);
  if (opt.ref) {
    onLog({ level: 'info', msg: `🧹 排版矫正按本书范本校准：范本 ${opt.ref.avgPara} 字/段 → 合并阈值 ${opt.mergeUnder} 字`
      + (opt.killEllipsis ? '' : '；范本本身多用省略号，保留不删') });
  }
  let touched = 0;
  for (const { num, path: fp } of files) {
    const r = deslopFile(fp, opt);
    if (r.changed) { touched++; onLog({ level: 'info', msg: `🧹 第${num}章排版矫正：字/行 ${r.cplBefore}→${r.cplAfter}，删省略号 ${r.ellBefore} 处` }); }
  }
  return { files: files.length, touched };
}
