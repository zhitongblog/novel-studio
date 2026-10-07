// 断更闸：钉住 2026-09-26 那天的真实情形——岳雷 09-19 最后更新，当天正好第 7 天，
// 而圣女 167 万字在读 1。每条测试对应一个当时若有这个闸就能拦住的场景。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCadence, scheduleThroughDate, coverDays, readableThrough, runwayEnough, 断更天数, 库存红线 } from '../src/cadence.mjs';

const 今天 = new Date('2026-09-26T10:00:00').getTime();
const 日 = 86400000;
function 查(publish, maxChapter = 100){ return updateCadence({ publish }, { now: 今天, maxChapter }); }

test('没发布过的书不报断更——那是新书，不是断更', () => {
  const r = 查({}, 20);
  assert.equal(r.level, 'none');
});

test('岳雷场景：09-19 最后更新，09-26 正好第 7 天 → 判已断更', () => {
  const r = 查({ lastPublishAt: new Date('2026-09-19T13:00:00').getTime(), publishedMax: 358 }, 371);
  assert.equal(r.daysSince, 断更天数);
  assert.equal(r.level, 'dead');
  assert.equal(r.stock, 13, '本地 371 章、线上 358 章 → 库存 13');
});

test('国术场景：断 60 天照样只报 dead，不会因为天数大而算错', () => {
  const r = 查({ lastPublishAt: 今天 - 60 * 日, publishedMax: 446 }, 446);
  assert.equal(r.level, 'dead');
  assert.equal(r.daysSince, 60);
});

test('第 5、6 天是 danger——剩 2 天以内才是真的来不及了', () => {
  assert.equal(查({ lastPublishAt: 今天 - 5 * 日, publishedMax: 10 }).level, 'danger');
  assert.equal(查({ lastPublishAt: 今天 - 6 * 日, publishedMax: 10 }).level, 'danger');
  assert.equal(查({ lastPublishAt: 今天 - 4 * 日, publishedMax: 10 }).level, 'warn');
  assert.equal(查({ lastPublishAt: 今天 - 3 * 日, publishedMax: 10 }).level, 'warn');
});

test('排期到未来就不算断更——这是 lastPublishAt 单独用不得的原因', () => {
  // 09-26 一次性把 13 章按 2 章/天排到 10-02：点发布的时刻是今天，读者可见日却铺到 6 天后。
  const pc = { lastPublishAt: 今天, scheduledThrough: '2026-10-02', publishedMax: 371 };
  const r = updateCadence({ publish: pc }, { now: 今天 + 5 * 日, maxChapter: 371 });
  assert.equal(r.daysSince, 0, '排期没走完就不该算"几天没更"');
  assert.equal(r.runway, 1);
  assert.equal(r.level, 'thin', '还剩 1 天、库存 0 章 → 该报库存见底');
});

test('排期还长但库存见底：不拉警报，但要写明"排期走完前要补上"', () => {
  // 岳雷 09-26 排到 10-02、库存 0。六天够写，不该报红；但也不能只打一行绿的让人以为没事。
  const r = updateCadence(
    { publish: { lastPublishAt: 今天, scheduledThrough: '2026-10-02', publishedMax: 358 } },
    { now: 今天, maxChapter: 358 });
  assert.equal(r.level, 'ok');
  assert.ok(r.text.includes('6 天内要补上'), r.text);
});

test('排期充足且有库存 → ok', () => {
  const r = updateCadence(
    { publish: { lastPublishAt: 今天, scheduledThrough: '2026-10-06', publishedMax: 100 } },
    { now: 今天, maxChapter: 120 });
  assert.equal(r.level, 'ok');
  assert.equal(r.runway, 10);
  assert.equal(r.stock, 20);
});

test('刚更过但库存见底 → thin，别等踩线了才说', () => {
  const r = 查({ lastPublishAt: 今天, publishedMax: 100 }, 100 + 库存红线 - 1);
  assert.equal(r.level, 'thin');
  const 够 = 查({ lastPublishAt: 今天, publishedMax: 100 }, 100 + 库存红线);
  assert.equal(够.level, 'ok');
});

test('readableThrough 取「排期尾日」和「发布时刻」里晚的那个', () => {
  const 早排期 = readableThrough({ publish: { lastPublishAt: 今天, scheduledThrough: '2026-09-20' } });
  assert.equal(早排期, 今天, '排期尾日比发布时刻还早时，以发布时刻为准');
  const 晚排期 = readableThrough({ publish: { lastPublishAt: 今天, scheduledThrough: '2026-10-02' } });
  assert.ok(晚排期 > 今天);
});

