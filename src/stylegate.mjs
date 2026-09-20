// 文风闸（确定性、不靠模型自觉）：治「辞藻堆砌 + 套话 + 比喻泛滥」，同时【防止越改越干】。
//
// 由来（2026-09-20 王莽这本书的实战）：番茄签约评估拒了两次，总评原话是
// 「辞藻堆砌、浓重的AI腔」。照着诊断改了一轮，我只按「宛如/犹如/如同/仿佛」计数验收，
// 指标全绿；可真读第 17 章开头，还是
//   「面如土色，浑身战栗，连大气都不敢喘」   ← 一个意思说三遍
//   「森冷的刀芒在昏暗的火光下泛着令人心悸的嗜血杀气」 ← 一个名词摞三层形容词
//   「如铁塔般按刀而立」「目光如鹰隼般」      ← 「…般」这类比喻我根本没数
// 结论：验收指标漏了三类，而这三类恰恰是编辑说的"AI腔"的主体。
//
// 【这个闸是双向的】作者原话：「不要调成了没人看的」。所以除了三条上限，还有两条【下限】：
// 字数不得低于原文 95%、每章至少 2 类具体感官细节。删掉的形容词必须换成动作与细节，
// 而不是删短了事——实测这么改，字数反而涨到 103–108%，读起来更快。
//
// 用法与 pacing.mjs 一致：styleScan → buildStyleFixInstruction → styleGate。
import fs from 'node:fs';
import path from 'node:path';

// 叙述里要清掉的套话。【只管叙述，不管对白】——角色嘴里说套话是性格，不是毛病。
export const TIC_WORDS = [
  '轰然', '面如土色', '战战兢兢', '如遭雷击', '目瞪口呆', '跌跌撞撞', '大气都不敢喘',
  '浑身战栗', '冷汗涔涔', '倒吸一口凉气', '瞳孔骤缩', '嘴角勾起', '眸光', '闻言',
  '电光火石', '躲无可躲', '避无可避', '不寒而栗', '心惊肉跳', '骇然失色', '面色铁青',
  '勃然大怒', '死死地', '狠狠地', '不由得', '缓缓开口',
];
// 具体感官线索：删掉形容词之后要拿这些补回来（气味/温度/声音/疼痛/触感）
const SENSE_WORDS = ['气味', '腥', '腐', '烟', '汗', '冷', '烫', '凉', '疼', '痛', '痒', '涩', '咸', '苦', '响', '嗡', '吱', '咳', '喘', '颤', '黏', '糙'];
// 空钩子词：章末只剩这些字眼而没有具体事件 = 假钩子（pacing.mjs 也有一份，这里只做提示不判死）
const EMPTY_HOOK = ['拉开序幕', '已然拉开', '风雨欲来', '暗流涌动', '好戏开场', '不得而知', '变局', '大幕'];

const zhLen = (s) => (String(s || '').match(/[一-鿿]/g) || []).length;

// 比喻计数：除了「宛如/犹如/如同/仿佛」，还要数「如…般」「似…般」「…似的」——
// 漏掉后者就是我 2026-09-20 踩的坑（第17章「如铁塔般」没被数出来）。
export function countSimiles(text) {
  const a = (text.match(/宛如|犹如|如同|仿佛/g) || []).length;
  const b = (text.match(/如[^，。！？、\s]{1,6}[般似]|似[^，。！？、\s]{1,6}般|[^，。！？\s]{1,5}似的/g) || []).length;
  return a + b;
}

// 形容词堆砌：一个短句里出现 3 个及以上「的」结构。粗，但和人读出来的"堆砌感"高度一致
// （王莽第3章 19 句、第21章 19 句，正是读起来最累的两章）。
export function countPiles(text) {
  return text.split(/[。！？\n]/).filter(s => s.trim().length > 8)
    .filter(s => (s.match(/的/g) || []).length >= 3).length;
}

// 对白之外的正文（套话只在叙述里算）
function narrationOnly(text) {
  return text.split(/\n+/).filter(p => !/[「」『』“”]/.test(p)).join('\n');
}

// 单章体检
export function inspectStyle(fp, num) {
  const raw = fs.readFileSync(fp, 'utf8');
  const paras = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const narration = narrationOnly(raw);
  const last = paras[paras.length - 1] || '';
  const chars = zhLen(raw);
  return {
    num,
    title: path.basename(fp).replace(/\.txt$/, ''),
    chars,
    avgPara: paras.length ? Math.round(chars / paras.length) : 0,
    similes: countSimiles(raw),
    piles: countPiles(raw),
    tics: TIC_WORDS.filter(w => narration.includes(w)),
    senses: SENSE_WORDS.filter(w => raw.includes(w)).length,
    exclaimQ: (raw.match(/？！/g) || []).length,
    emptyHook: EMPTY_HOOK.filter(w => last.includes(w)),
  };
}

// 默认阈值。可按书覆盖（std）。
export const STYLE_STD = {
  maxSimiles: 3,       // 每章比喻上限
  maxPiles: 5,         // 每章形容词堆砌句上限
  maxTics: 0,          // 叙述里的套话：一个都不许留
  minSenses: 2,        // 每章至少两类具体感官细节  ← 防止改干
  maxAvgPara: 40,      // 每段不超过手机三行
  maxExclaimQ: 1,      // 「？！」每章最多一处
  minKeepPct: 95,      // 改后字数不得低于改前的 95%  ← 防止改干
};

