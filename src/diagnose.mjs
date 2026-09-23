// 通用诊断：不依赖番茄签约页，任何一本书都能问一句「这书到底哪儿不行」。
//
// 已有的 signrun.mjs 是【签约诊断】：要连番茄、要读签约时间线、要知道被拒几次。
// 可作者手上多数书要么没上番茄，要么还没被拒过——那条路用不了，而问题一样存在。
// 这里把「客观指标 + 换个模型当责编读开头」抽出来，做成对任何书都成立的诊断：
//   · 指标部分复用 signdiag.objectiveFindings（段落长度/对话占比/省略号那套已经量好了）
//   · 文风部分复用 stylegate.styleScan（套话/堆砌/比喻/感官）
//   · 判断部分让另一个模型读【黄金三章 + 若干抽样章】，出必办清单
// 产出与签约诊断同构：reviews/改造诊断.md + 一份结构化 mustFix，供改造流水线当指令用。
import fs from 'node:fs';
import path from 'node:path';
import { listBookChapters, objectiveFindings } from './signdiag.mjs';
import { styleScan } from './stylegate.mjs';
import { reviewerCandidates, runModelOnceAsync, stripNoise, invalidReview } from './editor.mjs';

export function buildDiagnosePrompt(book, chapters, objective, style) {
  const read = (c, max = 5000) => { try { const t = fs.readFileSync(c.file, 'utf8'); return t.length > max ? t.slice(0, max) + '\n……（截断）' : t; } catch { return ''; } };
  const golden = chapters.slice(0, 3);
  const rest = chapters.slice(3);
  const pick = rest.length <= 3 ? rest : [rest[Math.floor(rest.length * 0.3)], rest[Math.floor(rest.length * 0.6)], rest[rest.length - 1]];
  const metric = (objective.findings || []).map(f => `- [${f.level === 'bad' ? '硬伤' : '偏差'}] ${f.text}`).join('\n');
  const st = style.chapters.length ? (() => {
    const sum = (k) => style.chapters.reduce((s, c) => s + (Array.isArray(c[k]) ? c[k].length : c[k]), 0);
    return `比喻 ${sum('similes')} 处、形容词堆砌 ${sum('piles')} 句、叙述套话 ${sum('tics')} 次（共 ${style.chapters.length} 章）`;
  })() : '（未扫描）';
  return [
    `你是网文资深责编。下面这本书《${book.title}》请你判断【它现在最大的问题是什么、该怎么改】。`,
    `分类：${book.category ? book.category.channel + ' · ' + book.category.mainCategory : '（未填）'}`,
    `简介：${book.synopsis || '（没有写简介）'}`,
    '',
    '# 已经量好的客观指标（别再数一遍，直接用）',
    metric || '（无明显指标问题）',
    '文风指标：' + st,
    '',
    '# 你要回答的（按顺序，逐条）',
    '1. 黄金三章：第一章前 500 字有没有具体的冲突或悬念？主角是谁、他的金手指/特别之处是什么，在前三章亮出来了没有？',
    '2. 卖点兑现：书名和简介承诺的东西，正文里来得够不够早、给得够不够足？说清楚"承诺了什么、正文实际给了什么"。',
    '3. 爽点节奏：每 2–3 章有没有一次读者能感到的进展或胜利？还是长时间铺垫不兑现？',
    '4. 人物：主角有没有被写成万年平静；配角会不会降智给主角让路。',
    '5. 硬伤：时代/设定错位（明清称谓用在汉代这类）、逻辑对不上、前后矛盾。',
    '',
    '# 输出格式（严格遵守，我要拿去直接当改稿指令）',
    '先写若干行必办项，每行：[必改] 问题（一句说清）→ 具体怎么改（落到第几章、改成什么）',
    '再写若干行建议项，每行：[建议] …→…',
    '最后两行：',
    '【一句话结论】…',
    '【最该先改的三章】第N章、第N章、第N章',
    '不要复述剧情、不要夸、不要写前言。',
    '',
    '# 正文（黄金三章 + 抽样）',
    ...golden.map(c => `\n=== 第${c.num}章 ${c.name} ===\n${read(c)}`),
    ...pick.map(c => `\n=== 第${c.num}章 ${c.name}（抽样）===\n${read(c, 3000)}`),
  ].join('\n');
}

