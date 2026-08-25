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
import { getModel, detectModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { lastChapterTail, recentChapterNames } from './contextpack.mjs';
import { currentVolume, getBook, bookStats, volumeDirName } from './books.mjs';
import { parseChapters, saveChapter, appendIndex, hanziCount } from './webwriter.mjs';
import { startWriting } from './writer.mjs';
import { chatComplete } from './apichat.mjs';
import { sendToBook, sessionAgentAlive } from './attach.mjs';
import { deslopRange } from './deslop.mjs';
import { pacingGate, refTargets } from './pacing.mjs';
import { chapterRomanceSection } from './romance.mjs';
import { paragraphHealth, reflowInstruction } from './craft.mjs';
// 【通用方法】审美层整个交给范本：MECHANICS 是唯一由代码写死的（与文风无关的硬性要求），
// voicePrint 来自本书的 style_refs/ 与手法卡。开发者不再规定"该怎么写"。
// 停用的 craftSpec + STYLE_GUARD + openingSection 夹带的是纯文学审美，对网文条条减分，
// 保留在 craft.mjs 里备查但不再注入。
import { voicePrint } from './voiceprint.mjs';
// 机制层：连续性铁律 + 节奏 + 输出规则 + 动笔前的私有约束卡。
// 判据是"换本书还成不成立"——成立才写死在代码里；审美一律交给范本。
import { mechanics, auditPrompt, fixPrompt } from './continuity.mjs';   // 单章级感情线尺度（可临时覆盖全书档位）
import { getSession, removeSession } from './sessions.mjs';
import { closeWindow } from './unterm.mjs';

// 允许用于共创的模型：能忠实跟住作者具体指令、会写好文的强 CLI。排除弱/网页/API 免费模型。
export const COWRITE_MODELS = ['claude', 'codex', 'gemini', 'qwen'];

// 共创的两类活，对模型的要求完全不同：
//   · 出主意 / 无头写一章 —— 只要「喂 prompt、拿文本」，任何能对话的模型都行（含 API/本地）；
//   · 窗口模式写一章 —— 要开可见的 Unterm 窗口让 AI 自己写文件，非 CLI 不可。
// 原来只有一个 isCowriteModel 把两类一刀切成「必须 CLI」，于是本地模型连"出主意"都用不了——
// 而那一步根本不需要窗口。拆成两个判断。
export function isCowriteTextModel(id) {
  if (COWRITE_MODELS.includes(id)) return true;
  const m = getModel(id);
  return !!m && m.kind === 'api';          // 直连接口的（含本地 Ollama）都能出文本
}
// 需要可见窗口的那条路：只能 CLI。
export function isCowriteWindowModel(id) { return COWRITE_MODELS.includes(id); }
// 兼容旧名（等价于"能不能参与共创"，现在按文本能力判定）
export function isCowriteModel(id) { return isCowriteTextModel(id); }

// 共创单次调用超时（ms）。claude/gemini 启动+推理更慢（写整章常 5–10 分钟），给足；codex/qwen 较快。
// kind: 'idea'(出主意，短) | 'chapter'(写整章，长)。宁可等久也别误判超时把活干到一半掐了。
function cwTimeout(model, kind) {
  // 本地模型（12G 卡跑 14B）比云端慢一个量级：出主意约 1 分钟、写整章 3–6 分钟。
  // 沿用 CLI 那套超时会误杀，直接给足——反正 API 路径由 chatComplete 自己的超时兜底。
  const m = getModel(model);
  if (m && m.kind === 'api') return kind === 'idea' ? 600000 : 1800000;
  const slow = (model === 'claude' || model === 'gemini');
  if (kind === 'idea') return slow ? 300000 : 180000;        // 出主意：claude 5min / codex 3min
  return slow ? 900000 : 480000;                              // 写整章：claude 15min / codex 8min
}

// headless 跑一次强模型 CLI，拿文本输出。model 直用（不重路由）。timeoutMs 给足（写整章慢）。
// 【异步 spawn】——绝不能用 spawnSync：那会把整个引擎的事件循环冻住数十秒到数分钟，期间 App 无任何响应
// （日志不刷、界面像卡死），用户以为"没开始创作"。async spawn 不阻塞，引擎照常刷日志、界面不卡。
// 【导出】文风冷启动 / 手法卡提炼也要用它。
// 之前那两处直接调 chatComplete，等于把 CLI 模型（claude、codex）排除在外——
// 而实测里写得最像网文的恰恰是 claude。同一个调度口，谁都能跑。
export function runCowrite(model, prompt, cfg, timeoutMs = 300000) {
  const m = getModel(model);
  if (!m) return Promise.reject(new Error('未知模型：' + model));

  // API 类（智谱/DeepSeek/通义/本地 Ollama）：直接一次对话调用拿文本，不需要任何 CLI 或窗口。
  // 这条路对本地模型尤其重要——共创是"一段段来"的交互式写法，正好适合慢但免费的本地模型。
  if (m.kind === 'api') {
    return chatComplete({
      provider: m.provider, cfg,
      messages: [{ role: 'user', content: prompt }],
    }).then(r => r.content);
  }

  if (!isCowriteTextModel(model)) {
    return Promise.reject(new Error(`「${m.name}」不能用于共创模式。`
      + `可用：claude / codex / gemini / qwen 这类 CLI，或任一 API 模型（含本地 Ollama）。`));
  }
  if (!m.bin) return Promise.reject(new Error(m.name + ' 不是本地 CLI，无法用于共创模式'));
  // 先探一下这个 CLI 在不在。不查的话，命令不存在时 shell 只往 stderr 写一句就退出，
  // 空的 stdout 一路走到解析器，报出来是"AI 未按格式产出本章"——让人以为模型跑偏，其实压根没调起来。
  if (!detectModel(model).available) {
    return Promise.reject(new Error(
      `没找到 ${m.bin} 命令——「${m.name}」本机没装或不在 PATH 里。装好后确保终端里能直接跑 ${m.bin}，或改用 API 类模型。`));
  }
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
    // 【实测踩过的坑】codex 没装时，shell 只把"命令找不到"写进 stderr 就退出，stdout 是空的。
    // 原来这里无脑 resolve，空回复一路走到解析器，报的是"AI 未按格式产出本章"——
    // 让人以为是模型跑偏，实际上根本没调起来。所以退出码非 0 且没正文时，直说是哪一步没成。
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const o = stripAnsi(out), e = stripAnsi(err);
      if (code !== 0 && !o.trim()) {
        const miss = /not (?:be )?recognized|No such file|command not found|无法将.*识别/i.test(e);
        return reject(new Error(miss
          ? `没找到 ${m.bin} 命令——「${m.name}」这个 CLI 本机没装或不在 PATH 里。请先装好并能在终端直接运行 ${m.bin}，或换用 API 类模型。`
          : `${m.name} 退出码 ${code}，没有产出内容：${e.trim().slice(0, 300) || '（无错误输出）'}`));
      }
      resolve(o + '\n' + e);
    });
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
// 文风约束分两半，缺一不可。
// 【教训】原来只有"别做什么"那一半（删套话、别升华、别凑字、实锚密度），模型就只优化被测量的东西：
// 拼命塞物件、把句子剁短、绝不抒情 —— 写出来是一堆舞台指示，人物成了摄像机镜头而不是活人，
// 通篇没有一句内心。读者感受到的"僵硬"正是这么来的。所以必须把"要做什么"明确写出来。
// 【已删】STYLE_GUARD —— 一套写死的文风守则（自由间接引语、每 250–400 字一个实锚、
// 信息不要给满、收尾不要抒情不要点题）。它夹带的是纯文学审美，网文里条条减分，
// 早已停用且零引用。文风一律来自 voiceprint.voicePrint(book)：本书的范本原文。

