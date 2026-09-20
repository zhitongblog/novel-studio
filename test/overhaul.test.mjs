// 改造流水线（救书）：把 2026-09-19/20 救《穿成王莽后》那两天踩过的坑逐条钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { styleScan, countSimiles, countPiles, buildStyleFixInstruction, STYLE_STD } from '../src/stylegate.mjs';
import { buildBatchInstruction, readFixBatches } from '../src/overhaul.mjs';
import { parseReadReview, buildReadFixInstruction } from '../src/readreview.mjs';
import { parseDiagnose } from '../src/diagnose.mjs';

function mkBook(chapters) {   // chapters: {num: 正文}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovh-'));
  const cdir = path.join(dir, 'chapters', '卷01_试');
  fs.mkdirSync(cdir, { recursive: true });
  for (const [n, t] of Object.entries(chapters)) fs.writeFileSync(path.join(cdir, String(n).padStart(3, '0') + '章.txt'), t);
  return { title: '测试书', slug: '测试书', dir };
}
const rm = (b) => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} };
const para = (s) => s + '\n\n';

test('比喻要数「如…般」「…似的」——只数宛如/犹如会漏掉一半（第17章就是这么漏的）', () => {
  assert.equal(countSimiles('他宛如一座山。'), 1);
  assert.equal(countSimiles('四名亲兵如铁塔般按刀而立，目光如鹰隼般刺来。'), 2);
  assert.equal(countSimiles('刀锋像冰似的。'), 1);
  assert.equal(countSimiles('他按刀站着，看了过来。'), 0);
});

test('形容词堆砌：一句话里三个以上「的」算堆砌', () => {
  assert.equal(countPiles('森冷的刀芒在昏暗的火光下泛着令人心悸的嗜血杀气。'), 1);
  assert.equal(countPiles('刀面映着烛火。'), 0);
});

test('套话只管叙述，人物对白里说套话不算毛病', () => {
  const b = mkBook({
    1: para('他轰然倒地。').repeat(1) + para('外面下着雪。') + para('血腥味涌上来，手很烫，疼得他咳了一声。'),
    2: para('「轰然一声，那可真是吓人。」老周说。') + para('他推门出去，雪腥味扑面，指节冻得疼。'),
  });
  try {
    const scan = styleScan(b.dir, 1, 2);
    const c1 = scan.chapters.find(c => c.num === 1);
    const c2 = scan.chapters.find(c => c.num === 2);
    assert.ok(c1.tics.includes('轰然'), '叙述里的套话要抓出来');
    assert.equal(c2.tics.length, 0, '对白里的套话不算');
  } finally { rm(b); }
});

test('【防改干】字数掉到 95% 以下、或感官细节太少，都判不达标', () => {
  const long = para('他推门出去，雪腥味扑面。') + para('指节冻得发疼，喉咙里一股铁锈味。') + para('远处有人在咳。');
  const b = mkBook({ 1: para('他出去了。') });
  try {
    const scan = styleScan(b.dir, 1, 1, { before: { 1: long } });
    const c = scan.chapters[0];
    assert.ok(c.keepPct < 95, '要算出字数保留率');
    assert.ok(c.bad.some(x => x.includes('字数只剩')), '字数掉太多必须报');
    assert.ok(c.bad.some(x => x.includes('感官')), '描写被删空要报');
  } finally { rm(b); }
});

test('“根本没改”要单独认出来——模型没跑起来时它和"改得不好"完全是两回事', () => {
  const t = para('他推门出去，雪腥味扑面。') + para('指节冻得发疼。');
  const b = mkBook({ 1: t });
  try {
    const scan = styleScan(b.dir, 1, 1, { before: { 1: t } });
    assert.equal(scan.chapters[0].unchanged, true);
    assert.ok(scan.issues[0].level === 'error', '没改是硬错，不是偏差');
  } finally { rm(b); }
});

test('返工指令只说这一批真的犯的毛病，且必须带"删了要补回来"', () => {
  const b = mkBook({ 1: para('他轰然倒地。') + para('冷。') });
  try {
    const scan = styleScan(b.dir, 1, 1);
    const ins = buildStyleFixInstruction(scan);
    assert.match(ins, /第1章/);
    assert.match(ins, /套话/);
    assert.match(ins, new RegExp(`不得低于原文 ${STYLE_STD.minKeepPct}%`));
    assert.match(ins, /一场戏都不许砍/);
  } finally { rm(b); }
});

