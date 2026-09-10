// 每批写完的代码级收尾自测：排版矫正 + 章号查重。
//
// 两件事原来的落点都不对：
// ① 排版矫正闸（deslop）只挂在 cowrite / statelessWriter 上，【长驻窗口 + autopilot 续写】
//    这条主路径一次都没跑过 → 《走进修仙》攒出 85 章「……」超标，发布前才被复检发现，
//    最后只能事后一次性扫 103 章。闸的意义是"写完立刻矫正"，事后补扫是下策。
// ② 章号重复从来没有代码级检查 → 《大宋第一女帝》两个 001、两个 002 并排登记成"已写"，
//    没有一环发现，直到作者自己看出来。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterBatch, findDuplicateChapters } from '../src/afterbatch.mjs';

function mkBook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ab-'));
  fs.mkdirSync(path.join(dir, 'chapters', '卷01'), { recursive: true });
  return dir;
}
const wr = (dir, name, body) => fs.writeFileSync(path.join(dir, 'chapters', '卷01', name), body, 'utf8');

console.log('— 章号查重 —');
{
  const dir = mkBook();
  wr(dir, '001红烛未剪.txt', '正文一');
  wr(dir, '001新妇不睡.txt', '正文二');
  wr(dir, '002火印.txt', '正文三');
  wr(dir, '002西壁第三格.txt', '正文四');
  wr(dir, '003不存在的年号.txt', '正文五');
  const d = findDuplicateChapters(dir);
  assert.strictEqual(d.length, 2, '001 和 002 各重了一次');
  assert.deepStrictEqual(d.map(x => x.num), [1, 2], '按章号排序');
  assert.strictEqual(d[0].files.length, 2);
  console.log(`✓ 抓出 ${d.map(x => '第' + x.num + '章').join('、')} 重号`);

  const logs = [];
  afterBatch({ dir }, { from: 0, to: 0, onLog: (e) => logs.push(e) });
  const warn = logs.find(e => e.level === 'warn' && String(e.msg).includes('重复章号'));
  assert.ok(warn, '重号必须报警，不能静默——静默正是当初没人发现的原因');
  assert.ok(warn.msg.includes('请人工确认留哪一版'), '要告诉作者怎么办，不只是报个错');
  console.log('✓ 报警文案：' + warn.msg.slice(0, 46) + '…');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— 没有重号时安静 —');
{
  const dir = mkBook();
  wr(dir, '001甲.txt', '正文'); wr(dir, '002乙.txt', '正文');
  assert.deepStrictEqual(findDuplicateChapters(dir), []);
  const logs = [];
  afterBatch({ dir }, { from: 0, to: 0, onLog: (e) => logs.push(e) });
  assert.ok(!logs.some(e => String(e.msg).includes('重复章号')), '没重号就别吵');
  console.log('✓ 无重号 → 不报警');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— 排版矫正真的会跑 —');
{
  const dir = mkBook();
  // 一章「……」雪球 + 逐句成段
  const sick = ['他站住了……', '', '风停了……', '', '远处有人在笑……', '', '那笑声很轻……'].join('\n');
  wr(dir, '005病章.txt', sick);
  const before = (fs.readFileSync(path.join(dir, 'chapters', '卷01', '005病章.txt'), 'utf8').match(/…+/g) || []).length;
  const logs = [];
  const r = afterBatch({ dir }, { from: 5, to: 5, onLog: (e) => logs.push(e) });
  const after = (fs.readFileSync(path.join(dir, 'chapters', '卷01', '005病章.txt'), 'utf8').match(/…+/g) || []).length;
  assert.ok(before > after, `省略号该被压下去：${before} → ${after}`);
  console.log(`✓ 第005章「……」${before} → ${after}，矫正 ${r.deslopped} 章`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— 算不出批次范围时只查重号、不动排版 —');
{
  const dir = mkBook();
  const sick = ['他站住了……', '', '风停了……'].join('\n');
  wr(dir, '005病章.txt', sick);
  const r = afterBatch({ dir }, { from: 0, to: 0, onLog: () => {} });
  assert.strictEqual(r.deslopped, 0, '范围不明时宁可不矫正，也不能误伤整本');
  const still = fs.readFileSync(path.join(dir, 'chapters', '卷01', '005病章.txt'), 'utf8');
  assert.ok(still.includes('……'), '正文未被改动');
  console.log('✓ from/to 为 0 → 不动正文');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— 书目录不存在也不能抛 —');
assert.deepStrictEqual(afterBatch({ dir: path.join(os.tmpdir(), '不存在的书') }, {}).dupes, []);
assert.deepStrictEqual(afterBatch({}, {}), { deslopped: 0, dupes: [] });
console.log('✓ 目录缺失 / 没有 book 都安全返回');

console.log('\n全部通过 ✅  写完一批就矫正排版、顺手查重号，不再攒到发布前');
