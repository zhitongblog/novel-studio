// 一本书只允许发布到一个平台。
//
// 为什么要有代码闸而不是写进文档：番茄和起点都要求独家首发。同一本书两边都发，
// 会同时触发双方的独家违约条款和各自的重复内容/自抄检测——后果是下架 + 追回稿费。
// 这种"错一次就很贵"的约束，必须由程序拦住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformOf, hasPublished, canSwitchPlatform, assertPlatform, platformName } from '../src/platform.mjs';

const book = (publish) => ({ title: '测试书', slug: 'test', publish });

test('老数据没有 platform 字段 → 按番茄算（这个字段是后加的，老书全是番茄）', () => {
  assert.equal(platformOf(book({ bookId: '123' })), 'fanqie');
  assert.equal(platformOf(book(undefined)), 'fanqie');
  assert.equal(platformOf({}), 'fanqie');
});

test('不认识的 platform 值也退回番茄，不让脏值改变发布去向', () => {
  assert.equal(platformOf(book({ platform: '晋江' })), 'fanqie');
  assert.equal(platformOf(book({ platform: '' })), 'fanqie');
});

test('还没发过的书可以随便换平台', () => {
  const b = book({ platform: 'fanqie', bookId: '123' });
  assert.equal(canSwitchPlatform(b, 'qidian').ok, true);
});

test('已经发过的书不许改绑另一个平台', () => {
  const b = book({ platform: 'fanqie', bookId: '123', publishedMax: 44, lastPublishAt: 1700000000000 });
  const r = canSwitchPlatform(b, 'qidian');
  assert.equal(r.ok, false);
  assert.match(r.reason, /已经发到番茄小说第 44 章/);
  assert.match(r.reason, /只能在一个平台首发/);
});

test('"发过没有"的判据要宽：lastPublishAt 或 publishedMax 有其一就算发过', () => {
  assert.equal(hasPublished(book({ lastPublishAt: 1 })), true);
  assert.equal(hasPublished(book({ publishedMax: 1 })), true);
  assert.equal(hasPublished(book({ bookId: 'x' })), false);
  // 边界：0 和 null 不算发过，否则新书会被永久锁死在默认平台上
  assert.equal(hasPublished(book({ publishedMax: 0, lastPublishAt: 0 })), false);
  assert.equal(hasPublished(book({ publishedMax: null })), false);
});

test('换成同一个平台永远放行（等于没换）', () => {
  const b = book({ platform: 'qidian', publishedMax: 44, lastPublishAt: 1 });
  assert.equal(canSwitchPlatform(b, 'qidian').ok, true);
});

test('不认识的目标平台直接拒绝', () => {
  assert.equal(canSwitchPlatform(book({}), '晋江').ok, false);
});

test('发布闸：绑定番茄的书不能走起点通道，反之亦然', () => {
  const fq = book({ platform: 'fanqie', bookId: '123' });
  assert.doesNotThrow(() => assertPlatform(fq, 'fanqie'));
  assert.throws(() => assertPlatform(fq, 'qidian'), /绑定的发布平台是番茄小说/);

  const qd = book({ platform: 'qidian', bookId: '456' });
  assert.doesNotThrow(() => assertPlatform(qd, 'qidian'));
  assert.throws(() => assertPlatform(qd, 'fanqie'), /绑定的发布平台是起点中文网/);
});

test('番茄的两个发布入口都挂了平台闸（漏一个就能绕过去）', async () => {
  const src = await import('node:fs').then(m => m.readFileSync(new URL('../src/publish.mjs', import.meta.url), 'utf8'));
  for (const fn of ['previewPublish', 'publishToFanqie']) {
    const i = src.indexOf(`export async function ${fn}(`);
    assert.ok(i > 0, `应有 ${fn}`);
    const head = src.slice(i, i + 260);
    assert.ok(head.includes(`assertPlatform(book, 'fanqie')`), `${fn} 没挂平台闸`);
  }
  for (const fn of ['previewQidian', 'publishToQidian']) {
    const i = src.indexOf(`export async function ${fn}(`);
    assert.ok(i > 0, `应有 ${fn}`);
    const head = src.slice(i, i + 260);
    assert.ok(head.includes(`assertPlatform(book, 'qidian')`), `${fn} 没挂平台闸`);
  }
});

test('改配置那条路也要拦：setBookPublish 传 platform 时必须过闸', async () => {
  const src = await import('node:fs').then(m => m.readFileSync(new URL('../src/books.mjs', import.meta.url), 'utf8'));
  const i = src.indexOf('export function setBookPublish(');
  const body = src.slice(i, i + 600);
  assert.ok(body.includes('canSwitchPlatform'), 'setBookPublish 没校验平台切换——这样能直接改配置绕过发布闸');
});

test('平台名用于提示，不认识的原样回显', () => {
  assert.equal(platformName('fanqie'), '番茄小说');
  assert.equal(platformName('qidian'), '起点中文网');
  assert.equal(platformName('x'), 'x');
});
