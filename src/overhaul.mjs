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

// 从窗口文字里算出「额度什么时候恢复」。两家写法完全不同，都得认：
//   · agy   ：Individual quota reached … Resets in 6m8s
//   · claude：Claude usage limit reached · your limit will reset at 10pm / resets at 3:00 AM
// 认不出就返回 null，由调用方给默认值——但默认值只能兜底，不能当常态：
// 2026-09-21 实测，claude 的额度是按小时窗口给的，默认等 15 分钟意味着每 15 分钟白开一次窗口。
export function parseQuotaReset(text, now = new Date()) {
  const t = String(text || '');
  const rel = [...t.matchAll(/resets?\s+in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/gi)].pop();
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return (((+rel[1] || 0) * 3600 + (+rel[2] || 0) * 60 + (+rel[3] || 0)) * 1000) || null;
  }
  const at = [...t.matchAll(/reset(?:s|ting)?\s*(?:at|在)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)].pop();
  if (at) {
    let h = +at[1]; const min = +(at[2] || 0); const ap = (at[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);   // 说的是明天那个点
    const ms = target - now;
    return ms > 0 && ms <= 13 * 3600 * 1000 ? ms : null;       // 超过 13 小时多半是解析错了
  }
  return null;
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
  rebuild: { name: '结构改造', std: { minKeepPct: 85, keepSoft: true, hardFloorPct: 70 } },   // 按清单砍戏是对的，只有砍过头(<70%)才判不达标
};

// 必办清单按批次筛：清单是全书级的，一条条都点着章号（"第14章 REM 写错了"）。
// 【2026-09-20 实证】不筛的后果：给第 11–20 章那批塞的是清单前 12 条，全在点名第 1–9 章，
// claude 读完认定"本批没有要办的事"，跑了 20 分钟、一个字没改就报完成收工。
// 所以：挑出点名本批章号的 + 不带章号的通则，两样都没有时明说"本批没有点名项，按文风规则逐章精修"。
export function pickMustFix(mustFix, a, b, limit = 12) {
  const inRange = [], global = [];
  for (const m of mustFix || []) {
    const nums = [...String(m).matchAll(/第\s*(\d+)\s*[章-]/g)].map(x => +x[1]);
    if (!nums.length) global.push(m);
    else if (nums.some(n => n >= a && n <= b)) inRange.push(m);
  }
  return { inRange: inRange.slice(0, limit), global: global.slice(0, Math.max(2, limit - inRange.length)) };
}

