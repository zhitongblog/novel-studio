// AI 立项：用所选模型非交互生成候选书名，并构造"全卷大纲都搭好再开写"的立项指令。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getModel, detectAll } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { STYLES, getStyle } from './styles.mjs';

// runModelOnce 能非交互驱动的本地 CLI（一次性喂 prompt 走 stdin 取文本）。trae 用法不同(run 子命令)，不在此列。
const CLI_GEN_PREF = ['codex', 'gemini', 'qwen', 'claude'];

// 把「用于文本生成的模型」解析成一个真正能本地 spawn 的 CLI：
// 网页版模型(kind:'web')/无 bin 的模型不能 spawn（会 "file argument must be string, received undefined"）——
// 立项/书名/简介/文风这些【元任务】改用一个可用的本地 CLI 跑（正文才用网页版）。返回 null=无可用 CLI。
export function resolveGenModel(model) {
  const m = getModel(model);
  if (m && m.kind !== 'web' && m.bin && CLI_GEN_PREF.includes(m.id)) return m.id; // 本身就是可跑的生成 CLI
  const avail = detectAll().filter(x => x.available && x.kind !== 'web' && x.bin).map(x => x.id);
  return CLI_GEN_PREF.find(id => avail.includes(id)) || null;
}

// 选"附带文本生成"(简介/封面提示词兜底)用的模型：写作模型是 claude 时自动换 codex/gemini，
// 既满足"claude 不跑这些杂活"的要求，也把 claude 额度留给正文写作。网页版模型不能跑本地生成 → 也换 CLI。
export function pickAuxModel(bookModel, cfg) {
  const bm = getModel(bookModel);
  if (bm && bm.kind === 'web') return resolveGenModel(bookModel) || 'codex';
  const avail = detectAll().filter(m => m.available && m.kind !== 'web' && m.bin).map(m => m.id);
  if (bookModel && bookModel !== 'claude' && avail.includes(bookModel)) return bookModel;
  const alt = ['codex', 'gemini'].find(id => avail.includes(id));
  return alt || bookModel || 'codex';
}

