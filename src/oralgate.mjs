// 口语密度闸的「书级设置」：建议值、写作要求文案。
//
// 由来（2026-10-07）：口语闸原来要人手改 books.json 才能开，阈值也是拍脑袋——
// 同一个 15/千字，《国术》刚好，《岳雷》前文中位数 7.8、《圣女》只有 1.1，一刀切会让后两本每批都被退回重写，
// 既烧 token 又把整本书的腔调硬拧过去。作者原话："这是不是应该是写作工具的能力"。
// 所以：阈值从这本书自己的前文量出来给建议，作者在界面上定；开了以后写作提示里先讲清要求，
// 闸只做兜底——第一稿就照着写，比写完再改一轮省得多。
//
// standards.oral = { mode: 'off'|'report'|'fix', minPerK, maxPerWord }
//   report：只在日志里提醒，不退回；fix：不过就当批退回改语言（只自纠一轮）。
//   兼容旧配置：没有 mode 但有 minPerK 的，按 fix 处理。

import fs from 'node:fs';
import path from 'node:path';
import { scanRegister, scanRhythm } from './chapgate.mjs';

export function oralMode(oral) {
  if (!oral) return 'off';
  if (oral.mode === 'off' || oral.mode === 'report' || oral.mode === 'fix') {
    return oral.mode !== 'off' && !(oral.minPerK > 0) ? 'off' : oral.mode;
  }
  return oral.minPerK > 0 ? 'fix' : 'off';
}

// 读 gate.json 里 oralprobe 推出来的本书口语表（有就用本书自己的词表）
function bookOralTable(bookDir) {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(bookDir, 'gate.json'), 'utf8'));
    return { markers: Array.isArray(g.oralMarkers) ? g.oralMarkers : null, calibrated: !!g.oralThresholds?.calibrated };
  } catch { return { markers: null, calibrated: false }; }
}

function recentChapterFiles(bookDir, n = 30) {
  const out = [];
  const cdir = path.join(bookDir, 'chapters');
  let vols = [];
  try { vols = fs.readdirSync(cdir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  for (const v of vols) {
    let files = [];
    try { files = fs.readdirSync(path.join(cdir, v)); } catch {}
    for (const f of files) {
      const m = f.match(/^(\d+).*\.txt$/i);
      if (m) out.push({ num: parseInt(m[1], 10), fp: path.join(cdir, v, f) });
    }
  }
  return out.sort((a, b) => a.num - b.num).slice(-n);
}

const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// 按本书最近 n 章给建议值。不改任何东西。
export function oralSuggest(book, { n = 30 } = {}) {
  const tbl = bookOralTable(book.dir);
  const files = recentChapterFiles(book.dir, n);
  const perK = [], longPct = [], maxWord = [];
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(f.fp, 'utf8'); } catch { continue; }
    const r = scanRegister(t, tbl.markers ? { markers: tbl.markers } : {});
    const h = scanRhythm(t);
    perK.push(r.perK);
    longPct.push(Math.round((h.longSentRatio || 0) * 100));
    maxWord.push(Math.max(0, ...(r.found || []).map(s => Number(String(s).split('×')[1]) || 0)));
  }
  const stats = {
    chapters: perK.length,
    from: files[0]?.num || 0, to: files[files.length - 1]?.num || 0,
    perKMedian: q(perK, 0.5), perKP25: q(perK, 0.25), perKMin: perK.length ? Math.min(...perK) : 0,
    longMedian: q(longPct, 0.5), maxWordMedian: q(maxWord, 0.5),
    table: tbl.markers ? '本书自己的口语表（gate.json）' : '默认北方官话表', calibrated: tbl.calibrated,
  };
  // 建议：门槛定在本书前文的 25 分位——拦的是"比自己平时明显更书面"的批次，不去改本书原有的腔调。
  // 没经朱雀标定的表，建议只提醒不自动改（自动改的依据不足）。
  const minPerK = Math.max(1, Math.round(stats.perKP25));
  const maxPerWord = stats.maxWordMedian <= 2 ? 2 : Math.min(4, Math.ceil(stats.maxWordMedian / 2) + 1);
  const mode = stats.chapters < 5 ? 'off' : (tbl.calibrated ? 'fix' : 'report');
  const why = stats.chapters < 5
    ? '前文不足 5 章，量不出可靠分布，先不开'
    : `最近 ${stats.chapters} 章口语中位 ${stats.perKMedian}/千字、25 分位 ${stats.perKP25}；门槛取 25 分位，只拦比本书平时更书面的批次。`
      + (tbl.calibrated ? '' : '口语表未经朱雀标定，建议先"只提醒"。');
  return { suggest: { mode, minPerK, maxPerWord }, stats, why };
}

// 写作要求（放进每批 prompt 和 AGENTS/CLAUDE.md）。关着就返回空串。
export function oralPromptSection(oral) {
  const mode = oralMode(oral);
  if (mode === 'off') return '';
  const per = oral.maxPerWord || 2;
  return [
    '## 口语与句式（本书已开口语密度闸）',
    `- 口语标记写到每千字 ${oral.minPerK} 个以上即可，不要往上堆；同一个口语词每章最多 ${per} 次，换着说；不造「底下头」「脸上头」这类不存在的词。`,
    '- 口语靠句法和对白：短分句、省主语、人物各说各的腔；不要往叙述里硬塞口语词。',
    '- 叙述别写成短句节拍器：碎句并成逗号连缀的流水句，叙述里 >25 字的长句占两成以上，同时留一部分短句；均句长 ≤22。',
    '- "不是X，是Y"每章最多 1 处；"跟……似的"每章最多 2 处；不写工整对仗的金句，不让旁白替主角喝彩。',
    mode === 'fix' ? '- 写完会自动量；不达标的章会被退回只改语言。' : '- 写完会自动量并在日志里提醒。',
  ].join('\n');
}
