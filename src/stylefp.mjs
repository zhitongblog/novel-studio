// 文风指纹：拿这本书【自己已经写出来的几百章】当标尺，判"新章有没有变成另一个人写的"。
//
// 由来（2026-09-28，《崇祯》297–321）。那一批 25 章，逐条对照写死的阈值几乎都"只是略超"，
// 可跟本书自己一比就是换了个人：
//
//              291–296（本书原样）   297–308（新写）
//   均句长          15.4–18.2          25.6–29.3
//   字/段           31.9–40.7          54.9–87.8
//   短句占比        35–47%             12–24%
//   感叹号/章       0（290–295 全 0）   19–54
//
// 旧闸报的是「均句长 25.7，超过 22」。22 是写死的默认值，
// 而真正的事实是【这本书 296 章一直写在 15–18】。对通用阈值只是略超，对这本书是事故。
// 感叹号更直接：全书没有任何一道闸在量它，只拿它切句子。
//
// 所以这里只做一件事：**把阈值从"我以为好文笔该是什么样"换成"这本书自己是什么样"**。
// 判据一律是「偏离本书自身分布」，不是「偏离我写死的数」。
//
// 配套的还有 style_refs/（范本）：指纹负责【判】，范本负责【示范】——
// 光判不给样子，模型只会在数值上兜圈子。两者都从本书已写章里自动挑，见 probeStyle()。

import fs from 'node:fs';
import path from 'node:path';
import { styleMetrics } from './pacing.mjs';

// 这几根轴越大越"爆款腔"，只设上限；越界即偏离。
// 分两族，因为它们的量纲完全不同，用同一条公式必然有一边失准：
//   · 腔调族（密度，全书常年贴着 0）：乘法 2.5× 兜"本来就爱用"的书，
//     加法 +1.0 兜"全书几乎为零"的书——否则 p90=0 会算出一句话就越界的线。
//   · 形态族（均句长、字/段，本来就是十几到几十）：2.5× 等于放行到 45 字一句，形同虚设。
//     实测《崇祯》p90=18，新章 25.6–29.3——要 1.35× 才拦得住，这个系数是照着那批定的。
const UP_ONLY = {
  bangPerK: '感叹号',
  similePerK: '「如…般/仿佛/宛如」式比喻',
  cheerPerK: '旁白替读者鼓掌',
  avgLen: '均句长',
  avgPara: '字/段',
};
const SHAPE = new Set(['avgLen', 'avgPara']);
// 这根轴越小越"书面腔"，只设下限。
const DOWN_ONLY = {
  shortRatio: '短句(≤10字)占比',
};

const clean = (t) => String(t).replace(/\s/g, '');
const chapNum = (name) => parseInt((String(name).match(/^(\d{1,4})/) || [])[1] || '0', 10);

function pct(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// 扫全书章节，返回 [{num, file, chars, metrics}]
export function scanChapters(bookDir, { upto = 0 } = {}) {
  const root = path.join(bookDir, 'chapters');
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      // 跟 checkup 同一条约定：点号/下划线开头的目录与文件是备份废稿，不算章节
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !e.name.startsWith('_')) walk(p); continue; }
      if (!/\.txt$/i.test(e.name) || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const num = chapNum(e.name);
      if (!num) continue;
      if (upto > 0 && num > upto) continue;
      let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const chars = clean(t).length;
      if (chars < 500) continue;            // 残章不参与统计，会把分布拉歪
      out.push({ num, file: p, name: e.name.replace(/\.txt$/i, ''), chars, metrics: styleMetrics(t) });
    }
  };
  walk(root);
  return out.sort((a, b) => a.num - b.num);
}

// 这本书自己的分布：每根轴的 p50 / p90，外加一条"越过就算换了个人"的天花板/地板。
//
// 天花板取 max(p90 × 2.5, p90 + 1.0)：
//   · 乘法项让"本来就爱用"的书有余地（p90 已经 4/千字的书，到 10 才报）；
//   · 加法项兜住"全书几乎为零"的轴——《崇祯》感叹号 p90 只有 0.5/千字，
//     纯乘法会算出 1.25 这种一句话就越界的线，加法把它抬到 1.5，仍然远低于新章的 8.46。
export function buildFingerprint(bookDir, { upto = 0, minChapters = 20 } = {}) {
  const chs = scanChapters(bookDir, { upto });
  if (chs.length < minChapters) return null;     // 样本太少，分布不可信，宁可不判
  const axes = {};
  for (const k of [...Object.keys(UP_ONLY), ...Object.keys(DOWN_ONLY)]) {
    const v = chs.map(c => c.metrics[k]).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) continue;
    const p50 = +pct(v, 0.5).toFixed(2), p90 = +pct(v, 0.9).toFixed(2), p10 = +pct(v, 0.1).toFixed(2);
    axes[k] = UP_ONLY[k]
      ? { p50, p90, max: +(SHAPE.has(k) ? p90 * 1.35 : Math.max(p90 * 2.5, p90 + 1.0)).toFixed(2) }
      : { p50, p10, min: +Math.max(0, Math.min(p10 * 0.5, p10 - 0.1)).toFixed(3) };
  }
  return { chapters: chs.length, upto: chs[chs.length - 1]?.num || 0, at: new Date().toISOString().slice(0, 10), axes };
}

