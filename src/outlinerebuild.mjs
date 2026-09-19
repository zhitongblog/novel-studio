// 给【已有大量正文】的书重建大纲：分层归纳，而不是"通读全书"。
//
// 作者问：「导入的图书如何生成合理的大纲」。
// 查下来现有的 buildRebuildOutlineInstruction 第一步就写着
// 「通读 chapters/ 下所有已写章节（按文件名顺序）」——这在物理上做不到：
//   《大乾女帝贴身神探》523 章 / 145 万字，《重生之我在岛国当天皇》358 章 / 104 万字。
// 任何模型都装不下。它只能读个开头就往下编，于是产出的东西对不上后面几百章。
//
// 落盘的证据（2026-09-19 实扫）：
//   大乾女帝  523 章 → outlines/ 只有 卷01分章大纲.md（23KB）
//   岛国天皇  358 章 → 只有 卷01、卷02
//   重生三国   86 章 → 只有 1 个文件，1KB
// 也就是说【几百章是在没有大纲的情况下写出来的】。
//
// 改成三层，每一层的输入都是有界的：
//   ① 逐章摘要（map）：一次只喂几章正文，每章出一行「核心事件 → 推进了什么 | 章末钩子」。
//      结果缓存到 outlines/.chapter-digest.json，【可断点续跑、可增量】——
//      523 章的书加写 3 章，只需要再跑 1 次，不是重来一遍。
//   ② 按卷聚合（reduce）：拿该卷的摘要（不是正文）生成 卷NN分章大纲.md。
//      一卷 60 章的摘要约 6 千字，完全装得下。
//   ③ 汇总全书：拿各卷摘要生成 bible 的主线/伏笔（本模块只做 ①②，③ 交给现有指令）。
//
// 纪律：
//   · 绝不碰 chapters/ 下的正文，一个字节都不动；
//   · 每批落盘一次——跑到一半断了，已完成的摘要必须留下；
//   · 模型漏了哪一章要当场发现并重试，不能默默少几章（少的那几章后面就永远没有大纲）。

import fs from 'node:fs';
import path from 'node:path';

const DIGEST_FILE = '.chapter-digest.json';

export function digestPath(book) { return path.join(book.dir, 'outlines', DIGEST_FILE); }

export function loadDigests(book) {
  try { return JSON.parse(fs.readFileSync(digestPath(book), 'utf8')) || {}; } catch { return {}; }
}
function saveDigests(book, d) {
  try {
    fs.mkdirSync(path.join(book.dir, 'outlines'), { recursive: true });
    fs.writeFileSync(digestPath(book), JSON.stringify(d, null, 1), 'utf8');
  } catch {}
}

// 扫出全书章节：[{num, vol, file, name}]，按章号排序
export function listChapters(book) {
  const root = path.join(book.dir, 'chapters');
  const out = [];
  let vols = [];
  try { vols = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const take = (dir, vol) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { take(path.join(dir, e.name), e.name); continue; }
      if (!e.name.toLowerCase().endsWith('.txt')) continue;
      const m = e.name.match(/^(\d{1,4})[_\-\s]*(.*)\.txt$/i);
      if (!m) continue;
      out.push({ num: parseInt(m[1], 10), vol: vol || '卷01', file: path.join(dir, e.name), name: (m[2] || '').trim() });
    }
  };
  for (const v of vols) {
    if (v.isDirectory()) take(path.join(root, v.name), v.name);
    else take(root, '');
  }
  return out.sort((a, b) => a.num - b.num);
}

// 还差哪些章没有摘要
export function missingDigests(book) {
  const have = loadDigests(book);
  return listChapters(book).filter(c => !have[String(c.num)]);
}

// 一批章节的摘要 prompt。要求【每章一行、行首是章号】——好解析，也好当场核对有没有漏。
export function buildDigestPrompt(chapters) {
  const body = chapters.map(c =>
    `【第 ${c.num} 章 ${c.name}】\n` + readChapter(c.file, 4000)
  ).join('\n\n');
  return [
    '下面是一本长篇网文的若干章正文。请为【每一章】写一行梗概，供后续重建分章大纲使用。',
    '',
    '格式要求（严格遵守，每章占且只占一行）：',
    '章号|核心事件与冲突|推进了什么（人物关系/势力/实力/目标的变化）|章末钩子',
    '例：037|王莽借飞章弹劾九卿，当廷对质|拿到北军虎符，与王商正面撕破脸|殿外传来太后急召',
    '',
    `一共 ${chapters.length} 章，就输出 ${chapters.length} 行，不要写任何别的话、不要小标题、不要空行。`,
    '章号用阿拉伯数字，不要补零。每一行都必须以章号和竖线开头。',
    '',
    '正文如下：',
    '',
    body,
  ].join('\n');
}

