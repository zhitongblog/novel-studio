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


// —— 重设计·二：抽屉重排的守则 ——
// 这一批只搬家、不动功能。最大的风险就是【搬丢一个 id】——丢一个就断一个功能，
// 而断了未必当场看得出来（按钮还在，点了没反应）。所以拿测试钉住。

test('五个抽屉都在，且只有「接着写」默认展开', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  for (const id of ['dwWrite', 'dwCheck', 'dwLook', 'dwShip', 'dwSettings']) {
    assert.ok(html.includes(`id="${id}"`), `抽屉 ${id} 不见了`);
  }
  // 只有 dwWrite 带 open：一进门只展开日常主路径，其余收起
  const openOnes = [...html.matchAll(/<details class="drawer[^"]*" id="(\w+)" open>/g)].map(m => m[1]);
  assert.deepEqual(openOnes, ['dwWrite'], 'HTML 里只该有「接着写」默认展开');
});

test('每个控件都落在它该在的抽屉里', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const bodyOf = (id) => {
    const i = html.indexOf(`id="${id}"`);
    const next = html.indexOf('<details', i + 10);
    return html.slice(i, next < 0 ? html.length : next);
  };
  const want = {
    dwWrite: ['btnCowrite', 'btnStart', 'btnStop', 'btnVolPlan', 'btnStudio', 'writeTask', 'btnSend'],
    dwCheck: ['btnRead', 'btnReview', 'btnOutline', 'btnRebuildOutline'],
    dwLook: ['btnVoice', 'btnStyle', 'btnRefStyle', 'btnCover', 'synText'],
    dwShip: ['btnPublish', 'btnFinale', 'btnRewrite'],
    dwSettings: ['writeModel', 'writeMode', 'statelessMode', 'wbTarget'],
  };
  for (const [drawer, ids] of Object.entries(want)) {
    const seg = bodyOf(drawer);
    for (const id of ids) assert.ok(seg.includes(`id="${id}"`), `${id} 不在 ${drawer} 里`);
  }
});

test('不可逆的三件事必须在危险区里，不能跟「阅读」平级', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.ok(/class="drawer danger-zone" id="dwShip"/.test(html), '拿出去那一栏要有 danger-zone');
  for (const id of ['btnPublish', 'btnFinale', 'btnRewrite']) {
    const m = html.match(new RegExp(`<button class="([^"]*)" id="${id}"`));
    assert.ok(m && /danger-out/.test(m[1]),
      `${id} 要带 danger-out：发到番茄读者立刻可见、重写会覆盖已写正文、完本会触发签约流程——` +
      '这三件事以前跟「阅读」长一个样，同样大小同样颜色');
  }
});

test('抽屉开合要记住，但记不住不能崩', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const seg = app.slice(app.indexOf('function initDrawers'));
  assert.ok(/localStorage/.test(seg.slice(0, 1200)), '每次进来都要重新展开一遍，等于把收纳的好处还回去了');
  assert.ok((seg.slice(0, 1200).match(/catch/g) || []).length >= 2,
    'localStorage 在隐私模式/禁用站点数据时会抛错——记不住不是错，崩了才是');
});


// —— 重设计·三：书架卡片 ——
// 原来卡上是三个孤立数字：「523 章」「4245 KB」「tokens 15.7M」，其中 tokens 是运维信息，
// 作者在书架上根本用不着。而真正要紧的「这本书在等我做什么」一个字都没有。

test('书架不再显示 KB 和 tokens——那是运维信息，不是作者要的', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const i = app.indexOf('function renderShelf');
  const seg = app.slice(i, app.indexOf('async function paintShelfStatus', i));
  assert.ok(!/KB</.test(seg), '书架卡上不该再有 KB');
  assert.ok(!/tokens \$\{fmtTok/.test(seg), '书架卡上不该再有 tokens');
  assert.ok(/写到第 \$\{ch\} 章/.test(seg), '要把章数说成人话');
});

test('KB→字数必须按 3 字节/字折算', () => {
  // 第一版按 2 折算，东京那本就从 117.9 万变成 177 万，比看板多出六十万字。
  // 数字对不上比没有数字更糟：它会让人不再信这块面板。
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.ok(/\* 1024\) \/ 3 \/ 10000/.test(app),
    '中文在 UTF-8 下是 3 字节/字；实测按 3 折算与看板实算偏差 0%');
});

test('书架状态分两步加载——卡片先出来，状态随后补', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.ok(/async function paintShelfStatus/.test(app));
  assert.ok(/shelf-status/.test(app), '走单独端点，别塞进 bootstrap 让开屏等最慢的那本书');
  const seg = app.slice(app.indexOf('async function paintShelfStatus'));
  assert.ok(/catch \{ return; \}/.test(seg.slice(0, 500)),
    '取不到状态就保持原样——宁可少一块，也不要把卡片改成错的');
});

test('一张卡只有一个主按钮，其余退成图标', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const i = app.indexOf('function renderShelf');
  const seg = app.slice(i, app.indexOf('async function paintShelfStatus', i));
  assert.ok(/card-btn primary" data-act="write"/.test(seg), '主行动要突出');
  assert.equal((seg.match(/card-btn icon/g) || []).length, 3,
    '阅读/复检/书名实验退成图标——11 本书 44 个同样醒目的按钮，等于没有推荐动作');
  // 功能一个都不能少
  for (const act of ['write', 'read', 'review', 'nameexp', 'del']) {
    assert.ok(seg.includes(`data-act="${act}"`), `${act} 入口没了——这一批只搬家，不许删功能`);
  }
});

test('主按钮说的是这本书现在该干什么，不是一律「写作」', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const seg = app.slice(app.indexOf('async function paintShelfStatus'));
  assert.ok(/r\.nextLabel/.test(seg.slice(0, 900)),
    '后端已经算出了 next/nextLabel，书架也该用它——正在写的书按钮就该是「正在写」而不是「写作」');
});

console.log('\n全部通过 ✅  软件知道的事，终于会主动说出口了');
