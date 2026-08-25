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
import { voicePrint } from './voiceprint.mjs';

function readOr(p, fallback = '') { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } }
function clip(s, max) { s = String(s || ''); return s.length > max ? s.slice(0, max) + `\n…（已截断，完整内容见文件，必要时自行读取）` : s; }

// 台账取用：新台账把合并出的【当前态快照】放在文件最前，并以 LEDGER_HISTORY_BELOW 标记与下方历史原文分隔。
// 检测到该结构就【整段喂快照】（无论长短，含尾部命名红线全带上），下方几十上百 KB 的历史原文不喂
// （模型需要某条来龙去脉时自行读文件）——这既治了 clip(前8000字)只读到早期陈旧状态的病根，又不膨胀上下文。
// 旧式纯 append 台账（无快照结构）回退到取前 maxChars 字。
function ledgerForPack(raw, maxChars = 8000) {
  const s = String(raw || '');
  const mk = s.indexOf('LEDGER_HISTORY_BELOW');
  if (mk >= 0 && s.includes('📌 当前态快照')) {
    const eol = s.indexOf('\n', mk);
    const head = eol >= 0 ? s.slice(0, eol + 1) : s;
    // 安全阀：快照异常膨胀时仍设个上限（是常规 clip 的 2 倍，够放完整快照又防失控）
    const cap = maxChars * 2;
    return head.length > cap ? head.slice(0, cap) + '\n…（快照过长已截断，完整见文件）' : head;
  }
  return clip(s, maxChars);
}

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