test('scheduleThroughDate：13 章按 2 章/天从 09-26 起 → 10-02（7 天）', () => {
  assert.equal(scheduleThroughDate('2026-09-26', 13, 2), '2026-10-02');
  assert.equal(scheduleThroughDate('2026-09-26', 2, 2), '2026-09-26', '正好一天发完就是当天');
  assert.equal(scheduleThroughDate('2026-09-26', 13, 'max'), '2026-09-26', '一次倒完只买今天一天');
  assert.equal(scheduleThroughDate('', 5, 2), '');
  assert.equal(scheduleThroughDate('2026-09-26', 0, 2), '');
});

test('导入的老书没有 publishedMax → 库存记「未知」，不许报成整本书都待发', () => {
  // 国术 446 章早就发完了，只是从没在这里记过账。旧算法拿 0 当线上章号，
  // 会在书架上打出「库存 446 章」——恰好把"该催更"读成"有的是存货"。
  const r = 查({ lastPublishAt: 今天 - 65 * 日 }, 446);
  assert.equal(r.level, 'dead');
  assert.equal(r.stock, null);
  assert.ok(r.text.includes('库存未知'), r.text);
  assert.ok(!r.text.includes('446'), '绝不能把本地章数当库存报出来');
});

test('库存不会算成负数——线上章号可能高于本地（老书导入前发过）', () => {
  const r = 查({ lastPublishAt: 今天, publishedMax: 500 }, 100);
  assert.equal(r.stock, 0);
});

test('coverDays：同一批稿子，铺开和倒完差出一条七天线', () => {
  assert.equal(coverDays(13, 'max'), 1, '一次倒完只买 1 天');
  assert.equal(coverDays(13, 2), 7, '2 章/天铺开买 7 天——正好抵住红线');
  assert.equal(coverDays(13, '2'), 7, '配置里是字符串也要认');
  assert.equal(coverDays(0, 2), 0);
});

test('已完本的书不算断更——《鸿门拔剑》写完了，别在书架上挂红标天天喊去发', () => {
  const r = updateCadence(
    { status: '已完本', publish: { lastPublishAt: 今天 - 100 * 日, publishedMax: 563 } },
    { now: 今天, maxChapter: 563 });
  assert.equal(r.level, 'done');
  assert.equal(r.daysSince, 0);
  // 同样的数据，没标完本就该报 dead——规则只由 status 决定，不由天数决定
  const 连载 = updateCadence(
    { publish: { lastPublishAt: 今天 - 100 * 日, publishedMax: 563 } },
    { now: 今天, maxChapter: 563 });
  assert.equal(连载.level, 'dead');
});

// 写作总闸 runwayEnough：2026-10-07 作者原话"不要每次一写就停不下来，把我的 token 给用完了"。
test('排期还够 20 天 → 不再续写', () => {
  const g = runwayEnough({ publish: { scheduledThrough: '2026-10-16', publishedMax: 100, chaptersPerDay: 2 } }, { minDays: 14, now: 今天, maxChapter: 100 });
  assert.equal(g.enough, true);
  assert.equal(g.runway, 20);
});

test('排期只剩 5 天，但库存 20 章、每天 2 章 → 合计 15 天，也算够', () => {
  const g = runwayEnough({ publish: { scheduledThrough: '2026-10-01', publishedMax: 100, chaptersPerDay: 2 } }, { minDays: 14, now: 今天, maxChapter: 120 });
  assert.equal(g.stockDays, 10);
  assert.equal(g.enough, true);
});

test('排期只剩 5 天、没库存 → 该写', () => {
  const g = runwayEnough({ publish: { scheduledThrough: '2026-10-01', publishedMax: 100, chaptersPerDay: 2 } }, { minDays: 14, now: 今天, maxChapter: 100 });
  assert.equal(g.enough, false);
});

test('从没发布过的新书不拦；已完本的书一律拦；minDays=0 等于关闭', () => {
  assert.equal(runwayEnough({ publish: {} }, { minDays: 14, now: 今天, maxChapter: 30 }).enough, false);
  assert.equal(runwayEnough({ status: '已完本', publish: {} }, { minDays: 14, now: 今天 }).enough, true);
  assert.equal(runwayEnough({ publish: { scheduledThrough: '2026-12-31', publishedMax: 1 } }, { minDays: 0, now: 今天 }).enough, false);
});
