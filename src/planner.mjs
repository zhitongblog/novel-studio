// AI 立项：用所选模型非交互生成候选书名，并构造"全卷大纲都搭好再开写"的立项指令。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getModel, detectAll } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { STYLES, getStyle } from './styles.mjs';

// 选"附带文本生成"(简介/封面提示词兜底)用的模型：写作模型是 claude 时自动换 codex/gemini，
// 既满足"claude 不跑这些杂活"的要求，也把 claude 额度留给正文写作。其它模型则沿用本书模型。
export function pickAuxModel(bookModel, cfg) {
  const avail = detectAll().filter(m => m.available).map(m => m.id);
  if (bookModel && bookModel !== 'claude' && avail.includes(bookModel)) return bookModel;
  const alt = ['codex', 'gemini'].find(id => avail.includes(id));
  return alt || bookModel || 'codex';
}

// 把模型输出清洗成"一段约150字的纯中文简介"：先砍掉被回显的 prompt，再去引导语/引号/空白。
function cleanSynopsis(text) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' ');
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
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  const env = { ...process.env };
  if (cfg?.enableProxy) {
    const px = proxyUrl();
    if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; }
  }
  // prompt 走 stdin（避免参数里 JSON 双引号/中文在 Windows cmd 下的引号地狱）；
  // shell:true 让 Windows 能解析 npm 的 .cmd shim（codex/claude/gemini 都是 shim）。
  let args;
  if (model === 'codex') args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  else if (model === 'claude') args = ['-p'];
  else args = ['-p']; // gemini
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

// 用户主动发起的「复检」：指定范围 + 维度（逻辑/文风/故事合理性）。单行。
const REVIEW_DIMS = {
  logic: '【逻辑】时间线先后、伏笔的铺设与回收、事实/关系/伤势/物件/欠债的前后矛盾、人物已知信息一致性、情节漏洞',
  style: '【文风】按反AI味标准核查：句长是否过于均匀、有无解释性套话(如“这不是…而是”“这意味着”)、有无翻译腔现代词与现代科研/管理词、每250-400字实锚密度是否足够、段尾是否总在点题升华、是否有重复词与重复句式',
  plausibility: '【故事合理性】人物动机是否可信、因果是否成立、反转与实力变化是否有铺垫与代价、世界/设定规则是否自洽',
  pace: '【节奏/格局/读者体验】主角处境(地点/权力层级/实力/对手量级/格局)是否随章可感升级还是原地打转；是否有连续多章以办牌/验册/对账/盘点/走流程为主线的事务流水账；隔几章有没有可感的进展或爽点(赢一场/收一人/揭真相/上台阶)还是全程压抑无回报；对照本卷阶段目标进度是否跑偏',
};
export function buildReviewInstruction(book, range, dims) {
  const sel = (Array.isArray(dims) && dims.length ? dims : ['logic', 'style', 'plausibility', 'pace'])
    .filter(d => REVIEW_DIMS[d]).map(d => REVIEW_DIMS[d]);
  const r = (range || '全书').trim();
  const s = `对《${book.title}》做一次【复检】，范围：${r}。只针对以下维度检查并修正：${sel.join('；')}。` +
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

// 构造"全卷大纲都搭好再开写"的立项指令。
// 必须是【单行】——多行 prompt 会被 agent 当作多行草稿、等待人工回车，无法自动开跑。
export function buildKickoffInstruction(book, theme, words) {
  const batch = book.standards?.batchSize || 3;
  const s = `你是资深网文主编与作者，现在为《${book.title}》立项并开写。` +
    `题材：${theme || '（见题材说明）'}；目标总字数：${words || '长篇，自定但需匹配卷数章数'}。` +
    `第一步立项：撰写 novel_bible.md（一句话卖点、目标读者、时代世界观、力量或设定体系——传统武侠国术宜用弱系统只记录或结算不替代修炼与道德抉择、主角、关键配角、对抗势力、主题、禁区、命名风格基线）。` +
    `第二步全书规划（必须落实，不许留空）：据目标字数确定【总卷数、每卷约章数、单章目标字数】，并为每一卷写一句【格局承诺】——本卷主角的处境(地点/权力层级/实力/对手量级)从什么状态升到什么状态；这些一并写入 bible 的“全书规模”与“节奏与格局承诺”。一个卷内的单个阶段目标原则上用 3–8 章兑现，严禁把一桩小事拉成几十章。` +
    `第三步全书骨架：在 outlines/ 下为每一卷创建 卷xx分章大纲.md，先给出卷级骨架（本卷阶段目标、关键转折、卷末交给下一卷的局面、章号区间），覆盖到全书结局；并在 bible 或 outlines/主线伏笔表.md 里建一张【全书主线伏笔表】，每条伏笔标注"埋设章号→计划回收章号"。` +
    `第四步把第 1 卷细化到【章级】：卷01 分章大纲必须逐章一行写清"该章核心事件/冲突、推进了什么(人物/关系/线索)、章末钩子"，并列出本卷【伏笔布点表】(埋设→回收章号)。【硬性闸门】：任何一卷在动笔前，其分章大纲都必须已细化到章级 beat，否则先补该卷章级大纲再写，绝不在只有卷级骨架时就开写。` +
    `第五步：建立并初始化 continuity_ledger.md。` +
    `第六步【大纲待审】：完成上述全部规划后，先【不要写正文】。在窗口单独输出一行哨兵「【大纲待审：立项】」然后停下等待——系统会自动调一位主编审你的 bible 与大纲。收到主编审稿意见（reviews/大纲审稿-立项.md）后，按意见修订 bible 与大纲。` +
    `第七步开写：修订完成后开始写第 1 批 ${batch} 章正文，写入 chapters/卷01/，仅正文不写标题，每章严格对齐该章 beat 与章末钩子，写完做常规批次自检。` +
    `全程严格遵守本目录 AGENTS.md 的 longform-webnovel-writer 规范。`;
  return s.replace(/[\r\n]+/g, ' ');
}
