// 无状态写作的【上下文包】组装器（纯只读，不调模型、不写文件）。
//
// 设计要害：长驻会话之所以质量稳，是因为 agent 把"前文"都留在对话历史里；
// 一旦改成每章全新进程，这份隐式上下文就没了。所以这里要把"这一批真正需要的前文"
// 精准地、显式地重新喂回去——而且要比 CLI 的通用压缩更懂该留什么：
//   bible 摘要 + 本卷分章大纲 + 连贯性台账 + 上一章结尾原文 + 近期章名表 + 规范红线。
// 喂进去的料与长驻会话里 agent 自己重建的一致 → 产出质量一致，但 token 从平方级压回线性。

import fs from 'node:fs';
import path from 'node:path';
import { bookStats, currentVolume, chaptersPerVol, plannedTotalChapters } from './books.mjs';

function readOr(p, fallback = '') { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } }
function clip(s, max) { s = String(s || ''); return s.length > max ? s.slice(0, max) + `\n…（已截断，完整内容见文件，必要时自行读取）` : s; }

// 找当前卷的分章大纲文件：outlines/卷NN*.md（NN = 当前卷号）。找不到则退回任意一份/空。
function currentOutline(book, volNum) {
  const odir = path.join(book.dir, 'outlines');
  let files = [];
  try { files = fs.readdirSync(odir).filter(f => /\.md$/i.test(f)); } catch { return { name: '', text: '' }; }
  const tag = '卷' + String(volNum || 1).padStart(2, '0');
  const tagLoose = '卷' + (volNum || 1);
  let hit = files.find(f => f.includes(tag)) || files.find(f => f.includes(tagLoose));
  // 主线伏笔表也带上（若单独成文）
  if (!hit && files.length) hit = files.sort()[files.length - 1];
  const text = hit ? readOr(path.join(odir, hit)) : '';
  return { name: hit || '', text };
}

// 全书主线伏笔表（若单独成文）
function foreshadowTable(book) {
  for (const rel of ['outlines/主线伏笔表.md', '主线伏笔表.md']) {
    const t = readOr(path.join(book.dir, rel), null);
    if (t) return t;
  }
  return '';
}

// 读"最高全局章号"那一章的正文尾部（保住文笔与语气的连续）。返回 {num, name, tail}。
function lastChapterTail(book, maxChars = 1800) {
  const cdir = path.join(book.dir, 'chapters');
  let best = { num: 0, file: '', vol: '' };
  const walk = (d, vol) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), e.name);
      else if (/\.txt$/i.test(e.name)) {
        const m = e.name.match(/^(\d{1,4})/);
        const num = m ? parseInt(m[1], 10) : 0;
        if (num >= best.num) best = { num, file: path.join(d, e.name), vol, name: e.name };
      }
    }
  };
  walk(cdir, '');
  if (!best.file) return { num: 0, name: '', tail: '' };
  const body = readOr(best.file);
  const tail = body.length > maxChars ? '…' + body.slice(-maxChars) : body;
  const hanzi = (body.match(/[一-鿿]/g) || []).length;   // 实际篇幅（汉字数）→ 用于字数自校准
  return { num: best.num, name: (best.name || '').replace(/\.txt$/i, ''), tail, hanzi };
}

// 近期章名表（去重防撞名用）：优先从 chapter_index.md 取，退回扫文件名。取最后 N 个 + 总数。
function recentChapterNames(book, n = 80) {
  const names = [];
  const idx = readOr(path.join(book.dir, 'chapter_index.md'));
  if (idx) {
    // 解析表格行：| 章号 | 章名 | ...
    for (const line of idx.split(/\r?\n/)) {
      const m = line.match(/^\s*\|\s*\d{1,4}\s*\|\s*([^|]+?)\s*\|/);
      if (m) names.push(m[1].trim());
    }
  }
  if (!names.length) {
    // 退回扫文件名
    const cdir = path.join(book.dir, 'chapters');
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name));
        else if (/\.txt$/i.test(e.name)) names.push(e.name.replace(/^\d+[_\-]?/, '').replace(/\.txt$/i, '').trim()); } };
    walk(cdir);
  }
  return { total: names.length, recent: names.slice(-n) };
}

