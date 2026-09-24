// 每写完一批之后的【代码级收尾】：排版矫正 + 章号查重。
//
// 为什么单独抽出来：这两件事原来的落点都不对。
//
// ① 排版矫正闸（deslop）本来只挂在 cowrite.mjs 和 statelessWriter.mjs 上，
//    【长驻窗口 + autopilot 续写】这条主路径一次都没跑过。结果就是《走进修仙》那本
//    攒出 85 章「……」超标——闸写了，主路径绕过了它，一路攒到发布前才被复检发现，
//    最后只能事后一次性扫 103 章。闸的意义就是"写完立刻矫正"，事后补扫是下策。
//
// ② 章号重复从来没有代码级检查。《大宋第一女帝》那本因为开写指令没写起点，
//    第二次点「开始写作」从 001 重来，chapter_index.md 里两个 001、两个 002
//    并排登记成"已写"，没有任何一环发现——直到作者自己看出来。
//    起点那个坑已经修了，但"撞号"这件事本身仍然值得有一道独立的探测：
//    重号的成因不止一种（手工改名、导入归档、两个 agent 抢写都可能撞）。
import fs from 'node:fs';
import path from 'node:path';
import { deslopRange } from './deslop.mjs';
import { pacingGate } from './pacing.mjs';
import { snapshotGate } from './ledgersnap.mjs';

// 扫出重复章号。返回 [{ num, files:[...] }, ...]，没有重号就是空数组。
export function findDuplicateChapters(bookDir) {
  const root = path.join(bookDir, 'chapters');
  const byNum = new Map();
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.txt')) continue;
      const m = e.name.match(/^(\d{1,4})/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num).push(path.relative(bookDir, p));
    }
  };
  walk(root);
  return [...byNum.entries()]
    .filter(([, files]) => files.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([num, files]) => ({ num, files }));
}

// 一批写完后跑：先矫正排版，再查重号。两件都是 best-effort，绝不打断写作循环。
// from/to 给 0 表示"这批的范围算不出来"，那就只查重号、不动排版（宁可不矫正，也不能误伤整本）。
export function afterBatch(book, { from = 0, to = 0, onLog = () => {} } = {}) {
  const out = { deslopped: 0, dupes: [] };
  if (!book?.dir) return out;

  if (from > 0 && to >= from) {
    try {
      const r = deslopRange(book.dir, from, to, (e) => onLog({ ...e, source: 'deslop' }));
      out.deslopped = r?.touched || 0;
    } catch (e) {
      // 矫正失败要说出来。静默吞掉的代价就是 85 章超标没人知道。
      onLog({ level: 'warn', source: 'deslop', msg: `排版矫正没跑成（${e.message}）——这一批的「……」与逐句换行没有被矫正，请留意` });
    }
  }

  try {
    const dupes = findDuplicateChapters(book.dir);
    out.dupes = dupes;
    if (dupes.length) {
      const head = dupes.slice(0, 5).map(d => `第${String(d.num).padStart(3, '0')}章(${d.files.length}个文件)`).join('、');
      onLog({
        level: 'warn', source: 'chapters',
        msg: `⚠️ 发现重复章号：${head}${dupes.length > 5 ? ` 等 ${dupes.length} 处` : ''}。`
          + '同一章号有多个正文文件，索引与台账会各写各的、发布也会错乱——请人工确认留哪一版，删掉多余的那份。',
      });
    }
  } catch {}
  return out;
}

// ── 写后闸（窗口模式）────────────────────────────────────────────
// 【这一块补的是什么洞】三道写后闸里，deslop 上面已经接了（afterBatch），
// 但【节奏闸 pacing】和【台账快照闸 ledgersnap】只挂在 statelessWriter.mjs 与
// cowrite.mjs 上，长驻窗口 + autopilot 这条主路径一次都没跑过。
//
// 代价是可量的。2026-09-24 查《重生三国，我吕布杀出一片天》151 章（全部窗口模式写的）：
//   · 数目堆砌 36 章超标，最密的第 35 章【每 51 字一个数】，读起来是后勤台账不是小说；
//   · 单章字数 13 章不足 3000、22 章超 3600；
//   · 4 章章末是「一场……已然悄然拉开了……大幕！」这种预告腔假钩子；
//   · 台账当前态快照停在第 149 章，落后实际 2 章。
// 这四样【全都是节奏闸与快照闸本来就会拦下的】。闸写了，主路径绕过了它。
//
// 【与无状态模式的差别：不能 await 作者】那边作者是 headless 进程，可以跑完再复检；
// 这边作者是活在 pane 里的 agent，指令发出去就得等下一拍。所以这里的复检靠【下一次循环】：
// 自纠完成后 autopilot 再次空闲时会重跑这道闸，改干净了自然放行。
//
// 【防死循环】同一个批次范围最多退回 maxNudge 次（默认 1，与无状态模式的"只自纠一轮"一致）。
// 超了就放行并留一条 warn——闸卡死写作比闸漏掉更糟。
const nudges = new Map();   // key: slug|from-to  → 已退回次数

export function resetBatchGateNudges(slug) {
  for (const k of [...nudges.keys()]) if (k.startsWith(slug + '|')) nudges.delete(k);
}

// 返回需要作者【就地自纠】的指令；没问题（或已达重催上限）返回 null。
// from/to = 这一批新写的章号区间；to<=0 表示这批没写出新章，直接放行。
export function batchGateInstruction(book, { slug, from = 0, to = 0, cfg = {}, onLog = () => {}, maxNudge = 1 } = {}) {
  if (!book?.dir || !(to > 0)) return null;
  const key = (slug || book.slug || book.dir) + '|' + from + '-' + to;
  const used = nudges.get(key) || 0;

  const instrs = [];
  // ⏱ 节奏闸：只量不改——拆章要起章名、补爽点要写情节，代码写不出来，只有作者动笔。
  if (cfg?.pacing?.enabled !== false) {
    try {
      const std = { ...(book.standards || {}), hardMax: cfg?.pacing?.hardMax || 6000 };
      const g = pacingGate(book.dir, from > 0 ? from : 1, to, (e) => onLog({ ...e, source: 'pacing' }),
        { std, warnAlso: cfg?.pacing?.strict === true });
      if (g?.instruction) instrs.push(g.instruction);
    } catch (e) { onLog({ level: 'warn', source: 'pacing', msg: '节奏闸异常（不阻断）：' + (e.message || e) }); }
  }
  // 📌 快照闸：台账顶部的「当前态快照」是下一批唯一读得到的状态，过期 = 后面每章都照旧账写。
  try {
    const g = snapshotGate(book.dir, to, (e) => onLog({ ...e, source: 'ledger' }), { book });
    if (g?.instruction) instrs.push(g.instruction);
  } catch (e) { onLog({ level: 'warn', source: 'ledger', msg: '快照闸异常（不阻断）：' + (e.message || e) }); }

  if (!instrs.length) { nudges.delete(key); return null; }
  if (used >= maxNudge) {
    onLog({ level: 'warn', source: 'pacing',
      msg: `写后闸仍未过，已达重催上限（${maxNudge} 次）→ 放行第 ${from}-${to} 章（请人工留意，详见 reviews/节奏体检）` });
    return null;
  }
  nudges.set(key, used + 1);
  // 两道都没过就合成一条——分两次发会让 agent 做完第一件事就以为交差了
  if (instrs.length === 1) return instrs[0];
  const NL = String.fromCharCode(10);
  const SEP = NL + NL + '────────' + NL + NL;
  return instrs.join(SEP) + NL + NL + '以上两件事【都要做完】再继续写新章。';
}
