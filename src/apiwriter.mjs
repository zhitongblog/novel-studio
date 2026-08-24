// API 写作主引擎：直连中文大模型的 OpenAI 兼容接口写小说（智谱 GLM / DeepSeek / 通义 API）。
//
// 与「网页版写作」同一套【喂料 → 产文字 → 引擎自己解析落盘】思路，但把「驱动浏览器聊天框」换成
// 「一次 HTTP chat/completions 调用」——稳、快、能连续跑、不碰浏览器那套脆弱输入。
//   1) 复用 contextpack.buildBatchPack 组装上下文包（与网页版/无状态一致，保证喂料一致→质量一致）；
//   2) 追加 webwriter.buildFormatInstruction 的【严格分隔符输出指令】；
//   3) chatComplete 调 API 取整段回答；
//   4) 复用 webwriter 的 parseChapters / saveChapter / appendIndex / appendLedgerAnchor 落盘；
//   5) 推进章号，下一批带更新后的上下文继续。

import { buildBatchPack } from './contextpack.mjs';
import { bookStats, getBook, currentVolume } from './books.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { chatComplete, API_PROVIDERS, resolveProviderCfg } from './apichat.mjs';
import { probeText } from './localai.mjs';
import { recordApiUsage, estimateCost, fmtCost } from './usage.mjs';
import {
  parseChapters,
  saveChapter, appendIndex, appendLedgerAnchor, hanziCount,
} from './webwriter.mjs';

// provider 列表（供 UI/校验）
export function isApiProvider(id) { return !!API_PROVIDERS[id]; }

const SYS_PROMPT = '你是一位资深中文网络小说作者。严格遵循用户给出的写作规范、设定、大纲与输出格式，只输出规范要求的正文，不要寒暄、解释、总结或元信息。';

// 【单章】严格输出格式指令 + 硬性字数要求。
// 关键：免费/小模型一次回复塞不下多章（token 上限），挤 3 章会各缩到几百字 → 改成【一次只写一章】，
// 单章拿满 token 预算，才写得够长。lo/hi = 目标字数区间。
function buildOneChapterInstruction(num, lo, hi) {
  return [
    `## ⚠️ 本次只写【第 ${num} 章】这一章（网页/接口对话，你不能写文件，请把正文直接输出在回复里，由程序解析落盘）`,
    `严格按下面分隔符输出，且【只输出这一章】：`,
    '```',
    `<<<CHAPTER 章号=${num} 标题=这里写本章章名>>>`,
    `（本章正文，仅正文，可含自然段换行；不要写“第X章”标题行、不要 markdown、不要作者旁白）`,
    '<<<END>>>',
    '```',
    `硬性要求：`,
    `1. 以 <<<CHAPTER 章号=${num} 标题=…>>> 开始、以 <<<END>>> 结束；标记单独成行。`,
    `2. 正文【约 ${lo}–${hi} 字】，靠情节推进与细节展开写足——但【严禁为凑字数重复段落、重复对话、原地绕圈】。每一段都必须往前推进（新的动作、新的信息、新的冲突或抉择），写不动了就自然收束到章末钩子，绝不复读。`,
    `3. 严格贴合上文给的【设定圣经、本卷大纲、上一章结尾】——题材、时代、人物、力量体系必须一致，不得跑到别的题材/世界去（这是历史正剧，无异能/系统/末世）。`,
    `4. 对照【本卷分章大纲里第 ${num} 章那一行】写：完成该章的核心事件/冲突、推进该推进的、落在该章的章末钩子上。`,
    `5. 章名与全书已有章名不重复（参考上文“近期已用章名”）。`,
    `6. 除这个带分隔符的章节块外，回复里不要有多余寒暄/解释/总结。`,
  ].join('\n');
}

// 单章「续写补足」指令：正文偏短时，让模型在已写内容基础上把这一章扩写到目标字数（不重开新章）。
function buildExtendInstruction(num, lo) {
  return `刚才第 ${num} 章正文偏短（不足 ${lo} 字）。请【重写这一章的完整正文】，把情节、场景、对话、心理与细节展开充分，`
    + `写足 ${lo} 字以上，仍严格用 <<<CHAPTER 章号=${num} 标题=章名>>> 正文 <<<END>>> 包裹，只输出这一章。`;
}

