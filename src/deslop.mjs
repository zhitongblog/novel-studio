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
    .replace(/。{2,}/g, '。')
    .replace(/，。/g, '。').replace(/。，/g, '。')
    .replace(/、。/g, '。')
    .replace(/？。/g, '？').replace(/！。/g, '！')
    .replace(/。([」』”"])/g, '。$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 核心：把整章正文矫正。返回 { text, changed, stats:{ellBefore, cplBefore, cplAfter} }
export function deslopText(raw, { mergeUnder = 35, killEllipsis = true } = {}) {
  const src = String(raw || '').replace(/\r\n/g, '\n');
  const blocks = src.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

  const ellBefore = (src.match(/…+/g) || []).length;
  const lb = src.split('\n').filter(l => l.trim());
  const charsAll = src.replace(/\s/g, '').length;
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
  const changed = text.trim() !== src.trim();
  return { text, changed, stats: { ellBefore, cplBefore, cplAfter } };
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