// 读"最高全局章号"那一章的正文尾部（保住文笔与语气的连续）。返回 {num, name, tail}。（导出供 cowrite 复用）
export function lastChapterTail(book, maxChars = 1800) {
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

// 近期章名表（去重防撞名用）：优先从 chapter_index.md 取，退回扫文件名。取最后 N 个 + 总数。（导出供 cowrite 复用）
export function recentChapterNames(book, n = 80) {
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
  const ledger = ledgerForPack(readOr(path.join(book.dir, 'continuity_ledger.md')), 8000);
  const last = lastChapterTail(book);
  const names = recentChapterNames(book);
  const review = latestReviewDigest(book);

  const numList = [];
  for (let i = nextNum; i <= lastNum; i++) numList.push(String(i).padStart(3, '0'));

  // —— 组装 prompt（单批一次性写 count 章；模型用文件工具自行落盘，保留全部现有质量机制：查重/台账/自检）——
  const sections = [];

  sections.push(
    // 【改过】原来这里写"尤其【开篇定位】【题材承诺兑现】【节奏与格局】【反 AI 味】四条最高优先级红线"。
    // 那把 skill.mjs 里那套句子层的写死规则抬成了最高优先级，而下面 voicePrint 又注入范本原文——
    // 同一个 prompt 里两套标准并排打架，且写死那套排在前面还挂着"最高优先级"。
    // 文风的最高依据只能有一个：本书的范本。
    `你是《${book.title}》的网文作者。本目录已有完整写作规范（见 AGENTS.md / CLAUDE.md），` +
    `其中【连续性】【章名唯一】【字数达标】【题材承诺】务必遵守；` +
    `【文风】一律以本书 \`style_refs/\` 的范本原文为准（下面已附上）。\n` +
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

  // 【文风范本原文】——不是"去读 style_refs/"，是把原文放在这里。
  //
  // 实测这两者差一个数量级：同一本书、同一个范本，
  //   共创路把范本原文塞进提示词  → 13.1 字/段（范本 21.5）
  //   窗口路只在 AGENTS.md 写一句"去读 style_refs/" → 47.7 字/段
  // agent 确实读了（材料全接住了），但读文件不等于范本在眼前：
  // 它复述了范本的内容，排版用回自己的默认。
  //
  // 所以这里给的是【文本】不是【指路】。这也不是往提示词里加规则——
  // 规则是我的审美，范本是作者的选择，两者的方向正好相反。
  const voice = voicePrint(book);
  if (voice && voice.trim()) sections.push(voice.trim());

  sections.push(
    `## 这一批要做的事\n` +
    `1. 写第 ${numList.join('、')} 章。【字数是硬指标】：每章正文目标 ${tgtLo}–${tgtHi} 字，硬下限 ${minChars} 字，任何一章都不得低于下限。` +
    `${last.hanzi && last.hanzi >= tgtLo ? `（上一章约 ${last.hanzi} 字达标，保持这个体量、别忽长忽短，也不要超过 ${tgtHi} 字太多。）` : last.hanzi ? `⚠️（注意：最近几章只有约 ${last.hanzi} 字、明显偏短——从本批起每章都要写足到 ${tgtLo}–${tgtHi} 字，绝不能跟着上一章的短篇幅继续写短。）` : ''}` +
    ` 别靠概述凑字数——用【更完整的场景、更多对话、更多具体细节、人物内心与动作】把篇幅撑到位，宁可多写一个有信息量的小节。\n` +
    `   ⚠️ 收尾前【逐章数汉字】：把每章正文的汉字数过一遍，凡不足 ${minChars} 字的章，回去【就地扩写】到 ${tgtLo}–${tgtHi} 字（补场景细节/对话/心理，不改剧情框架与结局），改够了再交——绝不允许提交任何低于 ${minChars} 字的章。\n` +
    `2. 每章严格对齐本卷大纲对应章号的 beat 与章末钩子；推进"人与冲突"，不要写成办手续/对账/盘点的事务流水账。\n` +
    `3. 落盘到 chapters/${volDir}/。【若本卷大纲章号区间已写满、本批进入下一卷】：先给下一卷起一个【有意境的卷名】（4–6字副标题，贴合本卷主线），把它同时写进 ①该卷大纲文件名 outlines/卷${String(volNum + 1).padStart(2, '0')}<卷名>分章大纲.md（如 卷${String(volNum + 1).padStart(2, '0')}静海旧火分章大纲.md）②novel_bible.md 的“全书规模/卷名”处；再建 chapters/卷${String(volNum + 1).padStart(2, '0')}/ 续写。发布番茄按卷名建卷，卷【必须有名】、绝不能只叫“卷${String(volNum + 1).padStart(2, '0')}”。\n` +
    `   文件名 = 3 位全局章号 + 唯一章名，例如 ${numList[0]}章名.txt；内容【仅正文】，不含标题行/卷名/注释/markdown。\n` +
    `4. 取章名前在 chapter_index.md 全表查重，确保全书唯一；写完把新章登记进 chapter_index.md。\n` +
    `5. 写完更新 continuity_ledger.md：\n` +
    `   ★ 文件顶部若有「📌 当前态快照」段（LEDGER_HISTORY_BELOW 标记以上），必须【就地改写该快照】——把本批带来的人物现状/未回收伏笔/待查/进度/伤势/关键物件的变化【更新进快照本段】（新增线加进去、已回收的移出/标了结、进度改到最新章），保持它精简且始终代表【最新状态】。这是写作唯一会读的一段，绝不能让它过期。\n` +
    `   ★ 详细增量（本批新增时间线/伏笔布点等）另【追加到 LEDGER_HISTORY_BELOW 标记以下】的历史区，不要动历史区已有内容。\n` +
    `   （若文件还没有「📌 当前态快照」段，按旧法在文中维护人物现状/未回收伏笔/欠债/伤势/关键物件/时间线即可。）\n` +
    `6. 做一次本批自检（字数/命名/唯一/仅正文/与台账连贯/文风是否贴着范本）。\n` +
    `完成后简要回报：写了哪几章、各多少字、更新了哪些文件。除非我要求，不要在回复里粘贴整章正文。`
  );

  const prompt = sections.join('\n\n');

  // 体积统计（用于 dry-run 展示与 token 估算）
  const sizes = {
    bible: bible.length, outline: outline.text.length, foreshadow: foreshadow.length,
    ledger: ledger.length, lastTail: last.tail.length, names: names.recent.join('').length,
    review: review.length, voice: voice.length, promptChars: prompt.length,
    estTokens: Math.round(prompt.length / 1.7),   // 中英混排粗估
  };
  const meta = { nextNum, lastNum, count, volNum, volDir, cpv, total, lastChapter: last.num, totalChapters: names.total };
  return { prompt, meta, sizes };
}
