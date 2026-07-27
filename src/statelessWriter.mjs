// 无状态分章写作：每批用一个【全新的无头进程】（codex exec / claude -p / gemini -p）写作，
// 写完即弃会话——彻底消除长驻 TUI 会话"每发一次继续就重放全部历史"的平方级 token 消耗。
//
// 质量保障：每批的上下文不是靠会话记忆，而是由 contextpack.buildBatchPack 把
// 设定/本卷大纲/台账/上一章结尾/章名表精准重喂（见该文件注释）。模型仍用文件工具
// 自行落盘、查重、更新台账、自检——现有的全部质量机制原样保留，只是换了驱动方式。
//
// 与长驻模式的关系：这是一个【可开关的并行模式】，不改动 writer.mjs / autopilot.mjs。

import { spawn } from 'node:child_process';
import { getModel, detectModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { buildBatchPack } from './contextpack.mjs';
import { bookStats, getBook } from './books.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { reviewOutline } from './editor.mjs';   // 卷边界大纲审稿门复用长驻那套主编无头审稿

// 各模型"无头 + 自动批准文件读写"的参数。
function writeArgs(model) {
  if (model === 'codex') return ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (model === 'claude') return ['-p', '--dangerously-skip-permissions'];
  return ['-p', '--yolo'];   // gemini：-y/--yolo 自动批准工具调用
}

// 异步跑一次无头模型（不阻塞事件循环）。prompt 走 stdin，cwd = 书目录（模型据此读写本书文件）。
function runHeadless(model, prompt, { cwd, cfg, timeoutMs = 900000, onChunk }) {
  const m = getModel(model);
  if (!m) return Promise.reject(new Error('未知模型：' + model));
  const env = { ...process.env };
  if (cfg?.enableProxy) { const px = proxyUrl(); if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; } }
  return new Promise((resolve) => {
    let out = '', err = '', killed = false;
    const child = spawn(m.bin, writeArgs(model), { cwd, env, shell: true, windowsHide: true });
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}
    child.stdout.on('data', d => { const s = d.toString(); out += s; if (onChunk) try { onChunk(s); } catch {} });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out, err: err + '\n' + e.message, killed }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !killed, code, out, err, killed }); });
  });
}

// 跨卷自愈指令：模型在卷边界因"该卷无章级大纲"而停下（输出【大纲待审：卷NN】）时，
// 授权它在无状态快速模式下【先补该卷章级大纲、再直接接着写】，不要停下等人工审稿。
function buildBoundaryRetryPrompt(book, pack, scope, reviewed = false) {
  const { nextNum, lastNum } = pack.meta;
  const reviewLine = reviewed
    ? `0. 【先过大纲审稿门】主编已审本卷分章大纲，意见在 reviews/大纲审稿-${scope}.md：先打开它，按其中【硬伤】逐条修订 outlines/ 里本卷的分章大纲并保存，再做下面的步骤。\n`
    : '';
  return pack.prompt + `\n\n## 补充授权（卷边界自愈）\n` +
    `检测到你认为需要先补「${scope}」的章级大纲才能继续——对。请在【本次调用内】一次做完：\n` +
    reviewLine +
    `1. ${reviewed ? '据修订后的大纲，确保' : '先在 outlines/ 下把'}该卷的【章级分章大纲】${reviewed ? '完整覆盖' : '补好（逐章 beat：核心事件/冲突、推进了什么、章末钩子；并标出本卷伏笔布点 埋设→回收章号），覆盖'}到至少第 ${String(lastNum).padStart(3, '0')} 章。\n` +
    `2. 然后【不要停下、不要输出任何待审哨兵】，直接接着写第 ${String(nextNum).padStart(3, '0')}–${String(lastNum).padStart(3, '0')} 章正文并落盘、更新索引与台账、自检。\n` +
    `（${reviewed ? '大纲审稿已在本轮前置完成' : '无状态模式下大纲审稿改为事后人工复检'}，此刻请连贯地把大纲改好并把正文写出来。）`;
}

// 写一批（count 章）。dryRun 时只组装并返回上下文包，不调模型、不写文件。
export async function writeBatchStateless({ book, model, cfg, count = 3, dryRun = false, onLog = () => {}, mode = 'continue' }) {
  const pack = buildBatchPack(book, { count, mode });
  if (dryRun) return { dryRun: true, ...pack };

  const before = bookStats(book);
  onLog({ level: 'act', msg: `无状态写作：第 ${pack.meta.nextNum}–${pack.meta.lastNum} 章（${count} 章）｜上下文包 ≈${(pack.sizes.promptChars / 1000).toFixed(1)}K 字 / ≈${pack.sizes.estTokens} tokens` });

  const timeoutMs = cfg?.stateless?.batchTimeoutMs || 900000;
  const t0 = Date.now();
  let r = await runHeadless(model, pack.prompt, { cwd: book.dir, cfg, timeoutMs });
  let after = bookStats(book);
  let grew = (after.chapters || 0) - (before.chapters || 0);

  // 卷边界：模型输出【大纲待审：卷NN】而没写章 → 先过【大纲审稿门】(默认开)：主编审该卷分章大纲，
  // 再授权模型按审稿意见改大纲并续写。关掉审稿门(outlineReview:false)则退回"补大纲直接写"的自愈。
  const m = (r.out + '\n' + r.err).match(/【大纲待审[:：]\s*([^】\n]+)】/);
  if (grew <= 0 && m) {
    const scope = m[1].trim();
    let reviewed = false;
    if (cfg?.stateless?.outlineReview !== false) {
      onLog({ level: 'act', msg: `卷边界【${scope}】：先过大纲审稿门——主编审该卷分章大纲…` });
      try { await reviewOutline({ book, scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) }); reviewed = true; }
      catch (e) { onLog({ level: 'warn', msg: '大纲审稿失败（放行不阻断）：' + e.message }); }
    }
    onLog({ level: 'info', msg: `卷边界【${scope}】：${reviewed ? '按审稿意见改大纲后' : '补大纲后'}直接续写…` });
    r = await runHeadless(model, buildBoundaryRetryPrompt(book, pack, scope, reviewed), { cwd: book.dir, cfg, timeoutMs });
    after = bookStats(book);
    grew = (after.chapters || 0) - (before.chapters || 0);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  if (grew <= 0) {
    const tail = (r.err || r.out || '').slice(-300);
    onLog({ level: 'warn', msg: `本批未见新章（${secs}s${r.killed ? '，超时被中止' : ''}）。模型输出尾部：${tail}` });
    return { ok: false, wrote: 0, secs, before, after, raw: r };
  }
  onLog({ level: 'act', msg: `本批完成：新增 ${grew} 章（最高章号 ${before.maxChapter}→${after.maxChapter}），用时 ${secs}s` });
  return { ok: true, wrote: grew, maxFrom: before.maxChapter, maxTo: after.maxChapter, secs, before, after };
}