// 每章可调的文风倾向。同一本书里，打戏、对峙、日常该偏重的东西完全不同，
// 用一条通用 STYLE_GUARD 压所有章节，出来的东西必然一个味道。
// 这里只做【加权】，不覆盖 STYLE_GUARD 的底线（内心、视角、不科普那几条始终生效）。
export const STYLE_SLANTS = {
  inner: { name: '心理', tip: '判断与克制，适合对峙/重逢/下决心',
    text: '【心理】把笔墨压在主角的判断与克制上——他认出了什么、在算计什么、为什么忍住。'
        + '外部动作可以少，但每个动作背后都要让读者感到他的取舍。' },
  fight: { name: '武打', tip: '拳脚交手、身法与伤',
    text: '【武打】打斗写【一招一结果】，不写招式名称的堆砌：距离、重心、先动哪只手、打在哪儿、对方怎么变形。'
        + '每一次交手都要改变局面（受伤、失去武器、暴露身份、被迫后退）。'
        + '主角不许毫发无伤地赢——疼痛、脱力、护住的旧伤都要落到实处。'
        + '打之前的对峙和打之后的余韵，比打的过程本身更值得写。' },
  scene: { name: '画面动作', tip: '身体与空间，适合追逃/场面',
    text: '【画面动作】以身体和空间为主：站位、距离、重心、手上的东西、光线和声音。'
        + '内心用极短的一两处点到即止，靠动作本身传递情绪。' },
  talk:  { name: '对话交锋', tip: '谈判/试探/揭底',
    text: '【对话交锋】主体由对话推动，让人物打断、绕圈、答非所问、留半句不说。'
        + '叙述只做最小限度的动作与神情标注，不替读者解释谁在想什么。' },
  scheme:{ name: '权谋算计', tip: '布局、试探、反制',
    text: '【权谋算计】让读者看得见棋盘：谁想要什么、谁手里有什么筹码、这一步换来什么。'
        + '算计要落在具体的人和事上，不写“他运筹帷幄”这类空话。'
        + '主角的谋划要有【被识破的风险】，对手不能是笨蛋。' },
  thrill:{ name: '悬疑压迫', tip: '追查/被追/时间紧迫',
    text: '【悬疑压迫】制造持续的压迫感：时间在走、包围在收拢、知情的人在减少。'
        + '每隔一段抛一个新的不对劲，且不要立刻解释。让读者比主角早半步察觉危险。' },
  payoff:{ name: '爽点打脸', tip: '亮本事/翻盘/立威',
    text: '【爽点打脸】要有【可感的翻转时刻】：之前被轻视/被压制，此刻用具体的本事翻过来。'
        + '爽点必须建立在前文的铺垫上（他早就看出来了、他一直在忍），不是天降神力。'
        + '打脸写旁人的反应比写主角的姿态更有效。' },
  slow:  { name: '铺陈氛围', tip: '放慢节奏、渗出时代感',
    text: '【铺陈氛围】放慢节奏，允许更长的句子和成段的环境描写，让时代和处境从细节里渗出来。'
        + '但仍须有一条明确的推进线，不能变成风景明信片。' },
};

