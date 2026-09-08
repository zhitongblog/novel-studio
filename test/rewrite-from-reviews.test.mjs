// 「按复检报告重写」自测。
//
// 断点在哪：复检把问题写进 reviews/*.md，但重写指令【完全不知道报告存在】——
// 它只接受一段自由文本「重点要求」，等于要作者把报告里那一条人肉复制粘贴过来。
// 《走进修仙》那本的报告已经十一轮、一千两百多行，翻起来比重写还累。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRewriteInstruction, reviewFilesOf } from '../src/planner.mjs';

// 造一本临时书：reviews/ 下放三份报告 + 一个非 md 干扰文件
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-rw-'));
fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
fs.writeFileSync(path.join(dir, 'reviews', '复检-全书.md'), '# 复检\n§2.12 018 章整章错位\n', 'utf8');
fs.writeFileSync(path.join(dir, 'reviews', '复检-051-086.md'), '# 复检\nY13 骨密度口径\n', 'utf8');
fs.writeFileSync(path.join(dir, 'reviews', '104-106内容自检.md'), '# 自检\n', 'utf8');
fs.writeFileSync(path.join(dir, 'reviews', 'notes.txt'), '不是 md，不该被列进去', 'utf8');
const book = { title: '走进修仙：我把金丹练成了核反应', dir };

console.log('— 报告清单 —');
const files = reviewFilesOf(book);
assert.deepStrictEqual(files, ['104-106内容自检.md', '复检-051-086.md', '复检-全书.md'], '只列 .md 且排序稳定');
console.log('✓ 列出', files.join('、'));
assert.deepStrictEqual(reviewFilesOf({ dir: path.join(dir, '不存在') }), [], 'reviews/ 不存在时给空数组，别抛');
console.log('✓ 没有 reviews/ 目录时返回空数组');

console.log('— 勾上「按复检报告重写」—');
const on = buildRewriteInstruction(book, '018-018', '', { useReviews: true });
for (const [what, needle] of [
  ['告诉它报告在哪', 'reviews/'],
  ['把文件名列出来', '复检-全书.md'],
  ['要它按本范围检索条目', '范围 018-018'],
  ['列成必办清单', '必须解决的清单'],
  ['重写后逐条核对', '逐条核对'],
  ['报告可能过期', '可能已经过期'],
  ['冲突时以正文与 bible 为准', '以正文与 bible 为准'],
]) {
  assert.ok(on.includes(needle), `缺少「${what}」`);
  console.log(`✓ ${what}`);
}
assert.ok(on.indexOf('第0步') < on.indexOf('第一步'), '读报告要排在通读 bible 之前');
console.log('✓ 读报告排在第一步之前');

console.log('— 不勾 —');
const off = buildRewriteInstruction(book, '018-018', '', { useReviews: false });
assert.ok(!off.includes('reviews/'), '不勾时不该提报告');
assert.ok(off.includes('推倒重写'), '其余指令照旧');
console.log('✓ 不勾时指令与原来一致');

console.log('— 重点要求仍然生效，且能与报告并存 —');
const both = buildRewriteInstruction(book, '051-086', '只处理换骨那一条', { useReviews: true });
assert.ok(both.includes('只处理换骨那一条') && both.includes('reviews/'), '两者不能互斥');
console.log('✓ 重点要求 + 报告清单可以同时给');

console.log('— 指令必须是单行（多行会被 agent 当草稿等回车）—');
assert.ok(!/[\r\n]/.test(on), '指令里不能有换行');
console.log('✓ 单行');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n全部通过 ✅  复检发现 → 报告落盘 → 重写自动读回来，不用人搬');
