// 口语表探底器：拿一本书自己的正文，量出它自己的口语底子，导出这本书专属的口语表和阈值。
//
// 【为什么需要这个】
// 语域闸原本只有一张豫北官话表。拿它去量《重生三国》，113 章全判"整章书面腔"；
// 去量《被圣女试药后》，499 章 100% 低于 20/千字，中位数只有 2.0——
// 数值没错，结论没法用：汉末的人不说"自个儿"，修仙书里也没人说"咋"。
// 手工一本配一张表不可持续（每张表都要拿全书探底 + 逐条验误伤），所以把这件事做成自动的。
//
// 【它怎么工作】
// 1. 拿一个跨语体的候选词库（现代北方白话 / 明清白话 / 演义腔 / 跨时代通用）去全书点名；
// 2. 用得上的留下，一次没用过的踢掉——那些不是"这本书缺口语"，是"这路词不属于这本书"；
// 3. 查误伤：只给【验过的】词加 (?<!…) 约束（见 KNOWN_TRAPS），
//    其余疑似的连例句一起写进 gate.json，等人看过再决定——理由见下面那段；
// 4. 阈值不拍脑袋，从这本书【自己的逐章分布】里取分位数——
//    闸从此报的是"这一章比全书四分之三的章都干"，而不是"够不够 20"。
//
// 【它不做什么】
// 不标定。绝对阈值只有朱雀能定，导出的表一律 calibrated:false，
// 报警措辞会跟着降级（见 chapgate.mjs 里的 why）。

import fs from 'node:fs';
import path from 'node:path';

// ── 候选词库 ─────────────────────────────────────────────────────────
// 按语体分家族。探底时全部点名，留下这本书真用的那一路。
// 单字词一律不收或自带约束——否则书面词会被算成口语（便宜/况且/某种/罢免/厮杀…）。
export const CANDIDATE_LEXICON = {
  现代北方白话: [
    '自个儿', '咋', '啥', '这会儿', '那会儿', '味儿', '娃子', '赶明儿', '一气儿',
    '这么着', '那么着', '了吧', '统共', '拢共', '出溜', '合计', '蔫', '家什',
    '犯不上', '值当', '架不住', '不作数', '就算完', '保不齐', '指不定', '没准',
  ],
  明清白话: [
    '小的', '老夫', '在下', '娃娃', '跟前', '末了', '索性', '偏生', '平白', '委实',
    '眼下', '只顾', '横竖', '当真', '少不得', '左右', '省得', '免得', '用不着',
    '不打紧', '不中用', '不济', '罢了', '就是了', '也罢', '便是', '端的', '打量',
    '晓得', '寻思', '拾掇', '好生', '生怕', '到底',
  ],
  演义腔: [
    '甚么', '作甚', '做甚', '怎地', '怎的', '怎生', '难不成', '莫不是', '岂不',
    '何苦', '莫要', '休要', '休得', '这厮', '那厮', '某家', '俺', '兀自',
    '竖子', '匹夫', '鼠辈', '呸', '直娘贼',
  ],
  跨时代通用: [
    '里头', '外头', '上头', '后头', '底下', '这地方', '打哪', '一溜', '老半天',
    '半晌', '瞧', '瞅', '搁', '攥', '拎', '杵', '撒手', '俩', '仨', '咱们', '咱',   // 「咱」自带 (?!们) 约束，见 KNOWN_TRAPS，不然会和「咱们」重复计数
    '跟[^，。！？]{1,8}似的', '似的', '挺[久好多大远快慢]',
  ],
};

// 全部候选摊平（去重）
export function allCandidates() {
  const seen = new Set();
  const out = [];
  for (const [family, words] of Object.entries(CANDIDATE_LEXICON)) {
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push({ w, family });
    }
  }
  return out;
}

