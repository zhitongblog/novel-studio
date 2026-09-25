// 回指闸：改写一章之后，检查它有没有把【后面章节还在回指的东西】删掉。
//
// 【由来】2026-09-24 夜，拿定点修去补《重生三国》13 章的字数不足。
// 第 014 章为了补 28 个字被重写了 113 行，其中删掉了「摩挲指节」这个动作。
// 而第 015 章开篇就回指它：
//     「十余刀斧手本能向董卓收拢，只有一个人贴墙退向侧门——
//       正是【李儒摩挲指节】后，悄然挪动过靴子的那人。」
// 锚点没了，015 的「正是…那人」从此指向一个读者从没见过的动作。两章都已上架。
//
// 改完跑的 styleGate 一声没吭——它量的是比喻数、堆砌句、套话、感官密度、段长、
// 字数保留率，全是【形式】指标，没有任何一条看前后文对不对得上。
//
// 【判据：用"还剩几章有这个词"把锚点和常用词分开】
// 实测同一本书：
//     摩挲指节  出现在 2 章    ← 锚点，删了就断
//     鸱弓      出现在 1 章
//     旧校场    出现在 22 章
//     赤兔      出现在 65 章
//     方天画戟  出现在 69 章   ← 常用词，删一处毫无影响
// 所以只盯【全书出现章数很少】的短语，常用词天然被排除。
//
// 四个条件同时成立才算断裂（缺一个都会误报）：
//   ① 改写前的第 N 章里有它；
//   ② 改写后的第 N 章里没有了；
//   ③ 现在【还有别的章】在用它——说明它是被回指的；
//   ④ 现在【第 N 章及之前的所有章】都没有它——前情没了，后文的回指落空。
// ④ 是关键：如果更早的章里还有，那锚点仍在，只是换了个位置，不算断。
//
// 纪律：只读、只报，绝不改正文。报出来必须指明【哪一章删了什么、哪一章还在指它】——
// 报一句"疑似不连贯"而不说在哪，等于把活儿又推回给人。

import fs from 'node:fs';
import path from 'node:path';
import { namesFromLedger } from './chapgate.mjs';

// 【第一版的教训：够敏感，但毫无特异性】
// 初版判据只有"全书出现章数 ≤6"。拿 014 那次真实事故回放，它确实抓到了
// 「李儒摩挲指节」——可同时报出约 190 条噪音：「没有回答」「抬起手」「他不敢」
// 「你不是」「的手上」「门开着」…这些通用搭配也只出现在两三章里，照样过了那道筛子。
// 190 条里混着 1 条真的，等于没有这道闸——没人会去读。
//
// 真假两类的差别其实很清楚：
//   真：李儒【摩挲指节】 / 【十七名】存活亲骑 / 灭口的【陈记】证人  → 含专名或数目
//   假：没有回答 / 抬起手 / 他不敢 / 的手上                        → 纯通用搭配
// 所以加一道硬判据：候选必须【含专名或数目】。专名取自台账（与钩子闸同源）。
// 【为什么不能只靠专名表】第二版加了"必须含专名或数目"，噪音从 190 降到 19，
// 却把真阳性「李儒摩挲指节」弄丢了——李儒是卷01 的角色，台账的「人物现状」
// 只列当前在场的人，他早就被移出去了。靠一张会过期的名单当判据，注定漏。
//
// 【改用全书字频：罕见字就是锚点的指纹】同一本书实测（全书 49.4 万汉字）：
//     李儒摩挲指节    最罕字频   8   ← 「挲」全书只有 8 次
//     灭口的陈记证人  最罕字频  97
//     十七名存活亲骑  最罕字频 110（另含数目，双保险）
//   ——以下是该被滤掉的通用搭配——
//     没有回答        最罕字频 141
//     露出一只        最罕字频 202
//     张辽按住        最罕字频 310
//     先看吕布        最罕字频 1154
// 阈值取【相对值】（全书汉字数 ÷ 4000，约 123），换一本书自动缩放。
// ⚠️ 这个阈值是在【一个样本】上调出来的，不是标定值：它会放进少量噪音
//   （「一条干净」最罕字频 84 就会漏网）。宁可多报一条也别漏掉真断裂——
//   但别把它当精确仪器，报出来的每一条仍要人眼确认。
const CN_NUM = /[零〇一二三四五六七八九十百千万两0-9]/;

