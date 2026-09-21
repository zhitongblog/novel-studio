import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// 番茄创建作品页新增的选项，我们该怎么选。
//
// 2026-09-18 实地摸了一遍创建页，发现三件事我们的代码完全没处理：
//   ① 新增【签约模式】(必填)：连载模式 / 完本模式。而且【默认两个都不选】——
//      我们的代码从来没碰过它，等于带着空的必填项去点创建。
//   ② 【目标读者】(男频/女频) 也是默认不选。原来那句是全页面找 textContent==='男频'
//      的元素直接点——只有一组单选时侥幸没出事，多一组就是定时炸弹；而且点完从不检查。
//   ③ 两个标签框里的【非主分类部分】一个都没选过：
//      阅读标签的 主题/角色/情节，以及【整个内容标签】(情节/情感/人设/世界观)。
//      作者原话：「内容标签也需要提前选好」。
//
// 签约模式选哪个：作者确认「我们一般都选连载模式」。也跟本工具的工作方式一致——
// 边写边发（每天 N 章、断点续发、重发修正、完结收口全是增量流程）。
// 完本模式要求完本且满 15 万/30 万字才可签约、整书一次性上传，跟这条流水线冲突。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { READ_TAGS, CONTENT_TAGS, TAG_LIMITS, REQUIRED_SECTIONS } from '../src/fanqietags.mjs';
import { FANQIE_CATEGORIES } from '../src/categories.mjs';

test('阅读标签分男女频，两套完全不同', () => {
  assert.deepEqual(Object.keys(READ_TAGS), ['男频', '女频']);
  assert.equal(READ_TAGS.男频.主分类.length, 19);
  assert.equal(READ_TAGS.女频.主分类.length, 21);
  assert.equal(READ_TAGS.男频.主题.length, 33);
  assert.equal(READ_TAGS.女频.主题.length, 25);
  assert.equal(READ_TAGS.男频.角色.length, 22);
  assert.equal(READ_TAGS.女频.角色.length, 41);
  assert.equal(READ_TAGS.男频.情节.length, 80);
  assert.equal(READ_TAGS.女频.情节.length, 95);
  assert.notDeepEqual(READ_TAGS.男频.主题, READ_TAGS.女频.主题, '两个频道的主题栏不该一样');
});

test('内容标签与频道无关——所以只存一份', () => {
  // 实抓验证：男频女频抓出来一模一样。存两遍必然有一天只改了一边。
  assert.equal(CONTENT_TAGS.情节.length, 144);
  assert.equal(CONTENT_TAGS.情感.length, 58);
  assert.equal(CONTENT_TAGS.人设.length, 94);
  assert.equal(CONTENT_TAGS.世界观.length, 60);
  assert.ok(!('男频' in CONTENT_TAGS), '内容标签不该按频道分开存');
});

test('主分类清单与 categories.mjs 是同一份，不能各存各的', () => {
  for (const ch of ['男频', '女频']) {
    assert.deepEqual(READ_TAGS[ch].主分类, FANQIE_CATEGORIES[ch],
      `${ch} 的主分类在两个模块里对不上——同一份数据存两处，迟早只改一边`);
  }
});

test('各栏上限按弹窗原文钉死', () => {
  // 弹窗原文：阅读标签「主分类必选且只能选一个，主题、角色、情节最多可选两个」
  //           内容标签「情节、人设最多可选四个，情感最多可选两个，世界观最多可选一个」
  assert.deepEqual(TAG_LIMITS.阅读标签, { 主分类: 1, 主题: 2, 角色: 2, 情节: 2 });
  assert.deepEqual(TAG_LIMITS.内容标签, { 情节: 4, 情感: 2, 人设: 4, 世界观: 1 });
});

test('只有主分类是必选——别把可选项做成拦路虎', () => {
  assert.deepEqual(REQUIRED_SECTIONS, [['阅读标签', '主分类']]);
});

