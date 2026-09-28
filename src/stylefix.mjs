// 文风回正：指纹判出哪几章漂了，就【让模型把它改回来】，改完再量一遍，不达标不收。
//
// 【为什么不是正则】2026-09-28 我先写过一版脚本，拿逗号断长句，结果是：
//   「若是关宁军不认那道借券，这会儿回来的就该是…」
//   → 「若是关宁军不认那道借券。这会儿回来的就该是…」   条件从句成了病句
//   「猛地扔下菜筐，瞧见前头有动静」→ 断开后因果顺序反了
//   「保定急报——！」→「保定急报——。」                破折号后面跟句号，标点错
// 文风是句子层面的事，正则只认字符。**写这几章的是模型，能把它改回来的也只有模型。**
//
// 【为什么不是"发条指令让它自己改"】那正是 297–333 那批的失败方式：闸报了偏差，
// 催一次，模型说改了，没有任何人复测，放行，接着漂。所以这里的循环必须闭合：
//     判 → 改 → 【再判】 → 不达标就重来 → 到上限停住交给人
// 收稿前还要验：字数没塌、专名没丢、章名没动。模型"改文风"时顺手删掉半章剧情，
// 是这类任务最常见的翻车方式，光看指标是看不出来的。
//
// 机械的那一点点仍然值得先做掉（省一轮模型调用，且绝不会改坏）：
// 感叹号按本书自己的用法收（短吼保留、叙述与长台词一律句号）、过厚的段落在句末换行。

import fs from 'node:fs';
import path from 'node:path';
import { styleMetrics } from './pacing.mjs';
import { loadFingerprint, driftOf, scanChapters } from './stylefp.mjs';
import { runModelOnceAsync, pickEditorModel } from './editor.mjs';

const clean = (t) => String(t).replace(/\s/g, '');
const SENT_END = /[。！？…]/;

// —— 机械矫正（只做两件不会改坏句子的事）——

// 感叹号：本书不是不用，而是只用在短吼上（《崇祯》前 296 章 1053 处、0.93/千字，
// 全是「站住！」「住手！」这种）。漂过的章是 8–20/千字，且大量用在叙述句和长台词上。
// 判据是【整段引语有多长】：五十多字的战报不是吼，是念。
export function fixBang(text) {
  const t = String(text).replace(/？！/g, '？').replace(/！？/g, '？').replace(/([—…])！/g, '$1');
  return t.split(/([“「『][^”」』]*[”」』])/).map((seg, k) => {
    if (k % 2 === 0) return seg.replace(/！/g, '。');                 // 引号外＝叙述，一律句号
    const inner = seg.slice(1, -1);
    const n = inner.replace(/[^一-龥a-zA-Z0-9]/g, '').length;
    return n <= 8 ? seg : seg[0] + inner.replace(/！/g, '。') + seg[seg.length - 1];
  }).join('');
}

// 过厚的段落在【句末】换行——只加换行，一个字不改。
export function splitFatParagraphs(text, target = 34) {
  return String(text).split('\n').map(line => {
    if (clean(line).length <= target * 1.6) return line;
    const parts = []; let buf = '';
    for (const ch of line) { buf += ch; if (SENT_END.test(ch)) { parts.push(buf); buf = ''; } }
    if (buf) parts.push(buf);
    if (parts.length < 2) return line;
    const out = []; let cur = '';
    for (const p of parts) {
      if (cur && clean(cur).length + clean(p).length > target * 1.25) { out.push(cur); cur = p; }
      else cur += p;
    }
    if (cur) out.push(cur);
    return out.join('\n');
  }).join('\n');
}

export function mechanicalFix(text, fp) {
  const target = fp?.axes?.avgPara?.p50 || 34;
  return splitFatParagraphs(fixBang(text), target).replace(/\r\n/g, '\n');
}

// —— 交给模型的那一半 ——

