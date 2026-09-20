// 改造一本书（救书流水线）：诊断 → 分批改 → 自动质检 → 返工 → 阅读复核 → 只发改动章。
//
// 这是 2026-09-19/20 给《穿成王莽后》救书那两天的产品化。当时全靠 scratchpad 里的一次性脚本，
// 踩过的坑一个都不能再踩，所以下面每一条防护都是实战换来的：
//
//  ① 指令措辞纪律：绝不能出现"后面各章"这种能被读成"往后写"的话。
//     实证：我写了一句「后面各章照此执行」，agy 就自作主张往后新写了 14 章（076–089）。
//  ② 跑飞保险：每 30 秒看一次全书最高章号，一变大立刻强停 + 按书杀 agent 进程。
//     只靠"指令里写了不许新增"没用——模型不听。
//  ③ 额度感知：agy 一批就能烧完个人额度，窗口里写着「Resets in 6m8s」。
//     撞上限不是失败，是等；等完从【第一章没改的地方】接着改。
//  ④ 断点续跑：进度落盘到 book.overhaul。那两天流水线被系统内存回收杀过一次、
//     连接重置崩过一次，没有落盘就得从头再来。
//  ⑤ 质检有盲区：指标能查套话/堆砌/比喻/字数，查不出"钩子是空的""人物失格"。
//     所以每批指标过关之后，还要让另一个模型【读】一遍（readreview.mjs）。
//  ⑥ 只发真正改过的章：引擎本来就有 publishedHashes 指纹，别让人去数哪几章动了。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getBook } from './books.mjs';
import { upsertBook } from './store.mjs';
import { listBookChapters } from './signdiag.mjs';
import { styleGate } from './stylegate.mjs';
import { readReview, buildReadFixInstruction, writeReadReport } from './readreview.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(3, '0');

// —— 状态：落盘在 book.overhaul，任何时候都能接着跑 ——
export function getState(slug) { return getBook(slug)?.overhaul || null; }
export function setState(slug, patch) {
  const b = getBook(slug);
  if (!b) return null;
  b.overhaul = { ...(b.overhaul || {}), ...patch, at: new Date().toISOString() };
  upsertBook(b);
  return b.overhaul;
}
export function clearState(slug) {
  const b = getBook(slug);
  if (!b) return;
  delete b.overhaul;
  upsertBook(b);
}

