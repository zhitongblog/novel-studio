// 大纲编辑审核（无头主编）：用【另一个模型】审作者写好的大纲，给出分档意见，回写成 reviews/大纲审稿-xxx.md。
// 触发点：立项规划完成、每卷开写前（作者在窗口输出哨兵「【大纲待审：xxx】」→ autopilot 调用本模块）。
// 设计：审稿者只出意见，不直接改大纲；由作者 agent 按意见修订 —— 保留作者一致性，且留痕。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getModel, detectAll } from './models.mjs';
import { proxyUrl } from './unterm.mjs';

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function safeName(s) { return String(s).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40); }

// 选“另一个模型”当主编：优先 cfg 指定 → 其次任一可用且与作者不同 → 实在没有就退回作者模型（仍是一次独立新上下文审稿）。
export function pickEditorModel(authorModel, cfg) {
  const avail = detectAll().filter(m => m.available).map(m => m.id);
  const want = cfg?.editorReview?.model;
  if (want && want !== 'auto' && avail.includes(want)) return want;
  const order = ['claude', 'codex', 'gemini'];
  const diff = order.find(id => id !== authorModel && avail.includes(id));
  return diff || authorModel;
}

// 非交互跑一次模型（异步 spawn，不阻塞事件循环 —— 与 planner 的同步版区分）。
function runModelOnceAsync(model, prompt, cfg, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const m = getModel(model);
    if (!m) return reject(new Error('未知模型：' + model));
    const env = { ...process.env };
    if (cfg?.enableProxy) {
      const px = proxyUrl();
      if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; }
    }
    const args = model === 'codex'
      ? ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']
      : ['-p'];
    const cp = spawn(m.bin, args, { env, cwd: os.tmpdir(), shell: true, windowsHide: true });
    let out = '', err = '';
    const to = setTimeout(() => { try { cp.kill(); } catch {} reject(new Error(m.name + ' 审稿超时')); }, timeoutMs);
    cp.stdout.on('data', d => (out += d));
    cp.stderr.on('data', d => (err += d));
    cp.on('error', e => { clearTimeout(to); reject(e); });
    cp.on('close', () => { clearTimeout(to); resolve(out + (err ? '\n' + err : '')); });
    try { cp.stdin.write(prompt); cp.stdin.end(); } catch (e) { clearTimeout(to); reject(e); }
  });
}

// 找出该 scope 要审的大纲文件：立项/全书=全部；卷NN=该卷的分章大纲。
function outlineFilesFor(dir, scope) {
  const odir = path.join(dir, 'outlines');
  let files = [];
  try { files = fs.readdirSync(odir).filter(f => /\.md$/i.test(f)); } catch {}
  if (/立项|全书|all/i.test(scope)) return files.map(f => path.join(odir, f));
  const m = String(scope).match(/卷?\s*0*(\d+)/);
  if (m) {
    const n = m[1];
    const hit = files.filter(f => new RegExp('卷0*' + n + '(?!\\d)').test(f));
    if (hit.length) return hit.map(f => path.join(odir, f));
  }
  return files.map(f => path.join(odir, f));  // 兜底：审全部
}

// 主编审稿 prompt：网文资深主编视角，重点盯节奏/格局/爽点/逻辑/规模/反流水账，给可执行改法。
function buildEditorPrompt(book, scope, bible, outline) {
  return [
    `你是一名极挑剔的资深网文主编，正在【开写前】审核一本长篇网文的大纲。你的职责是抓出"会让这本书写崩、读者弃书"的结构问题，并给出可执行的修改意见。`,
    `书名：《${book.title}》；本次审核范围：${scope}。`,
    ``,
    `# 设定圣经（novel_bible.md）`,
    bible || '（缺失）',
    ``,
    `# 待审大纲`,
    outline,
    ``,
    `# 审核要求（逐条核查，专挑硬骨头，别说客套话）`,
    `1. 节奏/格局：每卷主角处境（地点/权力层级/实力/对手量级/格局）是否【可感升级】？有没有把一桩小事拖成几十章的风险？单个阶段目标是否能在 3–8 章兑现？`,
    `2. 反流水账：是否存在大量"办牌/验册/对账/盘点/走流程"类事务被当成主线事件的苗头？这类内容会让书变成账本，必须点名。`,
    `3. 爽点节拍：隔几章有没有给读者一次可感的进展或胜利（赢一场/收一人/揭真相/上台阶/打脸）？还是长期只压抑不兑现？`,
    `4. 逻辑与伏笔：关键伏笔有没有回收章号？事件因果是否成立？有没有明显的人物动机硬伤或设定自相矛盾？`,
    `5. 题材契合与卖点：大纲是否对得起"一句话卖点"和目标读者要的爽感？有没有跑偏成另一个题材？`,
    `6. 规模合理性：卷数 × 每卷章数 × 单章字数 与目标总字数是否匹配？按这个大纲，能在规模内把故事讲完、还是会烂尾或注水？`,
    ``,
    `# 输出格式（中文，markdown，直接给结论，不要复述大纲）`,
    `按【硬伤】（会写崩，必须改）/【隐患】（有风险，建议改）/【建议】（锦上添花）三档列出。每条写清：问题是什么 → 具体怎么改（给到卷/章号或具体手法）。`,
    `最后一行给【总评】：可直接开写 / 需修订后开写，并一句话说明最关键的那个改动。`,
  ].join('\n');
}