// 侧重可【多选】——一章本来就可以既有心理、又有打戏、还有算计。
// 传入 'inner,fight' 这样的逗号串，或数组。选了多项时额外提醒模型怎么配比，
// 否则它容易平均用力、每样都浅尝辄止，反而比单选还糟。
export function styleSlantSection(slant) {
  const ids = (Array.isArray(slant) ? slant : String(slant || '').split(','))
    .map(x => x.trim()).filter(x => x && STYLE_SLANTS[x]);
  if (!ids.length) return '';
  const parts = ids.map(id => '· ' + STYLE_SLANTS[id].text);
  const head = ids.length === 1
    ? '\n【本章侧重】'
    : `\n【本章侧重（共 ${ids.length} 项，都要写到）】：不要平均用力——`
      + '挑其中一项作为这一章的主干撑起篇幅，其余的穿插进主干里，各自至少有一个成规模的段落，'
      + '而不是每样点一句就过。几项之间要互相咬合（比如打斗中途的算计、亲近之后的忌惮），别写成互不相干的板块。\n';
  return head + '\n' + parts.join('\n') + '\n';
}

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
export async function writeChapterFromIntent({ book, model, intent, useLastEnding = true, redoLast = false, slant = '', romance = null, cfg, onLog = () => {} }) {
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
    voicePrint(book),            // 文风全部来自范本+手法卡，代码不夹带审美
    styleSlantSection(slant),    // 侧重是作者本章主动选的，属于"作者的意图"，不是"我的审美"
    chapterRomanceSection(book.romance, romance),
    mechanics({ card: true }),
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
  const volDir = volumeDirName(book.dir, volNum);   // 复用已存在的卷目录（可能带卷名），别硬拼「卷NN」分叉出第二个
  const rel = saveChapter(book, volDir, num, ch.title, ch.body);
  const row = { num, title: ch.title, volDir, rel, words: hanziCount(ch.body) };
  try { appendIndex(book, [row]); } catch (e) { onLog({ level: 'warn', msg: '更新 chapter_index.md 失败：' + e.message }); }
  onLog({ level: 'act', msg: `  ✓ 第 ${num} 章《${ch.title}》已落盘（约 ${row.words} 字）→ ${rel}` });
  return { num, title: ch.title, body: ch.body, rel, words: row.words, model };
}

