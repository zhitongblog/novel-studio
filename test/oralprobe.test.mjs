// 口语表探底器。
//
// 这套东西的由来：一张豫北官话表量遍所有书是错的——
// 《重生三国》113 章全判"整章书面腔"，《被圣女试药后》499 章 100% 低于 20/千字、中位数 2.0。
// 数值没错，结论没法用。手工一本配一张表又不可持续，所以让书自己说它是什么腔。
//
// 下面每个 case 守的都是一条踩过的规矩，改了实现这里就会红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  probeBook, deriveOralTable, writeGateOral, guardWord,
  KNOWN_TRAPS, AMBIGUOUS, CANDIDATE_LEXICON, allCandidates, detectTraps,
} from '../src/oralprobe.mjs';

// 造一本临时书：chapters/卷01/00N标题.txt
function mkBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oralprobe-'));
  const vol = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(vol, { recursive: true });
  chapters.forEach((text, i) => {
    fs.writeFileSync(path.join(vol, String(i + 1).padStart(3, '0') + '章.txt'), text, 'utf8');
  });
  return dir;
}
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

// 三种腔的样章。填充字用「甲」把密度压到真实区间，不然造出来的数没有参考价值。
const 豫北 = (n = 12) => Array.from({ length: n }, (_, i) =>
  `他自个儿杵在院子里头，瞧了老半天，末了啥也没说。${'甲'.repeat(40)}`).join('\n');
const 明清 = (n = 12) => Array.from({ length: n }, () =>
  `小的不敢。老夫走到跟前，末了搁下那件东西。${'乙'.repeat(60)}`).join('\n');
const 演义 = (n = 12) => Array.from({ length: n }, () =>
  `这厮怎地不晓得？甚么道理，俺兀自不信。${'丙'.repeat(60)}`).join('\n');

test('语体画像能把三种腔分开——这是整件事的地基', () => {
  for (const [mk, want] of [[豫北, '现代北方白话'], [明清, '明清白话'], [演义, '演义腔']]) {
    const dir = mkBook([mk(), mk(), mk()]);
    try {
      const p = probeBook(dir);
      assert.ok(p.ok, p.reason);
      const dom = Object.entries(p.byFamily)
        .filter(([k]) => k !== '跨时代通用')
        .sort((a, b) => b[1] - a[1])[0];
      assert.equal(dom[0], want, `应判为「${want}」，实际画像 ${JSON.stringify(p.byFamily)}`);
    } finally { rm(dir); }
  }
});

test('这本书一次没用过的词要踢掉——那不是"缺口语"，是"这路词不属于这本书"', () => {
  const dir = mkBook([明清(), 明清(), 明清()]);
  try {
    const p = probeBook(dir);
    const keptWords = p.kept.map((k) => k.w);
    for (const w of ['俺', '这厮', '甚么', '咋']) {
      assert.ok(!keptWords.includes(w), `「${w}」这本书没用过，不该留在表里`);
      assert.ok(p.absent.some((a) => a.w === w), `「${w}」应当出现在 absent 里`);
    }
    assert.ok(keptWords.includes('小的'), '「小的」是这本书的招牌自称，必须留');
  } finally { rm(dir); }
});

// ── 误伤：这是最容易造成机械损伤的地方 ──────────────────────────────
test('只有验过的误伤才加约束', () => {
  assert.equal(guardWord('似的'), '(?<![相类近])似的');
  assert.equal(guardWord('一发'), null, '「一发」几乎全来自千钧一发，应当整词踢掉');
  assert.equal(guardWord('咱'), '咱(?!们)');
  assert.equal(guardWord('里头'), '里头', '没验过的词不许动');
});

test('没验过的疑似误伤【只报不改】——自动加约束会把合法搭配踢掉三四成', () => {
  // 2026-09-24 第一版就是按邻字集中度自动加约束，跑出来 攥→攥(?!着)、瞧→瞧(?!见)、
  // 打哪→打哪(?!儿)、自个儿→(?<!他)自个儿，全是错的。
  const text = ('他攥着那只碗，瞧见门缝里头有灰。' + '甲'.repeat(30)).repeat(12);
  const dir = mkBook([text, text, text]);
  try {
    const p = probeBook(dir);
    const 攥 = p.kept.find((k) => k.w === '攥');
    const 瞧 = p.kept.find((k) => k.w === '瞧');
    assert.ok(攥, '攥应当留在表里');
    assert.equal(攥.pattern, '攥', '「攥着」是正常搭配，不许自动加 (?!着)');
    assert.equal(攥.guarded, false);
    assert.equal(瞧.pattern, '瞧', '「瞧见」是词，不许自动加 (?!见)');
    // 但要报出来让人看
    assert.ok(p.suspects.some((s) => s.w === '攥'), '邻字集中应当进 suspects，供人复核');
    assert.ok(p.suspects.every((s) => s.traps.every((t) => t.例)), '每条疑似都要带例句——删约束前先看例句');
  } finally { rm(dir); }
});