// 批间"全文逻辑自检"：一次全新无头调用，让模型读 bible/大纲/index/台账+抽查关键章核查全书一致性并就地修硬伤。
// 复用长驻模式的 fullCheckText（行为对齐），只是改由独立进程跑。
async function runCheckStateless({ book, model, cfg, onLog }) {
  const text = cfg?.autopilot?.fullCheckText
    || '现在做一次【全文逻辑自检】：通读 novel_bible.md、全部 outlines/、chapter_index.md 与 continuity_ledger.md，抽查关键章节，核查时间线/人设/设定/伏笔回收/前后矛盾，把发现按【硬伤/隐患/待办】写入 reviews/，就地修正硬伤并更新台账。';
  onLog({ level: 'act', msg: '批间【全文逻辑自检】（独立进程，读台账/大纲核查全书一致性）…' });
  const t0 = Date.now();
  const r = await runHeadless(model, text, { cwd: book.dir, cfg, timeoutMs: cfg?.stateless?.batchTimeoutMs || 900000 });
  onLog({ level: r.ok ? 'info' : 'warn', msg: `全文逻辑自检完成（${Math.round((Date.now() - t0) / 1000)}s）` });
}

// 连续写。batches=固定批数；untilTarget=true 则一直写到"目标章数/被停止"。
// control={stopped} 批间检查实现优雅停止；onReachedTarget 在写满目标章数时触发（自动发布挂这）。
// checkEvery 每 N 批插一次全文逻辑自检（默认取 cfg.stateless.checkEvery）。
export async function runStateless({
  book, model, cfg, batches = 1, batchSize, dryRun = false, onLog = () => {},
  snapshot = true, control = null, untilTarget = false, checkEvery = null, onReachedTarget = null,
}) {
  const m = getModel(model);
  if (!m) throw new Error('未知模型：' + model);
  if (!dryRun) {
    const det = detectModel(model);
    if (!det.available) throw new Error(`${m.name} 不可用（${m.bin} 不在 PATH）`);
  }
  const count = batchSize || book.standards?.batchSize || 3;
  const everyCheck = checkEvery != null ? checkEvery : (cfg?.stateless?.checkEvery ?? 0);

  if (dryRun) {
    const pack = buildBatchPack(book, { count });
    onLog({ level: 'info', msg: '[dry-run] 已组装上下文包，未调用模型、未写文件' });
    return { dryRun: true, pack };
  }

  if (snapshot) { try { const h = gitSnapshot(book.dir, '无状态写作前自动存档'); if (h) onLog({ level: 'info', msg: `已 git 存档：${h}（不满意可回退）` }); } catch {} }

  const results = [];
  let done = 0, sinceCheck = 0;
  for (let i = 0; ; i++) {
    if (control?.stopped) { onLog({ level: 'act', msg: '收到停止请求 → 已在批间安全停止' }); break; }
    if (!untilTarget && i >= batches) break;

    // 写满目标章数 → 触发到达回调(自动发布)后停止
    const b = getBook(book.slug) || book;
    const target = b.targetChapters || 0;
    if (target > 0 && bookStats(b).chapters >= target) {
      onLog({ level: 'act', msg: `已达目标章数 ${target} → 停止续写` });
      if (onReachedTarget) { try { onReachedTarget(); } catch {} }
      break;
    }

    onLog({ level: 'info', msg: `—— 第 ${i + 1}${untilTarget ? '' : '/' + batches} 批 ——` });
    const r = await writeBatchStateless({ book, model, cfg, count, onLog });
    results.push(r);
    if (!r.ok && r.wrote <= 0) { onLog({ level: 'warn', msg: '本批无产出，停止（请检查模型/代理/额度）' }); break; }
    done++; sinceCheck++;

    // 批间错峰自检（不在收到停止/已达目标时跑）
    if (everyCheck > 0 && sinceCheck >= everyCheck && !control?.stopped) {
      sinceCheck = 0;
      try { await runCheckStateless({ book, model, cfg, onLog }); } catch (e) { onLog({ level: 'warn', msg: '自检异常（跳过）：' + e.message }); }
    }
  }
  const totalWrote = results.reduce((a, r) => a + (r.wrote || 0), 0);
  onLog({ level: 'act', msg: `无状态写作结束：共 ${results.length} 批、新增 ${totalWrote} 章` });
  return { ok: true, batches: results.length, totalWrote, results };
}
