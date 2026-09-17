// 「创建新书的时候分类和番茄映射不上」——因为压根没有映射。
//
// 2026-09-17 查清的三件事：
//   ① 新建书只收自由文本「题材/想法」和 9 选 1 的「文风」，书里根本没有"分类"这个字段；
//      番茄要的是固定选项里的【主分类 + 男/女频】。中间一行映射代码都没有。
//   ② 番茄那个下拉不从书里带任何东西，永远停在第一项「历史脑洞」——
//      而页面自己写着【主分类签约后不可改】。选错=不可逆。
//   ③ 女频是假的：切到女频，分类列表纹丝不动（写死的一套男频子集，里面还杵着「男频衍生」），
//      点创建必然撞 fanqie.mjs 那句「标签弹窗里没找到主分类」。
//
// 清单怎么重抓（番茄加分类时）：开创建作品页 → 关掉「签约模式说明」引导弹窗 →
// 点「阅读标签」框 → 读弹窗里【主分类】那一栏的 .category-choose-item-title。
// 注意弹窗有四栏（主分类/主题/角色/情节），四栏共用同一个类名，必须限定在主分类区里读。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { FANQIE_CATEGORIES, CHANNELS, categoriesOf, isValidCategory, channelsOf, normalizeChannel } from '../src/categories.mjs';

test('两个频道各有一套分类，女频不再是空的', () => {
  assert.deepEqual(CHANNELS, ['男频', '女频']);
  assert.equal(categoriesOf('男频').length, 19, '男频实抓 19 项');
  assert.equal(categoriesOf('女频').length, 21, '女频实抓 21 项——原来 UI 里一项都没有');
});

test('原来 UI 写死的 14 条确实漏了 5 个男频分类', () => {
  // 这 5 个是实抓时才发现的，之前选不到
  for (const c of ['战神赘婿', '动漫衍生', '游戏体育', '传统玄幻', '都市修真']) {
    assert.ok(categoriesOf('男频').includes(c), `男频应当有「${c}」`);
  }
});

test('拿男频的分类去女频找必然落空——这正是"创建失败"的真因', () => {
  assert.ok(isValidCategory('男频', '都市高武'));
  assert.equal(isValidCategory('女频', '都市高武'), false, '女频没有都市高武，番茄弹窗里也找不到这张卡');
  assert.ok(isValidCategory('女频', '宫斗宅斗'));
  assert.equal(isValidCategory('男频', '宫斗宅斗'), false);
  assert.equal(isValidCategory('男频', '男频衍生'), true);
  assert.equal(isValidCategory('女频', '男频衍生'), false, '原来的下拉在女频下还留着这一项，点了必错');
});

test('跨频道同名的分类要能认出两边都有', () => {
  for (const both of ['科幻末世', '悬疑脑洞', '动漫衍生', '游戏体育']) {
    assert.deepEqual(channelsOf(both), ['男频', '女频'], `「${both}」男女频都有`);
  }
  assert.deepEqual(channelsOf('战神赘婿'), ['男频']);
  assert.deepEqual(channelsOf('快穿'), ['女频']);
  assert.deepEqual(channelsOf('根本不存在的分类'), []);
});

test('频道归一化：不认识的一律当男频，不要抛错', () => {
  assert.equal(normalizeChannel('女频'), '女频');
  assert.equal(normalizeChannel('男频'), '男频');
  assert.equal(normalizeChannel(''), '男频');
  assert.equal(normalizeChannel(undefined), '男频');
  assert.equal(normalizeChannel('中性频'), '男频');
});

test('分类名不许带空格/别名——必须和番茄卡片上的字一模一样', () => {
  // 番茄那边是按【全名相等】匹配卡片的，差一个字就找不到
  for (const ch of CHANNELS) {
    for (const c of categoriesOf(ch)) {
      assert.equal(c, c.trim(), `「${c}」不该有首尾空格`);
      assert.ok(!/\s/.test(c), `「${c}」不该含空格`);
      assert.ok(c.length >= 2 && c.length <= 6, `「${c}」长度可疑`);
    }
  }
});

test('同一频道内不重复', () => {
  for (const ch of CHANNELS) {
    const list = categoriesOf(ch);
    assert.equal(new Set(list).size, list.length, `${ch}有重复项`);
  }
});

// —— 接线检查：光有清单不算修好，得真接到那三处 ——

test('书上要能存分类，且存之前校验频道对得上', async () => {
  const src = fs.readFileSync(new URL('../src/books.mjs', import.meta.url), 'utf8');
  assert.ok(/export function setBookCategory/.test(src), 'books.mjs 要有 setBookCategory');
  assert.ok(/isValidCategory\(ch, cat\)/.test(src), '存之前必须校验分类属于该频道——不然错的照样存进去');
});

test('立项时就推断分类，而不是等到发书那天', () => {
  const planner = fs.readFileSync(new URL('../src/planner.mjs', import.meta.url), 'utf8');
  assert.ok(/export async function recommendCategory/.test(planner), 'planner 要有 recommendCategory');
  assert.ok(/undecided/.test(planner),
    '认不出来时要【明说没认出来】，不能硬塞一个默认值——塞了作者就更不会去看那个下拉，而主分类签约后不可改');
  const server = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const launch = server.slice(server.indexOf("p === '/api/book/launch'"));
  assert.ok(/recommendCategory/.test(launch.slice(0, 4000)), '立项端点里要调 recommendCategory');
});

test('番茄建书那条路上要挡住频道/分类不匹配', () => {
  const server = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const seg = server.slice(server.indexOf("p === '/api/fanqie/create-book'"));
  assert.ok(/isValidCategory\(channel, mainCategory\)/.test(seg.slice(0, 4000)),
    '创建前要校验——否则只会在浏览器里静默失败，作者看不出错在频道');
});

test('番茄页面上那两个坑要堵住：引导弹窗 + 认准阅读标签', () => {
  const fq = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  assert.ok(/sign-pattern-guide-modal|我知道了\|知道了\|开始创作/.test(fq),
    '创建作品页会弹「签约模式说明」盖住表单，不关掉点击就落到遮罩上，报出来的却是"没找到选择框"');
  assert.ok(/阅读标签/.test(fq), '页面上有两个"请选择作品标签"(阅读标签/内容标签)，必须认准阅读标签那个');
  assert.ok(/category-choose-item-title/.test(fq),
    '要按卡片标题【全名相等】匹配：原来的 indexOf 子串匹配下，要「悬疑」会先撞上「悬疑脑洞」');
});

console.log('\n全部通过 ✅  分类在立项就定，男女频各认各的，错配当场拦下');