test('带正则元字符的候选不做邻字分析（跟…似的 / 挺[…]）', () => {
  assert.equal(detectTraps('跟石头似的'.repeat(20), '跟[^，。！？]{1,8}似的'), null);
});

// ── 阈值 ────────────────────────────────────────────────────────────
test('阈值取本书自己的分位数，且 hardFloor 不许导成 0（否则这道闸永远不会响）', () => {
  // 造一本口语极稀的书：分布贴地，5 分位必然是 0
  const dry = ('其人立于庭中，面容沉静，久之未发一言。' + '甲'.repeat(60)).repeat(6);
  const dir = mkBook(Array.from({ length: 20 }, () => dry));
  try {
    const p = probeBook(dir);
    const d = deriveOralTable(dir, p);
    assert.ok(d.hardFloor >= 0.3, `hardFloor 实际 ${d.hardFloor}，必须至少 0.3`);
    assert.ok(d.minPerK > d.hardFloor, 'minPerK 要高于 hardFloor');
    assert.equal(d.calibrated, false, '导出的表一律未标定——绝对阈值只有朱雀能定');
  } finally { rm(dir); }
});

test('中位数低于朱雀危险线 5 时必须单独提醒，不许被相对阈值盖住', () => {
  const dry = ('那人站在院中，看了一会儿，没有说话。' + '甲'.repeat(60)).repeat(6);
  const dir = mkBook(Array.from({ length: 20 }, () => dry));
  try {
    const d = deriveOralTable(dir, probeBook(dir));
    assert.ok(d.median < 5, '夹具本身就该是低密度的');
    assert.match(d.整书提醒, /危险线 5/);
    assert.match(d.整书提醒, /相对指标/, '必须说清楚导出阈值只是相对的');
  } finally { rm(dir); }
});

test('画像压倒性落在已标定的预设上时，建议用预设而不是导表', () => {
  const dir = mkBook([豫北(30), 豫北(30), 豫北(30)]);
  try {
    const p = probeBook(dir);
    assert.ok(p.建议用预设, '豫北腔的书应当建议用「北方官话」预设');
    assert.equal(p.建议用预设.set, '北方官话');
    assert.match(p.建议用预设.why, /标定/, '理由要说明预设是标定过的');
  } finally { rm(dir); }
});

test('明清腔的书没有对应预设，就该自己导表', () => {
  const dir = mkBook([明清(30), 明清(30), 明清(30)]);
  try {
    assert.equal(probeBook(dir).建议用预设, null);
  } finally { rm(dir); }
});

// ── 写回 ────────────────────────────────────────────────────────────
test('写回 gate.json 要带出处——半年后没人记得这张表怎么来的', () => {
  const dir = mkBook([明清(), 明清(), 明清()]);
  try {
    const p = probeBook(dir);
    const d = deriveOralTable(dir, p);
    writeGateOral(dir, p, d);
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8'));
    assert.ok(Array.isArray(conf.oralMarkers) && conf.oralMarkers.length, '要写 oralMarkers');
    assert.equal(conf.oralThresholds.calibrated, false);
    assert.ok(conf._oral出处, '必须留出处');
    assert.ok(conf._oral出处.语体画像, '出处要含语体画像');
    assert.ok(conf._oral出处['⚠️'].includes('朱雀'), '出处要写明未标定');
  } finally { rm(dir); }
});

test('写回不许冲掉 gate.json 里已有的 banned / aliases', () => {
  const dir = mkBook([明清(), 明清(), 明清()]);
  try {
    fs.writeFileSync(path.join(dir, 'gate.json'),
      JSON.stringify({ banned: [{ word: '赵四', why: '编的名字' }], aliases: [['王安', '张保']] }), 'utf8');
    const p = probeBook(dir);
    writeGateOral(dir, p, deriveOralTable(dir, p));
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8'));
    assert.equal(conf.banned[0].word, '赵四', 'banned 不许丢');
    assert.equal(conf.aliases[0][0], '王安', 'aliases 不许丢');
    assert.ok(conf.oralMarkers.length, '同时也要写进口语表');
  } finally { rm(dir); }
});

