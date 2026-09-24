// 阅读复核：换一个模型【只读不量】，专挑指标查不出的毛病。
//
// 为什么非要有这一道（2026-09-20 实证）：王莽第 29 章所有指标全绿——套话 0、堆砌 0、比喻 0、
// 字数 119%——可结尾是
//   「天下大势起伏流转，宿命般的变局，已然悄然拉开序幕。」「他低声自语，语气平定如坚冰。」
// 这正是番茄编辑点名批评过的【空钩子】和【万年平静的主角】。
// 指标闸永远查不出"钩子是空的""这段逻辑接不上""人物突然不像他自己"——那要靠读。
// 所以改造流水线的最后一道不是量，是读。
//
// 复核人 ≠ 作者模型（同一个模型给自己判卷，只会说"很好"）。选人复用 editor.reviewerCandidates
// （已经按能否无头跑 + 近况健康度排过序）。
import fs from 'node:fs';
import path from 'node:path';
import { reviewerCandidates, runModelOnceAsync, stripNoise, invalidReview } from './editor.mjs';

const zhLen = (s) => (String(s || '').match(/[一-鿿]/g) || []).length;

// 取范围内的章节文件
function chaptersInRange(bookDir, from, to) {
  const out = [];
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = e.name.match(/^(\d{1,4})/);
      if (!m || !e.name.toLowerCase().endsWith('.txt')) continue;
      const n = parseInt(m[1], 10);
      if (n >= from && (!to || n <= to)) out.push({ num: n, path: p });
    }
  };
  walk(path.join(bookDir, 'chapters'));
  return out.sort((a, b) => a.num - b.num);
}

export function buildReadPrompt(book, chs) {
  const body = chs.map(c => `\n\n=== 第${c.num}章 ${path.basename(c.path).replace(/^\d+/, '').replace(/\.txt$/, '')} ===\n`
    + fs.readFileSync(c.path, 'utf8').slice(0, 6000)).join('');
  return [
    `你是网文责编，现在【读】《${book.title}》的第${chs[0].num}–${chs[chs.length - 1].num}章，不要做任何统计。`,
    '我已经用程序量过套话、比喻、段落长度这些指标，全部达标——所以【不要再提这些】，提了等于没说。',
    '你要挑的是程序查不出来的四类问题：',
    '① 空钩子：章末是「变局已然拉开」「暗流涌动」这类不着地的话，而不是一件具体的、读者想知道下文的事；',
    '② 逻辑断裂：前后事实对不上、人物知道了他不该知道的事、时间地点前后矛盾；',
    '③ 人物失格：主角永远平静从容、配角降智给主角让路、反派不做正常人会做的反应；',
    '④ 情绪落空：本该爽/紧张/难受的地方没写到位，或者铺垫了没兑现。',
    '',
    '【输出格式】每条一行，严格按：第N章｜类型｜问题｜怎么改（一句话，具体到那一段）',
    '类型只能是：空钩子 / 逻辑 / 人物 / 情绪。没有问题的章不要写。最后单独一行写：总评：<50字以内>',
    '不要写前言、不要复述剧情、不要夸。',
    body,
  ].join('\n');
}

// 解析成结构化条目
export function parseReadReview(text) {
  const items = [];
  let summary = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // 「篇幅」是 2026-09-24 加的第五类：节奏闸量出的字数不足，本来只能报警、没有落实的通路。
    // 加了它之后，pacingScan 的发现可以直接喂进定点修（headless 逐批改、git 存档、改完过文风闸），
    // 不必开窗口挂 autopilot——那会在改完之后接着写新章。
    const m = s.match(/^第\s*(\d+)\s*章\s*[｜|]\s*(空钩子|逻辑|人物|情绪|篇幅)\s*[｜|]\s*([^｜|]+)[｜|]\s*(.+)$/);
    if (m) { items.push({ num: +m[1], kind: m[2], problem: m[3].trim(), fix: m[4].trim() }); continue; }
    const sm = s.match(/^总评[：:]\s*(.+)$/);
    if (sm) summary = sm[1].trim();
  }
  return { items, summary };
}