// ===== ③ 单章重写：挑任意一章，换模型 / 改章名 / 重新给情节 =====
// 为什么单独做：现有「♻️ 重写」是【按范围】的（001-008 / 卷01），固定用书的模型开 CLI 窗口，换不了模型。
// 而实际最常见的需求恰恰是反过来的——某一章写崩了（小模型尤其常见），想【就这一章】换个更强的模型重来，
// 而且往往还想顺手改掉章名、或者干脆重新规定这一章该发生什么。三件事凑在一起才是完整的「重写」。
//
// plot 为空 → 保持原情节，只提升文笔；plot 有内容 → 按作者给的新情节重写这一章（这才是"重新注入"）。
export async function rewriteChapter({
  book, rel, model, note = '', plot = '', newTitle = '', titleMode = 'keep',
  slant = '', romance = null, polish = false, critic = '', cfg, onLog = () => {},
}) {
  book = getBook(book.slug) || book;
  const abs = path.join(book.dir, rel);
  if (!fs.existsSync(abs)) throw new Error('找不到这一章：' + rel);

  const base = path.basename(abs);
  const num = parseInt((base.match(/^(\d{1,4})/) || [])[1] || '0', 10);
  const oldTitle = base.replace(/\.txt$/i, '').replace(/^\d{1,4}/, '');
  if (!num) throw new Error('这个文件不是章节正文（文件名要以章号开头）：' + base);

  // 章名三种处理：
  //   keep   保持原名（改完内容还叫原来那个名）
  //   manual 用作者填的新名
  //   auto   让模型【根据它重写出来的内容】自己起一个——重写后情节和重点都变了，
  //          沿用旧名或让作者盲填其实都别扭，由写的人起名最贴。
  // auto 时 title 先留空，等解析出正文再从 <<<CHAPTER 标题=…>>> 里取。
  const cleanTitle = (t) => String(t || '').trim().replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 40);
  const wantTitle = cleanTitle(newTitle);
  const mode = (titleMode === 'auto' || titleMode === 'manual') ? titleMode : 'keep';
  const autoTitle = mode === 'auto';
  const title = autoTitle ? '' : (mode === 'manual' && wantTitle ? wantTitle : oldTitle);

  const original = fs.readFileSync(abs, 'utf8').trim();
  const lo = book?.standards?.minChars || 3000;
  const hi = book?.standards?.targetCharsHi || 3600;
  const newPlot = String(plot || '').trim();

  // 上一章结尾：保持衔接。在同目录找 num-1 那一章——不能用 lastChapterTail（它取的是全书最后一章）。
  let prevTail = '';
  if (num > 1) {
    try {
      const dir = path.dirname(abs);
      const prev = fs.readdirSync(dir).find(f => /\.txt$/i.test(f)
        && parseInt((f.match(/^(\d{1,4})/) || [])[1] || '0', 10) === num - 1);
      if (prev) prevTail = fs.readFileSync(path.join(dir, prev), 'utf8').trim().slice(-1200);
    } catch {}
  }

  // auto 起名要避开全书已用的章名——本项目很在意章名全书唯一（自检闸会专门查重名）。
  const usedNames = autoTitle
    ? (recentChapterNames(book, 80).recent || []).filter(n => n && n !== oldTitle).slice(-40)
    : [];

  const prompt = [
    `你是资深中文网络小说作者。请【重写第 ${num} 章】。这一章已经写过一版，但作者不满意。`,
    `书：${bookGist(book)}。`,
    ``,
    `【这一章原来的内容（供你了解上下文；${newPlot ? '情节已被作者重新指定，下面这版只作参考，不必沿用' : '不要照抄它的文笔'}）】：`,
    original.slice(0, 4000),
    ``,
    newPlot
      ? `【作者重新指定的本章情节（最高优先，必须照做——与上面原内容冲突时，一律以这里为准）】：\n${newPlot}`
      : `【情节约束】：这一章在全书里的位置和作用不变——同样的情节节点、同样的人物、同样的结果，不要改剧情走向。要改的是【怎么写】：更具体的细节、更自然的对话、更好的节奏。`,
    note ? `\n【作者对这次重写的补充要求】：${note}` : '',
    autoTitle
      ? `\n【章名】：请你【根据自己重写出来的内容】另起一个章名——要具体、有钩子、能让人想点进来，`
        + `别用“风波”“变故”“重逢”这类万能词。原名《${oldTitle}》仅供参考，不必沿用。`
        + (usedNames.length ? `\n【已用章名（新名不得与这些重复，意思高度相近的也要错开）】：${usedNames.join('、')}` : '')
      : (mode === 'manual' && wantTitle
          ? `\n【章名】：作者已把本章章名改为《${title}》，请让内容与这个章名相称。`
          : `\n【章名】：保持《${title}》不变。`),
    ``,
    prevTail ? `【上一章结尾（衔接用，保持语气连续）】：\n${prevTail}\n` : '',
    voicePrint(book),            // 文风全部来自范本+手法卡，代码不夹带审美
    styleSlantSection(slant),
    chapterRomanceSection(book.romance, romance),
    mechanics({ card: true }),
    ``,
    `输出要求：`,
    `1. 约 ${lo}–${hi} 字，靠情节推进与细节写足，【严禁重复段落或原地绕圈凑字】。`,
    `2. 用固定分隔符包裹，标记单独成行，正文里不要出现 <<<CHAPTER 或 <<<END：`,
    `<<<CHAPTER 章号=${num} 标题=${autoTitle ? '你新起的章名' : title}>>>`,
    `（本章正文，仅正文，可含自然段换行；不要写“第X章”标题行、不要 markdown、不要作者旁白、不要解释）`,
    `<<<END>>>`,
    `3. 除这个带分隔符的章节块外，回复里不要有任何多余文字。`,
  ].filter(Boolean).join('\n');

  const mName = getModel(model)?.name || model;
  onLog({ level: 'act', msg: `重写第 ${num} 章《${oldTitle}》`
    + (autoTitle ? ' → 章名由 AI 按新内容重起' : (mode === 'manual' && wantTitle ? ` → 新章名《${title}》` : ''))
    + `（原 ${hanziCount(original)} 字，用 ${mName}${newPlot ? '，已重新指定情节' : ''}）…` });

  const out = await runCowrite(model, prompt, cfg, cwTimeout(model, 'chapter'));
  const ch = parseChapters(out, { onLog })[0];
  if (!ch) throw new Error(`${mName} 未按格式产出本章（可能被截断或跑偏）。可重试，或换个模型。`);

  // auto 模式：用模型给的章名。它没给或给了个空的就退回原名，别把文件写成没名字的。
  const finalTitle = autoTitle ? (cleanTitle(ch.title) || oldTitle) : title;

  // 多轮打磨：拿初稿再走一遍「挑刺→改」。多花一到两次调用，换修改层积出来的质感。
  let bodyText = ch.body;
  if (polish) {
    try {
      const pr = await auditChapter({ book, draft: bodyText, num, title: finalTitle, model, critic, prevTail, cfg, onLog });
      bodyText = pr.body;
    } catch (e) { onLog({ level: 'warn', msg: '  审计失败，保留初稿：' + (e.message || e) }); }
  }
  // ⚠️ 段落闸已停用：判据是反的。作者认可的样章有 53% 单行段、最长连续 10 行，
  // 这道闸会把【作者喜欢的文字】判为不合格打回重排。分段属于文风，交给范本管。
  // reflowChapter 保留为手动工具（作者自己觉得碎时用），不再自动拦截。
  ch.body = bodyText;

  const words = hanziCount(ch.body);
  if (words < lo * 0.5) {
    throw new Error(`${mName} 只写出 ${words} 字（目标 ${lo}–${hi}），太短没有替换价值。原文未改动，请重试或换个模型。`);
  }

  // 先备份原文再落盘——重写是破坏性操作，用户改坏了要能拿回来。
  try { fs.writeFileSync(abs + '.bak', original, 'utf8'); } catch {}

  let finalRel = rel;
  if (finalTitle !== oldTitle) {
    // 改名：重命名文件 + 同步 chapter_index.md 里那一行，否则索引会指向不存在的路径。
    const dir = path.dirname(abs);
    let name = `${String(num).padStart(3, '0')}${finalTitle}.txt`;
    let dst = path.join(dir, name);
    if (fs.existsSync(dst) && dst !== abs) { name = `${String(num).padStart(3, '0')}${finalTitle}_2.txt`; dst = path.join(dir, name); }
    fs.writeFileSync(dst, ch.body.endsWith('\n') ? ch.body : ch.body + '\n', 'utf8');
    if (dst !== abs) { try { fs.unlinkSync(abs); } catch {} }
    finalRel = path.relative(book.dir, dst).replace(/\\/g, '/');
    updateIndexRow(book, num, finalTitle, finalRel, onLog);
  } else {
    fs.writeFileSync(abs, ch.body.endsWith('\n') ? ch.body : ch.body + '\n', 'utf8');
  }

  onLog({ level: 'act', msg: `  ✓ 第 ${num} 章已重写（${hanziCount(original)} → ${words} 字）`
    + (finalTitle !== oldTitle ? `，章名改为《${finalTitle}》并已更新索引` : '') + `；原文备份在 ${path.basename(rel)}.bak` });

  return { num, title: finalTitle, oldTitle, rel: finalRel, words, before: hanziCount(original), body: ch.body, model, backup: rel + '.bak' };
}

