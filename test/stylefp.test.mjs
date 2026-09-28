// 文风指纹：把阈值从"我以为好文笔该是什么样"换成"这本书自己是什么样"。
//
// 每条测试钉的都是 2026-09-28《崇祯》297–321 那一批的真实数字：
// 旧 296 章均句长 15.4–18.2、感叹号 0.93/千字；新章均句长 25.6–29.3、感叹号 8.46/千字。
// 旧闸报的是「均句长 25.7 超过 22」——22 是写死的默认值，对通用阈值只是略超，
// 对这本书是换了个人写。这个模块存在的全部理由就是这句话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFingerprint, driftOf, pickRefChapters, probeStyle, scanChapters } from '../src/stylefp.mjs';

// 造一本"腔调稳定"的书：短句、无感叹号、无比喻
const 本分句 = '风从街口灌进来，吹得榜纸响。他抬手按住榜角。等风过去了，才往下描那一行。';
const 本分章 = (i) => Array.from({ length: 40 }, (_, k) => 本分句 + (k % 3 ? '他没吭声。' : '底下没人应。')).join('\n');
// 爆款腔：感叹号、如…般比喻、旁白喝彩、长句
const 爆款章 = () => Array.from({ length: 22 }, () =>
  '他目光如利剑般直射过去，声音如滚雷般炸响，满场数千人的心弦被狠狠拨动，无数人的眼眶瞬间红了！'
  + '字字诛心，声震长空！何曾有一位主帅敢当着全军的面认下这笔泼天巨债？！').join('\n');

function mkBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsfp-'));
  const cdir = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(cdir, { recursive: true });
  chapters.forEach((t, i) => fs.writeFileSync(path.join(cdir, `${String(i + 1).padStart(3, '0')}章.txt`), t));
  return dir;
}
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

test('章数不够就不建指纹——样本太少，分布不可信，宁可不判', () => {
  const dir = mkBook(Array.from({ length: 10 }, (_, i) => 本分章(i)));
  try { assert.equal(buildFingerprint(dir), null); } finally { rm(dir); }
});

test('指纹认得出"换了个人写"：本分的书 + 一章爆款腔', () => {
  const dir = mkBook([...Array.from({ length: 30 }, (_, i) => 本分章(i)), 爆款章()]);
  try {
    const fp = buildFingerprint(dir, { upto: 30 });     // 只拿前 30 章建指纹
    assert.ok(fp, '30 章够建指纹');
    const chs = scanChapters(dir);
    const 干净 = driftOf(chs[0].metrics, fp);
    assert.deepEqual(干净, [], '本书自己的章不该报');
    const 漂 = driftOf(chs[30].metrics, fp);
    const 轴 = 漂.map(d => d.axis).sort();
    assert.ok(轴.includes('bangPerK'), '感叹号要报：' + JSON.stringify(轴));
    assert.ok(轴.includes('similePerK'), '如…般比喻要报');
    assert.ok(轴.includes('cheerPerK'), '旁白喝彩要报');
    assert.ok(轴.includes('avgLen'), '均句长要报');
  } finally { rm(dir); }
});

test('形态轴不能用 2.5 倍——那等于放行到 45 字一句，形同虚设', () => {
  const dir = mkBook(Array.from({ length: 25 }, (_, i) => 本分章(i)));
  try {
    const fp = buildFingerprint(dir);
    // 《崇祯》实测 p90=18、新章 25.6–29.3；1.35 倍 → 24.3，拦得住；2.5 倍 → 45，拦不住
    assert.ok(fp.axes.avgLen.max < fp.axes.avgLen.p90 * 2, '均句长上限必须远小于 2 倍 p90');
    assert.ok(fp.axes.avgLen.max >= fp.axes.avgLen.p90, '也不能比 p90 还低，否则本书自己全报');
  } finally { rm(dir); }
});

test('腔调轴全书为零时不能算出"一句话就越界"的线', () => {
  const dir = mkBook(Array.from({ length: 25 }, (_, i) => 本分章(i)));
  try {
    const fp = buildFingerprint(dir);
    // p90 = 0 时纯乘法会得 0，任何一个感叹号都越界；加法项把它抬到 1/千字
    assert.equal(fp.axes.similePerK.p90, 0);
    assert.ok(fp.axes.similePerK.max >= 1, '上限至少 1/千字，别让偶尔一句就报');
  } finally { rm(dir); }
});

test('挑范本挑的是"最像本书平均水平的"，且绝不挑自带爆款腔的那章', () => {
  const dir = mkBook([...Array.from({ length: 30 }, (_, i) => 本分章(i)), 爆款章()]);
  try {
    const picks = pickRefChapters(dir, { n: 3 });
    assert.equal(picks.length, 3);
    assert.ok(!picks.some(p => p.num === 31), '爆款腔那章绝不能被挑成范本——挑了闸就会照着它放行');
  } finally { rm(dir); }
});

test('probeStyle 会把范本写进 style_refs/、把指纹写进 gate.json', () => {
  const dir = mkBook(Array.from({ length: 25 }, (_, i) => 本分章(i)));
  try {
    const r = probeStyle(dir, { n: 2 });
    assert.equal(r.ok, true);
    const refs = fs.readdirSync(path.join(dir, 'style_refs'));
    assert.equal(refs.length, 2, '范本落盘');
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8'));
    assert.ok(conf.styleFingerprint?.axes?.avgLen, '指纹进 gate.json');
    assert.equal(conf.styleFingerprint.chapters, 25);
  } finally { rm(dir); }
});

test('probeStyle 不动作者手工放进去的范本，只清自己挑的', () => {
  const dir = mkBook(Array.from({ length: 25 }, (_, i) => 本分章(i)));
  try {
    fs.mkdirSync(path.join(dir, 'style_refs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'style_refs', '我认可的一段.txt'), '这是作者自己挂的。');
    probeStyle(dir, { n: 2 });
    probeStyle(dir, { n: 2 });   // 跑两遍，确认不会越堆越多、也不会误删
    const refs = fs.readdirSync(path.join(dir, 'style_refs'));
    assert.ok(refs.includes('我认可的一段.txt'), '作者手工放的不许删');
    assert.equal(refs.filter(f => f.startsWith('自选-')).length, 2, '自己挑的每次重挂，不堆积');
  } finally { rm(dir); }
});
