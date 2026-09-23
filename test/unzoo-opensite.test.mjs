// 账号窗口没开时，直接打开该站点的后台地址。
//
// 由来（2026-09-23 作者提）：在「发布到番茄」里选书籍那一步，番茄没开着就只剩
// profile_launch 一条路，而它偶发 "failed to load profile"——一失败整条链就断在
// 「请手动打开该账号浏览器」，作者得自己去开窗口、自己敲网址。
// 加一层 tab_create 兜底：它能指定 profile 并直接导航到后台。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UnzooClient } from '../src/fanqie.mjs';

const src = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');

test('siteUrl：不传站点时默认番茄后台，传了站点按站点取', () => {
  assert.equal(new UnzooClient('/p/Profile_a').siteUrl, 'https://fanqienovel.com/main/writer/book-manage');
  assert.equal(new UnzooClient('/p/Profile_a', null, 'gemini.google.com', 'Gemini').siteUrl, 'https://gemini.google.com/');
  // 显式传入优先（起点后台不在根路径上）
  assert.equal(
    new UnzooClient('/p/Profile_a', null, 'write.qq.com', '起点', 'https://write.qq.com/portal/dashboard/books').siteUrl,
    'https://write.qq.com/portal/dashboard/books');
});

test('起点那条线把自己的后台地址传进去了（默认的 https://write.qq.com/ 不是作品列表页）', async () => {
  const q = fs.readFileSync(new URL('../src/qidian.mjs', import.meta.url), 'utf8');
  const news = q.match(/new UnzooClient\([^)]*\)/g) || [];
  assert.ok(news.length >= 3, '起点模块应有多处 new UnzooClient，实际 ' + news.length);
  for (const n of news) {
    assert.ok(n.includes('BOOKS_URL'), '这处没传后台地址：' + n);
  }
});

test('getActiveTab：profile_launch 之后仍读不到标签页，要再走 openSiteTab', () => {
  const i = src.indexOf('async getActiveTab()');
  const body = src.slice(i, i + 4200);
  const a = body.indexOf('this.launchProfile()');
  const b = body.indexOf('this.openSiteTab()');
  assert.ok(a > 0, 'getActiveTab 里应有 launchProfile');
  assert.ok(b > 0, 'getActiveTab 里应有 openSiteTab 兜底');
  assert.ok(b > a, 'openSiteTab 必须排在 launchProfile 之后——它是兜底，不是替代');
  // 兜底之后要重新轮询 tab_list，否则建了也读不到
  const after = body.slice(b, b + 400);
  assert.match(after, /tab_list/, 'openSiteTab 之后要重新读 tab_list');
});

test('openSiteTab：profile_id 要查表拿，不许按路径瞎猜', () => {
  const i = src.indexOf('async openSiteTab()');
  assert.ok(i > 0, '应有 openSiteTab');
  const body = src.slice(i, i + 2600);
  assert.match(body, /profile_list/, '要查 profile_list 拿 name');
  // 「工作」这个 profile 的目录是 Default——名字和路径不是简单规则，所以必须查表
  assert.match(src, /名字与路径不是简单规则/, '这条教训要留在注释里');
});

test('openSiteTab：建完必须验证落在选中账号下，落错要关掉（绝不发错号）', () => {
  const i = src.indexOf('async openSiteTab()');
  const body = src.slice(i, i + 2600);
  assert.match(body, /tab_close/, '落错账号要关掉那个标签页');
  assert.match(body, /绝不发错号/, '要写明这条纪律');
  // 验证发生在 tab_create 之后
  const c = body.indexOf('tab_create'), v = body.indexOf('tab_close');
  assert.ok(c > 0 && v > c, '必须先建后验，验不过再关');
});

test('openSiteTab：没绑定账号时直接返回 false，不去动任何标签页', async () => {
  const c = new UnzooClient(null);
  assert.equal(await c.openSiteTab(), false);
});
