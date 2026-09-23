// 改造流水线（救书）：把 2026-09-19/20 救《穿成王莽后》那两天踩过的坑逐条钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { styleScan, countSimiles, countPiles, buildStyleFixInstruction, STYLE_STD } from '../src/stylegate.mjs';
import { buildBatchInstruction, readFixBatches, pickMustFix, parseReadReportFile, parseQuotaReset } from '../src/overhaul.mjs';
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
    const ins = buildBatchInstruction(b, 11, 20, { mustFix: ['[必改] 第14章 REM 写错了→改成 NREM 三期'] });
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
  for (const p of ['/api/book/diagnose', '/api/book/read-review', '/api/book/apply-read-review', '/api/book/overhaul/start', '/api/book/overhaul/stop', '/api/book/overhaul/status', '/api/book/publish-changed']) {
    assert.ok(src.includes(p), '缺端点 ' + p);
  }
  const i = src.indexOf('function changedChapters');
  assert.ok(i > 0, '要有 changedChapters');
  // 没有基线指纹的章一律不算"改过"，否则会把整本书重发一遍
  assert.match(src.slice(i, i + 500), /hashes\[String\(c\.num\)\] &&/);
});

test('结构改造时字数是软线：按清单砍了戏不算不达标，砍过头才算', () => {
  // 2026-09-20《代码逆子》第1章：诊断明确要求砍掉开篇铺垫，模型照做 → 61%，
  // 却被字数闸判不达标退回重做——流水线自己跟必办清单打架。
  const long = para('他').repeat(200);
  const b = mkBook({ 1: para('他推门出去，雪腥味扑面。') + para('指节冻得发疼，喉咙一股铁锈味。') + para('远处有人在咳。') });
  try {
    const soft = styleScan(b.dir, 1, 1, { before: { 1: long }, std: { keepSoft: true, hardFloorPct: 70, minKeepPct: 85 } });
    const hard = styleScan(b.dir, 1, 1, { before: { 1: long }, std: { minKeepPct: 85 } });
    assert.ok(hard.chapters[0].bad.some(x => x.includes('字数只剩')), '精修模式下字数掉了就是不达标');
    // 砍到 70% 以下仍然判死（这是"砍过头只剩梗概"）
    assert.ok(soft.chapters[0].bad.some(x => x.includes('字数只剩')), '砍过头必须判不达标');
    // 轻微低于目标线时只提醒
    const mild = styleScan(b.dir, 1, 1, { before: { 1: para('他推门出去，雪腥味扑面。') + para('指节冻得发疼，喉咙一股铁锈味。') + para('远处有人在咳。') + para('他又站了一会。') }, std: { keepSoft: true, hardFloorPct: 70, minKeepPct: 95 } });
    assert.equal(mild.chapters[0].bad.length, 0, '结构改造下轻微缩水不判死');
    assert.ok(mild.chapters[0].warn?.length, '但要记进报告提醒');
  } finally { rm(b); }
});

test('必办清单要【按批次筛】——不筛的话模型会认定"本批没事可做"，跑二十分钟一个字不改', () => {
  // 2026-09-20《代码逆子》第 11–20 章实证：塞进去的是清单前 12 条，全在点名第 1–9 章，
  // claude 读完就报"任务完成"收工，十章一个字没动。
  const must = [
    '[必改] 第1章开局慢→砍掉营养液那段',
    '[必改] 第14章 REM 写错了→改成 NREM 三期',
    '[必改] 主角全程平静从容→该慌就慌',        // 不带章号 = 全书通则
  ];
  const b = mkBook({ 1: '正文' });
  try {
    const p = pickMustFix(must, 11, 20);
    assert.deepEqual(p.inRange, ['[必改] 第14章 REM 写错了→改成 NREM 三期'], '只要点名本批的');
    assert.equal(p.global.length, 1, '不带章号的通则要留下');
    const ins = buildBatchInstruction(b, 11, 20, { mustFix: must });
    assert.match(ins, /第14章 REM/);
    assert.ok(!/第1章开局慢/.test(ins), '别把别批的活塞进来');
    assert.match(ins, /全书通则/);
    // 清单一条都不沾这批时，必须明说"照样要改"，不能让模型以为没事可做
    const none = buildBatchInstruction(b, 21, 30, { mustFix: ['[必改] 第1章开局慢→砍掉营养液那段'] });
    assert.match(none, /诊断没有点名第21到第30章，但本批同样要改/);
  } finally { rm(b); }
});

test('复核报告能从落盘的 md 读回条目——复核与定点修常隔着几小时甚至隔天', () => {
  const md = [
    '# 阅读复核 1-20', '', '| 章 | 类型 | 问题 | 怎么改 |', '|---|---|---|---|',
    '| 1 | 逻辑 | 十九秒里做完五件事 | 把倒计时改成九十秒 |',
    '| 20 | 空钩子 | 结尾落在"收：待定" | 改成一件具体的事 |',
    '| 说明 | 这行不是条目 | x | y |',
  ].join(String.fromCharCode(10));
  const items = parseReadReportFile(md);
  assert.equal(items.length, 2, '只认四列且类型合法的行');
  assert.equal(items[0].num, 1);
  assert.equal(items[1].kind, '空钩子');
});

test('额度恢复时间：agy 和 claude 两种写法都要认，认不出才退避', () => {
  // 2026-09-21 实测：claude 的额度按小时窗口给，而解析只认 agy 的「Resets in 6m8s」，
  // 于是每次都退回默认 15 分钟 → 每 15 分钟白开一次窗口、白撞一次上限。
  const now = new Date('2026-09-21T21:12:00');
  assert.equal(parseQuotaReset('⚠ Individual quota reached. Resets in 6m8s', now), 368000);
  assert.equal(Math.round(parseQuotaReset('Claude usage limit reached · your limit will reset at 10pm', now) / 60000), 48);
  assert.equal(Math.round(parseQuotaReset('resets at 3:00 AM', now) / 60000), 348);
  assert.equal(parseQuotaReset('什么都没写', now), null, '认不出要返回 null，让调用方退避，别硬编一个数');
});