// 最近一份逻辑/节奏自检报告的"待办/硬伤"摘要（让续写顺手带上未决项，不漂）。
function latestReviewDigest(book, maxChars = 1200) {
  const rdir = path.join(book.dir, 'reviews');
  let files = [];
  try {
    files = fs.readdirSync(rdir).filter(f => /\.md$/i.test(f))
      .map(f => ({ f, m: (() => { try { return fs.statSync(path.join(rdir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
  } catch { return ''; }
  if (!files.length) return '';
  const t = readOr(path.join(rdir, files[0].f));
  // 抽含"硬伤/待办/未回收/欠债"的段落
  const keep = t.split(/\n(?=#|\*\*|【)/).filter(seg => /硬伤|待办|未回收|欠债|未决|遗留/.test(seg)).join('\n');
  return clip(keep || t, maxChars);
}

// 组装一批的上下文包。count = 本批要写几章。返回 { prompt, meta, sizes }。
export function buildBatchPack(book, { count = 3, mode = 'continue' } = {}) {
  const std = book.standards || {};
  const tgtLo = std.targetCharsLo || 3000;
  const tgtHi = std.targetCharsHi || 3600;
  const minChars = std.minChars || 3000;

  const st = bookStats(book);
  const nextNum = (st.maxChapter || st.chapters || 0) + 1;
  const lastNum = nextNum + count - 1;
  const volNum = currentVolume(book) || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const cpv = chaptersPerVol(book);
  const total = plannedTotalChapters(book);

  const bible = clip(readOr(path.join(book.dir, 'novel_bible.md')), 8000);
  const outline = currentOutline(book, volNum);
  const foreshadow = foreshadowTable(book);
  const ledger = clip(readOr(path.join(book.dir, 'continuity_ledger.md')), 8000);
  const last = lastChapterTail(book);
  const names = recentChapterNames(book);
  const review = latestReviewDigest(book);

  const numList = [];
  for (let i = nextNum; i <= lastNum; i++) numList.push(String(i).padStart(3, '0'));

  // —— 组装 prompt（单批一次性写 count 章；模型用文件工具自行落盘，保留全部现有质量机制：查重/台账/自检）——
  const sections = [];

  sections.push(
    `你是《${book.title}》的网文作者。本目录已有完整写作规范（见 AGENTS.md / CLAUDE.md，务必遵守，` +
    `尤其【开篇定位】【题材承诺兑现】【节奏与格局】【反 AI 味】四条最高优先级红线）。\n` +
    `现在请【接着往下写第 ${numList[0]}–${numList[numList.length - 1]} 章，共 ${count} 章】。`
  );

  sections.push(
    `## 重要：上下文已为你备好，不要通读全书\n` +
    `下面已经把这一批真正需要的前文【精准摘出】给你了（设定/本卷大纲/连贯性台账/上一章结尾/近期章名）。` +
    `请【直接据此动笔】，不要再去通读 chapters/ 下已写的几十上百章——那样既慢又没必要。` +
    `只有当你确实拿不准某个具体设定时，才去读对应的【单个】文件。`
  );

  sections.push(`## 设定圣经（novel_bible.md 摘录）\n${bible}`);

  if (outline.text) sections.push(`## 本卷分章大纲（${outline.name}）\n${clip(outline.text, 6000)}`);
  else sections.push(`## 本卷分章大纲\n⚠️ 未找到卷${volNum}的分章大纲文件。若 outlines/ 里缺本卷章级 beat，请先据 bible 与前文把本批章号的 beat 补到 outlines/${volDir}分章大纲.md，再动笔。`);

  if (foreshadow) sections.push(`## 全书主线伏笔表\n${clip(foreshadow, 3000)}`);

  sections.push(`## 连贯性台账（continuity_ledger.md，这是当前剧情状态的权威快照）\n${ledger}`);

  if (review) sections.push(`## 最近一份自检里的未决项（顺手带着，别漏）\n${review}`);

  if (last.tail) {
    sections.push(
      `## 上一章（第 ${String(last.num).padStart(3, '0')} 章《${last.name.replace(/^\d+[_\-]?/, '')}》）的结尾\n` +
      `> 紧接它往下写，保持同一文笔、语气、人物口吻与当前场景的时空连续：\n\n${last.tail}`
    );
  }

  sections.push(
    `## 近期已用章名（共 ${names.total} 章，列出最近 ${names.recent.length} 个，取名务必避开、连意思相近也错开）\n` +
    names.recent.map(n => '· ' + n).join('\n')
  );

  sections.push(
    `## 这一批要做的事\n` +
    `1. 写第 ${numList.join('、')} 章。${last.hanzi ? `单章篇幅与全书已有章节保持一致——上一章约 ${last.hanzi} 字，本批每章也写到这个体量（约 ${Math.round(last.hanzi * 0.8)}–${Math.round(last.hanzi * 1.2)} 字），不要明显变短或变长。` : `每章正文 ${tgtLo}–${tgtHi} 字（硬下限 > ${minChars} 字）。`}\n` +
    `2. 每章严格对齐本卷大纲对应章号的 beat 与章末钩子；推进"人与冲突"，不要写成办手续/对账/盘点的事务流水账。\n` +
    `3. 落盘到 chapters/${volDir}/（若本卷大纲的章号区间已写满、本批进入下一卷，则建 chapters/卷${String(volNum + 1).padStart(2, '0')}/ 续写）。\n` +
    `   文件名 = 3 位全局章号 + 唯一章名，例如 ${numList[0]}章名.txt；内容【仅正文】，不含标题行/卷名/注释/markdown。\n` +
    `4. 取章名前在 chapter_index.md 全表查重，确保全书唯一；写完把新章登记进 chapter_index.md。\n` +
    `5. 写完更新 continuity_ledger.md：人物现状、未回收伏笔、欠债与承诺、伤势、关键物件去向、时间线锚点。\n` +
    `6. 做一次本批自检（字数/命名/唯一/仅正文/与台账连贯/反 AI 味）。\n` +
    `完成后简要回报：写了哪几章、各多少字、更新了哪些文件。除非我要求，不要在回复里粘贴整章正文。`
  );

  const prompt = sections.join('\n\n');

  // 体积统计（用于 dry-run 展示与 token 估算）
  const sizes = {
    bible: bible.length, outline: outline.text.length, foreshadow: foreshadow.length,
    ledger: ledger.length, lastTail: last.tail.length, names: names.recent.join('').length,
    review: review.length, promptChars: prompt.length,
    estTokens: Math.round(prompt.length / 1.7),   // 中英混排粗估
  };
  const meta = { nextNum, lastNum, count, volNum, volDir, cpv, total, lastChapter: last.num, totalChapters: names.total };
  return { prompt, meta, sizes };
}
