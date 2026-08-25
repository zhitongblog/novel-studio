// 文风指纹 —— 通用方法：规则不由开发者写，从【范本】里来。
//
// 【为什么要有这个模块，以及之前错在哪】
// 之前的做法是把一套写作规范硬编码进提示词（结构规范 + 文风守则 + 侧重 + 感情线，
// 光结构文风两项就 ~1500 字符）。问题不是"规则写得不够好"，而是这件事本身做不对：
//
//   规则里必然夹带【一种审美】。我夹带的是纯文学的那套——克制、留白、不说破、
//   不抒情、实锚优先、别用套话。这套放在严肃文学里条条都对，
//   放在网文里【条条都是减分】：网文要直白、要快、要燃、要把推理讲给读者听、
//   要敢用"眉如远山"这种四字套话、要在章末立 flag。
//
//   实测对照：作者认可的样章（ChatGPT 直接写的重生三国）有 53% 的单行段、
//   通篇感叹号、大量成语套话、结尾直接喊"他就掀了谁的棋盘"——
//   而我立的规则会把这些【逐条判为毛病】，我甚至加了一道段落闸会把它打回重排。
//
// 所以通用解不是"换一套更好的规则"，换任何一套都只是换一种审美强加给所有书。
// 通用解是【把审美这一层整个交给范本】：
//
//   作者放几章他想要的文字进 style_refs/ → 模型直接看着它写。
//   模型模仿例子的能力远强于遵守描述，而且例子自带这本书特有的一切——
//   语感、节奏、幽默感、信息密度、叙述者的姿态——这些是任何规则描述都压不住的。
//
// 于是约束分成两层，界限很清楚：
//   【机制层】所有书都一样，且与审美无关：别自相矛盾、别复读凑字、章名唯一、字数达标。
//   【审美层】每本书都不同：一律来自范本，开发者一个字都不该写。
//
// 没有范本时退回一份【极简】默认（十来行），而不是现在这坨——
// 宁可让模型自由发挥，也不要用错误的审美把它按死。

import fs from 'node:fs';
import path from 'node:path';

// —— 机制层：唯一该由代码写死的东西 ——
// 判据：这条规则换一本书、换一个题材、换一种文风，是否依然成立？
// 只有答案为"是"的才能留在这里。凡是涉及"好不好看""该怎么写"的，一律出局。
export const MECHANICS = [
  '硬性要求（与文风无关，任何书都适用）：',
  '· 严格贴合上文给的设定与已写内容：人物、时代、能力体系、既成事实都不得矛盾。',
  '· 【绝不为凑字数复读】：不重复段落、不重复句式、不原地绕圈。写不动就自然收束。',
  '· 章名与全书已有章名不重复（含意思高度相近的）。',
  '· 只输出正文，不要解释、不要总结、不要旁白式的作者发言。',
].join('\n');

// —— 无范本时的极简默认 ——
// 只说"网文的基本盘"，不规定怎么写。十来行，不是一千五百字符。
export const MINIMAL_DEFAULT = [
  '文风基线（作者尚未提供范本，以下只是最低要求，不必拘泥）：',
  '· 这是面向手机读者的网络小说：读起来要顺、要有推力，别写成散文或报告。',
  '· 每章要有推进：局面、关系或认知，至少有一样跟章首不同。',
  '· 章末留一个具体的悬念，别停在总结或抒情上。',
].join('\n');

// 【实测教训】范本给到 7000 字符时，模型不是"学语感"而是【当模板填空】：
// 生成结果与范本逐句雷同——"香。/ 很香。/ 哪怕看惯了网络上各种精修美女…"整段照搬，
// 连"甚至任何滤镜落在她脸上，都是多余"这样的成句都一字不差。
// 语感靠几百字就能传递，多给的部分只会变成可抄的模板。故砍到 2500。
const ONE_MAX = 1200;      // 单篇范本上限
const TOTAL_MAX = 2500;    // 范本总量上限

export function refsDir(book) { return path.join(book.dir, 'style_refs'); }

// 读范本。优先读整篇——截断会把节奏和结构切没，而节奏正是最该学的东西。
// preferLater：优先取靠后的范本。用第一章当范本去写第一章，几乎必然被抄结构；
// 用中后段当范本写开篇，学到的才是语感而不是骨架。
export function readRefs(book, { totalMax = TOTAL_MAX, preferLater = true } = {}) {
  const dir = refsDir(book);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(txt|md)$/i.test(f)).sort(); } catch { return []; }
  if (preferLater && files.length > 2) files = files.slice().reverse();
  const out = []; let used = 0;
  for (const f of files) {
    if (used >= totalMax) break;
    let t = '';
    try { t = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { continue; }
    if (!t) continue;
    const seg = t.slice(0, Math.min(ONE_MAX, totalMax - used));
    out.push({ name: f.replace(/\.(txt|md)$/i, ''), text: seg, full: t.length });
    used += seg.length;
  }
  return out;
}

// 手法卡：由模型读范本后写出来的一段【具体观察】，存在书目录里。
// 它是范本的补充而非替代——范本管"感觉"，手法卡管"能说清楚的那部分"，
// 且明确规定冲突时以范本为准。
export function readCard(book) {
  try { return fs.readFileSync(path.join(book.dir, 'style_card.md'), 'utf8').trim(); } catch { return ''; }
}
export function saveCard(book, text) {
  fs.writeFileSync(path.join(book.dir, 'style_card.md'), String(text || '').trim() + '\n', 'utf8');
}