export function charFreq(text) {
  const f = new Map();
  for (const c of String(text || '').match(/[一-鿿]/g) || []) f.set(c, (f.get(c) || 0) + 1);
  return f;
}

// ⚠️【专名表这条规则已经删掉，别再加回来】第三版一度写成"含专名也算独特"，
// 结果噪音从 19 反弹到 39——因为【任何含「吕布」的短语都被判成有专名】，
// 而主角名是全书最不独特的词，几乎每段都有。名单救不了李儒（不在表里），
// 却放进了「吕布抬眼看」「先看吕布」这一堆。字频规则已经覆盖了它本想做的事。
export function isDistinctive(gram, { freq = null, maxCharFreq = Infinity } = {}) {
  if (CN_NUM.test(gram)) return true;                       // 含数目：具体事实
  if (!freq) return false;
  let min = Infinity;
  for (const c of gram) min = Math.min(min, freq.get(c) || 0);
  return min <= maxCharFreq;                                // 含全书罕见字
}

// 读全书章节（当前磁盘状态）。返回按章号升序的 [{num, text}]
export function loadChapters(bookDir) {
  const root = path.join(bookDir, 'chapters');
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.txt')) continue;
      const m = e.name.match(/^(\d{1,4})/);
      if (!m) continue;
      try { out.push({ num: parseInt(m[1], 10), text: fs.readFileSync(p, 'utf8'), file: e.name }); } catch {}
    }
  };
  walk(root);
  return out.sort((a, b) => a.num - b.num);
}

// 从「被删掉的文字」里取候选锚点：连续汉字组成的 n-gram。
// 长度下限 3：两个字的组合太容易撞车（「指节」「靴子」满书都是），报出来全是噪音。
export function candidateGrams(deletedText, { minLen = 3, maxLen = 8 } = {}) {
  const out = new Set();
  for (const run of String(deletedText || '').match(/[一-鿿]{3,}/g) || []) {
    for (let len = minLen; len <= Math.min(maxLen, run.length); len++) {
      for (let i = 0; i + len <= run.length; i++) out.add(run.slice(i, i + len));
    }
  }
  return [...out];
}

// 只留最长的那个：命中「摩挲指节」时，「摩挲指」「挲指节」都是它的碎片，报三遍等于噪音。
export function keepMaximal(grams) {
  const sorted = [...grams].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const g of sorted) {
    if (!kept.some(k => k.includes(g))) kept.push(g);
  }
  return kept;
}