// 跑一次阅读复核。chunk：一次喂几章（太多会超上下文，太少浪费轮次）
export async function readReview(book, from, to, { cfg, model = null, chunk = 5, onLog = () => {} } = {}) {
  const all = chaptersInRange(book.dir, from, to);
  if (!all.length) return { ok: false, error: `第 ${from}-${to} 章没有正文` };
  const cands = model ? [model] : reviewerCandidates(book.model, cfg);
  if (!cands.length) return { ok: false, error: '没有可用的复核模型（需要一个能无头跑的 CLI 模型）' };

  const items = [], summaries = [];
  let used = null;
  for (let i = 0; i < all.length; i += chunk) {
    const part = all.slice(i, i + chunk);
    const prompt = buildReadPrompt(book, part);
    let got = '';
    for (const m of cands) {
      onLog({ level: 'info', msg: `阅读复核：${m} 读第${part[0].num}–${part[part.length - 1].num}章（${Math.round(part.reduce((s, c) => s + zhLen(fs.readFileSync(c.path, 'utf8')), 0) / 1000)}千字）…` });
      try {
        const raw = stripNoise(await runModelOnceAsync(m, prompt, cfg, cfg?.editorReview?.timeoutMs || 420000));
        // 复用复检那套"这份报告是不是废的"判据：CLI 横幅、把提示词又念一遍、空壳
        if (invalidReview(raw, prompt)) { onLog({ level: 'warn', msg: `${m} 的复核无效（横幅/回声/空壳），换下一个` }); continue; }
        got = raw; used = m; break;
      } catch (e) { onLog({ level: 'warn', msg: `${m} 复核失败：${String(e.message || e).slice(0, 80)}` }); }
    }
    if (!got) continue;
    const r = parseReadReview(got);
    items.push(...r.items);
    if (r.summary) summaries.push(`第${part[0].num}–${part[part.length - 1].num}章：${r.summary}`);
    onLog({ level: 'act', msg: `第${part[0].num}–${part[part.length - 1].num}章读完，挑出 ${r.items.length} 处` });
  }
  if (!used) return { ok: false, error: '所有复核模型都没给出有效结果' };
  return { ok: true, model: used, items, summaries };
}

// 复核结论 → 给改写模型的返工指令（按章聚合，只说这一批）
export function buildReadFixInstruction(items) {
  if (!items?.length) return '';
  const byCh = new Map();
  for (const it of items) byCh.set(it.num, [...(byCh.get(it.num) || []), it]);
  const lines = [...byCh.entries()].sort((a, b) => a[0] - b[0])
    .map(([n, list]) => `第${n}章：` + list.map(i => `【${i.kind}】${i.problem}→${i.fix}`).join('；'));
  return [
    '【责编读完给的意见，逐条落实，只改这些地方，别重写整章】' + lines.join('。'),
    '【空钩子怎么改】章末换成一件具体的事：一封已经送到的信、一个少掉的数目、一个人推门进来，'
    + '让读者想知道下一章会怎样，而不是告诉他"变局拉开了"',
    '【人物怎么改】主角不要永远平静从容，该慌该怒该疼就写出来；配角不许降智给主角让路',
    ...(items.some(i => i.kind === '篇幅') ? [
      // 这一条是节奏闸里那条来之不易的规矩，原样搬过来：
      // 给下限，模型就会去凑数——凑出来的字比短章更糟。
      '【篇幅怎么改】**补的是戏，不是字**：加一个具体场景、一次交锋、一个转折，或让一处代价浮现，'
      + '让这一章多推进一件事。严禁靠复述前情、拉长对话、加形容词、原地绕圈凑字数——那比短章更糟。'
      + '差得少的章（几十字）只把已有的一处写实即可，不要硬塞一整场新戏',
    ] : []),
    '【硬约束】剧情结果与已埋伏笔不变，字数不得变少',
  ].join('。');
}

export function writeReadReport(bookDir, r, tag = '') {
  const dir = path.join(bookDir, 'reviews');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const byKind = {};
  for (const it of r.items || []) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  const head = `# 阅读复核 ${tag}\n复核模型：${r.model || '-'}　生成：${new Date().toLocaleString('zh-CN')}\n\n`
    + `共 ${r.items?.length || 0} 条：` + (Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、') || '无') + '\n\n'
    + (r.summaries?.length ? '## 总评\n' + r.summaries.map(s => '- ' + s).join('\n') + '\n\n' : '')
    + '## 逐条\n| 章 | 类型 | 问题 | 怎么改 |\n|---|---|---|---|\n';
  const rows = (r.items || []).map(i => `| ${i.num} | ${i.kind} | ${i.problem} | ${i.fix} |`).join('\n');
  const fp = path.join(dir, `阅读复核${tag ? '-' + tag : ''}.md`);
  fs.writeFileSync(fp, head + rows + '\n', 'utf8');
  return fp;
}
