// 回指闸。
//
// 由来（2026-09-24 夜的真实事故）：拿定点修去补《重生三国》13 章的字数不足，
// 第 014 章为了补 28 个字被重写了 113 行，删掉了「李儒摩挲指节」这个动作；
// 而第 015 章开篇就回指它：「正是李儒摩挲指节后，悄然挪动过靴子的那人」。
// 锚点没了，015 的「正是…那人」指向一个读者从没见过的动作。两章都已上架。
// 改完跑的 styleGate 一声没吭——它量的全是形式指标，没有一条看前后文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkAnchors, isDistinctive, charFreq, keepMaximal, candidateGrams, buildAnchorFixInstruction } from '../src/anchorgate.mjs';

// 造一本小书：{章号: 正文}
function mkBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  const vd = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(vd, { recursive: true });
  for (const [n, t] of Object.entries(chapters)) {
    fs.writeFileSync(path.join(vd, String(n).padStart(3, '0') + '_章.txt'), t, 'utf8');
  }
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
// 垫料：把全书字数撑起来，让字频阈值（全书汉字÷4000）有意义
const FILL = '寻常一日风平浪静城中安稳人来人往街市喧闹'.repeat(60);

test('抓得到：改写删了锚点，后文还在回指', () => {
  const orig14 = FILL + '\n那人的目光停在李儒摩挲指节的手上。\n' + FILL;
  const dir = mkBook({
    13: FILL,
    14: FILL + '\n那人贴着墙根站着。\n' + FILL,          // 锚点已被删
    15: FILL + '\n正是李儒摩挲指节后，悄然挪动过靴子的那人。\n' + FILL,
  });
  const r = checkAnchors(dir, new Map([[14, orig14]]));
  assert.equal(r.ok, false);
  const hit = r.breaks.find(b => b.gram.includes('摩挲指节'));
  assert.ok(hit, '应当抓到被删掉的锚点，实际：' + r.breaks.map(b => b.gram).join('/'));
  assert.deepEqual(hit.referencedBy, [15], '要指明是哪一章在回指');
  assert.ok(hit.sentence.includes('摩挲指节'), '要带上原句，否则人看不出该补什么');
  rm(dir);
});

test('不误报：后文没人提的东西，删了就删了', () => {
  const orig14 = FILL + '\n那人的目光停在李儒摩挲指节的手上。\n' + FILL;
  const dir = mkBook({ 14: FILL + '\n那人贴着墙根站着。\n' + FILL, 15: FILL });
  assert.equal(checkAnchors(dir, new Map([[14, orig14]])).ok, true);
  rm(dir);
});

test('不误报：更早的章里还有这个锚点 → 前情仍在，不算断', () => {
  const orig14 = FILL + '\n李儒摩挲指节。\n' + FILL;
  const dir = mkBook({
    12: FILL + '\n李儒摩挲指节，没有说话。\n' + FILL,     // 前情还在第 12 章
    14: FILL + '\n他没有说话。\n' + FILL,
    15: FILL + '\n正是李儒摩挲指节后的那人。\n' + FILL,
  });
  assert.equal(checkAnchors(dir, new Map([[14, orig14]])).ok, true, '锚点只是换了位置，不该报');
  rm(dir);
});

test('不误报：只有更早的章提过 → 那不是回指', () => {
  const orig14 = FILL + '\n李儒摩挲指节。\n' + FILL;
  const dir = mkBook({
    12: FILL + '\n有人说起过李儒摩挲指节的习惯。\n' + FILL,
    14: FILL + '\n他没有说话。\n' + FILL,
  });
  // 12 章在 14 之前 → earlierHas 命中，直接放行
  assert.equal(checkAnchors(dir, new Map([[14, orig14]])).ok, true);
  rm(dir);
});