// 主检查。
//   bookDir  书目录（读改写【后】的现状）
//   before   Map<章号, 改写前的正文>——只查这些章
//   maxSpread 全书出现章数超过这个数的，算常用词，不查（默认 6）
// 返回 { ok, breaks: [{ num, gram, referencedBy: [章号…] }], checked }
export function checkAnchors(bookDir, before, { maxSpread = 6, minLen = 4, maxLen = 10, names } = {}) {
  const chapters = loadChapters(bookDir);
  const byNum = new Map(chapters.map(c => [c.num, c.text]));
  // 专名表与钩子闸同源：台账的「人物现状」那一节
  let nameList = names;
  if (!nameList) {
    let led = ''; try { led = fs.readFileSync(path.join(bookDir, 'continuity_ledger.md'), 'utf8'); } catch {}
    nameList = namesFromLedger(led);
  }
  // 全书字频 + 相对阈值
  const freq = charFreq(chapters.map(c => c.text).join(''));
  let total = 0; for (const v of freq.values()) total += v;
  const maxCharFreq = Math.max(20, Math.round(total / 4000));
  const breaks = [];
  const checked = [];

  for (const [numRaw, oldText] of (before instanceof Map ? before : new Map(Object.entries(before || {})))) {
    const num = Number(numRaw);
    const nowText = byNum.get(num);
    if (!nowText || !oldText) continue;
    checked.push(num);

    // ① 被删掉的文字 = 改写前有、改写后没有的那些行
    const nowLines = new Set(nowText.split(/\r?\n/).map(s => s.trim()));
    const deleted = oldText.split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !nowLines.has(s)).join('\n');
    if (!deleted) continue;

    const cands = candidateGrams(deleted, { minLen, maxLen });
    const hits = [];
    for (const g of cands) {
      // ② 改写后的本章里已经没有了
      if (nowText.includes(g)) continue;
      // ③ 现在还有别的章在用它（= 它是被回指的）
      const others = chapters.filter(c => c.num !== num && c.text.includes(g)).map(c => c.num);
      if (!others.length) continue;
      // 常用词豁免：满书都是的东西，删一处毫无影响
      if (others.length + 1 > maxSpread) continue;
      // 必须像个锚点：含专名或数目。纯通用搭配（「没有回答」）不是锚点，是语言本身
      if (!isDistinctive(g, { freq, maxCharFreq })) continue;
      // ④ 本章及之前都没有它了 —— 前情彻底没了，后文的回指才真的落空
      const earlierHas = chapters.some(c => c.num <= num && c.text.includes(g));
      if (earlierHas) continue;
      const later = others.filter(n => n > num);
      if (!later.length) continue;         // 只有更早的章提过 → 不是回指，不算断
      let rarity = Infinity;
      for (const c of g) rarity = Math.min(rarity, freq.get(c) || 0);
      hits.push({ gram: g, referencedBy: later, rarity });
    }

    // 原句：只报一个半截 n-gram（「两名原证人与」）人根本看不出该补什么，
    // 把它所在的那句话一起带上，才可定位、可动手。
    const sentOf = (g) => {
      for (const line of oldText.split(/\r?\n/)) {
        if (!line.includes(g)) continue;
        for (const sent of line.split(/(?<=[。！？”])/)) if (sent.includes(g)) return sent.trim().slice(0, 60);
        return line.trim().slice(0, 60);
      }
      return '';
    };
    for (const g of keepMaximal(hits.map(h => h.gram))) {
      const h = hits.find(x => x.gram === g);
      breaks.push({ num, gram: g, referencedBy: h.referencedBy, rarity: h.rarity, sentence: sentOf(g) });
    }
  }

  // 越罕见越可能是真锚点 → 排前面。人眼先看的那几条要最值钱。
  breaks.sort((a, b) => a.rarity - b.rarity);
  return { ok: breaks.length === 0, breaks, checked };
}

// 把断裂写成一条【能直接发给作者】的自纠指令。没有断裂返回 ''。
export function buildAnchorFixInstruction(breaks, { max = 12 } = {}) {
  if (!breaks?.length) return '';
  // 只发最可疑的前 max 条：一次甩三十条过去，作者会挑着做，前面最真的那几条反而被埋掉。
  const lines = breaks.slice(0, max).map(b =>
    `第${b.num}章原来有「${b.gram}」${b.sentence ? `（原句：${b.sentence}）` : ''}，你改写时把它删掉了；`
    + `而第${b.referencedBy.join('、')}章还在回指这处（读者会一头雾水，不知道指的是什么）`);
  return [
    '【改写把后文还在回指的东西删掉了，必须补回来】' + lines.join('。'),
    '把这些细节【按原样】写回它原来所在的那一章——位置、措辞可以调整，但那个被回指的动作/物件/说法本身必须在',
    '【别用改后文的办法绕过去】后面那几章已经发出去给读者看过了，不许为了迁就改动去改它们',
  ].join('。');
}
