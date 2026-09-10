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
