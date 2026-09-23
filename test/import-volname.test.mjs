// 导入的书没有卷名：2026-09-20 查《岳飞：这一世，我不做忠臣》时发现——
// 番茄上七卷名字全在（"第一卷：靖康之耻，雪夜狂刀"…），导进来却一个都没留，
// 体检报「7 个卷还没有卷名」，建卷那一步就会卡住。
// 卷名在导入时是拿到手的（plan[].volName），只是落盘时只用了卷号。这里把「留下卷名」钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { volSubOf } from '../src/import_fanqie.mjs';
import { writeVolNameToBible } from '../src/volname.mjs';
import { bibleVolSubtitle } from '../src/publish.mjs';

test('volSubOf：从番茄卷名里剥出副标题（岳飞那本的真实七卷）', () => {
  assert.equal(volSubOf('第一卷：靖康之耻，雪夜狂刀'), '靖康之耻，雪夜狂刀');
  assert.equal(volSubOf('第二卷：孤军转战，裂土太行'), '孤军转战，裂土太行');
  assert.equal(volSubOf('第五卷：光复燕云'), '光复燕云');
  assert.equal(volSubOf('第七卷：万国来朝，盛世华章'), '万国来朝，盛世华章');
});

test('volSubOf：卷号的几种写法都要剥干净，别把数字漏进副标题', () => {
  assert.equal(volSubOf('卷01 静海旧火'), '静海旧火');
  assert.equal(volSubOf('卷03_煤山夺命'), '煤山夺命');
  assert.equal(volSubOf('第四卷《饮马黄河》'), '饮马黄河');
  assert.equal(volSubOf('第十二卷：天下一统'), '天下一统');
});

test('volSubOf：只有序号、没有副标题的，不要硬造一个名字', () => {
  assert.equal(volSubOf('第一卷'), '');
  assert.equal(volSubOf('卷01'), '');
  assert.equal(volSubOf(''), '');
  assert.equal(volSubOf(null), '');
});

test('剥出来的卷名写进 bible 后，体检那条路（bibleVolSubtitle）必须读得回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impvol-'));
  fs.writeFileSync(path.join(dir, 'novel_bible.md'), '# 设定圣经\n\n## 基本盘\n- 主角：\n');
  const book = { dir };
  const names = [
    '第一卷：靖康之耻，雪夜狂刀',
    '第二卷：孤军转战，裂土太行',
    '第五卷：光复燕云',
  ];
  const nums = [1, 2, 5];
  names.forEach((n, i) => writeVolNameToBible(book, nums[i], volSubOf(n)));

  assert.equal(bibleVolSubtitle(book, 1), '靖康之耻，雪夜狂刀');
  assert.equal(bibleVolSubtitle(book, 2), '孤军转战，裂土太行');
  assert.equal(bibleVolSubtitle(book, 5), '光复燕云');
  // 没登记的卷仍然是空——不能因为写了别的卷就误报有名字
  assert.equal(bibleVolSubtitle(book, 3), '');
});