function readChapter(file, maxChars) {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8'); } catch { return '（读不到这一章）'; }
  // 摘要不需要全文：开头定场景、结尾是钩子，中间取一段。省下来的上下文留给"一次多喂几章"。
  if (t.length <= maxChars) return t;
  const head = Math.floor(maxChars * 0.55), tail = maxChars - head;
  return t.slice(0, head) + '\n……（中略）……\n' + t.slice(-tail);
}

// 解析模型返回的摘要行 → { 章号: 摘要 }
// 【必须能看出漏了哪一章】模型少写几行是常态；不核对的话，那几章后面就永远没有大纲。
export function parseDigestLines(text, wantNums) {
  const got = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 【行首写法要放宽】模型不会严格听话，实际见过的：
    //   「1|…」「- 1|…」「第2章|…」「003｜…」（补零、全角竖线、前缀符号、中文"第N章"）
    // 太严的话，认不出来的那几章会被当成"漏了"，白白多跑一轮补写。
    const m = t.match(/^[^\d|｜]{0,6}(\d{1,4})[^|｜]{0,4}[|｜]\s*(.+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const body = m[2].trim();
    if (!body || body.length < 4) continue;
    got[String(n)] = body;
  }
  const want = new Set(wantNums.map(String));
  const missing = [...want].filter(n => !got[n]).map(Number).sort((a, b) => a - b);
  // 模型有时会顺手编出不存在的章号，丢掉
  for (const k of Object.keys(got)) if (!want.has(k)) delete got[k];
  return { got, missing };
}

// 按卷把摘要拼成「分章大纲」的输入。一卷 60 章的摘要约 6 千字，装得下。
export function volumeDigestText(book, vol) {
  const d = loadDigests(book);
  const rows = listChapters(book).filter(c => c.vol === vol);
  return rows.map(c => `${c.num}｜${c.name}｜${d[String(c.num)] || '（暂无梗概）'}`).join('\n');
}

export function listVolumes(book) {
  return [...new Set(listChapters(book).map(c => c.vol))].sort();
}

// 生成某一卷的分章大纲 prompt——喂的是【摘要】，不是正文。
export function buildVolumeOutlinePrompt(book, vol, digestText) {
  return [
    `下面是《${book.title}》${vol} 的逐章梗概（章号｜章名｜核心事件｜推进｜钩子）。`,
    '请据此写出这一卷的【分章大纲】，用于后续写作时对照，也用于检查这一卷的结构。',
    '',
    '输出格式：',
    `# ${vol}<卷名>分章大纲`,
    '（先给这一卷起一个 4–6 字有意境的卷名，据本卷主线取，填到上面的 <卷名> 处）',
    '',
    '## 本卷一句话走向',
    '（主角从什么处境 → 到什么处境）',
    '',
    '## 分章',
    '逐章一行：`章号 章名 — 核心事件/冲突；推进了什么；章末钩子`',
    '',
    '## 本卷伏笔布点表',
    '逐条一行：`伏笔 — 埋设章号 → 计划回收章号（已回收的写实际章号）`',
    '',
    '要求：完全依据下面的梗概，【不要编造梗概里没有的情节】；梗概缺失的章节照实写「（梗概缺失）」。',
    '',
    digestText,
  ].join('\n');
}

// 把生成好的卷大纲落盘。卷名从模型输出的一级标题里取，取不到就退回不带卷名的文件名。
export function saveVolumeOutline(book, vol, text) {
  const odir = path.join(book.dir, 'outlines');
  fs.mkdirSync(odir, { recursive: true });
  const m = String(text || '').match(/^#\s*(卷\s*\d+\s*[^\n]*?)分章大纲/m);
  const title = m ? m[1].replace(/\s+/g, '') : vol;
  const file = path.join(odir, `${title}分章大纲.md`);
  fs.writeFileSync(file, String(text || '').trim() + '\n', 'utf8');
  return file;
}

// 摘要进度：给界面/日志用
export function digestProgress(book) {
  const all = listChapters(book);
  const have = loadDigests(book);
  const done = all.filter(c => have[String(c.num)]).length;
  return { total: all.length, done, missing: all.length - done, volumes: listVolumes(book) };
}

// 记一批摘要（增量落盘——跑到一半断了，已完成的必须留下）
export function recordDigests(book, got) {
  const d = loadDigests(book);
  for (const [k, v] of Object.entries(got)) d[k] = v;
  saveDigests(book, d);
  return Object.keys(d).length;
}