// 【指令措辞纪律】这里是整条流水线最容易出人命的地方，改这段前先读上面 ①
export function buildBatchInstruction(book, a, b, { mustFix = [], carry = '', extra = '', mode = 'polish' } = {}) {
  const rebuild = mode === 'rebuild';
  const picked = pickMustFix(mustFix, a, b);
  return [
    `【本次只改写第${a}到第${b}章这几个已有的文件，改完就停；不新增任何章节，不写第${b + 1}章，不碰这个范围以外的任何文件】`,
    rebuild
      ? '【这是结构改造】允许按下面的必办清单改剧情——包括改事件结果、调整爽点位置、补设定交代、让人物做出不同的选择。'
        + '但只改清单点名的地方，清单没提到的情节保持原样；章号、章数、卷目录一律不变；'
        + '改完必须同步更新 chapter_index.md 和 continuity_ledger.md，让后面的章节接得上'
      : '【这是文风精修，不是重写】剧情事实、人物、事件结果、已埋伏笔全部保留，章号与卷目录不变',
    a > 1 ? `【衔接】第1到${a - 1}章已经按同样的标准改过，动笔前先读 chapter_index.md、continuity_ledger.md 和第${a - 1}章的结尾，保证接得上` : '',
    picked.inRange.length
      ? `【必办清单·点名本批的条目（逐条落实，改完自检一遍有没有漏）】${picked.inRange.join('；')}`
      : (mustFix.length ? `【诊断没有点名第${a}到第${b}章，但本批同样要改】按下面的文风硬规则逐章精修，并保证每章结尾是一件具体的事而不是"变局拉开"这类空话` : ''),
    picked.global.length ? `【全书通则（也适用于本批）】${picked.global.join('；')}` : '',
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
        const wait = (await api.quotaResetMs?.(quotaWaits + 1)) ?? 15 * 60000;
        onLog({ level: 'warn', msg: `⏳ 撞模型额度：本批已改 ${job.b - job.a + 1 - r.unchanged.length} 章，还剩 ${r.unchanged.length} 章；等 ${Math.round(wait / 60000)} 分钟后从第${Math.min(...r.unchanged)}章接着改` });
        setState(slug, { status: 'waiting-quota', waitUntil: new Date(Date.now() + wait).toISOString(), current: key });
        await ctx.killAgents();
        await sleep(wait);
        job.a = Math.min(...r.unchanged);
        setState(slug, { status: 'running' });
        continue;
      }

      // 一章都没改：可能是没跑起来（启动失败/额度），也可能是【模型以为没事可做】——
      // 2026-09-20 实证：必办清单里没有点名本批的条目时，claude 读完就报"任务完成"收工了。
      // 所以重试时把话挑明：上一轮你一个文件都没动，这不是完成。
      if (r.unchanged.length === job.b - job.a + 1 && job.round < maxRounds) {
        job.round++;
        job.fixInstruction = buildBatchInstruction(getBook(slug) || book, job.a, job.b, { mustFix, carry, mode })
          + `。【上一轮你一个文件都没动就报了完成——那不算完成】第${job.a}到第${job.b}章每一章都必须实际落盘修改：`
          + '哪怕诊断没点名这几章，也要按文风硬规则逐章精修（删套话、拆长段、把形容词堆砌换成动作与感官细节），'
          + '并检查每章结尾是不是一件具体的事。改完在回复里列出你改了哪几个文件';
        onLog({ level: 'warn', msg: `↻ 一章都没改，1 分钟后带着"这不算完成"重试（第 ${job.round} 次）` });
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

// 从落盘的阅读复核报告里把条目读回来（报告是 | 章 | 类型 | 问题 | 怎么改 | 的表格）。
// 为什么要能从文件读：复核和定点修常常隔着好几个小时甚至隔天（引擎中间退过两次），
// 内存里的那份早没了，但报告一直在。
export function parseReadReportFile(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(空钩子|逻辑|人物|情绪)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (m) items.push({ num: +m[1], kind: m[2], problem: m[3].trim(), fix: m[4].trim() });
  }
  return items;
}

// 按复核意见定点修：一次改一批章，指令只说这几章的这几条，改完照样过文风闸。
// 与 runOverhaul 共用 runBatch（开窗/盯跑飞/额度感知/质检全都一样），区别只在指令来源。
export async function runReadFix(book, { cfg, api, items, onLog = () => {}, batchSize = 8, maxRounds = 1, std = {}, shouldStop = () => false, batchTimeoutMin = 70 } = {}) {
  const slug = book.slug;
  const batches = readFixBatches(items, batchSize);
  if (!batches.length) return { ok: true, nothing: true };
  // 【mode 不能一律 rebuild】2026-09-24 实证：拿定点修去补 13 章的字数不足，
  // rebuild 的授权是「允许改事件结果、调整爽点位置、让人物做出不同的选择」——
  // 对"这章差 76 个字"来说大得离谱。结果第 22 章 2924→3997（缺 76 字却冲过了上限 3600），
  // 且为了这 76 个字删掉了 110 行已上架的原文。第 17/38 章同样是 +170/-83、+145/-183。
  // 判据：整批意见【全是轻活】（篇幅/情绪）时走 polish——"剧情事实、人物、事件结果、
  // 已埋伏笔全部保留"；只要掺了一条重活（逻辑/人物/空钩子），才需要 rebuild 的授权。
  const LIGHT = new Set(['篇幅', '情绪']);
  const mode = (items || []).length && items.every(i => LIGHT.has(i.kind)) ? 'polish' : 'rebuild';
  onLog({ level: 'info', msg: `定点修模式：${mode === 'polish' ? 'polish（文风精修，不许改剧情）' : 'rebuild（结构改造）'}` });
  const opts = { mustFix: [], std: { keepSoft: true, hardFloorPct: 80, minKeepPct: 95, ...std }, useReviews: false, batchTimeoutMin, mode };
  const ctx = { book, cfg, api, onLog, opts, killAgents: api.killAgents || (async () => 0) };
  setState(slug, { status: 'running', stage: 'readfix', total: batches.length, doneBatches: [] });
  const done = [], report = [];
  for (const b of batches) {
    if (shouldStop()) { setState(slug, { status: 'stopped' }); return { ok: false, stopped: true, report }; }
    const job = { a: b.from, b: b.to, round: 0, carry: '', fixInstruction: buildBatchInstruction(getBook(slug) || book, b.from, b.to, { mode }) + '。' + b.instruction };
    onLog({ level: 'act', msg: `定点修 第${b.from}–${b.to}章（${b.nums.length} 章有意见，共 ${items.filter(i => b.nums.includes(i.num)).length} 条）…` });
    for (;;) {
      const r = await runBatch(ctx, job);
      if (!r.ok) { setState(slug, { status: 'error', error: r.error }); return { ok: false, error: r.error, report }; }
      if (r.quota && r.unchanged.length && job.round < 12) { job.round++; const w = (await api.quotaResetMs?.(job.round)) ?? 15 * 60000; onLog({ level: 'warn', msg: `⏳ 撞额度，等 ${Math.round(w / 60000)} 分钟` }); await ctx.killAgents(); await sleep(w); continue; }
      if (r.unchanged.length === b.to - b.from + 1 && job.round < maxRounds) {
        job.round++;
        job.fixInstruction += '。【上一轮你一个文件都没动就报了完成——那不算完成】必须实际落盘修改这几章';
        onLog({ level: 'warn', msg: '↻ 一章都没改，重试一次' });
        continue;
      }
      report.push({ range: `${b.from}-${b.to}`, issues: r.gate.issues.map(i => i.msg), ok: r.gate.ok });
      done.push(`${b.from}-${b.to}`);
      setState(slug, { doneBatches: done });
      onLog({ level: 'act', msg: r.gate.ok ? `✅ 第${b.from}–${b.to}章定点修完成` : `⚠️ 第${b.from}–${b.to}章完成，文风指标还有 ${r.gate.issues.length} 处不达标` });
      break;
    }
  }
  setState(slug, { status: 'done', stage: 'readfix', finishedAt: new Date().toISOString() });
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