test('标签名不含空格，且不跨栏重名到影响判断', () => {
  const all = [...Object.values(READ_TAGS.男频).flat(), ...Object.values(READ_TAGS.女频).flat(), ...Object.values(CONTENT_TAGS).flat()];
  for (const t of all) {
    assert.equal(t, t.trim());
    assert.ok(!/\s/.test(t), `「${t}」不该含空格——番茄那边是按全名相等匹配卡片的`);
  }
  // 同一栏内不许重复
  for (const ch of ['男频', '女频']) {
    for (const [sec, list] of Object.entries(READ_TAGS[ch])) {
      assert.equal(new Set(list).size, list.length, `${ch}·${sec} 有重复项`);
    }
  }
  for (const [sec, list] of Object.entries(CONTENT_TAGS)) {
    assert.equal(new Set(list).size, list.length, `内容标签·${sec} 有重复项`);
  }
});

// —— 接线 ——

test('签约模式：默认连载模式，取值非法一律回落到它', () => {
  const fq = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  assert.ok(/signMode = '连载模式'/.test(fq), '默认必须是连载模式（作者：我们一般都选连载模式）');
  assert.ok(/signMode !== '连载模式' && signMode !== '完本模式'/.test(fq), '非法取值要兜住，别把空值送进必填项');
});

test('单选组按【表单项标签】限定范围，并且设完要验', () => {
  const fq = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  assert.ok(/const setRadio = async \(groupLabel, value\)/.test(fq),
    '页面现在有两组单选（签约模式/目标读者），全页面按文字找元素是定时炸弹');
  assert.ok(/arco-radio-checked/.test(fq), '设完要确认真的选中了——两组都默认不选，设失败会一路飘到创建时才炸');
  assert.ok(/setRadio\('签约模式'/.test(fq) && /setRadio\('目标读者'/.test(fq), '两组都要走这条路');
});

test('AI 选出来的标签必须逐项过滤：自造词/跨栏/超上限一律丢掉', () => {
  const planner = fs.readFileSync(new URL('../src/planner.mjs', import.meta.url), 'utf8');
  const seg = planner.slice(planner.indexOf('export async function recommendFanqieTags'));
  assert.ok(/dropped/.test(seg.slice(0, 5000)),
    '被丢掉的要记下来报给作者，不能闷声吃掉——不然作者只看到"选中的比预期少"却不知道为什么');
  assert.ok(/parseFailed/.test(seg.slice(0, 5000)),
    '"没解析出来"和"真的一个都没选"必须分开：实测 gemini/qwen 对这个超长 prompt 返回的是自己的帮助文本，' +
    '照样返回全空的话，作者会以为这本书就是没标签可选');
});

test('存进书里之前也要过一遍清单校验', () => {
  const books = fs.readFileSync(new URL('../src/books.mjs', import.meta.url), 'utf8');
  const seg = books.slice(books.indexOf('export function setBookTags'));
  assert.ok(/READ_TAGS/.test(seg.slice(0, 2000)) && /CONTENT_TAGS/.test(seg.slice(0, 2000)),
    '自造的词一路飘到浏览器里，只会表现成"找不到这张卡"——在落盘这一层就该拦掉');
});

test('内容标签选不上【不拦着建书】，主分类选不上才拦', () => {
  const fq = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  const i = fq.indexOf('内容标签：情节≤4');
  const seg = fq.slice(i, fq.indexOf('立即创建', i));
  assert.ok(/不影响创建/.test(seg),
    '内容标签不是必填。为了几个分发标签把整本书的创建卡住，得不偿失——必选项才值得拦');
});

console.log('\n全部通过 ✅  签约模式/目标读者/两套标签，建书前全都定好');

test('改番茄书名/简介必须真打字：注入排最后，且要说清它多半白填', () => {
  // 2026-09-20/21 连栽三次：原生 setter 填得进框、框里也显示对了，提交上去番茄存的还是旧值——
  // React 表单根本没收到这次变更。所以真实输入要有两级（browser_type → human_type），注入只兜底。
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('const typeInto');
  assert.ok(i > 0, 'updateFanqieBookInfo 要有 typeInto');
  const seg = src.slice(i, i + 2000);
  assert.ok(seg.indexOf("'browser_type'") < seg.indexOf("'human_type'"), 'browser_type 先试');
  assert.ok(seg.indexOf("'human_type'") < seg.indexOf('__sv('), '注入必须排在两种真实输入之后');
  assert.match(seg, /填得进框但番茄收不到|多半白填/, '退到注入时要把风险说出来，别让人以为填成功了');
  assert.match(seg, /readBack\(\) === text/, '每一级都要回读校验，不能只看调用没报错');
});