// 扫一段章号区间。before：{章号: 改前正文} —— 有它才能判"字数掉了"和"根本没改"。
export function styleScan(bookDir, from, to = 0, { std = {}, before = null } = {}) {
  const S = { ...STYLE_STD, ...std };
  const dir = path.join(bookDir, 'chapters');
  const files = [];
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = e.name.match(/^(\d{1,4})/);
      if (!m || !e.name.toLowerCase().endsWith('.txt')) continue;
      const n = parseInt(m[1], 10);
      if (n >= from && (!to || n <= to)) files.push({ num: n, path: p });
    }
  };
  walk(dir);
  files.sort((a, b) => a.num - b.num);

  const chapters = [], issues = [];
  for (const f of files) {
    let c; try { c = inspectStyle(f.path, f.num); } catch { continue; }
    const was = before && before[c.num] != null ? before[c.num] : null;
    if (was != null) {
      const wasChars = zhLen(was);
      c.wasChars = wasChars;
      c.keepPct = wasChars ? Math.round(c.chars / wasChars * 100) : null;
      c.unchanged = was === fs.readFileSync(f.path, 'utf8');
    }
    const bad = [];
    if (c.unchanged) bad.push('根本没改');
    if (c.keepPct != null && c.keepPct < S.minKeepPct) bad.push(`字数只剩 ${c.keepPct}%（不得低于 ${S.minKeepPct}%）`);
    if (c.tics.length > S.maxTics) bad.push(`叙述里还有套话：${c.tics.slice(0, 5).join('、')}`);
    if (c.piles > S.maxPiles) bad.push(`形容词堆砌 ${c.piles} 句（上限 ${S.maxPiles}）`);
    if (c.similes > S.maxSimiles) bad.push(`比喻 ${c.similes} 处（上限 ${S.maxSimiles}）`);
    if (c.senses < S.minSenses) bad.push(`具体感官细节只有 ${c.senses} 类（至少 ${S.minSenses}）——别把描写删空了`);
    if (c.avgPara > S.maxAvgPara) bad.push(`平均每段 ${c.avgPara} 字（上限 ${S.maxAvgPara}）`);
    if (c.exclaimQ > S.maxExclaimQ) bad.push(`「？！」${c.exclaimQ} 处（上限 ${S.maxExclaimQ}）`);
    c.bad = bad;
    if (bad.length) issues.push({ num: c.num, level: c.unchanged ? 'error' : 'warn', msg: `第${c.num}章：${bad.join('；')}` });
    if (c.emptyHook.length) c.hint = `章末像空钩子（${c.emptyHook.join('、')}）——指标判不了，留给阅读复核`;
    chapters.push(c);
  }
  const ok = issues.length === 0;
  return { from, to, std: S, chapters, issues, ok };
}

// 把扫描结论写成给模型的返工指令。只说这一批真的犯了的毛病，不念全套规则。
export function buildStyleFixInstruction(scan) {
  const bad = scan.chapters.filter(c => c.bad?.length);
  if (!bad.length) return '';
  const S = scan.std;
  const lines = bad.map(c => `第${c.num}章：${c.bad.join('；')}`);
  return [
    `【上一轮这几章没达标，只改这几章，别动别的】${lines.join('。')}`,
    '【怎么改】同义三连只留一处，最好换成具体动作（「他的手在袖子里抖」胜过「浑身战栗」）；'
    + '一个名词上不要摞三层形容词；套话在叙述里一个不留，人物对白里可以保留',
    `【删了要补回来】字数不得低于原文 ${S.minKeepPct}%：把删掉的辞藻换成气味、温度、声音、疼痛、触感这类具体细节，`
    + '以及人物的小动作。严禁靠拉长环境描写或重复叙述凑字数',
    '【一场戏都不许砍】剧情、人物、对白内容、已埋伏笔全部保留，只调语言',
  ].join('。');
}

// 写一份人能看的报告到 reviews/
export function writeStyleReport(bookDir, scan, tag = '') {
  const dir = path.join(bookDir, 'reviews');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const S = scan.std;
  const head = `# 文风体检 ${tag}\n生成：${new Date().toLocaleString('zh-CN')}\n\n`
    + `阈值：比喻≤${S.maxSimiles}、堆砌句≤${S.maxPiles}、叙述套话=${S.maxTics}、感官≥${S.minSenses}、均段≤${S.maxAvgPara}、字数≥原文${S.minKeepPct}%\n\n`
    + '| 章 | 字数 | 保留 | 均段 | 比喻 | 堆砌 | 套话 | 感官 | 结论 |\n|---|---|---|---|---|---|---|---|---|\n';
  const rows = scan.chapters.map(c =>
    `| ${c.num} | ${c.chars} | ${c.keepPct != null ? c.keepPct + '%' : '-'} | ${c.avgPara} | ${c.similes} | ${c.piles} | ${c.tics.length} | ${c.senses} | ${c.bad?.length ? '✗ ' + c.bad.join('；') : '✓'}${c.hint ? '（' + c.hint + '）' : ''} |`
  ).join('\n');
  const fp = path.join(dir, `文风体检${tag ? '-' + tag : ''}.md`);
  fs.writeFileSync(fp, head + rows + '\n', 'utf8');
  return fp;
}

// 一步到位：扫 + 记日志 + 出返工指令
export function styleGate(bookDir, from, to, onLog = () => {}, { std = {}, before = null, report = true } = {}) {
  const scan = styleScan(bookDir, from, to, { std, before });
  for (const i of scan.issues) onLog({ level: i.level === 'error' ? 'warn' : 'info', msg: (i.level === 'error' ? '⛔ ' : '⚠ ') + i.msg });
  for (const c of scan.chapters) if (c.hint) onLog({ level: 'info', msg: `第${c.num}章 ${c.hint}` });
  if (report && scan.chapters.length) writeStyleReport(bookDir, scan, `${from}-${to || ''}`);
  return { ok: scan.ok, issues: scan.issues, instruction: buildStyleFixInstruction(scan), scan };
}