// 主流程：审一个 scope 的大纲，写审稿文件，返回 { file, editorModel, critique }。
export async function reviewOutline({ book, scope = '立项', cfg, authorModel, onLog = () => {} }) {
  const dir = book.dir;
  const bible = readSafe(path.join(dir, 'novel_bible.md'));
  const ofiles = outlineFilesFor(dir, scope);
  const outline = ofiles.map(f => `### ${path.basename(f)}\n` + readSafe(f)).join('\n\n').trim();
  if (!outline) throw new Error('未找到可审的大纲文件（outlines/ 为空？）');

  const editorModel = pickEditorModel(authorModel, cfg);
  onLog({ level: 'act', msg: `主编（${editorModel}${editorModel === authorModel ? '·同模型独立审' : ''}）正在审【${scope}】大纲…` });

  const prompt = buildEditorPrompt(book, scope, bible, outline);
  const raw = await runModelOnceAsync(editorModel, prompt, cfg, cfg?.editorReview?.timeoutMs || 180000);
  const critique = (raw || '').trim() || '（审稿模型未返回内容）';

  const reviewsDir = path.join(dir, 'reviews');
  try { fs.mkdirSync(reviewsDir, { recursive: true }); } catch {}
  const file = path.join(reviewsDir, `大纲审稿-${safeName(scope)}.md`);
  const header = `# 大纲审稿（${scope}）\n\n> 审稿人：主编模型 ${editorModel}（作者：${authorModel}）\n> 时间：${new Date().toISOString()}\n\n`;
  fs.writeFileSync(file, header + critique + '\n', 'utf8');
  onLog({ level: 'info', msg: `审稿完成 → ${path.relative(dir, file)}` });

  return { file, editorModel, critique };
}

// 给作者 agent 的「按审稿修订」单行指令（autopilot 注入用）。改完要先输出哨兵停下待核，不直接写正文。
export function buildReviseInstruction(book, scope, file) {
  const rel = path.relative(book.dir, file).replace(/[\r\n]+/g, ' ');
  return (`主编已对【${scope}】大纲完成审稿，意见写在 ${rel}。请先通读这份审稿，按其中【硬伤】逐条修订对应的 novel_bible.md 与 outlines/ 大纲（重点：节奏/格局升级、压缩事务流水、补爽点、伏笔回收、规模匹配），【隐患/建议】酌情采纳；改完在大纲或 continuity_ledger.md 里留一句修订说明。若某条意见你不认同，可在大纲里简注理由后保留。修订完成后【先不要写正文】，在窗口单独输出一行「【大纲已修订：${scope}】」然后停下——系统会核对你是否确实改了大纲文件，核对通过后再开始写正文。`).replace(/[\r\n]+/g, ' ');
}

// 放行指令：核对通过，可以开写正文。
export function buildProceedInstruction(book, scope) {
  return `已核对：你的大纲/设定文件确有修订。现在按 longform-webnovel-writer 规范开始写【${scope}】范围的正文，每章对齐 beat 与章末钩子，写完做批次自检。`.replace(/[\r\n]+/g, ' ');
}
// 重催指令：文件没动，要求真正改文件。
export function buildRenudgeInstruction(book, scope) {
  return `系统核对发现 outlines/ 与 novel_bible.md 并未实际改动——这是要你【真正打开并修改大纲文件】、不是口头确认。请打开 outlines/ 下【${scope}】对应的分章大纲（必要时 novel_bible.md），按 reviews/大纲审稿-${safeName(scope)}.md 里的【硬伤】逐条修改并保存，改完再输出一行「【大纲已修订：${scope}】」。`.replace(/[\r\n]+/g, ' ');
}

// 读最近 n 章正文（按全局章号排序取末尾，即最接近结局的部分；总量截到 cap 字符）。
function readLastChapters(dir, n, cap) {
  const cdir = path.join(dir, 'chapters');
  const files = [];
  (function walk(d) { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.txt$/i.test(e.name)) files.push(p); } } catch {} })(cdir);
  files.sort((a, b) => (parseInt(path.basename(a)) || 0) - (parseInt(path.basename(b)) || 0));
  let out = '';
  for (const f of files.slice(-n)) out += `\n### ${path.basename(f)}\n` + readSafe(f);
  out = out.trim();
  if (cap && out.length > cap) out = out.slice(-cap);
  return out;
}

