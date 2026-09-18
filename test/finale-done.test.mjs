// 「完本」必须真的把小说完本，不能只是翻一个状态位。
//
// 作者原话：「完本功能要真的把小说完本」。查下来它原本只是【一次状态翻转】：
// writer.mjs 的 done() 先 setBookStatus('已完本')，再把收尾指令扔出去并 stop:true——
// 指令写没写、写成什么样，无人检查。而那条指令自己还写着
// 「①【可选】写一章简短的《完本感言》…或写一段简短尾声」，模型完全可以什么都不做。
//
// 更要命的是四条路里三条是"放行"：审稿关掉 / 审稿抛异常 / 退回 2 次仍不过，
// 全都直接标完本。于是"标完本"的门槛实际上比"写完"低得多。
//
// 活证据《大乾女帝贴身神探》：9/4 标成已完本（当时 480 章），之后又写了 45 章到 525；
// 没有尾声、没有完本感言，第 525 章结尾是「他已经带着魏忠原的尸身进了先帝陵」——
// 纯悬念，正在开新线。书挂着完本的牌子，内容却在往下铺坑。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finaleArtifacts, buildFinaleFixInstruction, finaleSummary } from '../src/finaledone.mjs';

// 造一本假书：chapters/卷01 下若干章 + 可选的 index/bible 标注
function mkBook(chapters, { index = '', bible = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsfin-'));
  const cdir = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(cdir, { recursive: true });
  for (const [name, body] of chapters) fs.writeFileSync(path.join(cdir, name), body || '正文若干。');
  if (index) fs.writeFileSync(path.join(dir, 'chapter_index.md'), index);
  if (bible) fs.writeFileSync(path.join(dir, 'novel_bible.md'), bible);
  return { title: '测试书', dir };
}
const rm = (b) => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} };

test('三样产物都没有 → 不算完本，而且要说清缺哪几样', () => {
  const b = mkBook([['001_开场.txt'], ['002_推进.txt']]);
  try {
    const r = finaleArtifacts(b);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 3, '尾声、chapter_index 的全书完、bible 的已完结，三样都缺');
    assert.match(finaleSummary(b), /还差/);
  } finally { rm(b); }
});

test('三样齐了 → 才算完本', () => {
  const b = mkBook(
    [['001_开场.txt'], ['002_大结局.txt'], ['003_完本感言.txt']],
    { index: '| 001 | 开场 |\n| 003 | 完本感言 |\n\n全书完：共 3 章，约 1 万字', bible: '# 设定圣经\n【已完结】\n\n世界观…' },
  );
  try {
    const r = finaleArtifacts(b);
    assert.ok(r.ok, '三样齐了就该判完本，实际缺：' + r.missing.join('、'));
    assert.match(finaleSummary(b), /齐了/);
  } finally { rm(b); }
});

test('【位置约束】卷内的「终章」不能冒充全书尾声', () => {
  // 实测踩到的误判：《重生之我在岛国当天皇》全书 325 章，第 074 章叫「春祭终章」，
  // 只按词匹配就被判成"尾声有了"。真正的收尾章一定在全书最后几章。
  const chapters = [];
  for (let i = 1; i <= 120; i++) chapters.push([String(i).padStart(3, '0') + '_普通章.txt']);
  chapters[73] = ['074_春祭终章.txt'];   // 第 74 章
  const b = mkBook(chapters);
  try {
    const r = finaleArtifacts(b);
    const aw = r.items.find(i => i.key === 'afterword');
    assert.equal(aw.ok, false, '第 74 章的「终章」在 120 章的书里不该算全书尾声');
    assert.match(aw.detail, /卷内终章/, '要说清楚为什么不算，而不是干巴巴一句"没有"');
  } finally { rm(b); }
});

test('收尾章就在最后几章内 → 算数（容忍 结局→尾声→感言 连着写）', () => {
  const chapters = [];
  for (let i = 1; i <= 50; i++) chapters.push([String(i).padStart(3, '0') + '_普通章.txt']);
  chapters[47] = ['048_尾声.txt'];   // 第 48 章，全书 50 章，差 2 章
  const b = mkBook(chapters);
  try {
    assert.ok(finaleArtifacts(b).items.find(i => i.key === 'afterword').ok, '差 2 章应当算数');
  } finally { rm(b); }
});