// 把模型输出清洗成"一段约150字的纯中文简介"：先砍掉被回显的 prompt，再去引导语/引号/空白。
function cleanSynopsis(text) {
  let t = String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // 去 ANSI/控制码防乱码
    .replace(/```[\s\S]*?```/g, ' ');
  // codex exec 等常把指令原样回显，粘在简介后面 → 在回显 prompt 的标志处截断（位置 >40 才截，避免误伤开头）。
  const cut = t.search(/你是资深网文编辑|为下面这本小说写一段|硬性要求[：:]|小说信息[：:]/);
  if (cut > 40) t = t.slice(0, cut);
  const META = /^(简介|内容简介|文案|以下|这是|好的|输出|note|here|小说信息|书名[：:]|题材[：:]|文风[：:])/i;
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !META.test(l) && !/^[#>\-*]/.test(l));
  const cand = lines.filter(l => (l.match(/[一-鿿]/g) || []).length >= 8);
  let s = (cand.length ? cand.join('') : lines.join('')).trim();
  s = s.replace(/^[「『（("'\s]+|[」』）)"'\s]+$/g, '').replace(/^(简介|内容简介|文案)[：:]\s*/, '').replace(/\s+/g, '').trim();
  if (s.length > 240) s = s.slice(0, 230) + '…';
  return s;
}

// 生成一段约150字的中文简介/推广文案（写作模型是 claude 时自动换 codex/gemini 来跑）。
export function generateSynopsis(book, cfg) {
  let bible = '';
  try { bible = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8').slice(0, 3000); } catch {}
  const ground = bible || [book.title && '书名：' + book.title, book.genre && '题材：' + book.genre].filter(Boolean).join('\n');
  const model = pickAuxModel(book.model, cfg);
  const prompt =
    `你是资深网文编辑。为下面这本小说写一段【中文简介/推广文案】，用于发布到网文平台、分享给读者。\n` +
    `硬性要求：①长度 150 字左右（130–170 字）；②一段话，不分段、不用列表；③点出核心卖点、主角处境与主要冲突，留一个悬念钩子；④不剧透结局；⑤不要出现"本书/简介/作者/读者/爽点/大纲"等元词，也不要任何引导语；⑥只输出简介正文本身，不要解释、不要标题、不要加引号。\n` +
    `小说信息：\n${ground}`;
  const out = runModelOnce(model, prompt, cfg, 120000) || '';
  return { synopsis: cleanSynopsis(out), model };
}

// 非交互跑一次模型，拿文本输出
function runModelOnce(model, prompt, cfg, timeoutMs = 120000) {
  // 网页版/无 bin 模型不能本地 spawn → 解析到一个可用的本地生成 CLI（立项/书名/简介等元任务）
  const useId = resolveGenModel(model);
  if (!useId) {
    throw new Error('没有可用于「立项 / 书名 / 简介」等生成的本地 CLI 模型。网页版模型只能写正文、不能跑这些元任务——'
      + '请先装一个 CLI（如 qwen / gemini / codex），或在上一步用「✍️ 我自己起名（跳过 AI 建议）」直接立项。');
  }
  const m = getModel(useId);
  const env = { ...process.env };
  if (cfg?.enableProxy) {
    const px = proxyUrl();
    if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; }
  }
  // prompt 走 stdin（避免参数里 JSON 双引号/中文在 Windows cmd 下的引号地狱）；
  // shell:true 让 Windows 能解析 npm 的 .cmd shim（codex/claude/gemini/qwen 都是 shim）。
  let args;
  if (useId === 'codex') args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  else if (useId === 'claude') args = ['-p'];
  else args = ['-p']; // gemini / qwen（gemini-cli 分支，同样 -p + stdin）
  const r = spawnSync(m.bin, args, {
    encoding: 'utf8', timeout: timeoutMs, input: prompt, cwd: os.tmpdir(),
    env, maxBuffer: 8 * 1024 * 1024, shell: true, windowsHide: true,
  });
  if (r.error) throw new Error(m.name + ' 调用失败：' + r.error.message);
  return (r.stdout || '') + '\n' + (r.stderr || '');
}

// 从模型输出里抽取候选数组。先试严格 JSON，失败则用容错正则
// （LLM 常在简介里塞未转义的双引号，破坏 JSON）。
function extractJsonArray(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const m = text.match(/\[\s*{[\s\S]*?}\s*\]/);
  if (m) candidates.push(m[0]);
  for (const c of candidates) {
    try { const v = JSON.parse(c.trim()); if (Array.isArray(v) && v.length) return v; } catch {}
  }
  // 容错：逐对抽取 title/premise（premise 里允许内部双引号）
  const out = [];
  const re = /"title"\s*:\s*"([^"]+?)"\s*,\s*"premise"\s*:\s*"([\s\S]*?)"\s*}/g;
  let g;
  while ((g = re.exec(text))) out.push({ title: g[1], premise: g[2] });
  if (out.length) return out;
  // 再退一步：只抽 title
  const tt = [];
  const rt = /"title"\s*:\s*"([^"]+?)"/g;
  while ((g = rt.exec(text))) tt.push({ title: g[1], premise: '' });
  return tt.length ? tt : null;
}

// 生成 3 个候选书名（含一句话简介）
export async function proposeTitles({ theme, words, model }, cfg) {
  const prompt =
    `你是资深网文主编。请据下面的题材，生成 3 个适合该题材的中文网文书名，各配一句话简介。\n` +
    `题材：${theme}\n目标总字数：${words || '长篇'}\n` +
    `只输出严格 JSON 数组，不要任何多余文字、不要 markdown 代码块。` +
    `简介里【不要使用英文双引号】，需要引用时用中文引号「」。格式：` +
    `[{"title":"书名","premise":"一句话简介"},{"title":"...","premise":"..."},{"title":"...","premise":"..."}]`;
  const out = runModelOnce(model, prompt, cfg, 120000);
  const arr = extractJsonArray(out);
  if (!arr || !arr.length) {
    const e = new Error('AI 返回未能解析为书名候选，请重试或换模型');
    e.raw = out.slice(-600);
    throw e;
  }
  return arr.slice(0, 3).map(x => ({ title: String(x.title || '').trim(), premise: String(x.premise || '').trim() }))
    .filter(x => x.title);
}

