// 共创模式（你出主意 · AI 逐章）——第五种写作引擎。
//
// 与其它模式最大的不同：【以作者的主意为主，AI 只出主意 + 按作者指令写这一章】。
//   - 不做长驻 autopilot、不喂厚上下文包（作者自己记着人物关系与逻辑，AI 不需要“特别记忆”）。
//   - 一次只写一章，作者审完满意再写下一章——AI 不能自作主张改方向，从根上治“越写越变形/漂移”。
//   - 两个动作：① 出主意/分段搭大纲（brainstorm，不落盘）；② 按作者本章要求写这一章（落盘）。
//   - 【必须用强模型 CLI：claude / codex】（也允许 gemini/qwen CLI）——弱模型跟不住作者的具体指令、会跑偏。
//
// 实现：每个动作 = 一次 headless CLI 调用（claude -p / codex exec / gemini -p / qwen -p），
// 输入=作者指令(+可选上一章结尾)，输出=文本；写章时解析 <<<CHAPTER…>>> 落盘。无窗口、无会话、无堆积。

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { lastChapterTail, recentChapterNames } from './contextpack.mjs';
import { currentVolume, getBook, bookStats } from './books.mjs';
import { parseChapters, saveChapter, appendIndex, hanziCount } from './webwriter.mjs';
import { startWriting } from './writer.mjs';
import { sendToBook, sessionAgentAlive } from './attach.mjs';
import { deslopRange } from './deslop.mjs';
import { getSession, removeSession } from './sessions.mjs';
import { killProcess } from './unterm.mjs';

// 允许用于共创的模型：能忠实跟住作者具体指令、会写好文的强 CLI。排除弱/网页/API 免费模型。
export const COWRITE_MODELS = ['claude', 'codex', 'gemini', 'qwen'];
export function isCowriteModel(id) { return COWRITE_MODELS.includes(id); }

// 共创单次调用超时（ms）。claude/gemini 启动+推理更慢（写整章常 5–10 分钟），给足；codex/qwen 较快。
// kind: 'idea'(出主意，短) | 'chapter'(写整章，长)。宁可等久也别误判超时把活干到一半掐了。
function cwTimeout(model, kind) {
  const slow = (model === 'claude' || model === 'gemini');
  if (kind === 'idea') return slow ? 300000 : 180000;        // 出主意：claude 5min / codex 3min
  return slow ? 900000 : 480000;                              // 写整章：claude 15min / codex 8min
}

