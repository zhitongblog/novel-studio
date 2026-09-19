// 卷名解析：2026-09-19 全书架扫描时抓到的三类误读，逐个钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanVolSub, outlineVolSubtitle, bibleVolSubtitle } from '../src/publish.mjs';

function mkBook({ outlines = {}, bible = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volname-'));
  fs.mkdirSync(path.join(dir, 'outlines'));
  for (const [f, body] of Object.entries(outlines)) fs.writeFileSync(path.join(dir, 'outlines', f), body);
  fs.writeFileSync(path.join(dir, 'novel_bible.md'), bible);
  return { dir };
}

test('cleanVolSub：去书名号、去"分章大纲"，只剩这些字眼的不算卷名', () => {
  assert.equal(cleanVolSub('《摇篮里的神明》'), '摇篮里的神明');
  assert.equal(cleanVolSub('分章'), '');
  assert.equal(cleanVolSub('静海旧火分章大纲'), '静海旧火');
  assert.equal(cleanVolSub(''), '');
});

test('大纲 H1「# 卷01 分章大纲」不能被读成卷名"分章"（大乾/修仙/岛国卷1 都中过）', () => {
  const b = mkBook({ outlines: { '卷01分章大纲.md': '# 《大乾女帝贴身神探》卷01 分章大纲\n' } });
  assert.equal(outlineVolSubtitle(b, 1), '');
});

test('大纲文件名带书名号：卷01《摇篮里的神明》分章大纲.md → 摇篮里的神明（不带《》）', () => {
  const b = mkBook({ outlines: { '卷01《摇篮里的神明》分章大纲.md': '# x\n' } });
  assert.equal(outlineVolSubtitle(b, 1), '摇篮里的神明');
});

test('bible「卷01：从「…」→「…」」是本卷弧线，不是卷名', () => {
  const b = mkBook({ bible: '- 卷01：从「被软禁在翠云宫、连御膳房都克扣他口粮的傀儡御门」→「亲手扳倒幕府」\n' });
  assert.equal(bibleVolSubtitle(b, 1), '');
  const c = mkBook({ bible: '- 卷01：从「」→「」\n' });
  assert.equal(bibleVolSubtitle(c, 1), '');
});

test('bible 带章节范围和加粗：卷01（001–120）：**天上十一根杆**', () => {
  const b = mkBook({ bible: '  - 卷01（001–120）：**天上十一根杆**\n- 卷01（001–120）：从「废柴」→「金丹」\n' });
  assert.equal(bibleVolSubtitle(b, 1), '天上十一根杆');
});

test('bible 常规写法照旧：卷02《四岛归旗》 / 第三卷：潜龙在渊', () => {
  const b = mkBook({ bible: '卷02《四岛归旗》：…\n### 第三卷：潜龙在渊\n' });
  assert.equal(bibleVolSubtitle(b, 2), '四岛归旗');
  assert.equal(bibleVolSubtitle(b, 3), '潜龙在渊');
});