const AXIS_HOWTO = {
  bangPerK: '感叹号太多。气势不靠感叹号，靠动作和后果——「他把刀拍在案上」比「他怒吼一声！」有力。只有短吼（「站住！」这种）才留。',
  similePerK: '「如…般／仿佛／宛如」式比喻太多。换成这个人物真能看见的东西：「目光如利剑般直射」→ 他盯着谁、盯了多久、谁先挪开了眼。',
  cheerPerK: '旁白在替读者鼓掌（「字字诛心」「无数人眼眶瞬间红了」「何曾有…」）。删掉，换成某一个具体的人做了什么——一个人比"数千人"更让读者信。',
  avgLen: '句子太长。把一句里串着的几件事拆成几句；拆的时候要保证每一句自己站得住，不许留下「若是…」这种没有下文的半截从句。',
  avgPara: '段落太厚。在句末换行拆开，转折、要害、情绪落点可以单句成段。',
  shortRatio: '短句太少，通篇中长句，读起来是一口气不换。该有三五字的短句进来断一下。',
};

export function buildFixPrompt({ title, chapterName, text, drift, refs }) {
  const axes = drift.map(d => `  · ${d.label}：本章 ${d.value}，本书中位 ${d.p50}（越过 ${d.limit} 就算换了个人写）\n    ${AXIS_HOWTO[d.axis] || ''}`).join('\n');
  return [
    `你在给长篇网文《${title}》做【文风回正】。这一章的剧情是好的，问题只出在腔调上：它跟这本书前面几百章不像一个人写的。`,
    ``,
    `# 这本书自己的样子（范本，节选自本书已写章节）`,
    refs,
    ``,
    `# 本章量出来的偏差`,
    axes,
    ``,
    `# 铁律（违反任何一条，这次改稿作废）`,
    `1. **只改语言，不改故事**：情节、人物、台词的意思、出场顺序、章末钩子，一个都不许变。`,
    `2. **不许删减内容**：改完的字数要和原文基本持平（上下不超过 5%）。不许把一段概括掉。`,
    `3. **不许改人名、地名、官职、数目**（「三千」不许写成「三万」）。`,
    `4. **不许加旁白**：不解释、不总结、不点评、不替读者鼓掌。`,
    `5. 向范本看齐的是**语感**：叙述者的姿态、句子的呼吸、段落的换行密度、情绪的外放程度。`,
    `   **不许照抄范本的情节、人名、成句。**`,
    ``,
    `# 本章正文（章名：${chapterName}）`,
    text,
    ``,
    `# 输出`,
    `直接输出改好的正文全文，不要任何前言、说明、标题行、markdown 标记、"以下是"之类的话。`,
  ].join('\n');
}

// 收稿前的体检：模型"改文风"时最常见的翻车是顺手把内容删了，光看指标看不出来。
export function acceptable(before, after, { names = [] } = {}) {
  const a = clean(before).length, b = clean(after).length;
  if (b < 500) return { ok: false, why: '产出太短，疑似只回了一段说明' };
  const ratio = b / a;
  if (ratio < 0.9) return { ok: false, why: `字数掉了 ${Math.round((1 - ratio) * 100)}%（${a}→${b}），疑似删了内容` };
  if (ratio > 1.15) return { ok: false, why: `字数涨了 ${Math.round((ratio - 1) * 100)}%（${a}→${b}），疑似加戏或注水` };
  if (/^(好的|以下是|这是|我已经|根据)/.test(after.trim())) return { ok: false, why: '开头带了寒暄/说明，不是纯正文' };
  const lost = names.filter(n => before.includes(n) && !after.includes(n));
  if (lost.length) return { ok: false, why: '改丢了专名：' + lost.join('、') };
  return { ok: true };
}

function loadRefs(bookDir, limit = 4000) {
  const dir = path.join(bookDir, 'style_refs');
  let out = '';
  try {
    for (const f of fs.readdirSync(dir).filter(f => /\.(txt|md)$/i.test(f))) {
      if (out.length >= limit) break;
      out += fs.readFileSync(path.join(dir, f), 'utf8').slice(0, Math.max(0, limit - out.length)) + '\n\n────\n\n';
    }
  } catch {}
  return out.trim();
}

function namesOf(bookDir) {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(bookDir, 'gate.json'), 'utf8'));
    return (conf.names || []).filter(n => String(n).length >= 2);
  } catch { return []; }
}