// 改章名后同步索引里那一行（章名 + 路径）。找不到该行就补一行，别让索引和磁盘对不上。
function updateIndexRow(book, num, title, rel, onLog = () => {}) {
  const fp = path.join(book.dir, 'chapter_index.md');
  try {
    const cur = fs.readFileSync(fp, 'utf8');
    let hit = false;
    const next = cur.split(/\r?\n/).map((line) => {
      const m = line.match(/^\s*\|\s*(\d{1,4})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/);
      if (!m || parseInt(m[1], 10) !== num) return line;
      hit = true;
      return `| ${num} | ${title} | ${m[3].trim()} | ${rel} | 已写 |`;
    }).join('\n');
    if (!hit) { onLog({ level: 'warn', msg: `  索引里没有第 ${num} 章那一行，已跳过更新（可跑一次自检修复）` }); return; }
    fs.writeFileSync(fp, next.replace(/\s*$/, '') + '\n', 'utf8');
  } catch (e) {
    onLog({ level: 'warn', msg: '  更新 chapter_index.md 失败：' + (e.message || e) });
  }
}

// 段落呼吸闸：写完真的量一遍，太碎就打回让它【只重新分段、一个字不改】。
// 为什么要机器量而不是靠提示词：模型对"段落要短"这类单向指标必然滑到极端
// （实测 155 段 / 3307 字，46% 的段落不到 10 字，读起来像机关枪）。
// 提示词是软约束，尺子才是硬的。最多打回一次，别为了分段来回折腾。
// 【已删】enforceParagraphs —— 段落闸，把单行段太多判为不合格并打回重排。
// 判据是反的：作者认可的网文样章有 76% 的短段，会被它整章判废。零调用点，删。
// 段落密度现在由 pacing.refTargets() 从本书范本量，deslop 也按范本校准。

