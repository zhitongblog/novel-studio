// 节奏闸（确定性、不靠模型自觉）：治「章越写越长、事务流程当主线、量级不换挡、章末假钩子」。
//
// 病根：skill.mjs 里那几条——「单章 3000–3600 字」「严禁把办手续/对账当章节主线」「禁止连续 ≥2 章
// 事务流程」「格局必须随卷可感升级」——全是写给模型看的说教。长程写作里模型会稳定漂移，而且
// 越漂越顺手：《重生94，我让爸妈替我当首富》11–39 章实测平均 9919 字（规定 3000–3600，超 2.8 倍）、
// 连续 29 章以单据/账目/手续为主线、29 章里主角自有现金 0.62 元 → 10.34 元、书名承诺的「首富」
// 一次都没兑现。每一条都踩了 skill.mjs 白纸黑字的红线，但没有任何东西拦得住它。
//
// 教训跟当初「……」雪球一模一样：规则写在 prompt 里是建议，量在代码里才是闸。
//
// 与 deslop 的分工：排版能机械矫正（deslop 直接改字，改完就干净了）；节奏不能——拆章要起章名、
// 补爽点要写情节，只有模型自己动笔。所以本闸只做两件事：
//   ① 用确定性指标量出病灶（章长/流程密度/量级曲线/钩子类型）
//   ② 生成一条「退回自纠」指令交给上层注入，让模型在【本批还没变成下一批上下文之前】就改掉。

import fs from 'node:fs';
import path from 'node:path';
import { chapterFilesInRange } from './deslop.mjs';

// —— 事务流程词表：这些东西当背景质感可以，当整章主线就是流水账 ——
const PAPERWORK = ['单据', '抬头', '报价', '比价', '执照', '验收', '结款', '备案', '发票', '收据',
  '对账', '盘点', '清点', '登记', '手续', '批文', '公文', '卷宗', '账本', '账目', '存根', '凭据',
  '采购单', '介绍信', '盖章', '签字', '经手人', '工商', '税务', '报销'];

// 章名另有一份更宽的词表：章名只有几个字，口语说法（「这单得挂我妈名下」「这活能不能走厂里的账」）
// 用正式词表扫不出来，但章名叫这个就说明整章主线是那张单子。章名短，放宽不易误伤。
const PAPERWORK_TITLE = [...PAPERWORK, '名下', '单子', '这单', '那单', '走账', '入账', '账上', '抵账', '上单'];

// —— 假钩子词表：章末总结/抒情/预告，skill.mjs 明令判废 ——
const FAKE_HOOK = ['才刚刚开始', '拉开了序幕', '等待着他', '等待着我', '命运', '注定', '谁也没想到',
  '未来的日子', '从此以后', '不知道的是', '殊不知', '一切都变了', '悄然', '暗流'];

// —— 对手服软/打脸信号（弱信号，只做提示不判事故）——
const PAYOFF = ['脸一下子白', '脸色变了', '说不出话', '没敢再', '服软', '认了', '服了', '道歉',
  '低头', '闭嘴', '没想到你', '刮目', '拿下', '签了字', '点了头', '答应了', '认输', '让开'];

const clean = (s) => String(s || '').replace(/\s/g, '');

// 中文数目 → 阿拉伯数（覆盖「一百五十六块八」「两千二百六十七」「三万八」这类口语写法；解析不了返回 NaN）
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
function cnNum(s) {
  if (!s) return NaN;
  let total = 0, section = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) { cur = CN_DIGIT[ch]; seen = true; continue; }
    const u = CN_UNIT[ch];
    if (!u) continue;
    seen = true;
    if (u >= 10000) { total += (section + (cur || 0)) * u; section = 0; cur = 0; }
    else { section += (cur || 1) * u; cur = 0; }
  }
  const n = total + section + cur;
  return seen ? n : NaN;
}

// 前世/未来标记：重生文里主角常拿上辈子的数目作对照（「上辈子我做过的最小一个单子是三十七万」），
// 那是前世的钱，不是本世的战果。量级曲线必须把这类句子剔掉，否则每本重生文开篇就被自己污染。
const PASTLIFE = /上辈子|上一世|前世|重生前|三十年后|后来我才|那时候我/;

