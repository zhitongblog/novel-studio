// 带字封面：让 ChatGPT/Gemini 一次画出【含书名与作者】的成品封面，并用视觉模型校验字形。
//
// 【为什么推翻了原来的设计】原来的路子是：模型只出干净无字底图（cover_bg.png），
// 书名作者由前端 canvas 叠上去（ui/app.js 的 drawCoverText）。imagegen.mjs 顶部那条
// 注释写得很清楚，当初这么做是因为模型画文字会糊成乱码假字。
//
// 但 canvas 那一层实在太朴素——居中、宋体、固定 30% 高度、一个投影，就这些。
// 没有字底压暗块、没有字距、没有竖排（中文网文封面的主流版式）、没有任何排版设计。
// 底图再好，出来也只是"素材 + 字"。2026-09-24 作者的原话：合成的图片有点差劲。
//
// 【所以改成让模型画字，但不许盲信】现代模型（gpt-image-1 / Gemini 出图）中文字形
// 比当年强得多，可仍是最难的一档：错字、缺笔、多一撇、把「吕」写成「呂」都可能。
// 而封面上的书名必须一字不差——番茄那边还要跟书名对得上。
// 所以配一道【字形校验】：把成品图交给视觉模型，让它【原样抄下】看见的字，
// 再跟真书名比对。对不上就重试，连试几次都不行，退回无字底图 + canvas 老路。
//
// 【校验的关键设计：绝不能把正确答案告诉校验模型】
// 如果提示词里写「请确认封面上的书名是不是《重生三国，我吕布杀出一片天》」，
// 模型会直接顺着答"是"——那不是校验，是复读。所以只让它抄它看见的东西，
// 比对在代码里做。看不清的字要求写成「？」，宁可判失败也不许猜。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';

// ── 一、带字封面的提示词 ──────────────────────────────────────────
// 与 buildChatGptCoverPrompt（无字版）并列。差别不只是"把字加回来"：
// 版式也要一起交代，否则模型会把字丢在角落里，比 canvas 还难看。
export function buildCoverPromptWithText(book, { title, author, note } = {}) {
  const t = String(title || book.title || '').trim();
  const a = String(author || '').trim();
  const bits = bibleBits(book);
  const parts = [
    '请生成一张**竖版 3:4 的中文网络小说封面成品图**（不是插画素材，是可以直接上架的成品封面）。',
    '',
    '【画面内必须出现的文字，一字不差】',
    `书名：${t}`,
    a ? `作者：${a}` : '',
    '',
    '⚠️ 这两行字必须【逐字准确】地画进画面里：不许错字、不许缺笔、不许改写、不许用近似字替代、',
    '不许简繁混用、不许自行增删标点。若书名里有逗号，照原样画出来。',
    '⚠️ 除了上面列出的文字，画面里【不要出现任何其它文字】——不要英文、不要拼音、不要出版社名、',
    '不要宣传语、不要落款、不要水印、不要页码。',
    '',
    '【排版要求】',
    '- 书名要做成中文网文封面那种**有设计感的标题字**：字重厚实、有存在感，',
    '  可用书法体/黑体加粗/毛笔字，按题材气质选；字底该压暗就压暗，保证字在图上清晰可读。',
    '- 书名放在上三分之一或沿竖排走一侧（中文竖排是网文封面的常见版式，按画面构图择优）。',
    '- 作者名字号明显小于书名，放在下方或书名侧下，不要喧宾夺主。',
    '- 文字与人物不许互相遮挡关键部位（脸、眼睛）。',
    '',
    '【画面内容】',
    book.genre ? ('题材：' + book.genre + '。') : '',
    bits.era ? ('时代/场景：' + bits.era + '。') : '',
    bits.hero ? ('主角形象：' + bits.hero + '。') : '主角是一位气质突出的中国人（东亚面孔）。',
    (book.style && book.style.name) ? ('画面气质贴合文风：' + book.style.name + '。') : '',
    '人物必须是【中国人、东亚面孔】，服饰与场景符合该时代的中国，国风审美；',
    '电影级戏剧光影、写实厚重的数字绘画、主角神态突出、有故事张力。',
    note ? ('\n【上一版的问题，这次务必避免】\n' + note) : '',
  ].filter(Boolean);
  return parts.join('\n');
}