// headless 跑一次强模型 CLI，拿文本输出。model 直用（不重路由）。timeoutMs 给足（写整章慢）。
// 【异步 spawn】——绝不能用 spawnSync：那会把整个引擎的事件循环冻住数十秒到数分钟，期间 App 无任何响应
// （日志不刷、界面像卡死），用户以为"没开始创作"。async spawn 不阻塞，引擎照常刷日志、界面不卡。
function runCowrite(model, prompt, cfg, timeoutMs = 300000) {
  const m = getModel(model);
  if (!m || !isCowriteModel(model)) {
    return Promise.reject(new Error('共创模式必须用 claude / codex（或 gemini / qwen）CLI；当前模型不支持：' + model
      + '。请在共创面板顶部选 claude 或 codex。'));
  }
  if (!m.bin) return Promise.reject(new Error(m.name + ' 不是本地 CLI，无法用于共创模式'));
  const env = { ...process.env };
  if (cfg?.enableProxy) {
    const px = proxyUrl();
    if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; }
  }
  let args;
  if (model === 'codex') args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  else args = ['-p'];   // claude / gemini / qwen 都是 -p + stdin
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(m.bin, args, { cwd: os.tmpdir(), env, shell: true, windowsHide: true });
    } catch (e) { return reject(new Error(m.name + ' 调用失败：' + (e.message || e))); }
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(m.name + ` 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout && child.stdout.on('data', d => { out += d; });
    child.stderr && child.stderr.on('data', d => { err += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(m.name + ' 调用失败：' + (e.message || e))); });
    child.on('close', () => { if (done) return; done = true; clearTimeout(timer); resolve(stripAnsi(out + '\n' + err)); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { /* 子进程若已退出，close/error 会处理 */ }
  });
}

// 书的极简身份行（不喂厚设定，只给最基本的“这是什么书”，其余靠作者指令）。
function bookGist(book) {
  const bits = [`《${book.title}》`];
  if (book.genre) bits.push('题材：' + book.genre);
  const synopsis = (book.synopsis || '').trim();
  if (synopsis) bits.push('一句话：' + synopsis.slice(0, 80));
  return bits.join('；');
}

// 文风与反 AI 味的最小硬标准（保证 AI 写出来不是 AI 腔，但不喂长篇规范）。
const STYLE_GUARD = [
  '文风与硬标准：句长短交错、张弛有度，不要句句等长；每 250–400 字有一个可见实锚（物件/身体感觉/具体动作/专有名词与数目）；',
  '删解释性套话（“这不是…而是”“这意味着”“换句话说”“总而言之”）与翻译腔现代词（进行/基于/针对/通过…的方式）；',
  '对话带潜台词、人物口吻各异；段尾别总点题升华；严禁为凑字数重复段落或原地绕圈。',
].join('');

// ① 出主意 / 分段搭大纲：按作者的问题给具体可用的建议，不写正文、不落盘。返回 {ideas, model}。
export async function brainstorm({ book, model, ask, cfg }) {
  book = getBook(book.slug) || book;
  const last = lastChapterTail(book, 600);
  const nextNum = (last.num || 0) + 1;
  const prompt = [
    `你是资深网文主编与作者，给作者【出主意】。作者自己掌控人物关系与全局逻辑，你只需针对他的具体问题给可落地的建议。`,
    `书：${bookGist(book)}。当前写到第 ${last.num || 0} 章，接下来是第 ${nextNum} 章。`,
    last.tail ? `上一章结尾（了解衔接用）：${last.tail}` : '',
    ``,
    `作者的问题 / 需求：${String(ask || '').trim()}`,
    ``,
    `请【只给 2–3 个方案】供作者挑选，每个方案【一两句话说清核心走向】即可（一句点子 + 半句钩子/为什么好）。`,
    `硬性要求：极简、口语、好读；每个方案不超过 2 行；【不要】beat 拆解、【不要】长篇分析、【不要】写正文、【不要】客套或讲道理。`,
    `格式示例：`,
    `方案一：<一句话走向>。（钩子：<半句>）`,
    `方案二：…`,
    `方案三：…`,
    `作者要的是能一眼挑的选项，不是方案书——越短越好。`,
  ].filter(Boolean).join('\n');
  const out = await runCowrite(model, prompt, cfg, cwTimeout(model, 'idea'));
  const ideas = cleanIdeas(out);
  if (!ideas) throw new Error('AI 未给出有效建议，请重试或换 claude/codex');
  return { ideas, model, nextNum };
}

// 删掉当前最高章号那一章（文件 + chapter_index.md 里对应行）。用于「重写刚才这章」。返回被删的章号。
export function removeLastChapter(book) {
  book = getBook(book.slug) || book;
  const last = lastChapterTail(book, 0);
  if (!last.num) return 0;
  // 删文件
  const cdir = path.join(book.dir, 'chapters');
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.txt$/i.test(e.name) && parseInt((e.name.match(/^(\d{1,4})/) || [])[1] || '0', 10) === last.num) { try { fs.unlinkSync(fp); } catch {} } } };
  walk(cdir);
  // 删 index 里该章号的行
  const idxPath = path.join(book.dir, 'chapter_index.md');
  try {
    const cur = fs.readFileSync(idxPath, 'utf8');
    const kept = cur.split(/\r?\n/).filter(line => {
      const m = line.match(/^\s*\|\s*(\d{1,4})\s*\|/);
      return !(m && parseInt(m[1], 10) === last.num);
    }).join('\n');
    fs.writeFileSync(idxPath, kept.replace(/\s*$/, '') + '\n', 'utf8');
  } catch {}
  return last.num;
}

// ② 按作者本章要求写这一章：严格照作者的 intent 写，AI 不得自作主张改方向。落盘一章。
// redoLast=true：先删掉刚写的最后一章，再用（可能改过的）要求重写同一章号。
export async function writeChapterFromIntent({ book, model, intent, useLastEnding = true, redoLast = false, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const it = String(intent || '').trim();
  if (!it) throw new Error('请先写「本章我的要求」——这一模式以你的主意为主，AI 按你的要求写。');
  if (redoLast) { const del = removeLastChapter(book); if (del) onLog({ level: 'info', msg: `重写：已移除刚才的第 ${del} 章` }); }
  const last = lastChapterTail(book, useLastEnding ? 1600 : 0);
  const num = (last.num || 0) + 1;
  const lo = book?.standards?.minChars || 3000;
  const hi = book?.standards?.targetCharsHi || 3600;
  const names = recentChapterNames(book, 60).recent;

  const prompt = [
    `你是资深网文作者。请【严格按作者对本章的要求】写第 ${num} 章正文。这是“作者主导”的共创：作者掌控人物关系与全局逻辑，你要忠实执行，【绝不自作主张改变作者定的情节方向、人物设定或走向】。`,
    `书：${bookGist(book)}。`,
    ``,
    `【作者对第 ${num} 章的要求（最高优先，务必照做）】：`,
    it,
    ``,
    useLastEnding && last.tail ? `【上一章结尾（衔接用，保持文笔与语气连续）】：\n${last.tail}\n` : '',
    names.length ? `【近期已用章名（新章名别与这些重复）】：${names.slice(-30).join('、')}\n` : '',
    STYLE_GUARD,
    ``,
    `输出要求：`,
    `1. 只写【第 ${num} 章】这一章，约 ${lo}–${hi} 字，情节靠推进与细节写足，不重复凑字。`,
    `2. 用固定分隔符包裹，标记单独成行，正文里不要出现 <<<CHAPTER 或 <<<END：`,
    `<<<CHAPTER 章号=${num} 标题=你起的本章章名>>>`,
    `（本章正文，仅正文，可含自然段换行；不要写“第X章”标题行、不要 markdown、不要作者旁白、不要解释）`,
    `<<<END>>>`,
    `3. 除这个带分隔符的章节块外，回复里不要有任何多余文字（不要复述要求、不要总结、不要评论）。`,
  ].filter(Boolean).join('\n');

  onLog({ level: 'act', msg: `共创：按你的要求写第 ${num} 章（${lo}–${hi} 字，模型 ${getModel(model)?.name || model}）…` });
  const out = await runCowrite(model, prompt, cfg, cwTimeout(model, 'chapter'));
  const chapters = parseChapters(out, { onLog });
  const ch = chapters[0];
  if (!ch) throw new Error('AI 未按格式产出本章（可能被截断或跑偏）。可重试，或把要求写得更具体。');

  const volNum = currentVolume(book) || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const rel = saveChapter(book, volDir, num, ch.title, ch.body);
  const row = { num, title: ch.title, volDir, rel, words: hanziCount(ch.body) };
  try { appendIndex(book, [row]); } catch (e) { onLog({ level: 'warn', msg: '更新 chapter_index.md 失败：' + e.message }); }
  onLog({ level: 'act', msg: `  ✓ 第 ${num} 章《${ch.title}》已落盘（约 ${row.words} 字）→ ${rel}` });
  return { num, title: ch.title, body: ch.body, rel, words: row.words, model };
}

// ===== 窗口模式（可见 Unterm）：作者能【看见】AI 在窗口里写这一章 =====
// 无头模式看不见、claude 还慢；窗口模式开一个可见终端、AI 在里面实时写文件，作者盯着看、更放心也更快
//（窗口常驻，后面每章不用冷启动）。autopilot 关掉——只写这一章、不自动续，作者主导每一章。

// 窗口模式的单章指令：让 AI 按作者要求写【就这一章】的 .txt 文件、登记 index，然后【停下】，绝不多写。
function buildWindowChapterInstruction(book, num, intent, useLastEnding) {
  const lo = book?.standards?.minChars || 3000;
  const hi = book?.standards?.targetCharsHi || 3600;
  const last = useLastEnding ? lastChapterTail(book, 1200) : { tail: '' };
  const volNum = currentVolume(book) || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const s = `这是【作者主导·共创】：作者掌控人物关系与全局逻辑，你只按作者对这一章的要求忠实执行，绝不自作主张改方向。` +
    `请【只写第 ${num} 章这一章正文】并落盘，然后【立即停下、不要写下一章、不要写下一批、不要问是否继续】。` +
    `【作者对第 ${num} 章的要求（最高优先，务必照做）】：${intent} 。` +
    (last.tail ? `【上一章结尾（衔接用，保持文笔语气连续）】：${last.tail} 。` : '') +
    `写作标准：约 ${lo}–${hi} 字（硬下限 > ${lo} 字）；严格遵守本目录 AGENTS.md 的反AI味/节奏/开篇等规范；情节靠推进与细节写足，不重复凑字。` +
    `落盘：写到 chapters/${volDir}/，文件名=3位全局章号+唯一章名（如 ${String(num).padStart(3, '0')}章名.txt），内容【仅正文】不含标题行/卷名/注释；章名先在 chapter_index.md 全表查重确保唯一；写完把这一章登记进 chapter_index.md。` +
    `完成这一章后【就停下】，不要继续写后面的章。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 读"最高章号"那一章的【完整正文】+ 路径（窗口模式下 AI 自己写了文件，我们读回展示给作者）。
function readNewestChapter(book) {
  const cdir = path.join(book.dir, 'chapters');
  let best = { num: 0, file: '', name: '' };
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/\.txt$/i.test(e.name)) {
        const num = parseInt((e.name.match(/^(\d{1,4})/) || [])[1] || '0', 10);
        if (num >= best.num) best = { num, file: path.join(d, e.name), name: e.name };
      }
    }
  };
  walk(cdir);
  if (!best.file) return null;
  let body = ''; try { body = fs.readFileSync(best.file, 'utf8'); } catch {}
  const title = best.name.replace(/\.txt$/i, '').replace(/^\d{1,4}/, '');
  return { num: best.num, title, body: body.trim(), rel: path.relative(book.dir, best.file).replace(/\\/g, '/'), words: hanziCount(body) };
}