// ── 读书 ────────────────────────────────────────────────────────────
// 只读带编号的章节文件，跳过简介/备份/下划线开头的。
export function readChapterTexts(bookDir) {
  const cdir = path.join(bookDir, 'chapters');
  const out = [];
  let vols = [];
  try { vols = fs.readdirSync(cdir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map((e) => e.name); } catch { return out; }
  for (const v of vols) {
    let files = [];
    try { files = fs.readdirSync(path.join(cdir, v)).filter((f) => /^\d+/.test(f) && /\.txt$/i.test(f) && !f.startsWith('_')); } catch { continue; }
    for (const f of files) {
      const num = parseInt(f, 10);
      if (!Number.isFinite(num)) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(cdir, v, f), 'utf8'); } catch { continue; }
      out.push({ num, vol: v, file: f, text });
    }
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

const hanCount = (s) => (String(s).match(/[一-龥]/g) || []).length;

// ── 误伤 ────────────────────────────────────────────────────────────
//
// 【为什么不自动加约束】2026-09-24 第一版是按"邻字集中度"自动加 (?<!…) 的，跑出来全是错的：
//   攥→攥(?!着)、瞧→瞧(?!见)、打哪→打哪(?!儿)、自个儿→(?<!他)自个儿
// 「攥着」「瞧见」「打哪儿来」「他自个儿」全是正常搭配，约束一加就把合法的命中踢掉三四成。
// 真正的误伤是【这个词被包在一个意思无关的长词里】（「相似的」里的似的、「千钧一发」里的一发），
// 光看邻字频率分不出来——那要语义。所以规矩改成：
//   · 已验证的误伤（KNOWN_TRAPS）才自动加约束；
//   · 其余只当"疑似"报出来，连例句一起写进 gate.json，等人看过再决定。
// 自动套一个没验过的约束，就是这套工具最容易造成的那种机械损伤，不干。

// 已验证的误伤。每一条都带例句，删之前先看例句。
// 前三条来自远端那张汉末三国表（拿 37 万字全书验过），后面是通用的。
export const KNOWN_TRAPS = {
  '似的': { pattern: '(?<![相类近])似的', why: '「相似的/类似的/近似的」不是比喻', 例: '能说明他们去过相似的地方' },
  '端的': { pattern: '(?<![叫端])端的', why: '「粥是我叫端的」「好端端的」', 例: '好端端的' },
  '一发': { pattern: null, why: '几乎全部来自「千钧一发」，直接踢掉', 例: '千钧一发之际' },
  '咱': { pattern: '咱(?!们)', why: '不加约束会和「咱们」重复计数', 例: '咱们' },
  '到底': { pattern: '(?<![说走查问追])到底', why: '「查到底/追到底」是动补，不是语气词', 例: '这件事要查到底' },
  '左右': { pattern: '左右(?![手边两])', why: '「左右手/左右两边」是方位，不是「横竖」的意思', 例: '左右两边' },
};

// 这些候选的非口语义太常见，探底时单独标出来，让人决定留不留。
export const AMBIGUOUS = new Set(['到底', '左右', '便是', '眼下', '好生', '当真', '罢了']);

// 疑似误伤侦测：只报，不自动改。靠前后字集中度发现"值得看一眼"的词。
export function detectTraps(text, word, { shareGate = 0.3, minHits = 6 } = {}) {
  // 带正则元字符的候选（跟…似的 / 挺[…]）不做前字分析，它们本身就是结构式
  if (/[[\]()|^$*+?{}\\]/.test(word)) return null;
  const idx = [];
  let i = -1;
  while ((i = text.indexOf(word, i + 1)) >= 0) idx.push(i);
  if (idx.length < minHits) return null;
  const tally = (chars) => {
    const c = {};
    for (const ch of chars) if (ch) c[ch] = (c[ch] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  const prev = tally(idx.map((p) => (p > 0 ? text[p - 1] : '')).filter((ch) => /[一-龥]/.test(ch || '')));
  const next = tally(idx.map((p) => text[p + word.length] || '').filter((ch) => /[一-龥]/.test(ch || '')));
  const top = (list) => (list.length ? { ch: list[0][0], n: list[0][1], share: +(list[0][1] / idx.length).toFixed(2) } : null);
  const p = top(prev);
  const n = top(next);
  const traps = [];
  if (p && p.share >= shareGate) traps.push({ side: 'prev', ...p });
  if (n && n.share >= shareGate) traps.push({ side: 'next', ...n });
  if (!traps.length) return null;
  // 例句，给人复核用——照搬远端那张三国表的规矩：删约束前先看例句
  const sample = (t) => {
    const want = t.side === 'prev' ? t.ch + word : word + t.ch;
    const at = text.indexOf(want);
    return at < 0 ? '' : text.slice(Math.max(0, at - 8), at + want.length + 8).replace(/\s+/g, '');
  };
  return { hits: idx.length, traps: traps.map((t) => ({ ...t, 例: sample(t) })) };
}

// 只有验过的误伤才落到正则上。返回 null 表示这个词整个踢掉。
export function guardWord(word) {
  if (!(word in KNOWN_TRAPS)) return word;
  return KNOWN_TRAPS[word].pattern;   // 可能是 null（整词踢掉）
}

// ── 探底 ────────────────────────────────────────────────────────────
export function probeBook(bookDir, { minPerKKeep = 0.02 } = {}) {
  const chapters = readChapterTexts(bookDir);
  if (!chapters.length) return { ok: false, reason: '这本书没有带编号的章节文件，探不了底' };
  const all = chapters.map((c) => c.text).join('\n');
  const han = hanCount(all) || 1;

  const kept = [];
  const absent = [];
  const dropped = [];
  const suspects = [];   // 疑似误伤：只报给人看，不自动改
  for (const { w, family } of allCandidates()) {
    const m = all.match(new RegExp(w, 'g'));
    const n = m ? m.length : 0;
    const perK = +(n / han * 1000).toFixed(3);
    if (n === 0) { absent.push({ w, family }); continue; }
    if (perK < minPerKKeep) { dropped.push({ w, family, n, perK, why: '太稀，留着只会抬高分母' }); continue; }
    const pattern = guardWord(w);
    if (pattern === null) { dropped.push({ w, family, n, perK, why: KNOWN_TRAPS[w].why }); continue; }
    const sus = detectTraps(all, w);
    if (sus && !(w in KNOWN_TRAPS)) suspects.push({ w, ...sus });
    kept.push({ w, family, n, perK, pattern, guarded: pattern !== w, ambiguous: AMBIGUOUS.has(w) });
  }
  kept.sort((a, b) => b.perK - a.perK);

  // 家族画像：这本书的语体偏向哪一路
  const byFamily = {};
  for (const k of kept) byFamily[k.family] = (byFamily[k.family] || 0) + k.perK;
  for (const f of Object.keys(CANDIDATE_LEXICON)) byFamily[f] = +(byFamily[f] || 0).toFixed(2);

  // 【别拿未标定的表换掉标定过的】
  // 画像如果压倒性落在某个已标定的预设上，就该用那张预设——它的阈值是朱雀实测出来的，
  // 探底导出的表再贴合，阈值也只是本书分位数，换过去等于把标定弄丢了。
  const 建议用预设 = (() => {
    const 现代 = byFamily['现代北方白话'] || 0;
    const 其他 = Math.max(byFamily['明清白话'] || 0, byFamily['演义腔'] || 0);
    if (现代 >= 3 && 现代 > 其他 * 2) {
      return { set: '北方官话', why: `现代北方白话密度 ${现代}，压倒性主导，且这张表的阈值经过朱雀标定——用预设比用导出的表稳` };
    }
    return null;
  })();

  return { ok: true, chapters: chapters.length, han, kept, absent, dropped, suspects, byFamily, 建议用预设 };
}

// ── 导表 ────────────────────────────────────────────────────────────
// 阈值从这本书自己的逐章分布里取分位数，不拍脑袋，也不套别的书的数。
export function deriveOralTable(bookDir, probe, { floorPct = 0.05, passPct = 0.25 } = {}) {
  const markers = probe.kept.map((k) => k.pattern);
  const chapters = readChapterTexts(bookDir);
  const perChapter = chapters.map((c) => {
    const han = hanCount(c.text) || 1;
    let hits = 0;
    for (const p of markers) hits += (c.text.match(new RegExp(p, 'g')) || []).length;
    return { num: c.num, perK: +(hits / han * 1000).toFixed(1) };
  });
  const vals = perChapter.map((x) => x.perK).sort((a, b) => a - b);
  const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0);
  const median = q(0.5);
  // hardFloor 至少给 0.3，否则分布低的书会导出 0——那样这道闸永远不会响，等于没有。
  const hardFloor = Math.max(0.3, +q(floorPct).toFixed(1));
  const minPerK = Math.max(hardFloor + 0.1, +q(passPct).toFixed(1));

  // 【集中度上限也得跟着书走】
  // 22% 这个上限是按豫北表（六十多个词）定的。《被圣女试药后》导出的表只有 25 个词，
  // 而「小的」是主角的自称（全书 939 次），有些章占到 60–73%——
  // 那不是口癖，是人物。拿 22% 去卡，254 章里有一半是被这一条误伤的。
  // 所以上限也从本书自己的分布取：取逐章 top 词占比的 90 分位，留一成给真正的异常。
  const 主导票 = {};
  const shares = chapters.map((c) => {
    const tally = markers.map((p) => (c.text.match(new RegExp(p, 'g')) || []).length);
    const hits = tally.reduce((a, b) => a + b, 0);
    if (hits < 10) return null;
    const top = Math.max(...tally);
    const w = probe.kept[tally.indexOf(top)];
    if (w) 主导票[w.w] = (主导票[w.w] || 0) + 1;
    return top / hits;
  }).filter((x) => x !== null).sort((a, b) => a - b);
  // 给写作用的靶子：本书较好那四分之一的水平。minPerK 是地板（低于它算掉队），
  // 靶子是"往哪儿够"——只给地板，模型会照着地板写，那是把下限当上限。
  const 建议目标 = +q(0.75).toFixed(1);

  const maxShare = shares.length
    ? Math.min(0.75, Math.max(0.22, +(shares[Math.floor(shares.length * 0.9)]).toFixed(2)))
    : 0.22;
  // 上限导得高时，必须说清楚是谁把它顶上去的——否则 71% 这种数字没人看得懂，
  // 也没人能判断它是"人物就这么说话"还是"作者在堆词"。
  const 主导词 = Object.entries(主导票).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([w, n]) => ({ 词: w, 领跑章数: n }));

  // 【别让相对阈值把事实盖住】
  // 导出的阈值答的是"这一章比你自己的书干不干"，答不了"这书会不会被判成 AI"。
  // 2026-09-23 朱雀实测：口语密度低于 5/千字的样本，人类率一律为 0。
  // 所以中位数低于 5 的书，必须单独说一句——否则作者会以为"全章过闸"就等于没问题。
  const 整书提醒 = median < 5
    ? `⚠️ 这本书在自己的表下中位数也只有 ${median}/千字，低于朱雀标定的危险线 5。`
      + `导出的阈值是相对指标（只比得过你自己的书），不代表过得了 AI 检测。`
      + `要下结论，拿两三章去朱雀跑一次，再回来定绝对阈值。`
    : '';

  // display / examples 给写作模板用（src/skill.mjs 会渲进 AGENTS.md）——
  // 闸换了表而模型没换，这本书只会被一直判红而永远改不动。
  const display = probe.kept.slice(0, 40).map((k) => k.w.replace(/\[\^[^\]]+\][^ ]*/, '…')).join('、');

  return {
    markers, hardFloor, minPerK, maxShare, 主导词, 建议目标, calibrated: false,
    整书提醒, median,
    display,
    分布: { 章数: vals.length, 最低: vals[0], 四分位: q(0.25), 中位: median, 四分位上: q(0.75), 最高: vals[vals.length - 1] },
    perChapter,
  };
}