function bibleBits(book) {
  let era = '', hero = '';
  try {
    const bible = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8');
    const em = bible.match(/时代\s*\/?\s*世界观[：:]\s*([^\n]+)/);
    if (em) era = em[1].replace(/[（(].*$/, '').trim().slice(0, 80);
    const hm = bible.match(/(?:^|\n)[-\s]*主角[：:]\s*([^\n]+)/);
    if (hm) hero = hm[1].replace(/[（(].*$/, '').trim().slice(0, 80);
  } catch {}
  return { era, hero };
}

// ── 二、比对用的归一化 ────────────────────────────────────────────
// 只抹掉【不影响读者认字】的差异：空白、书名号、全半角标点的写法。
// 【绝不】抹掉汉字本身的差异——错一个字就是错，那正是这道校验存在的理由。
const PUNCT_MAP = { '，': ',', '。': '.', '：': ':', '；': ';', '！': '!', '？': '?', '、': ',' };
export function normalizeCoverText(s) {
  return String(s || '')
    .replace(/[《》「」『』\[\]【】"'"'\s]/g, '')
    .replace(/[，。：；！？、]/g, (m) => PUNCT_MAP[m] || m)
    .trim();
}

// 两串是否算同一个书名。长度短的书名容错要更严——三个字错一个就是 33%。
export function sameCoverText(a, b) {
  const x = normalizeCoverText(a), y = normalizeCoverText(b);
  if (!x || !y) return false;
  return x === y;
}

// ── 三、字形校验：让视觉模型把封面上的字【原样抄下来】 ──────────────
// 安全：封面图是模型生成的不可信输入，claude 只放开 Read（照搬 refstyle.mjs 的做法），
// 不给 Bash/Write，也绝不用 --dangerously-skip-permissions。
export function readCoverText(file, cfg, { model } = {}) {
  if (!fs.existsSync(file)) throw new Error('封面文件不存在：' + file);
  const prefer = (model === 'gemini') ? ['gemini', 'claude'] : ['claude', 'gemini'];
  const visId = prefer.find((id) => { const m = getModel(id); return m && m.bin; });
  if (!visId) throw new Error('需要 claude 或 gemini CLI 做封面字形校验（当前都不可用）');
  const m = getModel(visId);
  const env = { ...process.env };
  if (cfg && cfg.enableProxy) {
    const px = proxyUrl();
    if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; }
  }
  const args = visId === 'claude' ? ['-p', '--allowedTools', 'Read'] : ['-p'];
  // 【不给正确答案】这条是本模块的命门：一旦提示词里出现真书名，模型就会顺着复读，
  // 校验立刻退化成橡皮图章。所以只描述任务，不提供答案。
  const prompt = [
    `这是一张书籍封面图（就在当前目录：./${path.basename(file)}）。请读图，把封面上【实际印着的文字】原样抄下来。`,
    '',
    '严格要求：',
    '- 【照抄】你看到的字，一个字都不要改、不要猜、不要补全、不要修正你认为的错别字。',
    '- 某个字看不清、缺笔、或者根本不是常用汉字，就在那个位置写一个「？」。',
    '- 不要翻译、不要解释、不要评价这张封面好不好看。',
    '',
    '严格按这两行格式输出，没有就留空：',
    '书名=<照抄封面上最大的那行标题>',
    '作者=<照抄封面上的作者署名>',
  ].join('\n');
  const r = spawnSync(m.bin, args, {
    encoding: 'utf8', timeout: 180000, input: prompt,
    cwd: path.dirname(file), env, maxBuffer: 8 * 1024 * 1024, shell: true, windowsHide: true,
  });
  if (r.error) throw new Error(m.name + ' 调用失败：' + r.error.message);
  const raw = (r.stdout || '') + '\n' + (r.stderr || '');
  return { ...parseReadBack(raw), visionModel: visId, raw: raw.slice(-800) };
}

export function parseReadBack(raw) {
  const clean = String(raw || '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const t = clean.match(/书名\s*[=＝：:]\s*([^\n]*)/);
  const a = clean.match(/作者\s*[=＝：:]\s*([^\n]*)/);
  return { title: t ? t[1].trim() : '', author: a ? a[1].trim() : '' };
}

// 一次完整校验：读回来 → 比对 → 给出能直接喂回提示词的「问题描述」。
export function verifyCoverText(file, { title, author } = {}, cfg, opts = {}) {
  // opts.read：注入点，测试用；不传就真去调视觉模型
  const got = opts.read ? opts.read(file) : readCoverText(file, cfg, opts);
  const titleOk = sameCoverText(got.title, title);
  // 作者没填就不校验它；填了就必须对
  const authorOk = !String(author || '').trim() || sameCoverText(got.author, author);
  const problems = [];
  if (!titleOk) {
    problems.push(got.title
      ? `封面上的书名画成了「${got.title}」，应该是「${title}」——逐字重画，不许错字缺笔。`
      : `封面上根本没读到书名，应该画上「${title}」。`);
  }
  if (!authorOk) {
    problems.push(got.author
      ? `作者署名画成了「${got.author}」，应该是「${author}」。`
      : `封面上没读到作者署名，应该画上「${author}」。`);
  }
  if (/？/.test(got.title) || /\?/.test(got.title)) {
    problems.push('书名里有看不清或缺笔的字（校验时被标成了「？」），把字画清楚。');
  }
  return { ok: titleOk && authorOk && problems.length === 0, read: got, problems, note: problems.join('\n') };
}

// ── 四、编排：出图 → 校验 → 重试 → 兜底 ────────────────────────────
// 成功：带字成品落 cover.png，返回 { ok:true, file, attempts, read }。
// 失败：退回老路（无字底图 cover_bg.png + 前端 canvas 叠字），返回 { ok:false, fallback:true }。
//
// 【为什么把失败原因喂回下一次提示词】空重试等于摇骰子。把「上一版把『吕』画成了『呂』」
// 这句话带进去，模型才知道要盯哪个字。verifyCoverText 的 note 就是为此准备的。
export async function generateCoverWithText(book, {
  engine = 'chatgpt', profilePath, onLog, title, author, attempts = 3, cfg, visionModel,
  genWithText, genPlain, verify,      // 注入点：测试用；不传就用真驱动 / 真校验
} = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  const want = { title: String(title || book.title || '').trim(), author: String(author || '').trim() };
  const out = path.join(book.dir, 'cover.png');

  const runWithText = genWithText || (async (prompt) => {
    const mod = engine === 'gemini'
      ? await import('./covergen_gemini.mjs') : await import('./covergen_web.mjs');
    const fn = engine === 'gemini' ? mod.generateCoverViaGemini : mod.generateCoverViaChatGPT;
    return fn(book, { prompt, profilePath, onLog, outFile: out });
  });

  let note = '';
  const tried = [];
  for (let i = 1; i <= attempts; i++) {
    log(`第 ${i}/${attempts} 次：让${engine === 'gemini' ? ' Gemini ' : ' ChatGPT '}画带字封面…`, 'act');
    const prompt = buildCoverPromptWithText(book, { ...want, note });
    try {
      await runWithText(prompt);
    } catch (e) {
      log(`第 ${i} 次出图失败：${e.message}`, 'warn');
      tried.push({ attempt: i, error: e.message });
      continue;
    }
    log('出图完成，正在校验封面上的字…');
    let v;
    try {
      v = verify ? verify(out, want) : verifyCoverText(out, want, cfg, { model: visionModel });
    } catch (e) {
      // 校验本身跑不起来（claude/gemini CLI 不可用）：不能假装通过，也不该判模型的错
      log('字形校验无法进行：' + e.message, 'warn');
      return { ok: false, file: out, attempts: i, verifyUnavailable: true, reason: e.message };
    }
    tried.push({ attempt: i, read: v.read && { title: v.read.title, author: v.read.author }, ok: v.ok });
    if (v.ok) {
      log(`✅ 字形校验通过（视觉模型读到：${v.read.title}）`, 'act');
      return { ok: true, file: out, attempts: i, read: v.read, tried };
    }
    log(`✖ 第 ${i} 次字形不对：${v.problems.join('；')}`, 'warn');
    note = v.note;
  }

  // 连试 attempts 次都不行 → 退回老路：无字底图 + canvas 叠字
  log(`${attempts} 次都没把字画对，退回「无字底图 + 叠字」的老路`, 'warn');
  try { fs.unlinkSync(out); } catch {}
  const runPlain = genPlain || (async () => {
    const mod = engine === 'gemini'
      ? await import('./covergen_gemini.mjs') : await import('./covergen_web.mjs');
    const fn = engine === 'gemini' ? mod.generateCoverViaGemini : mod.generateCoverViaChatGPT;
    return fn(book, { profilePath, onLog });   // 不传 prompt/outFile = 老的无字底图流程
  });
  const bg = await runPlain();
  return { ok: false, fallback: true, attempts, tried, bg };
}