test('【措辞纪律】批次指令绝不能出现能被读成"往后写"的话', () => {
  const b = mkBook({ 1: '正文' });
  try {
    const ins = buildBatchInstruction(b, 11, 20, { mustFix: ['[必改] 开局太慢→第2章就给冲突'] });
    assert.match(ins, /只改写第11到第20章/);
    assert.match(ins, /不新增任何章节/);
    assert.match(ins, /不写第21章/);
    // 这句是 2026-09-19 多写 14 章的直接原因，永远不许再出现
    assert.ok(!/后面各章|以此类推|照此执行/.test(ins), '不许出现"后面各章/照此执行"这类话');
    assert.match(ins, /必办清单/);
  } finally { rm(b); }
});

test('结构改造模式：允许按清单改剧情，但照样不许新增章节、且要同步台账', () => {
  // 2026-09-20《代码逆子与宇宙沙盒》诊断出 17 条必办，其中至少 10 条要动情节
  //（书名承诺"逆子"正文写成孝子、爽点迟到第14章、国家级超算变家用机箱）。
  // 精修模式的"剧情事实全部保留"会把这些全挡住，所以必须有第二种模式。
  const b = mkBook({ 1: '正文' });
  try {
    const polish = buildBatchInstruction(b, 1, 10, { mode: 'polish' });
    const rebuild = buildBatchInstruction(b, 1, 10, { mode: 'rebuild' });
    assert.match(polish, /剧情事实.*全部保留/);
    assert.match(rebuild, /允许按下面的必办清单改剧情/);
    assert.match(rebuild, /chapter_index\.md/, '改了剧情必须同步台账，否则后面的章接不上');
    for (const ins of [polish, rebuild]) {
      assert.match(ins, /不新增任何章节/, '两种模式都不许新增章节');
      assert.ok(!/后面各章|照此执行/.test(ins));
    }
    // 结构改造允许砍冗长推演，字数底线放宽，但不能只剩梗概
    assert.match(polish, /不得低于原文的 95%/);
    assert.match(rebuild, /不得低于原文的 85%/);
    assert.match(rebuild, /不能只剩梗概/);
  } finally { rm(b); }
});

test('阅读复核：解析成结构化条目，并能变成定点返工指令', () => {
  const raw = [
    '第29章｜空钩子｜结尾只说「变局已然拉开」，没有具体的事｜改成：南阳粮册上少掉的三千石被送到案头',
    '第30章｜人物｜主角全程平静从容｜让他在听到消息时打翻茶盏',
    '总评：结尾空、主角没有情绪',
  ].join('\n');
  const r = parseReadReview(raw);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].kind, '空钩子');
  assert.equal(r.summary, '结尾空、主角没有情绪');
  const ins = buildReadFixInstruction(r.items);
  assert.match(ins, /第29章/);
  assert.match(ins, /空钩子/);
  assert.match(ins, /只改这些地方/);
});

test('阅读复核的问题按章分批，方便一批一批地定点修', () => {
  const items = [{ num: 3, kind: '逻辑', problem: 'a', fix: 'b' }, { num: 12, kind: '人物', problem: 'c', fix: 'd' }];
  // 按【有问题的章数】分批：batchSize=10 时这两章合成一批（范围 3–12），batchSize=1 时拆成两批
  const one = readFixBatches(items, 10);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].nums, [3, 12]);
  assert.equal(one[0].from, 3);
  assert.equal(one[0].to, 12);
  assert.match(one[0].instruction, /第3章/);
  const two = readFixBatches(items, 1);
  assert.equal(two.length, 2);
  assert.deepEqual(two[1].nums, [12]);
});

test('通用诊断的输出能解析成必办清单（流水线直接拿它当指令）', () => {
  const raw = [
    '[必改] 卖点兑现太晚→第4章就要用金手指解决一件具体的事',
    '[建议] 简介与正文不符→改简介',
    '【一句话结论】开局慢、卖点兑现晚',
    '【最该先改的三章】第1章、第4章、第7章',
  ].join('\n');
  const d = parseDiagnose(raw);
  assert.equal(d.must.length, 1);
  assert.equal(d.advice.length, 1);
  assert.match(d.verdict, /开局慢/);
  assert.deepEqual(d.firstFix, [1, 4, 7]);
});

test('引擎必须提供改造流水线的四个入口，且只发改动章要靠指纹', () => {
  const src = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  for (const p of ['/api/book/diagnose', '/api/book/overhaul/start', '/api/book/overhaul/stop', '/api/book/overhaul/status', '/api/book/publish-changed']) {
    assert.ok(src.includes(p), '缺端点 ' + p);
  }
  const i = src.indexOf('function changedChapters');
  assert.ok(i > 0, '要有 changedChapters');
  // 没有基线指纹的章一律不算"改过"，否则会把整本书重发一遍
  assert.match(src.slice(i, i + 500), /hashes\[String\(c\.num\)\] &&/);
});