// 抽出一章里出现的最大「钱数」——量级换挡的度量衡。同时认阿拉伯数字与中文数目。
// 按句切分后逐句取数：含前世标记的句子整句跳过。
function maxMoney(text) {
  let max = 0;
  for (const sent of String(text).split(/[。！？\n]/)) {
    if (!sent || PASTLIFE.test(sent)) continue;
    for (const m of sent.matchAll(/(\d+(?:\.\d+)?)\s*(万元|万块|万|元|块钱|块)/g)) {
      let v = parseFloat(m[1]);
      if (/^万/.test(m[2])) v *= 10000;
      if (v > max) max = v;
    }
    for (const m of sent.matchAll(/([零〇一二两三四五六七八九十百千万亿]{2,})\s*(万元|万块|万|元|块钱|块)/g)) {
      let v = cnNum(m[1]);
      if (!Number.isFinite(v)) continue;
      if (/^万/.test(m[2])) v *= 10000;
      if (v > max) max = v;
    }
  }
  return max;
}

// —— 文风机械度：治「规范执行到极致 = 公式」——
//
// 病根跟前面几条不一样：不是不守规范，是【太守规范】。bible 里每条单独看都对，叠加执行就成了模板。
// 《重生94》实测（52 章 17.5 万字）：短句(≤10字)占 49%、数目每 92 字一个（规范要求 250–400 字
// 一个实锚，超标 3–4 倍）、「X把Y…」句式 702 句。单看每句都是好细节，连着读三十章就是节拍器。
// 作者的原话：「你不觉得很机械吗」——而闸当时全绿，因为它只量结构不量语言。
//
// 这几样恰好能量化，所以能建闸。量不到的部分（好不好看）仍然只能靠人读。
function styleMetrics(text) {
  const sents = String(text).split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length > 2);
  const n = sents.length || 1;
  const lens = sents.map(s => s.length);
  const short = lens.filter(l => l <= 10).length;
  const long = lens.filter(l => l > 25).length;
  const chars = clean(text).length || 1;
  const nums = (text.match(/[零〇一二两三四五六七八九十百千万]{2,}|\d+(?:\.\d+)?/g) || []).length;
  const ba = sents.filter(s => /[他她我你][^，。]{0,6}把/.test(s)).length;
  return {
    shortRatio: +(short / n).toFixed(3),          // 短句(≤10字)占比
    longRatio: +(long / n).toFixed(3),            // 长句(>25字)占比——太低说明节奏没被拉开
    avgLen: +(lens.reduce((a, b) => a + b, 0) / n).toFixed(1),
    numPer: nums ? Math.round(chars / nums) : 9999,   // 多少字出现一个数目
    baRatio: +(ba / n).toFixed(3),                // 「X把Y…」句式占比
  };
}

// 单章体检
export function inspectChapter(fp, num, std = {}) {
  const raw = fs.readFileSync(fp, 'utf8');
  const title = path.basename(fp).replace(/\.txt$/, '').replace(/^\d+/, '');
  const chars = clean(raw).length;
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const last = paras[paras.length - 1] || '';

  // 事务流程密度：章名命中是强信号（整章就叫这个名字），正文按每千字命中数算
  const inTitle = PAPERWORK_TITLE.filter(w => title.includes(w));
  let hits = 0;
  for (const w of PAPERWORK) hits += (raw.split(w).length - 1);
  const per1k = chars ? (hits / chars) * 1000 : 0;
  const paperwork = inTitle.length > 0 || per1k >= 3;

  // 章末钩子：有对话/具体事件才算真钩子；纯叙述又命中假钩子词表 = 判废
  const hasDialogue = /[「」『』“”]/.test(last);
  const fake = FAKE_HOOK.filter(w => last.includes(w));
  const hookOk = hasDialogue || (fake.length === 0 && last.length <= 120);

  return {
    num, title, chars, paperwork, paperworkWords: inTitle, paperworkPer1k: +per1k.toFixed(1),
    style: styleMetrics(raw),
    money: maxMoney(raw), hookOk, fakeHookWords: fake,
    payoff: PAYOFF.some(w => raw.includes(w)),
    overlong: chars > (std.hardMax || 6000),
    over: chars > Math.round((std.targetCharsHi || 3600) * 1.2),
    under: chars < (std.minChars || std.targetCharsLo || 3000),
  };
}