const maxChapter = (book) => Math.max(0, ...listBookChapters(book).map(c => c.num));
function chapterText(book, num) {
  const c = listBookChapters(book).find(x => x.num === num);
  try { return c ? fs.readFileSync(c.file, 'utf8') : ''; } catch { return ''; }
}
// 某章在某个 git 存档里的原文（质检要对比"改前"）
function chapterAt(book, num, snap) {
  const c = listBookChapters(book).find(x => x.num === num);
  if (!c || !snap) return null;
  const rel = c.file.slice(book.dir.length + 1).replace(/\\/g, '/');
  try { return execFileSync('git', ['-C', book.dir, 'show', `${snap}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// 两种改造模式。为什么要分（2026-09-20 给《代码逆子与宇宙沙盒》跑诊断时发现的）：
//   · polish（文风精修）：故事本身没问题，只是文笔像 AI。剧情一个字不许动。——王莽那本就是这种。
//   · rebuild（结构改造）：诊断说的是"承诺没兑现、设定前后打架、爽点迟到十四章"，
//     这些非改剧情不可。代码逆子那本 17 条必办里至少 10 条要动情节，
//     照 polish 的硬约束跑，等于自己把自己挡在门外。
// 两种模式都【绝不允许新增章节】——那是另一回事（续写），也是踩过大坑的地方。
export const MODES = {
  polish: { name: '文风精修', std: {} },
  rebuild: { name: '结构改造', std: { minKeepPct: 85 } },   // 改结构时砍冗长推演是对的，字数底线放宽
};

// 【指令措辞纪律】这里是整条流水线最容易出人命的地方，改这段前先读上面 ①
export function buildBatchInstruction(book, a, b, { mustFix = [], carry = '', extra = '', mode = 'polish' } = {}) {
  const rebuild = mode === 'rebuild';
  return [
    `【本次只改写第${a}到第${b}章这几个已有的文件，改完就停；不新增任何章节，不写第${b + 1}章，不碰这个范围以外的任何文件】`,
    rebuild
      ? '【这是结构改造】允许按下面的必办清单改剧情——包括改事件结果、调整爽点位置、补设定交代、让人物做出不同的选择。'
        + '但只改清单点名的地方，清单没提到的情节保持原样；章号、章数、卷目录一律不变；'
        + '改完必须同步更新 chapter_index.md 和 continuity_ledger.md，让后面的章节接得上'
      : '【这是文风精修，不是重写】剧情事实、人物、事件结果、已埋伏笔全部保留，章号与卷目录不变',
    a > 1 ? `【衔接】第1到${a - 1}章已经按同样的标准改过，动笔前先读 chapter_index.md、continuity_ledger.md 和第${a - 1}章的结尾，保证接得上` : '',
    mustFix.length ? `【必办清单（诊断给的，逐条落实）】${mustFix.slice(0, 12).join('；')}` : '',
    '【文风硬规则】叙述里不许出现套话（轰然、面如土色、战战兢兢、如遭雷击、目瞪口呆、倒吸一口凉气这类），人物对白里可以保留；'
    + '一个名词上不要摞三层形容词；同义的话不要说三遍；比喻一章不超过三处（含"如…般""…似的"）；'
    + '每段不超过四十字，动作、对白、转折各自成段；「？！」一章最多一处',
    '【删了必须补回来】删掉的辞藻要换成具体的动作和感官细节（气味、温度、声音、疼痛、触感），'
    + `每章至少两处；字数不得低于原文的 ${rebuild ? 85 : 95}%——这一条是防止把书改干，比上面任何一条都重要`,
    rebuild
      ? '【删戏要换成更好的戏】清单让你砍的（比如冗长推演、流水账参数）可以砍，但砍出来的篇幅要用正面交锋、'
        + '人物选择、可感的胜负补回来，不能只剩梗概；清单没让砍的爽点、打脸、反转一处都不许少'
      : '【一场戏都不许砍】爽点、打脸、反转、冲突，一处都不能删减或概括成一句话',
    carry ? `【上一批质检发现的毛病，本批别再犯】${carry}` : '',
    extra || '',
  ].filter(Boolean).join('。');
}

// 一批的执行：开窗 → 盯着跑 → 质检 → （不达标）返工
async function runBatch(ctx, job) {
  const { book, cfg, api, onLog, opts } = ctx;
  const { a, b } = job;
  const fresh = () => getBook(book.slug) || book;

  if (await api.live()) { await api.stop(); await sleep(6000); }
  await ctx.killAgents();
  const startMax = maxChapter(fresh());

  // 改前快照：每章原文留一份，质检要用（git 存档由 rewrite 端点自己打）
  const before = {};
  for (let n = a; n <= b; n++) before[n] = chapterText(fresh(), n);

  onLog({ level: 'act', msg: `改造 第${a}–${b}章（第 ${job.round + 1} 轮）…` });
  const r = await api.rewrite({
    range: `${pad(a)}-${pad(b)}`,
    useReviews: opts.useReviews !== false,
    note: job.fixInstruction || buildBatchInstruction(fresh(), a, b, { mustFix: opts.mustFix, carry: job.carry, mode: opts.mode }),
  });
  if (!r?.ok) return { ok: false, error: '开批失败：' + JSON.stringify(r).slice(0, 160) };
  const snap = r.snapshot;
  onLog({ level: 'info', msg: `已开窗（改前存档 ${snap}）` });

  const t0 = Date.now();
  let runaway = false;
  await sleep(60000);
  while (Date.now() - t0 < (opts.batchTimeoutMin || 70) * 60000) {
    if (maxChapter(fresh()) > startMax) {   // ② 跑飞保险
      runaway = true;
      onLog({ level: 'warn', msg: `⛔ 又写出了新章节（${startMax}→${maxChapter(fresh())}）→ 强停` });
      await api.stop(); await ctx.killAgents();
      break;
    }
    if (!(await api.live())) { onLog({ level: 'info', msg: `窗口已收（${Math.round((Date.now() - t0) / 60000)} 分钟）` }); break; }
    await sleep(30000);
  }
  if (Date.now() - t0 >= (opts.batchTimeoutMin || 70) * 60000) { onLog({ level: 'warn', msg: '本批超时 → 强停' }); await api.stop(); }

  // ③ 额度感知
  const quota = await api.hitQuota(t0 - 5000);

  // 质检：用改前正文当基线
  const gate = styleGate(fresh().dir, a, b, (e) => onLog({ ...e, source: 'stylegate' }), { std: opts.std, before });
  const unchanged = gate.scan.chapters.filter(c => c.unchanged).map(c => c.num);
  return { ok: true, snap, gate, unchanged, quota, runaway };
}

// 主流程。api 由调用方注入（server 传真的 HTTP 调用，测试传假的）
export async function runOverhaul(book, {
  cfg, api, onLog = () => {}, from = 1, to = 0, batchSize = 10,
  mustFix = [], std = {}, maxRounds = 2, readCheck = true, useReviews = true, mode = 'polish',
  shouldStop = () => false, batchTimeoutMin = 70,
} = {}) {
  const slug = book.slug;
  const last = to || maxChapter(book);
  // 模式决定硬约束与质检阈值：结构改造允许改剧情、字数底线放宽到 85%
  const modeDef = MODES[mode] || MODES.polish;
  const opts = { mustFix, std: { ...modeDef.std, ...std }, useReviews, batchTimeoutMin, mode };
  const ctx = { book, cfg, api, onLog, opts, killAgents: api.killAgents || (async () => 0) };

  // 断点续跑：已经做完的批次不再做
  const prev = getState(slug);
  const doneBatches = new Set((prev?.doneBatches || []).map(String));
  const batches = [];
  for (let a = from; a <= last; a += batchSize) batches.push({ a, b: Math.min(a + batchSize - 1, last), round: 0, carry: '', fixInstruction: '' });

  setState(slug, { status: 'running', mode, from, to: last, batchSize, total: batches.length, doneBatches: [...doneBatches], issues: [], startedAt: prev?.startedAt || new Date().toISOString() });
  const report = { batches: [], readItems: [] };
  let carry = '';

  for (const job of batches) {
    const key = `${job.a}-${job.b}`;
    if (doneBatches.has(key)) { onLog({ level: 'info', msg: `第${key}章上次已完成，跳过` }); continue; }
    job.carry = carry;
    let quotaWaits = 0;

    for (;;) {
      if (shouldStop()) { setState(slug, { status: 'stopped' }); onLog({ level: 'warn', msg: '收到停止请求，改造中止（进度已保存，可续跑）' }); return { ok: false, stopped: true, report }; }
      const r = await runBatch(ctx, job);
      if (!r.ok) { setState(slug, { status: 'error', error: r.error }); return { ok: false, error: r.error, report }; }

      // 撞额度 → 等恢复，从第一章没改的地方接着改（不算失败，也不算一轮）
      if (r.quota && r.unchanged.length && quotaWaits < (opts.quotaWaits || 12)) {
        quotaWaits++;
        const wait = (await api.quotaResetMs?.()) ?? 15 * 60000;
        onLog({ level: 'warn', msg: `⏳ 撞模型额度：本批已改 ${job.b - job.a + 1 - r.unchanged.length} 章，还剩 ${r.unchanged.length} 章；等 ${Math.round(wait / 60000)} 分钟后从第${Math.min(...r.unchanged)}章接着改` });
        setState(slug, { status: 'waiting-quota', waitUntil: new Date(Date.now() + wait).toISOString(), current: key });
        await ctx.killAgents();
        await sleep(wait);
        job.a = Math.min(...r.unchanged);
        setState(slug, { status: 'running' });
        continue;
      }

      // 一章都没改 = 没跑起来（启动失败/额度），重试有限次
      if (r.unchanged.length === job.b - job.a + 1 && job.round < maxRounds) {
        job.round++;
        onLog({ level: 'warn', msg: `↻ 一章都没改，1 分钟后重试（第 ${job.round} 次）` });
        await sleep(60000);
        continue;
      }

      // 指标不达标 → 带着【具体哪章哪条】返工
      if (!r.gate.ok && job.round < maxRounds) {
        job.round++;
        job.fixInstruction = buildBatchInstruction(getBook(slug) || book, job.a, job.b, { mustFix, carry, mode })
          + '。' + r.gate.instruction;
        onLog({ level: 'warn', msg: `↻ 质检不过（${r.gate.issues.length} 章），带着具体意见返工（第 ${job.round} 轮）` });
        continue;
      }

      report.batches.push({ range: key, snap: r.snap, issues: r.gate.issues.map(i => i.msg), ok: r.gate.ok, runaway: r.runaway });
      carry = r.gate.issues.length ? r.gate.issues.slice(0, 4).map(i => i.msg).join('；') : '';
      doneBatches.add(key);
      setState(slug, { doneBatches: [...doneBatches], current: null, issues: report.batches.flatMap(x => x.issues).slice(0, 40) });
      onLog({ level: 'act', msg: r.gate.ok ? `✅ 第${key}章改造完成，指标全部达标` : `⚠️ 第${key}章完成，但还有 ${r.gate.issues.length} 处不达标（已记在报告里）` });
      break;
    }
  }

  // ⑤ 阅读复核：指标之外的那一层
  if (readCheck) {
    onLog({ level: 'act', msg: '指标过了，现在让另一个模型【读】一遍，挑空钩子/逻辑/人物/情绪的问题…' });
    const rr = await readReview(getBook(slug) || book, from, last, { cfg, onLog });
    if (rr.ok) {
      const fp = writeReadReport((getBook(slug) || book).dir, rr, `${from}-${last}`);
      report.readItems = rr.items;
      report.readReport = fp;
      onLog({ level: 'act', msg: `阅读复核完成：${rr.items.length} 处待处理 → ${path.basename(fp)}` });
      setState(slug, { readItems: rr.items.length, readReport: fp });
    } else {
      onLog({ level: 'warn', msg: '阅读复核没跑成：' + rr.error });
    }
  }

  setState(slug, { status: 'done', finishedAt: new Date().toISOString() });
  return { ok: true, report };
}

// 阅读复核挑出来的问题 → 再开一轮定点修（按章分组，一次修一批）
export function readFixBatches(items, batchSize = 10) {
  const nums = [...new Set((items || []).map(i => i.num))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i += batchSize) {
    const part = nums.slice(i, i + batchSize);
    out.push({ from: part[0], to: part[part.length - 1], nums: part, instruction: buildReadFixInstruction((items || []).filter(x => part.includes(x.num))) });
  }
  return out;
}
