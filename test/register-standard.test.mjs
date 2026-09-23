// 语域标准必须留在写作规范模板里。
//
// 这套标准是 2026-09-23 拿腾讯朱雀标定出来的（四个版本的对照见 skill.mjs 里那张表），
// 不是风格偏好。它落在 src/skill.mjs 生成的 AGENTS.md/CLAUDE.md 里——那是 agy/codex/claude
// 这些引擎真正读的东西。模板是一大坨字符串，最容易在后续编辑里被整段带走而没人发现，
// 所以用测试钉住每一条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/skill.mjs', import.meta.url), 'utf8');

test('语域章节在，且排在旧的「反 AI 味」之前（它压过后者）', () => {
  const a = src.indexOf('## 语域：把书面腔换成口语腔');
  const b = src.indexOf('## 反 AI 味 / 拟人化标准');
  assert.ok(a > 0, '语域章节不见了');
  assert.ok(b > a, '语域章节必须排在「反 AI 味」之前——它的结论压过那一节的句式建议');
});

test('标定数据要带着——没有证据，后人会把规则当成可商量的建议删掉', () => {
  assert.match(src, /0%/, '要保留 0% 人类率那一行');
  assert.match(src, /33\.79%/, '只换词那档');
  assert.match(src, /75\.11%/, '全面重写那档');
  assert.match(src, /句长\s*CV\s*不是/, '「句长CV 不是主因」这条反直觉结论必须留着');
});

test('三件事一条都不能少', () => {
  assert.match(src, /① 词换成口语/, '① 口语密度');
  assert.match(src, /② 句子放短/, '② 句长');
  assert.match(src, /③ 允许写废话/, '③ 闲笔');
  assert.match(src, /每千字 20 个以上口语标记/, '口语密度阈值');
  assert.match(src, /22 字以内/, '均句长阈值');
  assert.match(src, /每章至少三处/, '闲笔密度');
});

test('「必须留长句」那一半不能丢——只写「句子放短」会写出短句节拍器', () => {
  assert.match(src, /必须留长句/, '这是我踩过的坑');
  assert.match(src, /短句节拍器/, '坑的名字要留着');
  assert.match(src, /低均值\s*\+\s*高方差/, '正确做法：低均值配高方差，不是一味堆短句');
});

test('口语词表在，且写明换背景要换表', () => {
  for (const w of ['自个儿', '上头', '末了', '囫囵', '出溜', '杵着']) {
    assert.ok(src.includes(w), '词表缺了「' + w + '」');
  }
  assert.match(src, /换书换背景时连这张词表一起换/, '吴语/川渝背景堆北方词是另一种假，这条要写明');
});

test('「这不是写差一点去骗检测器」的定性要留着', () => {
  assert.match(src, /口语腔不是低级腔/, '不许让人以为这是降质');
  assert.match(src, /也是网文读者的门槛/, '书面腔同时是读者门槛——这是接受这套标准的理由');
});

test('代码闸与模板说的是同一组阈值', async () => {
  const gate = fs.readFileSync(new URL('../src/chapgate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /minPerK = 20/, 'scanRegister 的口语阈值应是 20，与模板一致');
  assert.match(gate, /maxMeanSent = 22/, 'scanRegister 的句长阈值应是 22，与模板一致');
});