// AI 据题材/故事线，从预设文风里推荐最合适的一个（含理由），并可给一条本书专属的微调建议。
export async function recommendStyle({ theme, model }, cfg) {
  const list = STYLES.map(s => `${s.id}：${s.name}（${s.short}）`).join('；');
  const prompt =
    `你是资深网文主编。下面是一本书的题材/故事线，请从给定的文风预设里挑一个【最合适】的，并给一句话理由，` +
    `再补一句"本书专属的文风微调建议"。\n题材：${theme}\n可选文风：${list}\n` +
    `只输出严格 JSON，不要多余文字、不要双引号嵌套（需要引用用「」）：` +
    `{"id":"预设id","reason":"为什么最合适","tweak":"本书专属微调建议"}`;
  const out = runModelOnce(model, prompt, cfg, 120000);
  // 解析（容错）
  let id, reason = '', tweak = '';
  const j = (() => { try { const m = out.match(/\{[\s\S]*?\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } })();
  if (j) { id = j.id; reason = j.reason || ''; tweak = j.tweak || ''; }
  if (!id || !getStyle(id)) {
    // 兜底：从输出里找一个预设 id
    const hit = STYLES.find(s => out.includes(s.id) || out.includes(s.name));
    id = hit ? hit.id : 'hardboiled';
    if (!reason) { const rm = out.match(/[reason"：:\s]*([^"\n}]{4,60})/); reason = rm ? rm[1].trim() : 'AI 推荐'; }
  }
  const s = getStyle(id);
  return { id, name: s.name, short: s.short, reason, tweak };
}

// 对标书风格学习：给一段对标作品的正文样本，让强模型分析出一份「照着这个腔写」的文风指南。
// 返回 { name, rules } —— 直接可存进 book.style（styleVoice 接受 {name,rules}），经 refreshContext
// 注入每个 AGENTS/CLAUDE/GEMINI/QWEN.md 的「本书文风」段，写作时 agent 自动遵守。
export async function analyzeStyleSample({ sample, model }, cfg) {
  const s = String(sample || '').replace(/\r/g, '').trim();
  if (s.length < 40) throw new Error('样本太短，请贴几百字以上的对标正文');
  const prompt =
    `你是资深网文主编与文风分析师。下面是一段【对标作品的正文样本】。请分析它的写作风格，产出一份能让另一个 AI「照着这个腔写」的【文风指南】。\n` +
    `要抓住并写清（用"硬性照做"的祈使句、具体可执行，别写空泛形容词）：段落形态（长短、一句一段还是长段、换行密度）、语言基调（平白还是文学、口语程度、高频口头禅与句式）、叙事节奏与信息密度、感官细节多寡、叙述口吻（吐槽/爽/克制）、对话风格、爽点与钩子节奏、以及【明确的禁忌】（这种风格绝不做什么）。\n` +
    `末尾附 2 段最能代表该风格的【原文摘录】（从样本里选，各 2-4 句），当校准锚。\n\n` +
    `严格按下面格式输出（第一行必须是"风格名="，之后是指南正文；不要代码块、不要多余话）：\n` +
    `风格名=<一句话风格名，如：番茄爽文·快平短口语>\n` +
    `<从这里开始是文风指南正文……>\n\n` +
    `对标样本如下：\n----\n${s.slice(0, 12000)}\n----`;
  const raw = runModelOnce(model, prompt, cfg, 240000) || '';
  // 去 ANSI/控制符（CLI 输出常带），再从"风格名="处开始截（丢掉前面的横幅日志）
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const m = clean.match(/风格名\s*[=＝：:]\s*([^\n]+)\n([\s\S]+)/);
  let name, rules;
  if (m) { name = m[1].trim(); rules = m[2].trim(); }
  else { name = '对标文风'; rules = clean.trim(); }
  rules = rules.replace(/\n{3,}/g, '\n\n').trim();
  if (rules.length < 40) { const e = new Error('AI 分析结果异常（太短），请重试或换模型'); e.raw = raw.slice(-500); throw e; }
  return { name: name.slice(0, 40), rules };
}

