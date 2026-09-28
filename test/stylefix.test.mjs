// 文风回正：判 → 改 → 【再判】 → 不达标重来 → 到上限停住。
//
// 这个文件盯的是"收稿前那道体检"。模型改文风时最常见的翻车不是指标没达标，
// 是顺手把内容删了、或者回了一段"好的，以下是修改后的正文"——指标反而更好看。
// 2026-09-28 实测：《崇祯》307 章第一次调用回的就是一段说明，被这道体检拦下了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixBang, splitFatParagraphs, acceptable, buildFixPrompt } from '../src/stylefix.mjs';

test('感叹号：短吼保留，叙述和长台词一律改句号', () => {
  // 本书自己的用法：「站住！」留着（前 296 章 1053 处全是这种），
  // 「…六百里加急驰报天子！」这种五十字的战报不是吼，是念。
  const t = [
    '浓雾深处，一骑快马破雾而出！',
    '“站住！”',
    '“保定巡抚申绍德、副总兵郝一贵，六百里加急驰报天子！”',
  ].join('\n');
  const r = fixBang(t);
  assert.ok(r.includes('破雾而出。'), '叙述句的感叹号要改掉');
  assert.ok(r.includes('“站住！”'), '短吼要留着——本书本来就这么写');
  assert.ok(r.includes('驰报天子。”'), '长台词的感叹号要改掉');
});

test('感叹号：破折号后面的不许改成句号（那是错标点）', () => {
  assert.equal(fixBang('“保定急报——！”'), '“保定急报——”');
  assert.equal(fixBang('他愣住了——！'), '他愣住了——');
});

test('？！一律收成？', () => {
  assert.ok(!fixBang('他何曾想过？！').includes('！'));
});

test('拆段只加换行，一个字都不改', () => {
  const 原 = '甲'.repeat(30) + '。' + '乙'.repeat(30) + '。' + '丙'.repeat(30) + '。';
  const 后 = splitFatParagraphs(原, 34);
  assert.ok(后.includes('\n'), '该拆开');
  assert.equal(后.replace(/\n/g, ''), 原, '除了换行，一个字都不许变');
});

test('不够厚的段落不动', () => {
  const 短 = '他没吭声。底下没人应。';
  assert.equal(splitFatParagraphs(短, 34), 短);
});

test('收稿体检：删了内容不收', () => {
  const 原 = '甲'.repeat(2000);
  assert.equal(acceptable(原, '甲'.repeat(1500)).ok, false, '掉了 25% 必须拦下');
  assert.match(acceptable(原, '甲'.repeat(1500)).why, /字数掉了/);
});

test('收稿体检：注水加戏也不收', () => {
  const 原 = '甲'.repeat(2000);
  assert.equal(acceptable(原, '甲'.repeat(2600)).ok, false);
});

test('收稿体检：回了一段说明而不是正文，不收', () => {
  const 原 = '甲'.repeat(2000);
  assert.equal(acceptable(原, '好的，以下是修改后的正文：' + '甲'.repeat(1950)).ok, false);
  assert.equal(acceptable(原, '这是我改好的版本' + '甲'.repeat(1950)).ok, false);
});

test('收稿体检：改丢专名不收——这是光看指标看不出来的那种翻车', () => {
  const 原 = '吴三桂坐在帅堂上。' + '甲'.repeat(1000);
  const 改 = '他坐在帅堂上。' + '甲'.repeat(1010);
  const r = acceptable(原, 改, { names: ['吴三桂'] });
  assert.equal(r.ok, false);
  assert.match(r.why, /吴三桂/);
});

test('收稿体检：只改语言、长度基本持平 → 收', () => {
  const 原 = '吴三桂坐在帅堂上。' + '甲'.repeat(1000);
  const 改 = '吴三桂坐着，没动。' + '甲'.repeat(1000);
  assert.equal(acceptable(原, 改, { names: ['吴三桂'] }).ok, true);
});

test('给模型的 prompt 必须带上范本、偏差数值和"不许改故事"的铁律', () => {
  const p = buildFixPrompt({
    title: '崇祯：从煤山反杀开始', chapterName: '307三线同声', text: '正文若干。',
    drift: [{ axis: 'bangPerK', label: '感叹号', value: 16.05, p50: 0.26, limit: 7.5 }],
    refs: '范本正文若干。',
  });
  assert.ok(p.includes('范本正文若干。'), '范本要进 prompt——光说别那样写、不给样子没用');
  assert.ok(p.includes('16.05') && p.includes('0.26'), '要把本章数值和本书中位一起给出');
  assert.ok(p.includes('只改语言，不改故事'), '铁律要在');
  assert.ok(p.includes('不许照抄范本'), '范本是感受语感，不是填空模板');
});

test('拆段：右引号绝不许被甩到下一行', () => {
  // 2026-09-28 实测踩到：「“万顺。”温汝弼低低念了一句」在「。」后面断开，
  // 变成「“万顺。\n”温汝弼…」——右引号孤零零落在行首，一眼就是被机器改过的。
  const t = '“万顺。”温汝弼低低念了一句，抬头看朱由检，“万岁爷，这第三格原先定的是谁去接。营里派出去的人，才算去。万老爹还在登州外头的石坞里。他替的是石得胜的人，可他没打营里走过一步。”';
  const r = splitFatParagraphs(t, 34);
  assert.ok(!/\n[”」』]/.test(r), '右引号被甩到行首了：' + JSON.stringify(r));
});

test('拆段：引号里的台词一口气说完，不许拦腰断开', () => {
  const 台词 = '“' + '这话我说三遍。'.repeat(8) + '”';
  assert.equal(splitFatParagraphs(台词, 34), 台词, '台词内部不该出现换行');
});