// 一章 vs 指纹：返回越界的轴。空数组 = 跟本书一个调子。
export function driftOf(metrics, fp) {
  if (!fp?.axes) return [];
  const bad = [];
  for (const [k, label] of Object.entries(UP_ONLY)) {
    const a = fp.axes[k]; if (!a) continue;
    const v = metrics[k];
    if (typeof v === 'number' && v > a.max) {
      bad.push({ axis: k, label, value: v, limit: a.max, p50: a.p50, dir: 'up' });
    }
  }
  for (const [k, label] of Object.entries(DOWN_ONLY)) {
    const a = fp.axes[k]; if (!a) continue;
    const v = metrics[k];
    if (typeof v === 'number' && v < a.min) {
      bad.push({ axis: k, label, value: v, limit: a.min, p50: a.p50, dir: 'down' });
    }
  }
  return bad;
}

const fmt = (k, v) => (k === 'bangPerK' || k === 'similePerK' || k === 'cheerPerK') ? `${v}/千字`
  : k === 'shortRatio' ? `${Math.round(v * 100)}%`
  : String(v);

// 把越界写成人话 + 改法。给模型看的，所以说"跟本书自己比是多少"，不说"超过阈值"。
export function driftInstruction(rows) {
  if (!rows.length) return '';
  const lines = ['**文风漂移：这几章跟本书自己的前文不是一个调子**（判据是本书已写章的分布，不是写死的阈值）：', ''];
  for (const r of rows) {
    const items = r.drift.map(d => d.dir === 'up'
      ? `${d.label} ${fmt(d.axis, d.value)}（本书中位 ${fmt(d.axis, d.p50)}，越过 ${fmt(d.axis, d.limit)} 就算换了个人）`
      : `${d.label} ${fmt(d.axis, d.value)}（本书中位 ${fmt(d.axis, d.p50)}，低于 ${fmt(d.axis, d.limit)} 就算换了个人）`);
    lines.push(`  · **第 ${r.num} 章**：${items.join('；')}`);
  }
  lines.push('',
    '就地改（只调语言，不改情节、不改章名、不动台词的意思）：',
    '  · **感叹号**：删到跟前文一个密度。气势不靠感叹号，靠动作和后果——「他把刀拍在案上」比「他怒吼一声！」有力。',
    '  · **「如…般/仿佛/宛如」**：换成这个人物真能看见的东西。「目光如利剑」→ 他盯着谁、盯了多久、对方先挪开了眼。',
    '  · **旁白喝彩**：删掉叙述者替读者鼓掌的句子（「字字诛心」「无数人眼眶瞬间红了」「何曾有…」）。',
    '　　把它换成某一个具体的人做了什么——一个人比"数千人"更让读者信。',
    '  · **句子/段落变厚**：拆回前文的长度。参照 style_refs/ 里的范本，那是本书自己的样子。',
    '',
    '⚠️ 越是高潮越要压住腔调。这本书前面几百章没靠感叹号写过高潮，这几章也不该靠。');
  return lines.join('\n');
}

// 从本书已写章里【自动挑范本】：离全书中位最近、且三根腔调轴都低于中位的那几章。
// 不挑"最好看的"——挑"最像这本书平均水平的"，范本是基线不是标杆。
export function pickRefChapters(bookDir, { n = 3, upto = 0 } = {}) {
  const chs = scanChapters(bookDir, { upto });
  if (chs.length < 10) return [];
  const fp = buildFingerprint(bookDir, { upto, minChapters: 10 });
  if (!fp) return [];
  const score = (c) => {
    let d = 0;
    for (const k of Object.keys(fp.axes)) {
      const a = fp.axes[k], v = c.metrics[k];
      if (typeof v !== 'number' || !a?.p50) continue;
      d += Math.abs(v - a.p50) / (Math.abs(a.p50) || 1);          // 离中位越近越好
    }
    // 腔调轴高于中位的直接罚重——范本不能自带爆款腔，否则闸会照着它放行
    for (const k of ['bangPerK', 'similePerK', 'cheerPerK']) {
      const a = fp.axes[k], v = c.metrics[k];
      if (a && typeof v === 'number' && v > a.p50) d += 2;
    }
    return d;
  };
  return chs.map(c => ({ ...c, score: score(c) })).sort((a, b) => a.score - b.score).slice(0, n);
}

// 挂范本 + 存指纹。gate.json 里存指纹（跟 oralThresholds 同一个地方），
// style_refs/ 里放范本正文（pacing.refTargets 读的就是它）。
export function probeStyle(bookDir, { n = 3, upto = 0, write = true } = {}) {
  const fp = buildFingerprint(bookDir, { upto });
  if (!fp) return { ok: false, reason: '已写章不足 20 章，分布不可信——写够了再挂' };
  const picks = pickRefChapters(bookDir, { n, upto });
  if (!write) return { ok: true, fingerprint: fp, picks };

  const dir = path.join(bookDir, 'style_refs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // 只清我们自己写过的范本（带前缀），作者手工放进去的不动
  try {
    for (const f of fs.readdirSync(dir)) if (/^自选-/.test(f)) fs.unlinkSync(path.join(dir, f));
  } catch {}
  for (const p of picks) {
    try { fs.writeFileSync(path.join(dir, `自选-${p.name}.txt`), fs.readFileSync(p.file, 'utf8'), 'utf8'); } catch {}
  }

  const gp = path.join(bookDir, 'gate.json');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(gp, 'utf8')); } catch {}
  conf.styleFingerprint = fp;
  conf.styleRefs = picks.map(p => p.name);
  try { fs.writeFileSync(gp, JSON.stringify(conf, null, 2) + '\n', 'utf8'); } catch {}
  return { ok: true, fingerprint: fp, picks, refDir: dir };
}

export function loadFingerprint(bookDir) {
  try { return JSON.parse(fs.readFileSync(path.join(bookDir, 'gate.json'), 'utf8')).styleFingerprint || null; }
  catch { return null; }
}