// 写回 gate.json：表 + 阈值 + 出处（出处很重要，半年后没人记得这张表怎么来的）
export function writeGateOral(bookDir, probe, derived, { dry = false } = {}) {
  const gp = path.join(bookDir, 'gate.json');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(gp, 'utf8')); } catch {}
  conf.oralMarkers = derived.markers;
  conf.oralThresholds = { hardFloor: derived.hardFloor, minPerK: derived.minPerK, maxShare: derived.maxShare, 建议目标: derived.建议目标, calibrated: false };
  if (derived.整书提醒) conf.oralThresholds.整书提醒 = derived.整书提醒;
  conf.oralDisplay = derived.display;
  conf._oral出处 = {
    生成时间: new Date().toISOString().slice(0, 10),
    做法: '拿全书正文对跨语体候选词库点名，留下这本书真用的那一路；阈值取本书逐章分布的分位数',
    探底: `${probe.chapters} 章 / ${probe.han} 汉字`,
    语体画像: probe.byFamily,
    逐章分布: derived.分布,
    单词上限由谁顶上去: derived.主导词,
    '⚠️': '阈值【未经朱雀标定】，只当相对指标看（比的是"这章比全书多干"，不是"够不够N"）。要下死结论先拿两三章跑一次朱雀。',
    本书不用的词: probe.absent.slice(0, 30).map((a) => a.w),
    加了约束的词: probe.kept.filter((k) => k.guarded).map((k) => ({ 词: k.w, 约束: k.pattern, 依据: (KNOWN_TRAPS[k.w] || {}).why })),
    一词多义待复核: probe.kept.filter((k) => k.ambiguous).map((k) => k.w),
    疑似误伤待人看: (probe.suspects || []).map((s) => ({ 词: s.w, 命中: s.hits, 线索: s.traps })),
  };
  if (!dry) fs.writeFileSync(gp, JSON.stringify(conf, null, 2), 'utf8');
  return { path: gp, conf };
}