// 主流程：判 → 机械矫正 → 交模型 → 再判 → 不达标重来 → 到上限停住交给人。
export async function fixStyleRange(book, {
  from = 1, to = 0, cfg = {}, model = null, maxRounds = 2,
  onLog = () => {}, shouldStop = () => false, timeoutMs = 300000, dryRun = false,
} = {}) {
  const dir = book.dir;
  const fp = loadFingerprint(dir);
  if (!fp) return { ok: false, reason: '这本书还没有文风指纹，先跑 novel gate --probe-style' };
  const refs = loadRefs(dir);
  if (!refs) return { ok: false, reason: '这本书还没挂范本（style_refs/），先跑 novel gate --probe-style' };
  const names = namesOf(dir);
  // 【别用 book.model】那是"写这本书的人"，不一定跑得动改稿这种一次性无头调用——
  // 《崇祯》挂的是 agy，实测连"原样重复一句话"都会超时，两轮全废在这上头。
  // pickEditorModel 本来就是为审稿/改稿挑模型的，用它。
  const use = model || pickEditorModel(book.model, cfg);

  const todo = scanChapters(dir).filter(c => c.num >= from && (to <= 0 || c.num <= to))
    .map(c => ({ ...c, drift: driftOf(c.metrics, fp) })).filter(c => c.drift.length);
  onLog({ level: 'info', msg: `文风回正：${todo.length} 章要改（第 ${todo.map(c => c.num).join('、')} 章），模型=${use}` });

  const done = [], failed = [];
  for (const ch of todo) {
    if (shouldStop()) { onLog({ level: 'warn', msg: '已停止' }); break; }
    const original = fs.readFileSync(ch.file, 'utf8');

    // ① 机械那一点先做掉：省一轮模型调用，且绝不会改坏
    let cur = mechanicalFix(original, fp);
    let left = driftOf(styleMetrics(cur), fp);
    if (!left.length) {
      if (!dryRun) fs.writeFileSync(ch.file, cur, 'utf8');
      onLog({ level: 'info', msg: `  第 ${ch.num} 章：机械矫正即可（${ch.drift.map(d => d.label).join('、')}）` });
      done.push({ num: ch.num, by: '机械' });
      continue;
    }

    // ② 剩下的交模型，改完【再量一遍】，不达标就重来
    let okRound = 0;
    for (let round = 1; round <= maxRounds; round++) {
      if (shouldStop()) break;
      onLog({ level: 'act', msg: `  第 ${ch.num} 章 第 ${round} 轮：${left.map(d => d.label).join('、')}` });
      let out = '';
      try {
        out = await runModelOnceAsync(use, buildFixPrompt({
          title: book.title, chapterName: ch.name, text: cur, drift: left, refs,
        }), cfg, timeoutMs);
      } catch (e) { onLog({ level: 'warn', msg: `  第 ${ch.num} 章调用失败：${e.message || e}` }); break; }

      const body = String(out || '').replace(/^```[a-z]*\n?|```$/gim, '').trim();
      const chk = acceptable(cur, body, { names });
      if (!chk.ok) { onLog({ level: 'warn', msg: `  第 ${ch.num} 章第 ${round} 轮不收：${chk.why}` }); continue; }

      const after = mechanicalFix(body, fp);
      const rest = driftOf(styleMetrics(after), fp);
      if (rest.length >= left.length) {
        onLog({ level: 'warn', msg: `  第 ${ch.num} 章第 ${round} 轮没改进（仍 ${rest.map(d => d.label).join('、')}）` });
        cur = after; left = rest; continue;
      }
      cur = after; left = rest; okRound = round;
      if (!rest.length) break;
    }

    if (!dryRun && okRound) fs.writeFileSync(ch.file, cur.replace(/\r\n/g, '\n'), 'utf8');
    if (!left.length) { done.push({ num: ch.num, by: `模型第 ${okRound} 轮` }); onLog({ level: 'info', msg: `  ✔ 第 ${ch.num} 章已回正` }); }
    else { failed.push({ num: ch.num, left: left.map(d => d.label) }); onLog({ level: 'warn', msg: `  ✘ 第 ${ch.num} 章仍未达标：${left.map(d => d.label).join('、')}` }); }
  }
  return { ok: true, done, failed, total: todo.length };
}