// 记 API 用量+成本到 usage.json（books[slug].api），并把"本次 tokens/≈金额"打到日志（免费模型显示"免费"）。
function recordApiCost({ book, model, usage, cfg, onLog, label }) {
  if (!usage) return;
  const pt = usage.prompt_tokens || 0, ct = usage.completion_tokens || 0;
  const override = cfg?.api?.pricing;
  const { cost, price } = estimateCost(model, pt, ct, override);
  const free = !price.in && !price.out;
  onLog({ level: 'info', msg: `  API 用量（${label}）：输入 ${pt || '?'} + 输出 ${ct || '?'} tokens ${free ? '（免费）' : '≈ ' + fmtCost(cost)}` });
  try { recordApiUsage(book.slug, model, usage, override); } catch (e) { onLog({ level: 'warn', msg: '  记账失败：' + (e.message || e) }); }
}

// 写一章：组装上下文包(count=1) → API 调用 → 解析 → 太短则补写一次 → 落盘 → 更新索引/台账。
async function writeOneChapterApi({ book, provider, cfg, onLog }) {
  const pack = buildBatchPack(book, { count: 1 });
  const num = pack.meta.nextNum;
  const lo = book?.standards?.minChars || 3000;
  const hi = book?.standards?.targetCharsHi || 3600;

  const userPrompt = pack.prompt + '\n\n' + buildOneChapterInstruction(num, lo, hi);
  onLog({ level: 'act', msg: `API：请求第 ${num} 章（目标 ${lo}–${hi} 字）｜上下文包 ≈${(userPrompt.length / 1000).toFixed(1)}K 字` });

  const messages = [{ role: 'system', content: SYS_PROMPT }, { role: 'user', content: userPrompt }];
  let { content, usage, model } = await chatComplete({ provider, cfg, messages, onLog });
  recordApiCost({ book, model, usage, cfg, onLog, label: `第 ${num} 章` });

  let parsed = parseChapters(content, { onLog });
  let ch = parsed[0];
  // 太短才补写（阈值放低到 1500）：去重后仍不足说明是真被截断/写崩，而非“正常偏短”。
  // 阈值太高会在弱模型上触发反复扩写→反复复读，得不偿失。
  if (ch && hanziCount(ch.body) < 1500) {
    onLog({ level: 'warn', msg: `  第 ${num} 章偏短（${hanziCount(ch.body)}字）→ 请求扩写重试` });
    const extMsgs = [...messages, { role: 'assistant', content }, { role: 'user', content: buildExtendInstruction(num, lo) }];
    try {
      const r2 = await chatComplete({ provider, cfg, messages: extMsgs, onLog });
      recordApiCost({ book, model: r2.model, usage: r2.usage, cfg, onLog, label: `第 ${num} 章·扩写` });
      const p2 = parseChapters(r2.content, { onLog });
      if (p2[0] && hanziCount(p2[0].body) > hanziCount(ch.body)) ch = p2[0];   // 采用更长的那次
    } catch (e) { onLog({ level: 'warn', msg: '  扩写重试失败，用原文：' + e.message }); }
  }
  if (!ch) {
    onLog({ level: 'warn', msg: `API：第 ${num} 章未解析到（回答未按 <<<CHAPTER…>>> 格式或被截断）` });
    return { ok: false };
  }

  const volNum = currentVolume(book) || pack.meta.volNum || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const rel = saveChapter(book, volDir, num, ch.title, ch.body);
  const row = { num, title: ch.title, volDir, rel, words: hanziCount(ch.body) };
  try { appendIndex(book, [row]); } catch (e) { onLog({ level: 'warn', msg: '更新 chapter_index.md 失败：' + e.message }); }
  try { appendLedgerAnchor(book, [row]); } catch (e) { onLog({ level: 'warn', msg: '更新 continuity_ledger.md 失败：' + e.message }); }
  const okLen = row.words >= lo * 0.8;
  onLog({ level: okLen ? 'info' : 'warn', msg: `  ${okLen ? '✓' : '⚠'} 落盘 第 ${num} 章《${ch.title}》（约 ${row.words} 字${okLen ? '' : '，仍偏短'}）→ ${rel}` });
  return { ok: true, row };
}