test('--dry 不写文件', () => {
  const dir = mkBook([明清(), 明清(), 明清()]);
  try {
    const p = probeBook(dir);
    writeGateOral(dir, p, deriveOralTable(dir, p), { dry: true });
    assert.equal(fs.existsSync(path.join(dir, 'gate.json')), false);
  } finally { rm(dir); }
});

test('没有带编号的章节文件时，说人话而不是崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oralprobe-empty-'));
  try {
    const p = probeBook(dir);
    assert.equal(p.ok, false);
    assert.match(p.reason, /探不了底/);
  } finally { rm(dir); }
});

test('候选词库四个家族都不为空，且摊平后不重复', () => {
  for (const [fam, words] of Object.entries(CANDIDATE_LEXICON)) {
    assert.ok(words.length >= 20, `${fam} 只有 ${words.length} 个候选，太少`);
  }
  const all = allCandidates().map((x) => x.w);
  assert.equal(all.length, new Set(all).size, '摊平后不许有重复');
  for (const w of AMBIGUOUS) assert.ok(all.includes(w), `一词多义表里的「${w}」应当在候选库里`);
  for (const w of Object.keys(KNOWN_TRAPS)) {
    if (w === '一发') continue;   // 一发只在三国表里，候选库不收
    assert.ok(all.includes(w), `KNOWN_TRAPS 里的「${w}」应当在候选库里`);
  }
});

// ── 集中度上限 ──────────────────────────────────────────────────────
test('单词上限也从本书分布导出——22% 是按豫北表（六十多个词）定的，小表套不上', () => {
  // 《被圣女试药后》导出的表只有 25 个词，「小的」是主角自称（全书 939 次），
  // 有些章占到 60–73%。拿 22% 去卡，一半的章是被这一条误伤的。
  const 自称重 = ('“小的不敢。”小的低头，小的又说了一句。' + '甲'.repeat(50)).repeat(8);
  const dir = mkBook(Array.from({ length: 20 }, () => 自称重));
  try {
    const p = probeBook(dir);
    const d = deriveOralTable(dir, p);
    assert.ok(d.maxShare > 0.22, `自称占大头的书，上限应当抬起来，实际 ${d.maxShare}`);
    assert.ok(d.maxShare <= 0.75, '再怎么抬也要封顶，否则这道闸等于没有');
    assert.ok(d.主导词?.length, '必须报出是谁把上限顶上去的');
    assert.equal(d.主导词[0].词, '小的');
  } finally { rm(dir); }
});

test('词表分散的书，上限保持在 22% 不放宽', () => {
  const 分散 = ('他自个儿杵在院子里头，瞧了老半天，末了搁下家什，啥也没说。' + '甲'.repeat(40)).repeat(8);
  const dir = mkBook(Array.from({ length: 20 }, () => 分散));
  try {
    const d = deriveOralTable(dir, probeBook(dir));
    assert.equal(d.maxShare, 0.22, `没有哪个词独大时不该放宽，实际 ${d.maxShare}`);
  } finally { rm(dir); }
});

test('导出的阈值要能一路传到 scanRegister——只传表不传阈值等于没换表', async () => {
  const { gateChapter } = await import('../src/chapgate.mjs');
  // 密度要落在【本书导出阈值之上、豫北 20 之下】，不然两者的差别测不出来
  const 明清短 = ('小的不敢。' + '乙'.repeat(180)).repeat(6);   // ≈5.4/千字
  const dir = mkBook(Array.from({ length: 20 }, () => 明清短));
  try {
    const d = deriveOralTable(dir, probeBook(dir));
    const t = fs.readFileSync(path.join(dir, 'chapters', '卷01', '001章.txt'), 'utf8');
    const 只传表 = gateChapter({ text: t, oralMarkers: d.markers });
    const 传阈值 = gateChapter({ text: t, oralMarkers: d.markers, minPerK: d.minPerK, hardFloor: d.hardFloor, maxShare: d.maxShare });
    assert.match(只传表.register.problems.join(''), /低于 20/, '不传阈值会退回豫北的 20/千字');
    assert.ok(!传阈值.register.problems.some((p) => /低于 20/.test(p)), '传了阈值就不该再拿 20 说事');
  } finally { rm(dir); }
});