// 窗口模式写一章：开/复用可见 Unterm 窗口 → 注入本章要求 → 轮询"章数增加=写完" → 读回新章。
export async function writeChapterInWindow({ book, model, intent, useLastEnding = true, redoLast = false, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const it = String(intent || '').trim();
  if (!it) throw new Error('请先写「本章我的要求」——共创以你的主意为主。');
  if (!isCowriteModel(model)) throw new Error('共创窗口模式需 claude / codex（或 gemini / qwen）CLI；当前：' + model);
  if (redoLast) { const del = removeLastChapter(book); if (del) onLog({ level: 'info', msg: `重写：已移除刚才的第 ${del} 章` }); }

  const before = bookStats(book).chapters;
  const num = (lastChapterTail(book, 0).num || 0) + 1;
  const instruction = buildWindowChapterInstruction(book, num, it, useLastEnding);

  // 开窗或复用已开窗口（AI 还在跑就注入；否则开一个新的可见窗口，autopilot 关掉=只写这一章）
  const alive = await sessionAgentAlive(book.slug, cfg).catch(() => false);
  if (alive) {
    onLog({ level: 'act', msg: `共创窗口：向已开的 AI 窗口注入第 ${num} 章要求（你可在窗口里看它写）…` });
    await sendToBook(book.slug, instruction, cfg);
  } else {
    onLog({ level: 'act', msg: `共创窗口：打开可见 Unterm 窗口（${getModel(model)?.name || model}）并注入第 ${num} 章要求（你能看着它写）…` });
    // attachAutopilot + autopilotConfirmOnly：挂一个【只自动确认提问、绝不自动续写】的极简 autopilot，
    // 这样 AI 遇到"是否/信任目录/审批"等提问会被自动确认、不会卡住，但写完这一章就停、不自动写下一章。
    await startWriting({ book, model, instruction, cfg, attachAutopilot: true, autopilotConfirmOnly: true, onLog: (e) => onLog({ ...e }) });
  }

  // 轮询：章数比开写前多了 = 这一章写完落盘了。给足超时（claude 慢）。
  const timeoutMs = cwTimeout(model, 'chapter');
  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const now = bookStats(getBook(book.slug) || book).chapters;
    if (now > before) { done = true; break; }
  }
  if (!done) throw new Error(`等 AI 写完第 ${num} 章超时（${Math.round(timeoutMs / 1000)}s）。可到窗口看看它卡在哪，或重试；claude 较慢可换 codex。`);

  await new Promise(r => setTimeout(r, 3000));   // 让文件写完整再读
  const ch = readNewestChapter(getBook(book.slug) || book);
  if (!ch) throw new Error('章数增加了但没读到新章文件（可去窗口核对）');
  onLog({ level: 'act', msg: `  ✓ 第 ${ch.num} 章《${ch.title}》已写好（约 ${ch.words} 字）→ ${ch.rel}` });
  return { num: ch.num, title: ch.title, body: ch.body, rel: ch.rel, words: ch.words, model, windowMode: true };
}