test('常用词豁免：满书都是的词删一处毫无影响', () => {
  const orig = FILL + '\n他提起方天画戟。\n' + FILL;
  const chapters = { 14: FILL + '\n他站直了身子。\n' + FILL };
  for (let n = 15; n <= 25; n++) chapters[n] = FILL + '\n方天画戟横在马前。\n' + FILL;
  const dir = mkBook(chapters);
  assert.equal(checkAnchors(dir, new Map([[14, orig]])).ok, true, '出现在十来章的词是常用词，不是锚点');
  rm(dir);
});

test('独特性判据：含数目，或含全书罕见字', () => {
  const freq = charFreq('平常的话说了很多遍平常的话说了很多遍平常的话说了很多遍' + '挲');
  const opt = { freq, maxCharFreq: 2 };
  assert.equal(isDistinctive('十七名亲骑', opt), true, '含数目');
  assert.equal(isDistinctive('摩挲指节', opt), true, '含罕见字「挲」');
  assert.equal(isDistinctive('平常的话', opt), false, '全是常用字 → 不是锚点');
});

test('【别再加回来】专名表不能当独特性判据', () => {
  // 第三版一度写成"含专名也算独特"，噪音从 19 反弹到 39：
  // 任何含「吕布」的短语都被判成有专名，而主角名是全书最不独特的词。
  const src = fs.readFileSync(new URL('../src/anchorgate.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export function isDistinctive');
  const body = src.slice(i, i + 400);
  assert.ok(!/names\.some/.test(body), 'isDistinctive 里不许再用专名表——主角名会把噪音放回来');
  assert.match(src, /主角名是全书最不独特的词/, '这条教训要留在代码里');
});

test('碎片去重：命中长的就不报它的子串', () => {
  assert.deepEqual(keepMaximal(['摩挲指节', '摩挲指', '挲指节']), ['摩挲指节']);
});

test('候选只取连续汉字，长度有上下限', () => {
  const g = candidateGrams('李儒摩挲指节', { minLen: 4, maxLen: 6 });
  assert.ok(g.includes('李儒摩挲'));
  assert.ok(g.includes('李儒摩挲指节'));
  assert.ok(!g.some(x => x.length < 4 || x.length > 6));
});

test('排序：越罕见排越前，人眼先看的那几条要最值钱', () => {
  const breaks = [{ rarity: 100, gram: 'a' }, { rarity: 4, gram: 'b' }, { rarity: 40, gram: 'c' }];
  breaks.sort((x, y) => x.rarity - y.rarity);
  assert.deepEqual(breaks.map(b => b.gram), ['b', 'c', 'a']);
});

test('自纠指令：限量、带原句、且不许靠改后文绕过去', () => {
  const breaks = Array.from({ length: 20 }, (_, i) =>
    ({ num: 14, gram: 'X' + i, referencedBy: [15], sentence: '原句' + i }));
  const instr = buildAnchorFixInstruction(breaks, { max: 5 });
  assert.equal((instr.match(/你改写时把它删掉了/g) || []).length, 5, '一次甩二十条，真的那几条会被埋掉');
  assert.match(instr, /原句0/);
  assert.match(instr, /不许为了迁就改动去改它们/, '后文已经发给读者看过了');
  assert.equal(buildAnchorFixInstruction([]), '');
});

test('已接进 runBatch，并且回指断了会退回自纠', () => {
  const src = fs.readFileSync(new URL('../src/overhaul.mjs', import.meta.url), 'utf8');
  assert.match(src, /checkAnchors\(fresh\(\)\.dir, before\)/, 'runBatch 要跑回指闸');
  assert.match(src, /r\.anchors && !r\.anchors\.ok && job\.round < maxRounds/, '断了要退回补一轮');
  assert.match(src, /buildAnchorFixInstruction\(r\.anchors\.breaks\)/, '要把断裂喂回指令');
  // 闸自己出问题不许阻断改造
  const i = src.indexOf('anchors = checkAnchors');
  assert.match(src.slice(i - 200, i + 600), /catch \(e\)/, '回指闸异常必须吞掉');
});
