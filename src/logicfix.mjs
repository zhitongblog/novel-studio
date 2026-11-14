// 定点修（逻辑）：把阅读复核挑出的【逻辑】问题，一章一章改掉，改完验，验不过不收。
//
// 和 stylefix 是同一个架构，区别只在"拿什么当判据"：
//   · stylefix 改完能【再量一遍】——指纹是数值，回没回正一目了然；
//   · 逻辑改完没有数值可量。所以这里的闸全压在【收稿体检】上：
//     字数持平、专名不丢、引号不多、文风指标不许因为这次修改而跑出本书分布。
//     换句话说——**没法证明它改对了，但能挡住它改坏了**。
//
// 【为什么不走 overhaul 那条定点修】那条要开 Unterm 窗口、挂 autopilot、防跑飞。
// 2026-09-28/30 两次实测，窗口这条路在本机被 timeout 和系统内存回收各杀过一次，
// 一死就没人看着，agent 继续裸奔。无头逐章调用没有这个问题：一章一个进程，
// 死了就是这一章没改，不会写出 79 章没人管的正文。
//
// 【一次只给一章的意见】复核意见天然是按章给的，合并成批只会让模型顾此失彼；
// 而且一章一次调用，失败的爆炸半径就是一章。

import fs from 'node:fs';
import path from 'node:path';
import { styleMetrics } from './pacing.mjs';
import { loadFingerprint, driftOf, scanChapters } from './stylefp.mjs';
import { runModelOnceAsync, pickEditorModel } from './editor.mjs';
import { acceptable, mechanicalFix } from './stylefix.mjs';

const clean = (t) => String(t).replace(/\s/g, '');

export function buildLogicPrompt({ title, chapterName, text, items, refs }) {
  const list = items.map((it, k) => `${k + 1}. **${it.p}**\n   建议改法：${it.fix}`).join('\n');
  return [
    `你在给长篇网文《${title}》做【定点修】。复核读出了这一章的几处逻辑问题，请只改这几处。`,
    ``,
    `# 要改的（只改这些，别的一个字都不要动）`,
    list,
    ``,
    refs ? `# 这本书的腔调（范本节选，改写时照着这个语感）\n${refs}\n` : '',
    `# 铁律（违反任何一条，这次改稿作废）`,
    `1. **只改上面列出的地方**。没点到的段落、句子、标点，原样保留。`,
    `2. **字数基本持平**（上下不超过 5%）。不许借机重写整章，不许把一段概括掉。`,
    `3. **不许改章名、不许改人名地名官职**；确实是名字写错了（比如前世名写成了今生名）才改那一处。`,
    `4. **不许新增情节线**。补交代可以，补的是"本来就该有的那一句"，不是新戏。`,
    `5. 改完的段落要和上下文一个腔调：句子短、段落薄、别加旁白、别加感叹号。`,
    ``,
    `# 本章正文（章名：${chapterName}）`,
    text,
    ``,
    `# 输出`,
    `直接输出改好的正文全文，不要任何前言、说明、标题行、markdown 标记、"以下是"之类的话。`,
  ].filter(Boolean).join('\n');
}

function loadRefs(bookDir, limit = 2500) {
  const dir = path.join(bookDir, 'style_refs');
  let out = '';
  try {
    for (const f of fs.readdirSync(dir).filter(x => /\.(txt|md)$/i.test(x))) {
      if (out.length >= limit) break;
      out += fs.readFileSync(path.join(dir, f), 'utf8').slice(0, Math.max(0, limit - out.length));
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

// items: [{num, kind, p, fix}]，只处理 kind==='逻辑' 的
export async function fixLogicItems(book, {
  items = [], cfg = {}, model = null, from = 0, to = 0,
  onLog = () => {}, shouldStop = () => false, timeoutMs = 300000, dryRun = false,
} = {}) {
  const dir = book.dir;
  const fp = loadFingerprint(dir);
  const refs = loadRefs(dir);
  const names = namesOf(dir);
  const use = model || pickEditorModel(book.model, cfg);

  const byNum = new Map();
  for (const it of items) {
    if (it.kind !== '逻辑') continue;
    if (from && it.num < from) continue;
    if (to && it.num > to) continue;
    if (!byNum.has(it.num)) byNum.set(it.num, []);
    byNum.get(it.num).push(it);
  }
  const files = new Map(scanChapters(dir).map(c => [c.num, c]));
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  onLog({ level: 'info', msg: `定点修：${nums.length} 章、${[...byNum.values()].reduce((s, a) => s + a.length, 0)} 条逻辑问题，模型=${use}` });

  const done = [], failed = [];
  for (const num of nums) {
    if (shouldStop()) { onLog({ level: 'warn', msg: '已停止' }); break; }
    const ch = files.get(num);
    if (!ch) { failed.push({ num, why: '找不到正文' }); continue; }
    const its = byNum.get(num);
    const before = fs.readFileSync(ch.file, 'utf8');
    onLog({ level: 'act', msg: `  第 ${num} 章（${its.length} 条）` });

    let out = '';
    try {
      out = await runModelOnceAsync(use, buildLogicPrompt({
        title: book.title, chapterName: ch.name, text: before, items: its, refs,
      }), cfg, timeoutMs);
    } catch (e) { failed.push({ num, why: '调用失败：' + (e.message || e) }); onLog({ level: 'warn', msg: `  ✘ 第 ${num} 章调用失败` }); continue; }

    const body = String(out || '').replace(/^```[a-z]*\n?|```$/gim, '').trim();
    const chk = acceptable(before, body, { names });
    if (!chk.ok) { failed.push({ num, why: chk.why }); onLog({ level: 'warn', msg: `  ✘ 第 ${num} 章不收：${chk.why}` }); continue; }

    // 文风不许因为这次修改而跑出本书分布——定点修最容易的翻车就是"改对了逻辑，写成了另一个人"
    const after = fp ? mechanicalFix(body, fp) : body;
    if (fp) {
      const d0 = driftOf(styleMetrics(before), fp), d1 = driftOf(styleMetrics(after), fp);
      if (d1.length > d0.length) {
        failed.push({ num, why: '改完文风跑偏：' + d1.map(x => x.label).join('、') });
        onLog({ level: 'warn', msg: `  ✘ 第 ${num} 章不收：改完文风跑偏` });
        continue;
      }
    }
    if (!dryRun) fs.writeFileSync(ch.file, after.replace(/\r\n/g, '\n'), 'utf8');
    done.push({ num, fixed: its.length });
    onLog({ level: 'info', msg: `  ✔ 第 ${num} 章已改（${its.length} 条）` });
  }
  return { ok: true, done, failed, chapters: nums.length };
}