// 完本审稿 prompt：对照完本检查清单逐条核对，首行严格给"判定：可完本/未完本"。
function buildEndingPrompt(book, bible, ledger, ending) {
  return [
    `你是资深网文主编，正在对《${book.title}》做【完本审稿】——判断它现在是否真能"完结"，还是结局仓促、还有没收的线。只看硬指标，别说客套。`,
    ``,
    `# 设定圣经（长线弧光 / 主题 / 卖点 / 结局设想）`, bible || '（缺失）', ``,
    `# 连贯性台账（未回收伏笔 / 未了欠债 / 人物现状）`, ledger || '（缺失）', ``,
    `# 结局部分正文（最近若干章）`, ending || '（空）', ``,
    `# 完本检查清单（逐条核对）`,
    `1. 主线核心冲突是否真正解决（不是搁置/含糊带过）？`,
    `2. 主角弧光是否闭合、有明确结局或归宿？`,
    `3. 关键配角是否都有交代（胜负/生死/聚散），有没有人物凭空消失？`,
    `4. 台账里的重要伏笔、欠债、承诺是否已回收（或明确弃坑并交代）？`,
    `5. 反派 / 对抗势力是否已处置？`,
    `6. 开篇给读者的核心卖点 / 承诺是否兑现？`,
    `7. 结局有没有"为完结而完结"的仓促 / 烂尾感？大高潮是否写足？`,
    ``,
    `# 输出格式（严格）`,
    `第一行【只能】是：判定：可完本   或   判定：未完本`,
    `若未完本：从第二行起逐条列出"还差什么 → 需要补写什么（给到具体伏笔/人物/事件）"。`,
    `若可完本：第二行起一句话说明主线与关键伏笔均已收束。`,
  ].join('\n');
}

// 完本审稿：核对这本书是否真的可以完结。返回 { pass, body, file, editorModel }。
export async function reviewEnding({ book, cfg, authorModel, onLog = () => {} }) {
  const dir = book.dir;
  const bible = readSafe(path.join(dir, 'novel_bible.md'));
  const ledger = readSafe(path.join(dir, 'continuity_ledger.md'));
  const ending = readLastChapters(dir, cfg?.finale?.endingChapters || 10, 24000);
  const editorModel = pickEditorModel(authorModel, cfg);
  onLog({ level: 'act', msg: `主编（${editorModel}）完本审稿：核对主线/伏笔/人物是否真正收束…` });
  const raw = await runModelOnceAsync(editorModel, buildEndingPrompt(book, bible, ledger, ending), cfg, cfg?.editorReview?.timeoutMs || 180000);
  const out = (raw || '').trim();
  const pass = /判定[：:]\s*(可完本|通过)/.test(out) && !/判定[：:]\s*(未完本|不可完本|未通过)/.test(out);
  const file = path.join(dir, 'reviews', '完本审稿.md');
  try {
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(file, `# 完本审稿\n\n> 审稿模型 ${editorModel}｜${new Date().toISOString()}｜判定：${pass ? '可完本' : '未完本'}\n\n` + out + '\n', 'utf8');
  } catch {}
  onLog({ level: pass ? 'info' : 'warn', msg: `完本审稿${pass ? '通过（可完本）' : '未通过（需补写结局）'} → ${path.relative(dir, file)}` });
  return { pass, body: out, file, editorModel };
}

// 完本审稿未过：退回作者继续补写结局。单行。
export function buildEndingRenudgeInstruction(book, file) {
  const rel = file ? path.relative(book.dir, file).replace(/[\r\n]+/g, ' ') : 'reviews/完本审稿.md';
  return `完本审稿认为结局尚未真正收束，仍有未了项写在 ${rel}。请按其中每一条继续【补写正文】：回收剩余伏笔、给未交代的人物结局、补全大高潮或结局；不要草草收尾，也不要只在台账里写"已解决"而正文没写。补完再输出一行「【完本待审】」等待复审。`.replace(/[\r\n]+/g, ' ');
}

// 复审重催指令：复审认定硬伤没改对，退回作者继续改。
export function buildRecheckRenudgeInstruction(book, scope, file) {
  const rel = file ? path.relative(book.dir, file).replace(/[\r\n]+/g, ' ') : ('reviews/大纲复审-' + safeName(scope) + '.md');
  return `主编复审了你改后的【${scope}】大纲，认定仍有【硬伤】没有真正解决，逐条写在 ${rel}。请按其中每一条继续修改 outlines/ 与 novel_bible.md（别只改字面、要真正解决问题），改完再输出一行「【大纲已修订：${scope}】」等待复审。`.replace(/[\r\n]+/g, ' ');
}