test('章名没写但正文点明了「全书完」也算', () => {
  const b = mkBook([['001_开场.txt'], ['002_落幕.txt', '他转身离去。\n\n——全书完']]);
  try {
    assert.ok(finaleArtifacts(b).items.find(i => i.key === 'afterword').ok,
      '模型常把"全书完"放在正文末尾而不写进章名，卡章名会把真写了的判成没写');
  } finally { rm(b); }
});

test('补写指令【只要求缺的那几样】，别把已做好的再喊一遍', () => {
  const b = mkBook([['001_开场.txt'], ['002_尾声.txt']], { bible: '【已完结】' });
  try {
    const r = finaleArtifacts(b);
    const ins = buildFinaleFixInstruction(b, r.missing);
    assert.ok(!/完本感言/.test(ins) || !/尾声/.test(r.missing.join('')),
      '尾声已经有了就不该再要求写——喊了模型可能重写，反而把好的搞坏');
    assert.match(ins, /chapter_index/, '缺的那样要点名');
    assert.ok(!/\n/.test(ins), '必须是单行：多行 prompt 会被 agent 当成多行草稿等人工回车');
  } finally { rm(b); }
});

test('补写指令必须把话说死：是硬要求，不是"可选"', () => {
  const b = mkBook([['001_开场.txt']]);
  try {
    const ins = buildFinaleFixInstruction(b, finaleArtifacts(b).missing);
    assert.match(ins, /必写|硬要求/, '原来那条指令写的是"①可选写一章完本感言"——等于没要求');
    // 查的是原来那句【把事情说成可做可不做】的措辞，不是"可选"这两个字本身——
    // 新文案里「不是可选」正是在强调它是硬要求，按词匹配会把它也判成违规。
    assert.ok(!/可选写|可选：|（可选）/.test(ins), '不许再出现"可选写…"这种把硬要求说成随意项的措辞');
  } finally { rm(b); }
});

// —— 接线：光有检查器不算修好 ——

test('writer 的完本闸：产物没齐【绝不】标已完本', () => {
  const w = fs.readFileSync(new URL('../src/writer.mjs', import.meta.url), 'utf8');
  const i = w.indexOf('const onFinaleReady');
  const seg = w.slice(i, w.indexOf('onBatchReview', i));
  assert.ok(/finaleArtifacts/.test(seg), '标完本前要先查落盘产物');
  // setBookStatus('已完本') 必须出现在 art.ok 之后，而不是函数一进来就翻状态
  const artAt = seg.indexOf('art.ok');
  const doneAt = seg.indexOf("setBookStatus(slug, '已完本')");
  assert.ok(artAt > 0 && doneAt > artAt,
    '「已完本」必须在产物核对【之后】才设——原来是一进 done() 就先翻状态，再把指令扔出去 stop 掉，没人回头看');
});

test('催不动就停在「收尾中」，不许退而求其次标完本', () => {
  const w = fs.readFileSync(new URL('../src/writer.mjs', import.meta.url), 'utf8');
  const i = w.indexOf('const onFinaleReady');
  const seg = w.slice(i, w.indexOf('onBatchReview', i));
  assert.ok(/setBookStatus\(slug, '收尾中'\)/.test(seg),
    '补不出来就该停在收尾中——错标成完本比没标严重得多，番茄那边会按完本走签约/推荐流程');
});

test('三条"放行"路不再能绕开产物核对', () => {
  const w = fs.readFileSync(new URL('../src/writer.mjs', import.meta.url), 'utf8');
  const i = w.indexOf('const onFinaleReady');
  const seg = w.slice(i, w.indexOf('onBatchReview', i));
  // 审稿关掉 / 审稿抛异常 / 超上限，三条都得走 done()，而 done() 里有产物闸
  assert.ok(!/放行标完本/.test(seg), '"完本审稿失败 → 放行标完本"这种话不该再有');
  assert.ok(!/已达上限 → 标完本/.test(seg), '"已达上限 → 标完本"不该再有');
});

console.log('\n全部通过 ✅  完本由落盘产物说了算，不由模型说了算');
