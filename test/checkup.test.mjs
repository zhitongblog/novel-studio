// 体检：把软件【已经知道、但从来没说出口】的异常摆到作者面前。
//
// 由来：2026-09-18 这一天，靠人工翻查才发现的问题——
//   · 大乾女帝：本地写到 525 章，番茄只到 513，12 章没发出去
//   · 大乾女帝：缺第 353、364 章（章名前后连着，是当时跳了号）
//   · 大乾女帝：两周前被错标「已完本」，而完本产物三样全缺、最后一章停在悬念
//   · 穿成王莽：绑的是 agy，每次点写作都会静默改用窗口模式
// 这些结论所需的材料软件全都有（章节在硬盘、publishedMax 在配置、完本产物有 finaledone 查、
// 模型能力有 canRunHeadless 判），缺的只是"有人把它们摆出来"。
//
// 装上后当场又挖出两条我没注意的：《重生之我在岛国当天皇》也缺 3 章、还有 6 章没发。
//
// 核心纪律：【每条信息都要带着它的动作】。只报事实不给出口，等于把活儿又推回给作者。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkupBook } from '../src/checkup.mjs';

function mkBook(chapterNames, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nschk-'));
  const cdir = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(cdir, { recursive: true });
  for (const n of chapterNames) fs.writeFileSync(path.join(cdir, n), '正文若干。');
  return { title: '测试书', slug: '测试书', dir, ...extra };
}
const rm = (b) => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} };
const seq = (n) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, '0') + '_章.txt');
const keyOf = (r, k) => r.items.find(i => i.key === k);

test('章号断档要报出来——这是发布和续写的地基', () => {
  const names = seq(10).filter(n => !/^(003|007)/.test(n));
  const b = mkBook(names);
  try {
    const r = checkupBook(b);
    const it = keyOf(r, 'missing-chapters');
    assert.ok(it, '缺 003/007 必须报');
    assert.equal(it.level, 'bad');
    assert.match(it.text, /3、7/);
    assert.ok(it.action?.label, '必须带动作——只报事实不给出口等于把活儿推回给作者');
  } finally { rm(b); }
});

test('缺得多时不刷屏，只列前几个并说明总数', () => {
  const b = mkBook(['001_章.txt', '050_章.txt']);
  try {
    const it = keyOf(checkupBook(b), 'missing-chapters');
    assert.match(it.text, /等 48 章/, '48 个章号全列出来只会把卡片撑爆');
  } finally { rm(b); }
});

test('章号重复要报——同一个章号两个文件，发布时必然发错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nschk-'));
  fs.mkdirSync(path.join(dir, 'chapters', '卷01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chapters', '卷02'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', '卷01', '001_红烛未剪.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'chapters', '卷02', '001_新妇不睡.txt'), 'x');
  const b = { title: '测试书', dir };
  try {
    const it = keyOf(checkupBook(b), 'dup-chapters');
    assert.ok(it && it.level === 'bad', '两个 001 必须报（《大宋第一女帝》就这么撞过）');
  } finally { rm(b); }
});

test('写了没发要报，并且算清差几章', () => {
  const b = mkBook(seq(525), { publish: { bookId: 'x', publishedMax: 513 } });
  try {
    const it = keyOf(checkupBook(b), 'unpublished');
    assert.match(it.text, /525/);
    assert.match(it.text, /513/);
    assert.match(it.text, /12 章/, '要直接算出差几章，别让作者自己减');
  } finally { rm(b); }
});

test('发齐了就别吵——publishedMax 追平就不该再报', () => {
  const b = mkBook(seq(525), { publish: { bookId: 'x', publishedMax: 525 } });
  try { assert.ok(!keyOf(checkupBook(b), 'unpublished')); } finally { rm(b); }
});

test('标着已完本、却没有完本产物 → 报硬伤', () => {
  const b = mkBook(seq(20), { status: '已完本' });
  try {
    const it = keyOf(checkupBook(b), 'fake-finale');
    assert.ok(it && it.level === 'bad',
      '大乾女帝就是这样：挂着完本的牌子，没有尾声、最后一章停在悬念上，还在往下铺新坑');
    assert.match(it.text, /尾声|全书完|已完结/);
  } finally { rm(b); }
});

test('跑不了省钱模式的模型要提前说，别等它静默换模式', () => {
  const b = mkBook(seq(5), { model: 'agy' });
  try {
    const it = keyOf(checkupBook(b), 'no-headless');
    assert.ok(it, 'agy 凭据不落盘，点写作会被自动改道窗口模式——作者该提前知道，而不是事后困惑');
  } finally { rm(b); }
});

test('能无头跑的模型不要没事找事', () => {
  const b = mkBook(seq(5), { model: 'claude' });
  try { assert.ok(!keyOf(checkupBook(b), 'no-headless')); } finally { rm(b); }
});

test('写了一阵还没在番茄建作品 → 提醒（主分类签约后不可改）', () => {
  const b = mkBook(seq(12));
  try { assert.ok(keyOf(checkupBook(b), 'no-fanqie')); } finally { rm(b); }
});

test('刚起步的书别唠叨——没几章就催建作品是噪音', () => {
  const b = mkBook(seq(3));
  try {
    const r = checkupBook(b);
    assert.ok(!keyOf(r, 'no-fanqie'));
    assert.ok(!keyOf(r, 'no-synopsis'));
  } finally { rm(b); }
});

test('每一条都必须带动作，且指向真实入口', () => {
  const b = mkBook(seq(525).filter(n => !/^050/.test(n)), { status: '已完本', model: 'agy', publish: { bookId: 'x', publishedMax: 500 } });
  try {
    const r = checkupBook(b);
    assert.ok(r.items.length >= 3);
    const kinds = new Set(['cowrite', 'read', 'publish', 'finale', 'synopsis', 'settings']);
    for (const i of r.items) {
      assert.ok(i.action && i.action.label, `「${i.text}」没带动作`);
      assert.ok(kinds.has(i.action.kind), `动作 kind「${i.action.kind}」不在已知入口里——指到不存在的地方等于没有`);
    }
  } finally { rm(b); }
});

test('按轻重排序：该立刻处理的排最前', () => {
  const b = mkBook(seq(30).filter(n => !/^005/.test(n)), { model: 'agy' });
  try {
    const r = checkupBook(b);
    assert.equal(r.items[0].level, 'bad', '硬伤要排在"顺带一提"前面');
  } finally { rm(b); }
});

test('没问题时明确说没问题，而不是空着', () => {
  const b = mkBook(seq(5), { model: 'claude' });
  try {
    const r = checkupBook(b);
    assert.equal(r.items.length, 0);
    assert.equal(r.ok, true);
  } finally { rm(b); }
});

test('体检是只读的——不许动书目录里的任何东西', () => {
  const b = mkBook(seq(6), { status: '已完本', model: 'agy' });
  try {
    const before = fs.readdirSync(path.join(b.dir, 'chapters', '卷01')).sort();
    checkupBook(b);
    const after = fs.readdirSync(path.join(b.dir, 'chapters', '卷01')).sort();
    assert.deepEqual(after, before, '体检改了文件——它只该看，不该动');
  } finally { rm(b); }
});

console.log('\n全部通过 ✅  软件知道的事，终于会主动说出口了');