// ===== 自由式·一段情节 → AI 自拆 3–5 章（探索式书的主写法）=====
// 与"一次一章"的区别：作者给的是【一段故事情节】（可能够写好几章），AI 自己判断该拆成几章（3–5），
// 逐章落盘。全程没有大纲文件——情节以作者这段话为唯一依据；需要新配角就地起名并登记进人物名册。

const BATCH_MIN = 3, BATCH_MAX = 5;

// 自拆批次的窗口指令：读手法与名册 → 把作者这段情节拆成 3–5 章 → 逐章落盘登记 → 停。单行。
function buildPlotBatchInstruction(book, startNum, plot, useLastEnding) {
  const lo = book?.standards?.minChars || 3000;
  const hi = book?.standards?.targetCharsHi || 3600;
  const last = useLastEnding ? lastChapterTail(book, 1200) : { tail: '' };
  const volNum = currentVolume(book) || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const endNum = startNum + BATCH_MAX - 1;
  const s = `这是【作者主导·探索式】：本书没有任何大纲，剧情由作者一段一段给你，你只负责拆章执笔。` +
    `动笔前先读 novel_bible.md 的【写作手法】（整本照这个手法写）与 continuity_ledger.md 的【人物名册】（已出场人物一律沿用名册里的名字，绝不改名、绝不串名）。` +
    `【作者给的这一段情节（最高优先，必须原样落实）】：${plot} 。` +
    `请把这段情节【自己判断拆成 ${BATCH_MIN}–${BATCH_MAX} 章】——情节量小就 ${BATCH_MIN} 章、量大就 ${BATCH_MAX} 章，宁可写足也别注水；` +
    `从第 ${startNum} 章开始连续写（最多写到第 ${endNum} 章），一章一个文件，写完这一批就【立即停下】，不要自作主张往后续写、不要问是否继续。` +
    `【硬性】不得改变作者定的情节走向、人物设定与结果，不得自加大转折或提前用掉作者没给的剧情；` +
    `拆章只是分配节奏（每章一个小目标 + 章末钩子），不是改故事。` +
    `【配角临时起名】这一段里若出现新人物，就按 bible 里的命名口味【当场给他起名】，并把「姓名｜身份｜当前处境｜首次出场章」追加进 continuity_ledger.md 的人物名册；` +
    `除名册与 chapter_index.md 外不要改动别的设定文件。` +
    (last.tail ? `【上一章结尾（衔接用，保持文笔语气连续）】：${last.tail} 。` : '') +
    `写作标准：每章约 ${lo}–${hi} 字（硬下限 > ${lo} 字），严格遵守本目录 AGENTS.md 的反AI味/排版/节奏规范，靠推进与细节写足、绝不重复凑字。` +
    `落盘：写到 chapters/${volDir}/，文件名=3位全局章号+唯一章名（如 ${String(startNum).padStart(3, '0')}章名.txt），内容【仅正文】不含标题行/卷名/注释；` +
    `章名先在 chapter_index.md 全表查重确保唯一；每写完一章就立刻登记进 chapter_index.md 再写下一章。` +
    `【绝对禁止】新建或写入 outlines/ 下的任何大纲文件、给本书排卷排阶段、改写 novel_bible.md 的故事概述。` +
    `这一批 ${BATCH_MIN}–${BATCH_MAX} 章写完就停下，等作者给下一段情节。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 读 chapters/ 下所有章号 >= fromNum 的章（正文+路径+字数），按章号升序。
function readChaptersFrom(book, fromNum) {
  const out = [];
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!/\.txt$/i.test(e.name)) continue;
      const num = parseInt((e.name.match(/^(\d{1,4})/) || [])[1] || '0', 10);
      if (!num || num < fromNum) continue;
      let body = ''; try { body = fs.readFileSync(fp, 'utf8'); } catch {}
      out.push({
        num, title: e.name.replace(/\.txt$/i, '').replace(/^\d{1,4}/, ''), body: body.trim(),
        rel: path.relative(book.dir, fp).replace(/\\/g, '/'), words: hanziCount(body),
      });
    }
  };
  walk(path.join(book.dir, 'chapters'));
  return out.sort((a, b) => a.num - b.num);
}

// 按作者这一段情节连写 3–5 章（可见窗口模式）：开/复用窗口 → 注入 → 轮询到"写完不再增加" → 排版矫正 → 读回。
export async function writeChaptersFromPlot({ book, model, plot, useLastEnding = true, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const pt = String(plot || '').trim();
  if (!pt) throw new Error('请先写「这一段的故事情节」——本书没有大纲，剧情以你给的这段为准。');
  if (!isCowriteModel(model)) throw new Error('需 claude / codex（或 gemini / qwen）CLI；当前：' + model);

  const before = bookStats(book).chapters;
  const startNum = (lastChapterTail(book, 0).num || 0) + 1;
  const instruction = buildPlotBatchInstruction(book, startNum, pt, useLastEnding);

  const alive = await sessionAgentAlive(book.slug, cfg).catch(() => false);
  if (alive) {
    onLog({ level: 'act', msg: `按你这段情节连写 ${BATCH_MIN}–${BATCH_MAX} 章：向已开的 AI 窗口注入（从第 ${startNum} 章起）…` });
    onLog({ level: 'warn', msg: '注意：这是复用你已开着的窗口。若它是「▶ 开始写作」起的全自动窗口，写完这批它仍会自己接着写——本模式建议先停掉那个窗口再给情节。' });
    await sendToBook(book.slug, instruction, cfg);
  } else {
    onLog({ level: 'act', msg: `按你这段情节连写 ${BATCH_MIN}–${BATCH_MAX} 章：打开 Unterm 窗口（${getModel(model)?.name || model}），从第 ${startNum} 章起（你能看着它写）…` });
    await startWriting({ book, model, instruction, cfg, attachAutopilot: true, autopilotConfirmOnly: true, onLog: (e) => onLog({ ...e }) });
  }

  // 轮询：一批 3–5 章比单章久得多 → 超时给到单章的 3 倍。判定这一批写完：
  //   ① 已写满 BATCH_MAX 章；② 已够 BATCH_MIN 章且 90s 没有新章落盘（AI 停在窗口里等下一段情节）；
  //   ③ 不足 BATCH_MIN 但"够写一整章的时间"都没有新章 → 它是真停了（情节太小/被中断），别干等到总超时。
  const chapterMs = cwTimeout(model, 'chapter');
  const timeoutMs = chapterMs * 3;
  const deadline = Date.now() + timeoutMs;
  let seen = before, lastGrow = Date.now();
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const now = bookStats(getBook(book.slug) || book).chapters;
    if (now > seen) {
      seen = now; lastGrow = Date.now();
      onLog({ level: 'info', msg: `  …已落盘 ${seen - before} 章` });
    }
    const got = seen - before;
    const idle = Date.now() - lastGrow;
    if (got >= BATCH_MAX) break;
    if (got >= BATCH_MIN && idle > 90000) break;
    if (got >= 1 && idle > chapterMs) break;
  }
  const got = seen - before;
  if (!got) throw new Error(`等 AI 写这一批超时（${Math.round(timeoutMs / 60000)} 分钟没有任何新章落盘）。可到窗口看看它卡在哪，或重试；claude 较慢可换 codex。`);
  if (got < BATCH_MIN) onLog({ level: 'warn', msg: `只写出 ${got} 章（少于 ${BATCH_MIN} 章）就停了——可能情节量太小或被中断，正文已保留。` });

  // 【硬闸】这一批到此为止：我们自己开的窗口，写完就收掉。作者主导模式下"多写"永远是错的——
  // 靠指令里那句"写完就停"不够硬(agent 一句"要接着写吗"就可能把自己续下去)，直接断掉执行环境最保险。
  // 复用来的窗口不动（那是作者自己开的，由他决定何时停）。
  if (!alive) {
    try {
      const s = getSession(book.slug);
      if (s?.pid) { killProcess(s.pid); removeSession(book.slug); onLog({ level: 'act', msg: '这一批写完 → 已收起窗口（下一段情节会重新开窗，避免它自己接着写）' }); }
    } catch (e) { onLog({ level: 'warn', msg: '收窗失败（不影响已写的章）：' + e.message }); }
  }

  await new Promise(r => setTimeout(r, 4000));   // 让最后一章写完整再读
  const chapters = readChaptersFrom(getBook(book.slug) || book, startNum);
  if (!chapters.length) throw new Error('章数增加了但没读到新章文件（可去窗口核对）');
  const endNum = chapters[chapters.length - 1].num;
  // 写后强制排版矫正：治「……」雪球 + 逐句换行（不靠模型自觉）
  try {
    const dr = deslopRange(book.dir, startNum, endNum, onLog);
    if (dr && dr.touched) { for (const c of chapters) { try { c.body = fs.readFileSync(path.join(book.dir, c.rel), 'utf8').trim(); } catch {} } }
  } catch (e) { onLog({ level: 'warn', msg: '排版矫正跳过：' + e.message }); }
  onLog({ level: 'act', msg: `  ✓ 这一段已写成 ${chapters.length} 章（第 ${startNum}–${endNum} 章，约 ${chapters.reduce((s, c) => s + c.words, 0)} 字）` });
  return { chapters, startNum, endNum, count: chapters.length, model, windowMode: true };
}

// 清洗“出主意”文本：去 CLI 回显的 prompt/元信息，保留建议正文。
function cleanIdeas(text) {
  let t = String(text || '');
  // 裁掉回显的 prompt 段
  const cut = t.search(/你是资深网文主编|作者的问题\s*\/\s*需求[:：]/);
  if (cut > 40) t = t.slice(0, cut);
  // 去掉 codex/claude CLI 的启动横幅/运行信息行（stdout/stderr 里混进来的噪声）
  const NOISE = /^(Reading prompt from stdin|OpenAI Codex|Anthropic|Claude Code|-{3,}|workdir:|model:|provider:|approval:|sandbox:|reasoning( effort| summaries)?:|session id:|tokens used|Using|Loaded|▌|\[.*\]\s*$|Warning:|\(node:|To show).*$/i;
  t = t.split(/\r?\n/).filter(line => !NOISE.test(line.trim())).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