// 写一批（batchSize 章）：逐章调 API（每章一次，拿满 token 预算写够长）。
async function writeBatchApi({ book, provider, cfg, count, onLog, control }) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    if (control?.stopped) break;
    let r;
    try { r = await writeOneChapterApi({ book, provider, cfg, onLog }); }
    catch (e) { onLog({ level: 'error', msg: `第 ${i + 1}/${count} 章异常：` + (e.message || e) }); return { ok: rows.length > 0, wrote: rows.length, rows, fatal: true, error: e.message }; }
    if (!r.ok) return { ok: rows.length > 0, wrote: rows.length, rows };
    rows.push(r.row);
  }
  if (rows.length) onLog({ level: 'act', msg: `API 本批完成：落盘 ${rows.length} 章（第 ${rows[0].num}–${rows[rows.length - 1].num} 章）` });
  return { ok: rows.length > 0, wrote: rows.length, rows };
}

// 连续跑 batches 批的 API 写作。
// 参数：book、provider（zhipu|deepseek|dashscope）、batches、onLog、cfg、control。
export async function runApiWrite({
  book, provider, batches = 1, onLog = () => {}, cfg = null, control = null,
} = {}) {
  if (!isApiProvider(provider)) throw new Error('未知 API 提供方：' + provider + '（可选 ' + Object.keys(API_PROVIDERS).join('|') + '）');
  // 提前校验（缺就早失败、提示清楚）。本地模型没有 key 的概念——改成探服务在不在，
  // 否则「写了一整批才发现 Ollama 没启动」，白等好几分钟。
  const pc = resolveProviderCfg(provider, cfg);
  if (pc.keyless) {
    const probe = await probeText(pc.baseUrl);
    if (!probe.ok) throw new Error(`本地模型不可用：${probe.error}`);
    const names = (probe.models || []).map(m => m.name);
    // 模型名允许省略 :latest（ollama list 显示 qwen3:14b，用户可能填 qwen3）
    const hit = names.some(n => n === pc.model || n.split(':')[0] === pc.model.split(':')[0]);
    if (names.length && !hit) {
      throw new Error(`本地没有模型「${pc.model}」。已装的是：${names.slice(0, 8).join('、')}。`
        + `先拉一个：ollama pull ${pc.model}，或到「设置 · 本地模型」改成已装的名字。`);
    }
    onLog({ level: 'info', msg: `本地模型就绪：${probe.kind === 'ollama' ? 'Ollama' : 'OpenAI 兼容服务'} @ ${pc.baseUrl}｜模型 ${pc.model}｜上下文 ${pc.numCtx}` });
  } else if (!pc.apiKey) {
    throw new Error(`未配置 ${pc.name} 的 API Key（在「设置 · API 模型」里填）。`);
  }

  const count = book?.standards?.batchSize || 3;

  // 写前 git 存档（best-effort）
  try { const h = gitSnapshot(book.dir, 'API 写作前自动存档'); if (h) onLog({ level: 'info', msg: `已 git 存档：${h}（不满意可回退）` }); } catch {}

  onLog({ level: 'act', msg: `API 写作启动：${pc.name}（模型 ${pc.model}）、每批 ${count} 章、共 ${batches} 批`
    + (pc.local ? `｜本地生成较慢，单章约 2–5 分钟，本次约 ${count * batches * 3} 分钟起，可挂着跑` : '') });

  const results = [];
  let totalWrote = 0;
  for (let i = 0; i < batches; i++) {
    if (control?.stopped) { onLog({ level: 'act', msg: '收到停止请求 → 在批间安全停止' }); break; }

    const b = getBook(book.slug) || book;
    const target = b.targetChapters || 0;
    if (target > 0 && bookStats(b).chapters >= target) {
      onLog({ level: 'act', msg: `已达目标章数 ${target} → 停止 API 写作` });
      break;
    }

    onLog({ level: 'info', msg: `—— 第 ${i + 1}/${batches} 批（API · ${pc.name}）——` });
    let r;
    try {
      r = await writeBatchApi({ book, provider, cfg, count, onLog, control });
    } catch (e) {
      const msg = e.message || String(e);
      onLog({ level: 'error', msg: 'API 本批异常，停止：' + msg });
      break;
    }
    results.push(r);
    if (!r.ok || r.wrote <= 0) { onLog({ level: 'warn', msg: '本批无产出 → 停止（检查格式/额度/上下文）' }); break; }
    totalWrote += r.wrote;
  }

  onLog({ level: 'act', msg: `API 写作结束：共 ${results.length} 批、新增 ${totalWrote} 章` });
  return { ok: true, batches: results.length, totalWrote, results };
}
