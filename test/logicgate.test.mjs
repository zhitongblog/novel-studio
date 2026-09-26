// 全文逻辑自检闸：让「每写若干章体检一次全书逻辑」真的发生。
//
// 由来：autopilot 本来就有 fullCheckEvery（每 5 次续写插一次），规范也写了怎么做。
// 但判据是 this.continueCount % N，而 continueCount 在 Autopilot 构造函数里初始化为 0
// ——【每次会话重开就归零】。2026-09-25 一晚重启 6 次应用、每次写三章就停，
// 结果《重生三国》152 章的 reviews/ 里只有一份自检报告（至 134 章），本该有十来份。
// 代价：全书阅读复核挑出 264 条逻辑问题，127/152 章中招，77 条是跨章硬矛盾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lastFullCheckChapter, fullCheckDue, resetFullCheckSent } from '../src/logicgate.mjs';

function mkBook(reports = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  for (const n of reports) fs.writeFileSync(path.join(dir, 'reviews', `全文逻辑自检-至${n}.md`), 'x', 'utf8');
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('从报告文件名读出上次查到第几章；没跑过是 0', () => {
  const a = mkBook(); assert.equal(lastFullCheckChapter(a), 0); rm(a);
  const b = mkBook([50, 134, 90]);
  assert.equal(lastFullCheckChapter(b), 134, '有多份要取最大的那个');
  rm(b);
});

test('不认别的报告文件——只认全文逻辑自检', () => {
  const d = mkBook();
  fs.writeFileSync(path.join(d, 'reviews', '阅读复核-1-86.md'), 'x', 'utf8');
  fs.writeFileSync(path.join(d, 'reviews', '节奏体检-149-151.md'), 'x', 'utf8');
  assert.equal(lastFullCheckChapter(d), 0);
  rm(d);
});

test('判据按【书写到第几章】算，跨会话重启有效', () => {
  const d = mkBook([134]);
  resetFullCheckSent(d);
  assert.equal(fullCheckDue(d, 140, { everyChapters: 15 }).due, false, '才写了 6 章，还不到');
  assert.equal(fullCheckDue(d, 149, { everyChapters: 15 }).due, true, '写够 15 章就该查');
  rm(d);
});

test('一次都没查过的书，写够 N 章就查', () => {
  const d = mkBook();
  resetFullCheckSent(d);
  const r = fullCheckDue(d, 15, { everyChapters: 15 });
  assert.equal(r.due, true);
  assert.equal(r.last, 0);
  assert.equal(r.since, 15);
  rm(d);
});

test('【防卡死】作者没落报告时不许每批重发，否则写作永远卡在自检上', () => {
  const d = mkBook([134]);
  resetFullCheckSent(d);
  assert.equal(fullCheckDue(d, 150, { everyChapters: 15 }).due, true, '第一次要发');
  const again = fullCheckDue(d, 150, { everyChapters: 15 });
  assert.equal(again.due, false, '同一进度不许重发');
  assert.equal(again.alreadySent, true);
  // 又写出新章 → 可以再催一次
  assert.equal(fullCheckDue(d, 151, { everyChapters: 15 }).due, true);
  rm(d);
});

test('查过之后计数归零——报告一落，下次要再写够 N 章', () => {
  const d = mkBook([134]);
  resetFullCheckSent(d);
  assert.equal(fullCheckDue(d, 149, { everyChapters: 15 }).due, true);
  fs.writeFileSync(path.join(d, 'reviews', '全文逻辑自检-至149.md'), 'x', 'utf8');
  assert.equal(fullCheckDue(d, 150, { everyChapters: 15 }).due, false, '刚查过，不该马上再查');
  assert.equal(fullCheckDue(d, 164, { everyChapters: 15 }).due, true, '又写够 15 章才再查');
  rm(d);
});

test('两条窗口路径都挂了，且排在节奏闸/快照闸之后', () => {
  for (const f of ['writer.mjs', 'attach.mjs']) {
    const src = fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    assert.match(src, /fullCheckDue\(b\.dir, now/, f + ' 没挂全文逻辑自检');
    const i = src.indexOf('batchGateInstruction(');
    const j = src.indexOf('fullCheckDue(');
    assert.ok(i > 0 && i < j, f + '：自检要排在节奏/快照闸之后——病章先改干净再体检全书');
    // 水位已推进才发自检，否则自检指令会被当成"这批没写新章"反复触发
    const k = src.indexOf('batchLowWater = now;');
    assert.ok(k > 0 && k < j, f + '：要先推进水位再发自检');
  }
});

test('配置里要有按章算的那个开关，并写明旧的那个为什么不行', () => {
  const cfg = fs.readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8');
  assert.match(cfg, /fullCheckEveryChapters: 15/);
  assert.match(cfg, /会话一重开就归零/, '旧判据的毛病要写在旁边，免得有人以为两个开关重复了');
});