// 复审 prompt：对照上一轮【硬伤】，逐条核对改后大纲是否真解决。要求首行给严格判定。
function buildRecheckPrompt(book, scope, priorCritique, bible, outline) {
  return [
    `你是之前审过这本书大纲的资深网文主编。下面给你三样东西：①你上一轮的审稿意见（重点是其中的【硬伤】）②设定圣经 ③作者据你意见【改后】的大纲。`,
    `请只做一件事：逐条核对你上一轮指出的每一个【硬伤】，在改后的大纲里【是否已被真正解决】。不要夸奖、不要提新的小毛病，只盯硬伤改没改对。`,
    ``,
    `# 上一轮审稿意见`, priorCritique, ``,
    `# 设定圣经`, bible || '（缺失）', ``,
    `# 改后的大纲`, outline || '（空）', ``,
    `# 输出格式（严格遵守）`,
    `第一行【只能】是：判定：通过   或   判定：未通过`,
    `若未通过：从第二行起，逐条列出"仍未解决的硬伤 → 还需怎么改（给到卷/章号）"。`,
    `若通过：第二行起用一句话说明哪些硬伤已确认解决。`,
  ].join('\n');
}

// 主编二次复审改后大纲：对照原审稿的硬伤逐条核对。返回 { pass, body, file, editorModel }。
export async function recheckRevision({ book, scope = '立项', cfg, authorModel, onLog = () => {} }) {
  const dir = book.dir;
  const priorFile = path.join(dir, 'reviews', `大纲审稿-${safeName(scope)}.md`);
  const prior = readSafe(priorFile);
  if (!prior.trim()) return { pass: true, body: '（无原审稿意见，跳过复审）', file: null, editorModel: null };
  const bible = readSafe(path.join(dir, 'novel_bible.md'));
  const ofiles = outlineFilesFor(dir, scope);
  const outline = ofiles.map(f => `### ${path.basename(f)}\n` + readSafe(f)).join('\n\n').trim();

  const editorModel = pickEditorModel(authorModel, cfg);
  onLog({ level: 'act', msg: `主编（${editorModel}）复审【${scope}】改后大纲，核对硬伤是否真改对…` });
  const raw = await runModelOnceAsync(editorModel, buildRecheckPrompt(book, scope, prior, bible, outline), cfg, cfg?.editorReview?.timeoutMs || 180000);
  const out = (raw || '').trim();
  const pass = /判定[：:]\s*通过/.test(out) && !/判定[：:]\s*未通过/.test(out);

  const file = path.join(dir, 'reviews', `大纲复审-${safeName(scope)}.md`);
  try {
    fs.writeFileSync(file, `# 大纲复审（${scope}）\n\n> 复审模型 ${editorModel}｜${new Date().toISOString()}｜判定：${pass ? '通过' : '未通过'}\n\n` + out + '\n', 'utf8');
  } catch {}
  onLog({ level: pass ? 'info' : 'warn', msg: `复审${pass ? '通过' : '未通过'} → ${path.relative(dir, file)}` });
  return { pass, body: out, file, editorModel };
}

// —— 修订验证：审稿时给相关文件拍快照，作者改完后比对是否真的变了 ——
function relevantFiles(dir, scope) {
  return [path.join(dir, 'novel_bible.md'), ...outlineFilesFor(dir, scope)];
}
function hashFile(p) { const c = readSafe(p); let h = 0; for (let i = 0; i < c.length; i++) { h = (h * 31 + c.charCodeAt(i)) | 0; } return c.length + ':' + h; }
function snapPath(dir, scope) { return path.join(dir, '.studio', 'ol-snap-' + safeName(scope) + '.json'); }
export function snapshotOutline(book, scope) {
  const dir = book.dir;
  const sig = {};
  for (const f of relevantFiles(dir, scope)) sig[path.basename(f)] = hashFile(f);
  try { fs.mkdirSync(path.join(dir, '.studio'), { recursive: true }); fs.writeFileSync(snapPath(dir, scope), JSON.stringify(sig), 'utf8'); } catch {}
  return sig;
}
export function verifyRevision(book, scope) {
  const dir = book.dir;
  let prev = null;
  try { prev = JSON.parse(readSafe(snapPath(dir, scope)) || 'null'); } catch {}
  if (!prev) return { hadSnapshot: false, changed: false, changedFiles: [] };
  const changedFiles = [];
  for (const f of relevantFiles(dir, scope)) { const name = path.basename(f); if (prev[name] !== hashFile(f)) changedFiles.push(name); }
  return { hadSnapshot: true, changed: changedFiles.length > 0, changedFiles };
}
