// 「点了写作没反应」的两条病根——都不是写作坏了，是【作者看不见】。
//
// 2026-09-17 王莽实证：13:12 点开写，agy 在窗口里把 037/038/039 三章全写完了
// （13:15、13:17、13:17 落盘），但作者面板上：
//   ① 换模式那句解释【根本没出现过】——无状态入口 pushLog 了「agy 没法无头跑 → 改用窗口模式」，
//      转头 doWrite 开头一句 rtOf(slug).logs = [] 把它当场抹掉。日志第一条是"确保 profile"，
//      没有一个字说明模式为什么变了。
//   ② 从 13:12:47「autopilot 已启动」到 13:20:06，面板整整静了 7 分半——而那 7 分半里三章全写完了。
//      无状态模式每批都报「第 302–304 章」，窗口模式一行都没有。
// 两条叠一起 = 一本写得好好的书被判定成卡死。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { chapterProgressLine, isFirstSight } from '../src/progress.mjs';

const SERVER = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

// —— ① 缘由不能在清空日志之前发 ——

test('doWrite 的"开写缘由"必须在 logs=[] 之后才发', () => {
  const body = SERVER.slice(SERVER.indexOf('async function doWrite('));
  const clear = body.indexOf('rtOf(slug).logs = []');
  assert.ok(clear > 0, 'doWrite 里应该还有那句清空日志');
  // 清空之后必须补发一次缘由，否则调用方给的 note 永远到不了作者眼前
  const noteAfter = body.indexOf('sayNote()', clear);
  assert.ok(noteAfter > clear, 'logs=[] 之后必须补发 sayNote()——不然缘由被自己抹掉');
});

test('无状态入口改道窗口模式时，缘由靠参数传，不能先 pushLog', () => {
  // 取 canRunHeadless 判断 → doWrite 调用 这一段
  const i = SERVER.indexOf('if (!canRunHeadless(model))');
  assert.ok(i > 0, '无头兜底分支还在');
  const seg = SERVER.slice(i, SERVER.indexOf('return json(res, 400', i));
  assert.ok(/doWrite\(/.test(seg), '这条分支应当改道 doWrite');
  assert.ok(/note:/.test(seg), '缘由必须作为 note 传给 doWrite（它会在清空日志之后发）');
  assert.ok(!/pushLog\(/.test(seg),
    '不能在这儿 pushLog——doWrite 开头就会清空日志，发了等于没发（2026-09-17 王莽的病根）');
});

// —— ② 落章播报 ——

test('章号涨了就播一行，没涨就闭嘴', () => {
  const st = { maxChapter: 39, chapters: 39, kb: 480 };
  assert.equal(chapterProgressLine(39, st), null, '没涨不该播——否则 20 秒刷一行噪音');
  assert.equal(chapterProgressLine(40, st), null, '水位比实际高（人工删章）也不该播');
  assert.ok(chapterProgressLine(38, st), '涨了必须播');
});

test('落一章报单章，落一批报区间——王莽那天该看见的是这两行', () => {
  const one = chapterProgressLine(36, { maxChapter: 37, chapters: 37, kb: 450 });
  assert.match(one, /第 037 章已落盘/);
  assert.match(one, /全书 37 章/, '要带全书进度，作者才知道离目标还有多远');

  const many = chapterProgressLine(36, { maxChapter: 39, chapters: 39, kb: 480 });
  assert.match(many, /第 037–039 章已落盘/, '一批三章要报成区间，不是只报最后一章');
  assert.match(many, /3 章/);
});

test('章号补零到三位——和文件名/索引里的写法一致', () => {
  assert.match(chapterProgressLine(0, { maxChapter: 1, chapters: 1, kb: 12 }), /第 001 章/);
  assert.match(chapterProgressLine(8, { maxChapter: 9, chapters: 9, kb: 99 }), /第 009 章/);
});

test('第一次见到一本书只记水位，不把已有的几百章当成刚写的刷一屏', () => {
  assert.equal(isFirstSight(undefined), true, '没见过 → 只记水位');
  assert.equal(isFirstSight(null), true);
  assert.equal(isFirstSight(0), false, '0 是"开写时一章都没有"，是真水位，不是没见过');
  assert.equal(isFirstSight(292), false);
});

test('水位在【点写作那一刻】就定下，不等看门狗自己去认', () => {
  const body = SERVER.slice(SERVER.indexOf('async function doWrite('));
  assert.ok(/_chapHigh\.set\(slug, already\?\.maxChapter \|\| 0\)/.test(body),
    'doWrite 开窗成功后要把水位定在开写前的章号——否则头 20 秒里落的那章会被当成"本来就有的"，永远播不出来');
});

console.log('\n全部通过 ✅  换模式有说法、写到哪儿看得见');
