// 完结收口：把"内部判完本"接到"番茄平台真正完结"。
// 解决病根——我们的完本检测只看故事内部收束，从不回读/驱动番茄平台侧的完结状态，
// 于是出现"我们判完本了、番茄还连载中"（如《逆宋：重生岳云》600章176.9万字内容写完、后台仍连载中）。
//
// 提供：
//  - getCompletionReport：完结就绪报告(B) —— 本地统计 + 番茄状态 + 平台硬指标清单 + ready 判定
//  - runFinaleClosure   ：完结终发布闭环(C) —— 把收尾新增章(含尾声/完本感言)发齐到番茄，再对账出报告
//  - buildCompletionNote：给番茄编辑的"完结说明"文本(D 辅助)
import fs from 'node:fs';
import path from 'node:path';
import { getBook, bookStats } from './books.mjs';
import { loadConfig } from './config.mjs';
import { loadPublishChapters, publishToFanqie } from './publish.mjs';
import { getFanqieBookStatus, locateFanqieCompletionEntry } from './fanqie.mjs';

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// 本地收尾统计：章数、字数(字符数)、末章号/标题/正文、是否含尾声·完本感言·"全书完"标记。
export function computeLocalFinaleStats(book) {
  const all = loadPublishChapters(book);
  const words = all.reduce((s, c) => s + (c.content ? c.content.length : 0), 0);
  const last = all.length ? all[all.length - 1] : null;
  const lastTitle = last ? last.title : '';
  const lastContent = last ? (last.content || '') : '';
  // 末章是否像"真·大结局/尾声/完本感言"
  const FINALE_RE = /大结局|结局|终章|终篇|尾声|番外|全书完|完本|完结|落幕|大婚|功成|圆满/;
  const looksFinale = FINALE_RE.test(lastTitle) || FINALE_RE.test(lastContent.slice(0, 200)) || FINALE_RE.test(lastContent.slice(-200));
  const hasAfterword = all.some(c => /完本感言|作者的话|尾声|后记|完结感言/.test(c.title));
  // chapter_index.md 末尾"全书完" / bible 顶部【已完结】
  const idx = readSafe(path.join(book.dir, 'chapter_index.md'));
  const bible = readSafe(path.join(book.dir, 'novel_bible.md'));
  const hasFinaleMark = /全书完/.test(idx) || /【已完结】|已完结/.test(bible.slice(0, 200));
  return {
    chapters: all.length, words, lastNum: last ? last.num : 0,
    lastTitle, lastContentLen: lastContent.length,
    looksFinale, hasAfterword, hasFinaleMark,
  };
}

// 完结就绪报告(B)：本地 + 番茄 + 平台硬指标清单。
// includeFanqie=false 时只看本地(不连浏览器)。
// 返回 { ok, ready, blocked, checks:[{key,label,level,ok,detail}], local, fanqie, mismatch:[] }
export async function getCompletionReport(book, { cfg, onLog = () => {}, includeFanqie = true } = {}) {
  cfg = cfg || loadConfig();
  const local = computeLocalFinaleStats(book);
  const minWords = cfg?.finale?.minWords ?? 200000;
  const internalStatus = book.status || '连载中';

  let fanqie = null;
  if (includeFanqie) {
    const pc = book.publish || {};
    if (!pc.profilePath || !pc.bookId) {
      fanqie = { ok: false, error: '未配置番茄账号/书籍(请在「发布番茄」里配置)' };
    } else {
      onLog({ level: 'act', source: 'fanqie', msg: '读取番茄作品状态以对账…' });
      fanqie = await getFanqieBookStatus({ profilePath: pc.profilePath, bookId: pc.bookId, onLog });
    }
  }

  const checks = [];
  const add = (key, label, ok, level, detail) => checks.push({ key, label, ok: !!ok, level, detail: detail || '' });

  // 1) 内部完本审稿（硬）：状态已是"已完本"
  add('internal', '内部完本审稿', internalStatus === '已完本', 'hard',
    internalStatus === '已完本' ? '已标记【已完本】' : `当前状态「${internalStatus}」——先在完本弹窗跑完本审稿/标记已完本`);

  // 2) 末章是真·大结局（建议）
  add('finaleEnding', '末章为真·大结局', local.looksFinale, 'soft',
    local.looksFinale ? `末章《${local.lastTitle}》看起来是结局` : `末章《${local.lastTitle}》不像结局——确认大高潮/结局已写足`);

  // 3) 尾声/完本感言 + 全书完标记（建议）
  add('afterword', '尾声/完本感言·全书完标记', local.hasAfterword || local.hasFinaleMark, 'soft',
    (local.hasAfterword ? '有尾声/完本感言章；' : '未见尾声/完本感言章；') + (local.hasFinaleMark ? '已标"全书完"' : '索引未标"全书完"'));

  // 4) 总字数门槛（建议）
  const wordsOk = local.words >= minWords;
  add('words', `总字数 ≥ ${(minWords / 10000).toFixed(0)}万`, wordsOk, 'soft',
    `本地约 ${(local.words / 10000).toFixed(1)} 万字（门槛 ${(minWords / 10000).toFixed(0)} 万）`);

  const mismatch = [];
  if (fanqie && fanqie.ok) {
    // 5) 本地末章 == 番茄已发布末章（硬）：内容全部落地
    const fqLast = fanqie.lastChapterNum || 0;
    const landed = fqLast >= local.lastNum && local.lastNum > 0;
    add('landed', '内容已全部发到番茄', landed, 'hard',
      `本地末章 第${local.lastNum}章｜番茄末章 第${fqLast}章` + (landed ? '（已对齐）' : `（番茄还差 ${Math.max(0, local.lastNum - fqLast)} 章未发）`));
    if (!landed) mismatch.push(`番茄缺 ${Math.max(0, local.lastNum - fqLast)} 章未发`);

    // 6) 番茄平台完结状态（信息）
    const fqDone = fanqie.status === '已完结';
    const fqReviewing = fanqie.status === '完结审核中';
    add('platform', '番茄平台已完结', fqDone, 'info',
      fqDone ? '番茄状态：已完结 ✅' : fqReviewing ? '番茄状态：完结审核中（编辑审批中）' : `番茄状态：${fanqie.status || '未知'}${fanqie.signed ? '·已签约' : ''} —— 需在番茄后台/联系编辑申请完结`);
    if (!fqDone && internalStatus === '已完本') mismatch.push(fqReviewing ? '番茄完结审核中' : `内部已完本但番茄仍「${fanqie.status || '连载中'}」`);
  } else if (includeFanqie) {
    add('landed', '内容已全部发到番茄', false, 'hard', '无法读取番茄状态：' + (fanqie?.error || '未知'));
    add('platform', '番茄平台已完结', false, 'info', '无法读取番茄状态：' + (fanqie?.error || '未知'));
  }

  // 7) 审核不通过残留章（信息，深度巡检需单独跑）
  add('rejected', '无"审核不通过"残留章', true, 'info', '未检——如需确认请用「已发布章节巡检」深度扫描');

  const hardFail = checks.filter(c => c.level === 'hard' && !c.ok);
  const ready = hardFail.length === 0;
  return { ok: true, ready, blocked: !ready, checks, local, fanqie, mismatch, minWords };
}

