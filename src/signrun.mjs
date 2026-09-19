// 「签约诊断」的编排：番茄签约进度 → 定时乱序 → 客观指标 → 编辑视角评估 → 修改清单。
// 全程只读，结果落 reviews/签约诊断.md，摘要存进 book.signDiag 供体检/此刻卡使用。
//
// 这套流程就是 2026-09-19 手工查《穿成王莽后》签约被拒时走的路，原样固化下来：
//   ① 番茄签约管理：第二次签约「签约评估拒绝」，下次机会在 8 万字
//   ② 编辑看到的只有已发布的 19 章 / 6.3 万字（待发布的 32 章不算）
//   ③ 定时发布乱序：读者会从第 19 章直接跳到第 35 章
//   ④ 客观指标：平均每段 50–70 字（网文范本约 16）
//   ⑤ 编辑视角评估：必改 11 条，每条都带章号，抽查全部属实

import fs from 'node:fs';
import path from 'node:path';
import { fetchSignStatus, fetchChapterSchedule } from './signfetch.mjs';
import { listBookChapters, objectiveFindings, buildSignEvalPrompt, parseSignEval, scheduleDisorder } from './signdiag.mjs';
import { reviewerCandidates, runModelOnceAsync, invalidReview, stripNoise } from './editor.mjs';
import { noteReviewerOk, noteReviewerFail, classifyFail } from './reviewerhealth.mjs';
import { upsertBook, getBook } from './store.mjs';

export async function diagnoseSigning(book, { cfg, onLog = () => {}, model = null } = {}) {
  const pub = book.publish || {};
  if (!pub.bookId || !pub.profilePath) throw new Error('这本书还没绑定番茄作品（发布设置里没有账号/书籍 ID）');
  const report = { at: new Date().toISOString(), title: book.title };

  // ① 签约进度
  onLog({ level: 'act', msg: '读番茄签约管理…' });
  let sign;
  try { sign = await fetchSignStatus({ profilePath: pub.profilePath, bookId: pub.bookId, title: book.title, onLog }); }
  catch (e) { sign = { error: e.message }; }
  report.sign = sign;
  if (sign?.error) onLog({ level: 'warn', msg: '签约进度没读到：' + sign.error + '（继续做其余检查）' });
  else if (sign.signed) onLog({ level: 'act', msg: '这本书已经签约了' });
  else if (sign.rejected) onLog({ level: 'warn', msg: `签约评估被拒${sign.nextApplyChars ? `，下次申请门槛 ${sign.nextApplyChars / 10000} 万字` : ''}；番茄上公开 ${sign.publicChapters ?? '?'} 章 / ${sign.publicChars ? (sign.publicChars / 10000).toFixed(1) + ' 万字' : '?'}` });

  // ② 章节定时表 + 乱序
  onLog({ level: 'act', msg: '读番茄章节定时表…' });
  let rows = [];
  try { rows = await fetchChapterSchedule({ profilePath: pub.profilePath, bookId: pub.bookId, onLog }); }
  catch (e) { onLog({ level: 'warn', msg: '章节定时表没读到：' + e.message }); }
  const disorder = scheduleDisorder(rows);
  report.schedule = { total: rows.length, published: rows.filter(r => r.status === '已发布').length, pending: disorder.pendingCount, outOfOrder: disorder.outOfOrder.map(x => x.num), readerOrder: disorder.readerOrder.slice(0, 15) };
  if (disorder.outOfOrder.length) {
    onLog({ level: 'warn', msg: `⚠️ 定时发布乱序：第 ${disorder.outOfOrder.map(x => x.num).join('、')} 章会插到前面章节之前上线——读者实际顺序 ${disorder.readerOrder.slice(0, 6).join(' → ')} …` });
  }

  // ③ 编辑看到的是哪几章：只算已发布的（签约评估不看待发布）
  const publishedMax = rows.filter(r => r.status === '已发布').map(r => r.num).sort((a, b) => b - a)[0]
    || sign?.publicChapters || 0;
  const all = listBookChapters(book);
  const seen = publishedMax ? all.filter(c => c.num <= publishedMax) : all.slice(0, 20);
  report.seenChapters = seen.length ? [seen[0].num, seen[seen.length - 1].num] : [];
  onLog({ level: 'info', msg: `编辑能看到的是第 ${report.seenChapters.join('–')} 章，按这些做评估` });

  // ④ 客观指标
  const obj = objectiveFindings(seen);
  report.objective = { avgPara: obj.avgPara, avgDialog: obj.avgDialog, avgChars: obj.avgChars, findings: obj.findings };

  // ⑤ 编辑视角评估（逐个审稿人试，拿不到有效结果就明说）
  const prompt = buildSignEvalPrompt(book, seen, obj);
  const cands = model ? [model] : reviewerCandidates(book.model || cfg?.defaultModel, cfg);
  let evalText = '', used = null;
  for (const m of cands) {
    onLog({ level: 'act', msg: `编辑视角评估（${m}）——约 3–4 分钟…` });
    try {
      const out = await runModelOnceAsync(m, prompt, cfg, Math.max(cfg?.editorReview?.timeoutMs || 0, 600000));
      if (!invalidReview(out, prompt)) { evalText = stripNoise(out); used = m; noteReviewerOk(m); break; }
      noteReviewerFail(m, classifyFail(stripNoise(out)), stripNoise(out).slice(0, 100));
      onLog({ level: 'warn', msg: `${m} 的输出无效，换下一个` });
    } catch (e) { noteReviewerFail(m, classifyFail(e.message), e.message); onLog({ level: 'warn', msg: `${m} 失败：${e.message}，换下一个` }); }
  }
  report.eval = evalText ? { model: used, ...parseSignEval(evalText) } : { unavailable: true };

  // 落盘：完整报告给人看，摘要存书上给体检用
  const file = path.join(book.dir, 'reviews', '签约诊断.md');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderReport(book, report, evalText), 'utf8');
  } catch {}
  report.file = file;
  const b = getBook(book.slug) || book;
  b.signDiag = {
    at: report.at,
    rejected: !!sign?.rejected, signed: !!sign?.signed,
    nextApplyChars: sign?.nextApplyChars || 0, publicChars: sign?.publicChars || 0,
    outOfOrder: report.schedule.outOfOrder, readerOrder: report.schedule.readerOrder,
    mustFix: (report.eval.items || []).filter(i => i.level === '必改').length,
  };
  upsertBook(b);
  onLog({ level: 'act', msg: `✅ 签约诊断完成 → reviews/签约诊断.md（必改 ${b.signDiag.mustFix} 条）` });
  return report;
}