// 用户主动发起的「复检」：指定范围 + 维度（逻辑/文风/故事合理性）。单行。
const REVIEW_DIMS = {
  logic: '【逻辑】时间线先后、伏笔的铺设与回收、事实/关系/伤势/物件/欠债的前后矛盾、人物已知信息一致性、情节漏洞',
  style: '【文风】按反AI味标准核查：句长是否过于均匀、有无解释性套话(如“这不是…而是”“这意味着”)、有无翻译腔现代词与现代科研/管理词、每250-400字实锚密度是否足够、段尾是否总在点题升华、是否有重复词与重复句式',
  plausibility: '【故事合理性】人物动机是否可信、因果是否成立、反转与实力变化是否有铺垫与代价、世界/设定规则是否自洽',
  pace: '【节奏/格局/读者体验】主角处境(地点/权力层级/实力/对手量级/格局)是否随章可感升级还是原地打转；是否有连续多章以办牌/验册/对账/盘点/走流程为主线的事务流水账；隔几章有没有可感的进展或爽点(赢一场/收一人/揭真相/上台阶)还是全程压抑无回报；对照本卷阶段目标进度是否跑偏',
};
export function buildReviewInstruction(book, range, dims, note) {
  const sel = (Array.isArray(dims) && dims.length ? dims : ['logic', 'style', 'plausibility', 'pace'])
    .filter(d => REVIEW_DIMS[d]).map(d => REVIEW_DIMS[d]);
  const r = (range || '全书').trim();
  const focus = note ? `本次复检的【重点要求】：${String(note).replace(/[\r\n]+/g, ' ')}。` : '';
  const s = `对《${book.title}》做一次【复检】，范围：${r}。${focus}只针对以下维度检查并修正：${sel.join('；')}。` +
    `请按文件名顺序逐章通读该范围内的正文（必要时参考 novel_bible.md、outlines/、continuity_ledger.md、chapter_index.md）；` +
    `把发现按【硬伤 / 隐患 / 建议】三档写入 reviews/复检-${r}.md。` +
    `处理方式：逻辑硬伤与设定矛盾就地修正（保持已写剧情框架与结局，只改必要处）；文风问题就地润色（句式打散、删AI套话、去翻译腔/现代词、补实锚，不改剧情走向）；` +
    `故事合理性的硬伤若需较大改动剧情，先在报告里给出修改方案、不要擅自大改。` +
    `节奏/格局问题主要靠【前瞻提速】修正——给出“接下来如何提速、收束当前阶段、把舞台推大、压缩事务流水、补爽点”的具体安排，不要大规模重写旧章；若 novel_bible.md 某条口吻基线/限制（如“扩权必须逐一办牌验册、不许顺滑”）在逼出流水账，提出并把它改成“几章一个里程碑”的写法、同步更新 bible。` +
    `严禁改动范围以外的章节，也不要新增后续章节。完成后简要汇报改了哪些章、还剩哪些未决项。全程遵守 AGENTS.md 的 longform-webnovel-writer 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 导入的半成品书：先恢复上下文再续写。单行。
export function buildResumeInstruction(book) {
  const batch = book.standards?.batchSize || 3;
  // 导入的"平铺分章"书：已写章节散在书目录根下、不在 chapters/ 里 → 先整理归档再恢复。
  const ingest = book.flatImport
    ? `第0步整理归档（重要）：本书的已写章节目前是【平铺在书目录根下的 .txt/.md 文件】，不在 chapters/ 子目录里。请先逐个查看根目录下的 .txt/.md：先判定哪些是正文章节、哪些是设定/大纲/笔记（排除 novel_bible.md、各卷大纲、chapter_index.md、continuity_ledger.md、AGENTS.md/CLAUDE.md/GEMINI.md、README 等非正文）；把正文章节依正确先后顺序（看文件名编号或正文衔接判断）逐章移动到 chapters/卷xx/ 下，重命名为「3位全局章号+唯一章名.txt」、内容仅保留正文（去掉标题行/卷名/注释），并逐条登记进 chapter_index.md；把设定/大纲类内容并入 novel_bible.md 或 outlines/。归档过程已 git 受控、可回溯。整理完成后再继续下面步骤。`
    : '';
  const s = `这是一本写了一半的小说《${book.title}》，现在要接着写。` + ingest +
    `第一步恢复上下文：通读 chapters/ 下所有已写章节（按文件名顺序），以及现有的 novel_bible.md、outlines/、chapter_index.md（若不完整或为空模板则据已写正文重建/补全）；` +
    `据已写内容梳理：世界观与力量/设定体系、主角与关键人物及其当前处境、已埋下但未回收的伏笔、未决线索、命名与文风基线，整理进 novel_bible.md 与 continuity_ledger.md。` +
    `第二步校准：确认当前最新的全局章号与所在卷，必要时补全后续卷的分章大纲。` +
    `第三步续写：从最新章节之后接着写下一批 ${batch} 章，严格延续既有剧情走向、人物口吻与文风，不要重写或改动已写章节；写完做常规批次自检。` +
    `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 只重建【设定圣经 + 大纲】，不写新正文：导入/半成品书据已写正文逆向重建规划文件。单行。
export function buildRebuildOutlineInstruction(book) {
  const s = `这是一本已有正文的小说《${book.title}》，但【设定圣经与大纲】缺失或不完整。请【只重建规划、绝不写任何新正文】：` +
    `第一步：通读 chapters/ 下所有已写章节（按文件名顺序）。` +
    `第二步：据正文逆向重建 novel_bible.md——世界观与力量/设定体系、主角与关键人物及其当前处境、对抗势力、主题与禁区、命名与文风基线、已埋未回收的伏笔与未决线索；关键事实同步进 continuity_ledger.md。` +
    `第三步：为【每一卷】起一个有意境的卷名（4–6字副标题；已写到的卷据其正文主线取名），在 outlines/ 下建或补【带卷名的】「卷xx<卷名>分章大纲.md」（如 卷03静海旧火分章大纲.md）——逐章一行写清"该章核心事件/冲突、推进了什么、章末钩子"，并列【本卷伏笔布点表】(埋设→回收章号)；已写到的卷据正文回填，未写到的卷据 bible 主线给章级骨架，覆盖到全书结局；把各卷卷名列进 novel_bible.md 的“全书规模/卷名”处（发布番茄按卷名建卷，卷必须有名、不能只叫“卷xx”）。` +
    `第四步：校对 chapter_index.md，使每章一行(章号/章名/卷/路径/状态)与 chapters/ 实际一致。` +
    `【硬性约束】本次绝不新增/改写/删除任何正文章节(.txt)，只产出或更新 novel_bible.md、outlines/、continuity_ledger.md、chapter_index.md。完成后输出一行「【设定与大纲已重建】」并停下。全程遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 范围重写：把指定范围的章节【推倒重写】（不是润色）。单行。
export function buildRewriteInstruction(book, range, note) {
  const r = (range || '全书').trim();
  const focus = note ? `本次重写的重点要求：${String(note).replace(/[\r\n]+/g, ' ')}。` : '';
  const s = `对《${book.title}》的【范围 ${r}】做【推倒重写】——不是润色、是从头写出更好的版本（旧版本已 git 存档、可回退）。` +
    `第一步：通读 novel_bible.md、该范围对应的 outlines 分章大纲，以及范围【之后】已写的章节，确保新版与后文在人物、伏笔、设定、时间线上严丝合缝。` +
    `第二步：把范围内每一章【整章重写】，覆盖原 .txt 文件；章号与卷目录结构保持不变（若大纲要求调整命名则同步改 chapter_index.md）。${focus}` +
    `第三步：逐章自检并更新 chapter_index.md。严禁改动范围之外的章节、不要新增后续章节。` +
    `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范，尤其【开篇定位】【题材承诺兑现】【节奏与格局】【反 AI 味】。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 整本重立项：保留题材方向，重写 bible + 大纲 + 全部正文。单行。
export function buildReprojectInstruction(book, note) {
  const focus = note ? `调整重点：${String(note).replace(/[\r\n]+/g, ' ')}。` : '';
  const s = `对《${book.title}》做【整本推倒重立项】（旧的 bible / 大纲 / 正文已 git 存档、可回退）。保留题材大方向，但重做规划与正文：` +
    `第一步重写 novel_bible.md：一句话卖点、目标读者、时代世界观、力量/设定体系、主角与关键人物、对抗势力、主题、禁区、开篇策略、节奏与格局承诺、全书规模（卷数/每卷章数/总字数）。${focus}` +
    `第二步在 outlines/ 重排全卷分章大纲（每卷章级 beat 表 + 伏笔布点表，覆盖到全书结局）；为每一卷起一个有意境的卷名（4–6字副标题），大纲文件名带上卷名（卷xx<卷名>分章大纲.md），并把各卷卷名列进 bible 的“全书规模/卷名”（发布番茄按卷名建卷、卷必须有名）。` +
    `第三步从第 1 章开始重写正文，旧正文作废（可参考、不照搬），按 longform-webnovel-writer 规范与新大纲写，每批 ${book.standards?.batchSize || 3} 章自检；务必落实【开篇定位】（尽早立住主角身份+时代+核心爽点）与【题材承诺兑现】。` +
    `第四步重建 chapter_index.md，使其与新正文一致。全程遵守 AGENTS.md 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 收束令：进入收尾/完本冲刺阶段发给作者的指令。first=首次进入(给全套纪律)；否则给精简续推。单行。
export function buildFinaleInstruction(book, { first = false } = {}) {
  if (first) {
    const s = `现在进入《${book.title}》的【收尾 / 完本冲刺】阶段，从这一批起【只收不放】：` +
      `第一步通读 continuity_ledger.md 与各卷大纲，列出所有未回收伏笔、未了欠债与承诺、未交代的人物与线索、未兑现的开篇卖点；` +
      `第二步起【不要再引入任何新人物、新势力、新长线、新坑】；` +
      `第三步逐章加速向全书大高潮推进，把上面列出的未决项一个个在剧情里真正了结（确需舍弃的，在台账里标注"弃坑"并给一句合理交代，不许无视）；` +
      `第四步给主角与每个关键配角各自的结局或归宿（胜负、生死、聚散都要落地，不许人物凭空消失）；` +
      `第五步写出大高潮→结局，必要时加一段尾声收一收气口；保持既有文风与节奏，宁可多写两章把结局写满，也不要仓促烂尾。` +
      `当你确认主线冲突已解决、关键伏笔已回收、主要人物已有交代、结局已写完时，【不要再继续写】，在窗口单独输出一行「【完本待审】」然后停下，等待完本审稿。全程遵守 longform-webnovel-writer 规范。`;
    return s.replace(/[\r\n]+/g, ' ');
  }
  const s = `继续收尾：延续收束令，只收不放、不起新线，对照 continuity_ledger.md 把未回收伏笔与未了承诺继续逐条了结，` +
    `推进大高潮与结局并给人物收束。写够这一批后自检；当主线已解决、关键伏笔已回收、结局已写完时，输出一行「【完本待审】」停下等待完本审稿。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 完本审稿通过后，最后的收尾指令：写完结感言 + 标注全书完结。单行。
export function buildAfterwordInstruction(book) {
  const s = `恭喜，《${book.title}》已通过完本审稿、正式完结。请做最后收尾：` +
    `①可选写一章简短的《完本感言 / 作者的话》（200–400字，真诚、不套路，谢读者、谈创作初衷与遗憾），或写一段简短尾声；` +
    `②在 chapter_index.md 末尾标注"全书完"（含总章数、约总字数）；③更新 novel_bible.md 顶部标注【已完结】。做完即全部结束，无需再写任何正文。`;
  return s.replace(/[\r\n]+/g, ' ');
}

// 构造"全卷大纲都搭好再开写"的立项指令。
// 必须是【单行】——多行 prompt 会被 agent 当作多行草稿、等待人工回车，无法自动开跑。
export function buildKickoffInstruction(book, theme, words, opts = {}) {
  const batch = book.standards?.batchSize || 3;
  // planOnly：网页版模型立项——只建 设定圣经 + 全卷大纲，不写正文（正文由网页版引擎另行续写）。
  if (opts.planOnly) {
    const p = `你是资深网文主编，现在为《${book.title}》做【立项规划】（只搭设定与大纲，绝不写正文）。` +
      `题材：${theme || '（见题材说明）'}；目标总字数：${words || '长篇，自定但需匹配卷数章数'}。` +
      `第一步立项：撰写 novel_bible.md（一句话卖点、目标读者、时代世界观、力量或设定体系、主角、关键配角、对抗势力、主题、禁区、命名风格基线）。` +
      `第二步全书规划（必须落实，不许留空）：据目标字数确定【总卷数、每卷约章数、单章目标字数】，并为每一卷写一句【格局承诺】，写入 bible 的“全书规模”与“节奏与格局承诺”。一个卷内单个阶段目标用 3–8 章兑现，严禁把小事拉成几十章。` +
      `第三步全书骨架：为每一卷【起一个有意境的卷名】（4–6字副标题，贴合本卷主线），在 outlines/ 下建【带卷名的】大纲文件 卷xx<卷名>分章大纲.md（如 卷03静海旧火分章大纲.md），文件内含卷级骨架（本卷阶段目标、关键转折、卷末交给下一卷的局面、章号区间）；并把各卷卷名列进 novel_bible.md 的“全书规模/卷名”处（发布番茄按卷名建卷，卷必须有名）。覆盖到全书结局，并建【全书主线伏笔表】（每条标注埋设→回收章号）。` +
      `第四步把第 1 卷细化到【章级】：卷01 分章大纲逐章一行写清“该章核心事件/冲突、推进了什么、章末钩子”，并列出本卷伏笔布点表。` +
      `第五步：建立并初始化 continuity_ledger.md。` +
      `第六步：完成上述全部规划后【立即停止，绝对不要写任何正文章节】——本书正文将由网页版模型另行续写。完成后单独输出一行「【立项完成：规划就绪，待网页版续写】」然后停下。` +
      `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范中关于设定与大纲的部分。`;
    return p.replace(/[\r\n]+/g, ' ');
  }
  const s = `你是资深网文主编与作者，现在为《${book.title}》立项并开写。` +
    `题材：${theme || '（见题材说明）'}；目标总字数：${words || '长篇，自定但需匹配卷数章数'}。` +
    `第一步立项：撰写 novel_bible.md（一句话卖点、目标读者、时代世界观、力量或设定体系——传统武侠国术宜用弱系统只记录或结算不替代修炼与道德抉择、主角、关键配角、对抗势力、主题、禁区、命名风格基线）。` +
    `第二步全书规划（必须落实，不许留空）：据目标字数确定【总卷数、每卷约章数、单章目标字数】，并为每一卷写一句【格局承诺】——本卷主角的处境(地点/权力层级/实力/对手量级)从什么状态升到什么状态；这些一并写入 bible 的“全书规模”与“节奏与格局承诺”。一个卷内的单个阶段目标原则上用 3–8 章兑现，严禁把一桩小事拉成几十章。` +
    `第三步全书骨架：为每一卷【起一个有意境的卷名】（4–6字副标题，贴合本卷主线），在 outlines/ 下建【带卷名的】大纲文件 卷xx<卷名>分章大纲.md（如 卷03静海旧火分章大纲.md），先给出卷级骨架（本卷阶段目标、关键转折、卷末交给下一卷的局面、章号区间），覆盖到全书结局；把各卷卷名列进 novel_bible.md 的“全书规模/卷名”处（发布番茄按卷名建卷，卷必须有名、不能只叫“卷xx”）；并在 bible 或 outlines/主线伏笔表.md 里建一张【全书主线伏笔表】，每条伏笔标注"埋设章号→计划回收章号"。` +
    `第四步把第 1 卷细化到【章级】：卷01 分章大纲必须逐章一行写清"该章核心事件/冲突、推进了什么(人物/关系/线索)、章末钩子"，并列出本卷【伏笔布点表】(埋设→回收章号)。【硬性闸门】：任何一卷在动笔前，其分章大纲都必须已细化到章级 beat，否则先补该卷章级大纲再写，绝不在只有卷级骨架时就开写。` +
    `第五步：建立并初始化 continuity_ledger.md。` +
    `第六步【大纲待审】：完成上述全部规划后，先【不要写正文】。在窗口单独输出一行哨兵「【大纲待审：立项】」然后停下等待——系统会自动调一位主编审你的 bible 与大纲。收到主编审稿意见（reviews/大纲审稿-立项.md）后，按意见修订 bible 与大纲。` +
    `第七步开写：修订完成后开始写第 1 批 ${batch} 章正文，写入 chapters/卷01/，仅正文不写标题，每章严格对齐该章 beat 与章末钩子，写完做常规批次自检。` +
    `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}