export function parseDiagnose(text) {
  const must = [], advice = [];
  let verdict = '', firstFix = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let m = s.match(/^[-*\s]*\[?必改\]?[:：]?\s*(.+)$/);
    if (m && /→|->/.test(m[1])) { must.push(m[1].trim()); continue; }
    m = s.match(/^[-*\s]*\[?建议\]?[:：]?\s*(.+)$/);
    if (m && /→|->/.test(m[1])) { advice.push(m[1].trim()); continue; }
    m = s.match(/^【一句话结论】\s*(.+)$/);
    if (m) { verdict = m[1].trim(); continue; }
    m = s.match(/^【最该先改的三章】\s*(.+)$/);
    if (m) { firstFix = [...m[1].matchAll(/(\d+)/g)].map(x => +x[1]); continue; }
  }
  return { must, advice, verdict, firstFix };
}

// 主流程。sample：抽样看多少章（默认前 20 章，黄金三章必看）
export async function diagnoseBook(book, { cfg, sample = 20, model = null, onLog = () => {} } = {}) {
  const all = listBookChapters(book);
  if (!all.length) return { ok: false, error: '这本书还没有正文' };
  const scope = all.filter(c => c.num <= sample);
  const objective = objectiveFindings(scope);
  const style = styleScan(book.dir, 1, Math.min(sample, all[all.length - 1].num));

  const cands = model ? [model] : reviewerCandidates(book.model, cfg);
  if (!cands.length) return { ok: false, error: '没有可用的诊断模型（需要一个能无头跑的 CLI 模型）' };
  const prompt = buildDiagnosePrompt(book, scope, objective, style);

  let raw = '', used = null;
  for (const m of cands) {
    onLog({ level: 'act', msg: `让 ${m} 以责编视角读第 1–${scope[scope.length - 1].num} 章…` });
    try {
      const out = stripNoise(await runModelOnceAsync(m, prompt, cfg, Math.max(cfg?.editorReview?.timeoutMs || 0, 600000)));
      if (invalidReview(out, prompt)) { onLog({ level: 'warn', msg: `${m} 的诊断无效（横幅/回声/空壳），换下一个` }); continue; }
      raw = out; used = m; break;
    } catch (e) { onLog({ level: 'warn', msg: `${m} 诊断失败：${String(e.message || e).slice(0, 80)}` }); }
  }
  if (!raw) return { ok: false, error: '所有模型都没给出有效诊断' };

  const parsed = parseDiagnose(raw);
  // 指标发现的硬伤直接并进必办清单——这些是量出来的，比模型说的更硬
  const fromMetrics = (objective.findings || []).filter(f => f.level === 'bad').map(f => f.text);
  const styleBad = style.chapters.filter(c => c.bad?.length).slice(0, 8).map(c => `第${c.num}章 ${c.bad.join('；')}`);

  const dir = path.join(book.dir, 'reviews');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const md = [
    `# 改造诊断《${book.title}》`,
    `诊断模型：${used}　生成：${new Date().toLocaleString('zh-CN')}　范围：第 1–${scope[scope.length - 1].num} 章`,
    '',
    parsed.verdict ? `## 一句话结论\n${parsed.verdict}\n` : '',
    fromMetrics.length ? '## 指标量出来的硬伤\n' + fromMetrics.map(t => '- ' + t).join('\n') + '\n' : '',
    styleBad.length ? '## 文风指标不达标的章\n' + styleBad.map(t => '- ' + t).join('\n') + '\n' : '',
    parsed.must.length ? '## 必办（改造流水线会照着这个改）\n' + parsed.must.map(t => '- [必改] ' + t).join('\n') + '\n' : '',
    parsed.advice.length ? '## 建议\n' + parsed.advice.map(t => '- [建议] ' + t).join('\n') + '\n' : '',
    parsed.firstFix.length ? `## 最该先改的三章\n第 ${parsed.firstFix.join('、')} 章\n` : '',
    '\n---\n<details><summary>模型原文</summary>\n\n```\n' + raw.slice(0, 20000) + '\n```\n</details>\n',
  ].filter(Boolean).join('\n');
  const fp = path.join(dir, '改造诊断.md');
  fs.writeFileSync(fp, md, 'utf8');
  onLog({ level: 'act', msg: `诊断完成：必办 ${parsed.must.length} 条、建议 ${parsed.advice.length} 条 → ${path.relative(book.dir, fp)}` });

  return { ok: true, model: used, file: fp, must: parsed.must, advice: parsed.advice, verdict: parsed.verdict, firstFix: parsed.firstFix, metrics: fromMetrics, styleBad };
}