// 完结终发布闭环(C)：把番茄还没有的收尾章(含尾声/完本感言)发齐 → 再对账出报告。
// 修了"完本路径不触发终发布"的缺口：标已完本后既要发齐内容、又要对账平台状态。
// 返回 { ok, published, report, error }
export async function runFinaleClosure(book, { cfg, onLog = () => {} } = {}) {
  cfg = cfg || loadConfig();
  const log = (level, msg) => { try { onLog({ level, source: 'fanqie', msg }); } catch {} };
  try {
    const pc = book.publish || {};
    if (!pc.profilePath || !pc.bookId) {
      log('error', '⚠️ 完结收口需要先配置番茄账号/书籍（在「📤发布番茄」里配置）。');
      return { ok: false, error: '未配置番茄账号/书籍' };
    }
    log('act', `🏁 《${book.title}》完结收口：把收尾新增章(含尾声/完本感言)发齐到番茄…`);
    let pub = { published: 0 };
    try { pub = await publishToFanqie(book, { onLog }); }
    catch (e) { log('error', '收口发布异常：' + (e.message || e)); }
    if (pub.blocked) log('error', `收口发布中止：${pub.reason || '番茄页面无效'}`);
    else log('info', `收口发布完成：本次发 ${pub.published || 0} 章。`);

    // 发完再对账
    const report = await getCompletionReport(getBook(book.slug) || book, { cfg, onLog, includeFanqie: true });
    if (report.ready) {
      log('act', '✅ 完结就绪：内容已全部落地、内部已完本。下一步去番茄申请完结（签约/征文书需编辑审批）。');
    } else {
      log('warn', `完结尚未就绪：${(report.checks.filter(c => c.level === 'hard' && !c.ok).map(c => c.label + '（' + c.detail + '）').join('；')) || '见报告'}`);
    }
    if (report.mismatch && report.mismatch.length) log('warn', '对账提示：' + report.mismatch.join('；'));
    log('act', '完结收口结束');
    return { ok: true, published: pub.published || 0, report };
  } catch (e) {
    log('error', '完结收口异常：' + (e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}

// 探测番茄"申请完结"入口 + 给一段可发给编辑的"完结说明"。
export async function locateCompletion(book, { onLog = () => {} } = {}) {
  const pc = book.publish || {};
  if (!pc.profilePath || !pc.bookId) return { ok: false, error: '未配置番茄账号/书籍' };
  return await locateFanqieCompletionEntry({ profilePath: pc.profilePath, bookId: pc.bookId, onLog });
}

// 给番茄编辑的"完结说明"文本：书名/总章/总字数/大结局章名/收束概述。
export function buildCompletionNote(book, report) {
  const L = report?.local || computeLocalFinaleStats(book);
  return [
    `《${book.title}》完结申请说明`,
    `· 总章数：${L.chapters} 章｜总字数：约 ${(L.words / 10000).toFixed(1)} 万字`,
    `· 大结局：第${L.lastNum}章《${(L.lastTitle || '').replace(/^第\d+章\s*/, '')}》`,
    `· 收束情况：主线核心冲突已解决，关键伏笔已回收，主要人物均有结局交代${L.hasAfterword ? '，并已写完本感言/尾声' : ''}。`,
    `· 申请将本作设为「已完结」，请审核。`,
  ].join('\n');
}
