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

// 行内标点规整：省略号→句号，并消除叠标点。不改字。
function normPunct(s) {
  return s
    .replace(/…+/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/，。/g, '。').replace(/。，/g, '。')
    .replace(/、。/g, '。')
    .replace(/？。/g, '？').replace(/！。/g, '！')
    .replace(/。([」』”"])/g, '。$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 核心：把整章正文矫正。返回 { text, changed, stats:{ellBefore, cplBefore, cplAfter} }
export function deslopText(raw, { mergeUnder = 35 } = {}) {
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
    if (hasDialogue(b)) { flush(); paras.push(normPunct(b)); continue; }  // 对话独立成段
    const n = normPunct(b);
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
export function deslopFile(fp) {
  let raw; try { raw = fs.readFileSync(fp, 'utf8'); } catch { return { file: fp, changed: false, error: 'read' }; }
  const r = deslopText(raw);
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

// 矫正一段章号区间；供【写后强制闸】与手动清洗共用。onLog 逐章报改动。
export function deslopRange(bookDir, from, to = 0, onLog = () => {}) {
  const files = chapterFilesInRange(bookDir, from, to);
  let touched = 0;
  for (const { num, path: fp } of files) {
    const r = deslopFile(fp);
    if (r.changed) { touched++; onLog({ level: 'info', msg: `🧹 第${num}章排版矫正：字/行 ${r.cplBefore}→${r.cplAfter}，删省略号 ${r.ellBefore} 处` }); }
  }
  return { files: files.length, touched };
}