// 让模型从范本里【自己总结】手法的提示词。
// 关键是逼它给【具体到可执行】的观察，而不是"多用短句、注重细节"这类放之四海皆准的废话——
// 后者恰恰是之前那套规则的形态，也正是它没用的原因。
export const CARD_PROMPT = [
  '下面是作者认可的样章。请你把它的【写法】总结成一份可执行的手法卡，供后续章节照着写。',
  '',
  '要求：',
  '1. 只写【这些样章特有的、可观察到的】做法，附上原文里的例子。',
  '   ——不要写"多用短句""注重细节""对话要自然"这类任何小说都适用的废话，那等于没说。',
  '2. 至少覆盖这几面，每面 1–3 条，每条都要能直接照着做：',
  '   · 叙述者的姿态：他在不在场？跟读者的距离多近？会不会直接对读者说话？',
  '   · 信息给法：推理/知识是讲给读者听，还是让读者自己看出来？给得早还是晚？',
  '   · 句子与段落的形态：长短、换行密度、什么时候单句成段。',
  '   · 用词的口味：敢不敢用成语套话？有没有现代语汇乱入？夸张到什么程度？',
  '   · 情绪的外放程度：抒情、感叹、喊口号，用不用？用在哪儿？',
  '   · 一章怎么起、怎么推、怎么收。',
  '3. 【不要评价好坏】，只描述"它是怎么做的"。',
  '4. 控制在 500 字以内，条目式，别写成论文。',
].join('\n');

// 组装注入提示词的文风段。
// 有范本 → 范本为主 + 手法卡为辅，【不叠加任何开发者写死的审美规则】。
// 无范本 → 极简默认。
export function voicePrint(book) {
  const refs = readRefs(book);
  const card = readCard(book);

  if (!refs.length && !card) return '\n' + MINIMAL_DEFAULT + '\n';

  const lines = [];
  if (card) {
    lines.push('【本书手法卡（从作者认可的样章里总结出来的）】');
    lines.push(card);
    lines.push('');
  }
  if (refs.length) {
    lines.push('【文风范本 —— 这是判断文风的最高依据】');
    lines.push('下面是作者认可的文字。你要写成【这个样子】。');
    lines.push('学的是：叙述者的姿态、句子的呼吸、信息给法、用词口味、情绪的外放程度、一章的起收方式。');
    lines.push('⚠️ 【严禁照抄】范本里的情节、人物、地名、专有名词或成句。');
    lines.push('⚠️ 【也严禁复制范本的句子结构与开场方式】——不要套用它的开头句式、不要沿用它的');
    lines.push('   段落排布顺序、不要把它的比喻和梗换个词再用一遍。范本是让你感受"这个人怎么说话"，');
    lines.push('   不是让你填空。写出来的东西如果能和范本逐句对上，就是抄，重写。');
    if (card) lines.push('⚠️ 手法卡与范本冲突时，【以范本为准】——描述总是有损的，原文才是真的。');
    for (const r of refs) {
      lines.push('');
      lines.push(`—— 范本《${r.name}》 ——`);
      lines.push(r.text);
    }
    lines.push('—— 范本结束 ——');
  }
  return '\n' + lines.join('\n') + '\n';
}

// 长驻窗口那条路（autopilot 每批往窗口发一句"继续下一批…"）没有上下文包可挂，
// 但同样需要范本【在眼前】而不是【在文件里】。所以把范本原文接在续写指令后面。
//
// 实测差距：同一本书同一份范本，范本进提示词 13.1 字/段，只在 AGENTS.md 写一句
// "去读 style_refs/" 是 47.7 字/段。agent 读了文件、复述了内容，排版却用回自己的默认。
export function continueWithVoice(book, text) {
  const base = String(text || '').trim();
  let voice = '';
  try { voice = (voicePrint(book) || '').trim(); } catch { voice = ''; }
  // 没挂范本时 voicePrint 返回的是四行极简默认，那个 AGENTS.md 里已经有了，不必每批重发
  if (!voice || !readRefs(book).length) return base;
  return base + '\n\n' + voice;
}

export function hasVoicePrint(book) {
  return readRefs(book).length > 0 || !!readCard(book);
}

// —— 范本管理 ——
export function listRefs(book) {
  const dir = refsDir(book);
  try {
    return fs.readdirSync(dir).filter(f => /\.(txt|md)$/i.test(f)).map(f => {
      let n = 0;
      try { n = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\s/g, '').length; } catch {}
      return { file: f, name: f.replace(/\.(txt|md)$/i, ''), chars: n };
    });
  } catch { return []; }
}

export function addRef(book, name, text) {
  const dir = refsDir(book);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || '范本').trim().replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 60) || '范本';
  fs.writeFileSync(path.join(dir, safe + '.txt'), String(text || '').trim() + '\n', 'utf8');
  return safe + '.txt';
}

export function removeRef(book, file) {
  const safe = path.basename(String(file || ''));
  if (!/\.(txt|md)$/i.test(safe)) return false;
  try { fs.unlinkSync(path.join(refsDir(book), safe)); return true; } catch { return false; }
}
