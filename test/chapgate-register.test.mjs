// 语域闸：口语密度 + 均句长。
//
// 这道闸的阈值不是拍脑袋定的，是 2026-09-23 拿《岳飞》卷01 的四个样本去腾讯朱雀
// AI 检测跑出来的。四个点连成一条很干净的曲线：
//
//   样本            人类率     口语/千字  均句长
//   001 原版         0%          0       25.9
//   006（agy 写）    0%          1.6      19.4
//   001 只换词      33.79%      21.9      26.2
//   001 全面重写    75.11%      30.5      20.7
//
// 下面每个 case 都是在守这条曲线——阈值动了，测试就会红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRegister, ORAL_MARKERS, gateChapter } from '../src/chapgate.mjs';

// 造样本：以句号断句，控制均句长与口语词数量
const mk = (sent, n, oral = '') => Array.from({ length: n }, (_, i) =>
  (i === 0 && oral ? oral : '') + '甲'.repeat(sent)).join('。') + '。';

test('零口语标记 = 书面腔，判硬伤（实测这类样本人类率一律 0）', () => {
  const r = scanRegister(mk(20, 30));
  assert.equal(r.perK, 0);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /低于 5 的样本人类率一律为 0/);
});

test('口语标记 1.6/千字 仍判硬伤——agy 那章就卡在这里', () => {
  // 600 字里放 1 个标记 ≈ 1.7/千字
  const r = scanRegister('瞧' + '甲'.repeat(599));
  assert.ok(r.perK < 5, '应落在硬伤区，实际 ' + r.perK);
  assert.match(r.problems[0], /低于 5/);
});

test('只换词不够：口语够了但句子还长，仍不放行（对应实测的 33.79% 弱人类创作）', () => {
  // 均句长 26（>22），口语密度拉满
  const oral = '上头里头后头自个儿俩仨末了家什囫囵出溜杵着瞧搁没准味儿这地方啥咋了吧';
  const r = scanRegister(oral + mk(26, 20));
  assert.ok(r.perK >= 20, '口语密度应达标，实际 ' + r.perK);
  assert.ok(r.meanSent > 22, '均句长应超标，实际 ' + r.meanSent);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /均句长/.test(p)), '应当指出是句长的问题，而不是口语的问题');
});

test('口语够 + 句子短 = 放行（对应实测的 75.11% 强人类创作）', () => {
  const oral = '上头里头后头自个儿俩仨末了家什囫囵出溜杵着瞧搁没准味儿这地方啥咋了吧';
  const r = scanRegister(oral + mk(18, 20));
  assert.ok(r.perK >= 20, '口语密度 ' + r.perK);
  assert.ok(r.meanSent <= 22, '均句长 ' + r.meanSent);
  assert.equal(r.ok, true, '两项都达标却没放行：' + r.problems.join('；'));
});

test('阈值可调，但默认值就是实测标定出来的那两个', () => {
  const t = '瞧瞧瞧' + mk(19, 20);
  assert.equal(scanRegister(t, { minPerK: 0, maxMeanSent: 99 }).ok, true);
  // 默认 minPerK=20 / maxMeanSent=22 —— 改了默认值这里会红
  const sig = scanRegister('甲'.repeat(100));
  assert.ok(/低于 5/.test(sig.problems[0]));
  assert.match(scanRegister(mk(30, 10) + '瞧'.repeat(30)).problems.join(), /均句长/);
});

test('口语词表存在且非空；换书换背景要连表一起换（注释里写明了）', () => {
  assert.ok(Array.isArray(ORAL_MARKERS) && ORAL_MARKERS.length > 15);
  // 几个最典型的北方官话标记必须在表里
  for (const w of ['自个儿', '上头', '俩', '瞧', '搁']) {
    assert.ok(ORAL_MARKERS.includes(w), '词表里应有「' + w + '」');
  }
});

test('语域闸已接进 gateChapter，且能被 registerOff 关掉', () => {
  const bookish = mk(26, 30);
  const g = gateChapter({ text: bookish });
  assert.ok(g.register, 'gateChapter 应返回 register 结果');
  assert.ok(g.problems.some(p => /口语标记/.test(p)), '书面腔应被 gateChapter 报出来');
  const off = gateChapter({ text: bookish, registerOff: true });
  assert.ok(!off.problems.some(p => /口语标记/.test(p)), 'registerOff 应能关掉这道闸');
});

test('节奏闸量不到 AI 味——这条是实测结论，别再把 CV 当反 AI 指标', async () => {
  const src = await import('node:fs').then(m => m.readFileSync(new URL('../src/chapgate.mjs', import.meta.url), 'utf8'));
  // 006 的句长CV(0.767) 比原版 001(0.633) 还高，却是最差样本。这条教训必须留在代码里。
  assert.match(src, /句长CV 不是主因/);
  assert.match(src, /006/);
});