function renderReport(book, r, evalText) {
  const L = [];
  L.push(`# 签约诊断《${book.title}》`, '', `> ${r.at}`, '');
  L.push('## 番茄签约进度');
  if (r.sign?.error) L.push(`没读到：${r.sign.error}`);
  else if (r.sign?.signed) L.push('已签约。');
  else {
    for (const s of r.sign?.steps || []) L.push(`- ${s.step}${s.time ? '（' + s.time + '）' : ''}${s.text ? '：' + s.text : ''}`);
    if (r.sign?.nextApplyChars) L.push('', `下次申请门槛：${r.sign.nextApplyChars / 10000} 万字；番茄上当前公开 ${r.sign.publicChars ? (r.sign.publicChars / 10000).toFixed(1) + ' 万字' : '?'}`);
  }
  L.push('', '## 定时发布顺序');
  if (r.schedule.outOfOrder.length) {
    L.push(`⚠️ 乱序：第 ${r.schedule.outOfOrder.join('、')} 章会插到前面章节之前上线。`);
    L.push(`读者实际会读到的顺序：${r.schedule.readerOrder.join(' → ')} …`);
  } else L.push(`正常（待发布 ${r.schedule.pending} 章，按章号顺序上线）`);
  L.push('', `## 编辑看到的内容：第 ${r.seenChapters.join('–')} 章`, '', '### 客观指标');
  L.push(`平均每段 ${r.objective.avgPara} 字 · 对话占比 ${r.objective.avgDialog}% · 平均每章 ${r.objective.avgChars} 字`);
  for (const f of r.objective.findings) L.push(`- [${f.level === 'bad' ? '必改' : '建议'}] ${f.text} → ${f.fix}`);
  L.push('', `### 编辑视角评估${r.eval.model ? '（' + r.eval.model + '）' : ''}`);
  L.push(evalText || '（所有审稿模型都没给出有效结果，本次没有这一部分）');
  return L.join('\n') + '\n';
}