// 扫一段章号区间，出体检结论。lookback：往前多看几章，用来判断「连续」类问题与量级曲线。
export function pacingScan(bookDir, from, to = 0, { std = {}, lookback = 6 } = {}) {
  const files = chapterFilesInRange(bookDir, Math.max(1, from - lookback), to);
  const all = [];
  for (const { num, path: fp } of files) {
    try { all.push(inspectChapter(fp, num, std)); } catch { /* 读不了就跳过，闸不阻断写作 */ }
  }
  const fresh = all.filter(c => c.num >= from);
  const issues = [];
  const tgtLo = std.targetCharsLo || 3000, tgtHi = std.targetCharsHi || 3600;

  // 1) 章长——最硬的一条，也是最好修的一条（拆章几乎不用改正文）
  const overlong = fresh.filter(c => c.overlong);
  const over = fresh.filter(c => c.over && !c.overlong);
  if (overlong.length) {
    issues.push({
      kind: 'overlong', level: 'error', chapters: overlong.map(c => c.num),
      msg: `第 ${overlong.map(c => c.num).join('、')} 章超长（${overlong.map(c => c.chars).join('/')} 字，上限 ${std.hardMax || 6000}）`,
      fix: `把这些章按场景拆成每章 ${tgtLo}–${tgtHi} 字的独立章：一章一个完整小事件 + 一个未解钩子，每个新章按 bible 的取名口味起台词体/疑问体章名（先在 chapter_index.md 全表查重），重排后续章号并更新 chapter_index.md。正文尽量不动，只拆不重写。`,
    });
  } else if (over.length) {
    issues.push({
      kind: 'over', level: 'warn', chapters: over.map(c => c.num),
      msg: `第 ${over.map(c => c.num).join('、')} 章偏长（${over.map(c => c.chars).join('/')} 字，目标 ${tgtLo}–${tgtHi}）`,
      fix: `下一批把单章压回 ${tgtLo}–${tgtHi} 字：一章只写一个小事件，写满就收在钩子上，别把三个场景塞进一章。`,
    });
  }

  // 1b) 章太短——bible 写的是【硬下限】。注意退回时要说清补的是戏不是字：
  // 让模型「写够字数」最容易招来注水（复述、绕圈、拉长对话），那比短章更难治。
  const under = fresh.filter(c => c.under);
  if (under.length) {
    const min = std.minChars || tgtLo;
    issues.push({
      kind: 'under', level: 'error', chapters: under.map(c => c.num),
      msg: `第 ${under.map(c => c.num).join('、')} 章不足硬下限（${under.map(c => c.chars).join('/')} 字，下限 ${min}）`,
      fix: `把这些章补到 ${tgtLo}–${tgtHi} 字。**补的是戏，不是字**：加一个具体场景、一次交锋、一个转折或一处代价浮现，让这一章多推进一件事。严禁靠复述前情、拉长对话、加形容词、原地绕圈凑字数——那比短章更糟。`,
    });
  }

  // 2) 事务流程当主线——skill.mjs 明令「禁止连续 ≥2 章」，这里量出来
  let run = 0, runs = [];
  for (const c of all) {
    if (c.paperwork) { run++; if (run >= 2) runs.push(c.num); }
    else run = 0;
  }
  const freshRuns = runs.filter(n => n >= from);
  if (freshRuns.length) {
    const names = fresh.filter(c => c.paperwork).map(c => `${c.num}${c.title}`);
    issues.push({
      kind: 'paperwork', level: 'error', chapters: freshRuns,
      msg: `连续 ≥2 章以事务流程为主线（${names.join('、')}）`,
      fix: `办手续/对账/比价/验收/开单这些只能当障碍、筹码或背景质感，压成段落带过，绝不能占据整章、更不能连着两章。把这几章改写成有对手、有攻防、有代价的场景——流程是那场戏的赌注，不是那场戏本身。`,
    });
  }

  // 3) 量级换挡——重生/经商/升级类的命脉：读者要看见数字往上走
  const moneys = all.filter(c => c.money > 0);
  if (moneys.length >= 6) {
    const half = Math.ceil(moneys.length / 2);
    const earlyMax = Math.max(...moneys.slice(0, half).map(c => c.money));
    const lateMax = Math.max(...moneys.slice(half).map(c => c.money));
    if (lateMax <= earlyMax * 1.5) {
      issues.push({
        kind: 'scale', level: 'warn', chapters: fresh.map(c => c.num),
        msg: `量级没换挡：前半段最大 ${earlyMax}，后半段最大 ${lateMax}（应至少上一个台阶）`,
        fix: `主角的处境——钱数、人手、地盘、对手层级——必须随章节可感升级。若已连写十几章还在同一量级的小事上打转，这是节奏事故：收束当前阶段、跳过过程、把舞台推大，让读者看见数字/层级往上走一格。`,
      });
    }
  }

  // 4) 章末假钩子
  const badHook = fresh.filter(c => !c.hookOk);
  if (badHook.length) {
    issues.push({
      kind: 'hook', level: 'warn', chapters: badHook.map(c => c.num),
      msg: `第 ${badHook.map(c => c.num).join('、')} 章章末不是具体钩子（疑似总结/抒情/预告）`,
      fix: `章末钩子必须是具体事件或具体台词：新人物进门／一句挑衅／一个没接的电话／一句「这下麻烦了」。绝不在章末总结、抒情、预告。`,
    });
  }

  // 4b) 文风机械度——太守规范反而写成模板。阈值按《重生94》实测基线定，留出题材差异的余量。
  const S = std.styleLimits || {};
  const LIM = {
    shortRatio: S.shortRatio ?? 0.45,   // 短句(≤10字)占比上限（实测 0.49 已明显节拍器化）
    numPer: S.numPer ?? 150,            // 至少多少字才出现一个数目（实测 92，规范本意是 250–400）
    baRatio: S.baRatio ?? 0.05,         // 「X把Y…」单一句式占比上限（实测 0.063）
    longRatio: S.longRatio ?? 0.08,     // 长句(>25字)占比下限——低于此说明节奏全程没被拉开
  };
  const bad = { short: [], num: [], ba: [], flat: [] };
  for (const c of fresh) {
    const m = c.style || {};
    if (m.shortRatio > LIM.shortRatio) bad.short.push(`${c.num}(${Math.round(m.shortRatio * 100)}%)`);
    if (m.numPer < LIM.numPer) bad.num.push(`${c.num}(每${m.numPer}字)`);
    if (m.baRatio > LIM.baRatio) bad.ba.push(`${c.num}(${Math.round(m.baRatio * 100)}%)`);
    if (m.longRatio < LIM.longRatio) bad.flat.push(`${c.num}`);
  }
  const styleBits = [];
  if (bad.short.length) styleBits.push(`短句(≤10字)过半：${bad.short.join('、')}——一半句子不到十个字，读起来像节拍器`);
  if (bad.num.length) styleBits.push(`数目堆砌：${bad.num.join('、')}——密到读者记不住，实锚就不再是实锚，是账本`);
  if (bad.ba.length) styleBits.push(`「X把Y…」句式扎堆：${bad.ba.join('、')}`);
  if (bad.flat.length) styleBits.push(`全章没有长句把节奏拉开：${bad.flat.join('、')}`);
  // 【关键】给出【这一章具体要改几处】。模型没法在写的时候统计自己的短句占比——
  // 比例类要求靠 prompt 天生无效（实测：把上限写进 skill 后，短句 0.488→0.480、
  // 数目 95→85 字一个、把字句 0.066→0.091，全无改善甚至更差）。必须换算成可执行的条数。
  const todo = [];
  for (const c of fresh) {
    const m = c.style || {}; const bits = [];
    const sents = Math.round(c.chars / Math.max(1, m.avgLen || 14));
    if (m.shortRatio > LIM.shortRatio) {
      const now = Math.round(sents * m.shortRatio), want = Math.floor(sents * LIM.shortRatio);
      bits.push(`短句约 ${now} 句（全章约 ${sents} 句），**至少合并掉 ${Math.max(1, now - want)} 句**——把相邻的两三个短句并成一个带从句的长句`);
    }
    if (m.numPer < LIM.numPer) {
      const now = Math.round(c.chars / Math.max(1, m.numPer)), want = Math.floor(c.chars / LIM.numPer);
      bits.push(`出现数目约 ${now} 处，**删到 ${Math.max(1, want)} 处以内**（只留改变局面的那几笔，其余换成"块把钱""小半麻袋""一沓"）`);
    }
    if (m.baRatio > LIM.baRatio) {
      const now = Math.round(sents * m.baRatio);
      bits.push(`「把…」动作句约 ${now} 句，**留不超过 3 句**，其余换写法或直接删掉动作`);
    }
    if (m.longRatio < LIM.longRatio) bits.push(`全章几乎没有 25 字以上的长句，**至少补 ${Math.max(2, Math.round(sents * 0.1))} 个**`);
    if (bits.length) todo.push(`  · **第 ${c.num} 章**：` + bits.join('；'));
  }
  if (styleBits.length) {
    const heavy = bad.short.length + bad.num.length >= Math.max(2, Math.ceil(fresh.length * 0.6));
    issues.push({
      kind: 'style', level: heavy ? 'error' : 'warn', chapters: fresh.map(c => c.num),
      msg: '文风机械：' + styleBits.join('；'),
      fix: [
        '这不是没守规范，是【太守规范】——每条单独看都对，叠加执行就成了模板。',
        '',
        '**逐章要改的量（照着数改，别凭感觉）**：',
        todo.join('\n'),
        '',
        '就地改：',
        '  · **句长真正拉开**：把相邻的两三个短句并成一个带从句的长句，让节奏有起伏；不要靠堆短句制造"不均匀"——那是另一种单调。',
        '  · **数目大幅删减**：只在【这一笔钱/这个数改变了局面】时报数字，其余一律换成"块把钱""小半麻袋""一沓"。实锚的主力是物件、身体感觉、具体动作，不是每段砸一个数目。',
        '  · **动作小节拍不要每句都挂**：三句对白最多一句带动作；「把…往…一磕/一撂/一扔」全章不超过三次，其余换写法或干脆不写。',
        '  · **别每章开头都报"某月某日礼拜几下午几点，某地"**——那是场景切换的写法，不是章节开头的公式。',
        '',
        '改完不要重写情节、不要改章名、不要动人物和台词的意思，只调语言。',
      ].join('\n'),
    });
  }

  // 4c) 台账体积——只增不减会拖垮往后每一批（模型每批都要读它）。
  // 实测：某 27 章的书台账已 6.5 万字符（每章 2400 字，快赶上正文）；《重生94》一度 10.2 万字符，
  // 其中 76,823 是已废弃剧情的分章条目（占 75%）——推倒重写时只加了句「以下不作数」却没删。
  // 跟文风一条同理：写「保持精简」没用，得量出来并给出【删到多少】。
  try {
    const lf = path.join(bookDir, 'continuity_ledger.md');
    const cap = std.ledgerMaxChars || 30000;
    const txt = fs.readFileSync(lf, 'utf8');
    const n = txt.length;
    if (n > cap) {
      // 找出「分章条目」类小节（#### 开头），它们是滚动窗口层，最该被压缩
      // 边界要认【所有层级】的标题：只认 ###/#### 会跨过中间的 ## 节，把一节算成十节那么大
      // （实测风水那本因此把某节报成 104,348 字符，虚高十倍，压缩指令就会指错地方）
      const secs = [...txt.matchAll(/\n#{2,4} ([^\n]{2,60})/g)];
      const sized = secs.map((m, i) => ({
        title: m[1].trim().slice(0, 30),
        size: (i + 1 < secs.length ? secs[i + 1].index : txt.length) - m.index,
      })).sort((a, b) => b.size - a.size);
      const top = sized.slice(0, 5).map(x => `「${x.title}」${x.size} 字符`).join('、');
      issues.push({
        kind: 'ledger', level: 'error', chapters: fresh.map(c => c.num),
        msg: `台账已 ${n} 字符（上限 ${cap}），最大的几节：${top}`,
        fix: [
          `先压缩 \`continuity_ledger.md\`，**至少砍掉 ${n - cap} 字符**（压到 ${cap} 以内）再往下写。`,
          '按这个顺序砍，砍完为止：',
          '  1. **已废弃剧情的分章条目**——推倒重写过的那些段落，整段删掉，别留「以下不作数」的说明；',
          '  2. **已回收的伏笔/欠债**——删掉整条，不要留「已于 XX 章兑现」的尸体；',
          '  3. **超出最近 20 章的细节条目**——每 10 章压成一段摘要，只留还会影响后文的（谁欠谁、什么没了结、哪个数字还要用）；',
          '  4. **人物名册里同一个人的历史流水**——只留「当前处境」一行，就地覆盖，不追加。',
          '**不许动**：人物名册的人名与身份、时间锚、还没回收的伏笔。压缩的是篇幅，不是事实。',
        ].join('\n'),
      });
    }
  } catch { /* 没有台账文件就不管 */ }

  // 5) 爽点节拍（弱信号，只提示）——长期只铺不发＝劝退
  if (fresh.length >= 5 && !fresh.some(c => c.payoff)) {
    issues.push({
      kind: 'payoff', level: 'warn', chapters: fresh.map(c => c.num),
      msg: `本批 ${fresh.length} 章没有一次可感的兑现（打脸／服软／拿下／扳回一城）`,
      fix: `每隔几章要给读者一次担心之后的兑现：先让读者替主角捏把汗，再打脸一次、收服一个人、上一个台阶。全程都是讲道理的好人、没有人被顶回去，读者没有理由追下去。`,
    });
  }

  return { chapters: fresh, all, issues };
}

// 把体检结论写成给模型的「退回自纠」指令。无 error 级问题时返回 null（不打扰）。
export function buildPacingFixInstruction(scan, { warnAlso = false } = {}) {
  const items = scan.issues.filter(i => warnAlso || i.level === 'error');
  if (!items.length) return null;
  const body = items.map((i, k) => `${k + 1}. 【${i.level === 'error' ? '事故' : '偏差'}】${i.msg}\n   → ${i.fix}`).join('\n');
  return `本批刚写完的章节没过【节奏体检】，请先就地修掉下面的问题，再继续写下一批：\n\n${body}\n\n改完把 chapter_index.md 与 continuity_ledger.md 同步更新。不要新写章节，先把这几条改干净。`;
}

// 体检报告落盘到 reviews/，便于人工回看（不阻断）。
export function writePacingReport(bookDir, scan, tag = '') {
  const dir = path.join(bookDir, 'reviews');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const lines = ['# 节奏体检' + (tag ? `（${tag}）` : ''), '',
    '| 章 | 字数 | 流程主线 | 最大钱数 | 钩子 | 短句占比 | 几字一个数 | 均句长 |',
    '|---|---|---|---|---|---|---|---|'];
  for (const c of scan.chapters) {
    const m = c.style || {};
    lines.push(`| ${c.num}${c.title} | ${c.chars} | ${c.paperwork ? '是' : ''} | ${c.money || ''} | ${c.hookOk ? 'ok' : '假钩子'} | ${Math.round((m.shortRatio || 0) * 100)}% | ${m.numPer || ''} | ${m.avgLen || ''} |`);
  }
  lines.push('', '## 结论', '');
  if (!scan.issues.length) lines.push('全部通过。');
  for (const i of scan.issues) lines.push(`- **${i.level === 'error' ? '事故' : '偏差'}｜${i.kind}**：${i.msg}\n  - ${i.fix}`);
  const fp = path.join(dir, `节奏体检${tag ? '-' + tag : ''}.md`);
  try { fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8'); } catch {}
  return fp;
}

// 写后节奏闸：给 statelessWriter / cowrite 用。返回 { issues, instruction }；instruction 非空则上层注入退回自纠。
export function pacingGate(bookDir, from, to, onLog = () => {}, { std = {}, warnAlso = false, report = true } = {}) {
  const scan = pacingScan(bookDir, from, to, { std });
  for (const i of scan.issues) {
    onLog({ level: i.level === 'error' ? 'warn' : 'info', msg: `${i.level === 'error' ? '⛔ 节奏事故' : '⚠ 节奏偏差'}：${i.msg}` });
  }
  if (report && scan.chapters.length) writePacingReport(bookDir, scan, `${from}-${to}`);
  return { issues: scan.issues, instruction: buildPacingFixInstruction(scan, { warnAlso }), scan };
}