// 对【已经写好的章】单独重排段落：一个字不改，只并段。
// 这是个独立能力，不必跟重写绑在一起——存量章节大多只是分得太碎，
// 文字本身没问题，重写反而会把好句子改没。
export async function reflowChapter({ book, rel, model, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const abs = path.join(book.dir, rel);
  if (!fs.existsSync(abs)) throw new Error('找不到这一章：' + rel);
  const base = path.basename(abs);
  const num = parseInt((base.match(/^(\d{1,4})/) || [])[1] || '0', 10);
  const title = base.replace(/\.txt$/i, '').replace(/^\d{1,4}/, '');
  const original = fs.readFileSync(abs, 'utf8').trim();

  // 用本书范本当尺子，而不是写死的健康值（见 craft.paragraphHealth 的说明）
  const rt = refTargets(book.dir);
  const pref = rt ? { avgPara: rt.avgPara, tinyPct: null } : null;
  const h = paragraphHealth(original, pref);
  if (h.ok) {
    onLog({ level: 'info', msg: `第 ${num} 章段落已经健康（${h.paras} 段 / 平均 ${h.avgLen} 字），无需重排` });
    return { num, title, rel, changed: false, before: h, after: h };
  }
  onLog({ level: 'act', msg: `重排第 ${num} 章《${title}》：${h.paras} 段 / 平均 ${h.avgLen} 字 / ${h.tinyPct}% 是单行` });

  const out = await runCowrite(model, reflowInstruction(h, num, title) + '\n\n【正文】\n' + original,
    cfg, cwTimeout(model, 'chapter'));
  const re = parseChapters(out, { onLog })[0];
  if (!re) throw new Error('重排没按格式返回，原文未改动。可重试或换个模型。');

  const b = hanziCount(original), a = hanziCount(re.body);
  if (a < b * 0.9) throw new Error(`重排时把字改没了（${b} → ${a}），原文未改动。这一步只该动换行，请重试。`);

  const h2 = paragraphHealth(re.body, pref);
  try { fs.writeFileSync(abs + '.bak', original, 'utf8'); } catch {}
  fs.writeFileSync(abs, re.body.endsWith('\n') ? re.body : re.body + '\n', 'utf8');
  onLog({ level: 'act', msg: `  ✓ ${h.paras} 段 → ${h2.paras} 段，平均 ${h.avgLen} → ${h2.avgLen} 字（字数 ${b}→${a}，原文已备份 .bak）` });
  return { num, title, rel, changed: true, before: h, after: h2, words: a };
}

// ===== 多轮打磨：初稿 → 挑刺 → 改 =====
// 人写一章是【写完再改】，每一遍改不同的东西；一次成稿不可能有修改层积出来的质感。
// 这里做最小可用的两轮：让【另一个视角】专挑"哪里像 AI 写的"，再让原模型按意见改。
//
// 关键在挑刺那一轮的提示词——不能问"写得好不好"（模型会一通夸），
// 要问【具体哪一句、为什么像机器写的、怎么改】，逼它给出可执行的修改点。

// 连续性审计：初稿 → 只查连续性 → 最小改动修订。
//
// 【为什么从"挑文笔"改成"挑连续性"】
// 原来这一轮让模型挑文笔毛病。那是审美：机器判不好，而且它挑出来的意见
// 会把文字往更"正确"也更死板的方向推——越打磨越像标准答案，正是作者说的"僵硬"。
// 而连续性是客观的：人死没死、伤好没好、他知不知道这件事、兵有多少、走了几天——
// 每一条都能对照已知状态判定真假。机器擅长记账，就让它记账。
async function auditChapter({ book, draft, num, title, model, critic = '', prevTail = '', cfg, onLog = () => {} }) {
  const criticModel = critic && getModel(critic) ? critic : model;
  const cName = getModel(criticModel)?.name || criticModel;

  let ledger = '';
  try { ledger = fs.readFileSync(path.join(book.dir, 'continuity_ledger.md'), 'utf8'); } catch {}

  onLog({ level: 'act', msg: `  连续性审计：让 ${cName} 对照已知状态核一遍…` });
  const notes = await runCowrite(
    criticModel,
    auditPrompt({ chapterText: draft.slice(0, 12000), prevTail, ledger, num }),
    cfg, cwTimeout(criticModel, 'idea'),
  );
  const clean = String(notes || '').trim();
  if (!clean || clean.length < 20 || /^无[。.]?$/.test(clean)) {
    onLog({ level: 'info', msg: '  连续性无问题' });
    return { body: draft, notes: '', fixed: false };
  }
  const n = (clean.match(/·/g) || []).length || '若干';
  onLog({ level: 'warn', msg: `  查出 ${n} 处连续性问题，按最小改动修…` });

  const NL = String.fromCharCode(10);
  const out = await runCowrite(model, fixPrompt({ notes: clean, num, title }) + NL + NL + '【正文】' + NL + draft,
    cfg, cwTimeout(model, 'chapter'));
  const ch = parseChapters(out, { onLog })[0];
  if (!ch || hanziCount(ch.body) < hanziCount(draft) * 0.85) {
    onLog({ level: 'warn', msg: '  修订失败或改动过大（应是最小改动），保留初稿' });
    return { body: draft, notes: clean, fixed: false };
  }
  onLog({ level: 'act', msg: `  ✓ 已修（${hanziCount(draft)} → ${hanziCount(ch.body)} 字）` });
  return { body: ch.body, notes: clean, fixed: true };
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
  const volDir = volumeDirName(book.dir, volNum);   // 复用已存在的卷目录（可能带卷名），别硬拼「卷NN」分叉出第二个
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
export async function writeChapterInWindow({ book, model, intent, useLastEnding = true, redoLast = false, romance = null, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const it = String(intent || '').trim();
  if (!it) throw new Error('请先写「本章我的要求」——共创以你的主意为主。');
  if (!isCowriteWindowModel(model)) throw new Error(`「${getModel(model)?.name || model}」没有可执行文件，开不了可见窗口。`
    + `窗口模式要能在终端里跑起来的 CLI（claude / codex / gemini / qwen）。`
    + `用 API/本地模型的话，共创会走【无头模式】：同样按你的要求写这一章并落盘，只是看不到窗口里实时打字。`);
  if (redoLast) { const del = removeLastChapter(book); if (del) onLog({ level: 'info', msg: `重写：已移除刚才的第 ${del} 章` }); }

  const before = bookStats(book).chapters;
  const num = (lastChapterTail(book, 0).num || 0) + 1;
  const instruction = buildWindowChapterInstruction(book, num, it, useLastEnding);
  const instrWithRomance = instruction + '\n\n' + chapterRomanceSection(book.romance, romance);

  // 开窗或复用已开窗口（AI 还在跑就注入；否则开一个新的可见窗口，autopilot 关掉=只写这一章）
  const alive = await sessionAgentAlive(book.slug, cfg).catch(() => false);
  if (alive) {
    onLog({ level: 'act', msg: `共创窗口：向已开的 AI 窗口注入第 ${num} 章要求（你可在窗口里看它写）…` });
    await sendToBook(book.slug, instruction, cfg);
  } else {
    onLog({ level: 'act', msg: `共创窗口：打开可见 Unterm 窗口（${getModel(model)?.name || model}）并注入第 ${num} 章要求（你能看着它写）…` });
    // attachAutopilot + autopilotConfirmOnly：挂一个【只自动确认提问、绝不自动续写】的极简 autopilot，
    // 这样 AI 遇到"是否/信任目录/审批"等提问会被自动确认、不会卡住，但写完这一章就停、不自动写下一章。
    await startWriting({ book, model, instruction: instrWithRomance, cfg, attachAutopilot: true, autopilotConfirmOnly: true, onLog: (e) => onLog({ ...e }) });
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
  const volDir = volumeDirName(book.dir, volNum);   // 复用已存在的卷目录（可能带卷名），别硬拼「卷NN」分叉出第二个
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
export async function writeChaptersFromPlot({ book, model, plot, useLastEnding = true, romance = null, cfg, onLog = () => {} }) {
  book = getBook(book.slug) || book;
  const pt = String(plot || '').trim();
  if (!pt) throw new Error('请先写「这一段的故事情节」——本书没有大纲，剧情以你给的这段为准。');
  if (!isCowriteWindowModel(model)) throw new Error(`「${getModel(model)?.name || model}」开不了可见窗口，这个功能需要 CLI 模型（claude / codex / gemini / qwen）。`);

  const before = bookStats(book).chapters;
  const startNum = (lastChapterTail(book, 0).num || 0) + 1;
  let instruction = buildPlotBatchInstruction(book, startNum, pt, useLastEnding);
  // 本批的感情线尺度：作者可临时提高/降低，不改全书档位（初吻、独处那一夜这类章需要临场拿捏）
  instruction += '\n\n' + chapterRomanceSection(book.romance, romance);

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
      // 先关 pane 再杀窗口进程：0.65 起 agent 不是窗口进程的子进程，只杀窗口会留下一个还在接着写的 agent
      if (s?.pid) {
        const closed = await closeWindow({ id: s.instanceId, mcp_port: s.mcp_port, auth_token: s.auth_token, pid: s.pid, pane: s.pane });
        removeSession(book.slug);
        // 据实报告：收窗失败要说出来，别让作者以为窗口收干净了（假成功会让空窗口一直堆积）
        onLog(closed
          ? { level: 'act', msg: '这一批写完 → 已收起窗口（下一段情节会重新开窗，避免它自己接着写）' }
          : { level: 'warn', msg: `⚠ 收窗未成功：窗口进程 ${s.pid} 仍在（unterm 版本/权限问题）。请手动关掉它，否则会越开越多。` });
      }
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
  // 写后节奏体检：共创模式下作者本来就在逐段把关，所以这里只量指标 + 出报告，不自动退回改稿——
  // 要不要重写这一段由作者当场定（结论同时落到 reviews/节奏体检-*.md）。
  let pacingFix = null;
  try {
    const std = { ...(book.standards || {}), hardMax: cfg?.pacing?.hardMax || 6000 };
    const g = pacingGate(book.dir, startNum, endNum, onLog, { std });
    pacingFix = g.instruction;
    // 事故级（章长/文风机械等）就地退回自纠：原来这里只出报告不退回，理由是"共创模式作者会把关"——
    // 实测那等于没人管。《重生94》053–054 是补完文风上限后写的第一批，短句 0.48、数目每 85 字一个、
    // 把字句 0.091，比旧规范还差。**比例类要求靠 prompt 天生无效**（模型没法边写边统计自己的短句占比），
    // 只有写完量出来、带着具体条数退回，才改得动。窗口还活着就直接注入。
    if (pacingFix && cfg?.pacing?.autofix !== false) {
      const alive = await sessionAgentAlive(book.slug, cfg).catch(() => false);
      if (alive) {
        onLog({ level: 'act', msg: '⛔ 本批未过节奏/文风闸 → 已把【带具体条数的】自纠指令注入窗口，改完再继续' });
        await sendToBook(book.slug, pacingFix, cfg);
      } else {
        onLog({ level: 'warn', msg: '⛔ 本批未过节奏/文风闸，但写作窗口已关——自纠指令见 reviews/节奏体检-*.md' });
      }
    }
  } catch (e) { onLog({ level: 'warn', msg: '节奏体检跳过：' + e.message }); }
  onLog({ level: 'act', msg: `  ✓ 这一段已写成 ${chapters.length} 章（第 ${startNum}–${endNum} 章，约 ${chapters.reduce((s, c) => s + c.words, 0)} 字）` });
  return { chapters, startNum, endNum, count: chapters.length, model, windowMode: true, pacingFix: pacingFix || null };
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
