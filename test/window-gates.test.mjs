// 窗口模式的写后闸。
//
// 由来：2026-09-24 查《重生三国，我吕布杀出一片天》151 章——全部是窗口模式
// （agy 长驻窗口 + autopilot）写的。三道写后闸里只有 deslop 接上了（afterbatch），
// 节奏闸与台账快照闸只挂在 statelessWriter / cowrite 上，这条主路径一次都没跑过。
// 代价：36 章数目堆砌（最密第 35 章每 51 字一个数，读起来是后勤台账）、
// 13 章不足 3000 字、4 章章末是「一场……已然悄然拉开了……大幕！」的预告腔假钩子、
// 台账当前态快照停在第 149 章。这四样全是那两道闸本来就会拦下的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { batchGateInstruction, resetBatchGateNudges } from '../src/afterbatch.mjs';

const readSrc = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

// 造一本"节奏必然不过"的书：章太短 + 数目堆砌
function mkBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
  const vd = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(vd, { recursive: true });
  for (const [num, text] of chapters) {
    fs.writeFileSync(path.join(vd, String(num).padStart(3, '0') + '_测试章.txt'), text, 'utf8');
  }
  return { title: 'T', slug: 'T', dir, standards: {} };
}

test('窗口模式的闸落在【发继续之前】，不是 onBatchDone', () => {
  const ap = readSrc('autopilot.mjs');
  const i = ap.indexOf('onBeforeContinue');
  const j = ap.indexOf('await this.mcp.submitText(this.paneId, text)');
  assert.ok(i > 0, 'autopilot 要有 onBeforeContinue 钩子');
  assert.ok(i < j, '闸必须在发"继续"之前跑——onBatchDone 是发完之后才触发的，那时下一批已开写');
  // 不过就顶替"继续"、并且 return（本轮不写新章）
  const body = ap.slice(i, j);
  assert.match(body, /submitText\(this\.paneId, gateInstr\)/, '不过要把自纠指令发下去');
  assert.match(body, /return;/, '发完自纠指令必须 return，否则又把"继续"也发了一遍');
});

test('两条窗口路径都要挂——重挂的会话漏了等于重启后闸全没了', () => {
  for (const f of ['writer.mjs', 'attach.mjs']) {
    assert.match(readSrc(f), /onBeforeContinue: async \(\) => \{/, f + ' 没挂 onBeforeContinue');
  }
});

test('没写出新章时放行，不许拦住写作循环', () => {
  const b = mkBook([[1, '甲'.repeat(3200)]]);
  assert.equal(batchGateInstruction(b, { slug: 'T', from: 0, to: 0 }), null, 'to=0 表示这拍没新章');
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('章太短 → 退回自纠，且指令里说得出是哪几章', () => {
  resetBatchGateNudges('T');
  const b = mkBook([[1, '甲'.repeat(1200) + '。'], [2, '乙'.repeat(1100) + '。']]);
  const instr = batchGateInstruction(b, { slug: 'T', from: 1, to: 2 });
  assert.ok(instr, '字数不足硬下限应当退回自纠');
  assert.match(instr, /1|2/, '要指明是哪几章');
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('【防死循环】同一批最多退回一次，之后放行并留 warn——闸卡死写作比漏掉更糟', () => {
  resetBatchGateNudges('T');
  const b = mkBook([[1, '甲'.repeat(1200) + '。']]);
  const logs = [];
  const first = batchGateInstruction(b, { slug: 'T', from: 1, to: 1, onLog: (e) => logs.push(e) });
  assert.ok(first, '第一次要退回');
  const second = batchGateInstruction(b, { slug: 'T', from: 1, to: 1, onLog: (e) => logs.push(e) });
  assert.equal(second, null, '第二次必须放行，不能无限退回');
  assert.ok(logs.some(e => e.level === 'warn' && /重催上限/.test(e.msg)), '放行要留一条 warn，不能静默');
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('水位只在闸【通过】之后才推进——否则同一批只体检一次就永远跳过了', () => {
  for (const f of ['writer.mjs', 'attach.mjs']) {
    const src = readSrc(f);
    const i = src.indexOf('onBeforeContinue: async () => {');
    const body = src.slice(i, i + 1400);
    const ret = body.indexOf('if (instr) return instr;');
    const bump = body.indexOf('batchLowWater = now;');
    assert.ok(ret > 0 && bump > 0, f + ' 的闸体缺了退回或水位推进');
    assert.ok(ret < bump, f + '：必须"不过就 return、过了才推进水位"，反过来会让病章只被查一次就溜过去');
  }
});

test('排版矫正在闸之前跑——它是纯代码，不该因为节奏不过而被跳过', () => {
  for (const f of ['writer.mjs', 'attach.mjs']) {
    const src = readSrc(f);
    const i = src.indexOf('onBeforeContinue: async () => {');
    const body = src.slice(i, i + 1400);
    assert.ok(body.indexOf('afterBatch(') < body.indexOf('batchGateInstruction('),
      f + '：deslop 要先做掉，再判节奏/快照');
  }
});

test('onBatchDone 里不许再留 afterBatch——留着会把水位提前推掉', () => {
  for (const f of ['writer.mjs', 'attach.mjs']) {
    const src = readSrc(f);
    const i = src.indexOf('onBatchDone: async () => {');
    const j = src.indexOf('onBeforeContinue: async () => {');
    const body = i < j ? src.slice(i, j) : src.slice(i, i + 600);
    assert.ok(!body.includes('afterBatch('), f + ' 的 onBatchDone 里还留着 afterBatch，会和新闸抢水位');
  }
});

test('闸自己出异常不许阻断写作', () => {
  // book.dir 指向不存在的目录 → 两道闸都会抛，但必须吞掉返回 null
  const logs = [];
  const r = batchGateInstruction({ title: 'X', dir: path.join(os.tmpdir(), 'nope-' + Date.now()) },
    { slug: 'X', from: 1, to: 3, onLog: (e) => logs.push(e) });
  assert.equal(r === null || typeof r === 'string', true, '不许抛出去');
});

// ── 节奏闸 → 定点修 的通路 ──────────────────────────────────────
// 2026-09-24：节奏闸量出《重生三国》13 章字数不足，但它只会报警——
// 落实的通路（定点修 readfix）只认「空钩子/逻辑/人物/情绪」四类，字数不足塞不进去。
// 加了「篇幅」这第五类，两套机器才接上。
test('定点修认得「篇幅」这一类，且带上「补戏不补字」那条规矩', async () => {
  const { parseReadReview, buildReadFixInstruction } = await import('../src/readreview.mjs');
  const r = parseReadReview('第 82 章｜篇幅｜只有 2394 字，缺 606 字｜加一场具体的戏');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, '篇幅');
  assert.equal(r.items[0].num, 82);

  const instr = buildReadFixInstruction(r.items);
  assert.match(instr, /补的是戏，不是字/, '不带这条，模型就会去凑字数');
  assert.match(instr, /严禁靠复述前情/);
  assert.match(instr, /差得少的章/, '差几十字的章不该被硬塞一整场新戏');
  assert.match(instr, /字数不得变少/, '原有的硬约束不能丢');

  // 没有篇幅条目时不许多出这一段——提示词要紧凑
  const other = buildReadFixInstruction([{ num: 1, kind: '逻辑', problem: 'a', fix: 'b' }]);
  assert.ok(!other.includes('篇幅怎么改'));
  // 原来四类不许被破坏
  assert.equal(parseReadReview('第 3 章｜空钩子｜章末在总结｜换成具体的事').items[0].kind, '空钩子');
});

test('篇幅这种轻活必须走 polish，不能给 rebuild 的授权', async () => {
  const src = fs.readFileSync(new URL('../src/overhaul.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export async function runReadFix');
  const body = src.slice(i, i + 2200);
  assert.ok(!/mode: 'rebuild' \}/.test(body) || /const mode =/.test(body),
    'runReadFix 不许再写死 rebuild');
  assert.match(body, /const LIGHT = new Set\(\['篇幅', '情绪'\]\)/, '轻活清单');
  assert.match(body, /items\.every\(i => LIGHT\.has\(i\.kind\)\)/,
    '整批都是轻活才降级成 polish；掺一条重活就仍需 rebuild 的授权');
  assert.match(body, /buildBatchInstruction\(getBook\(slug\) \|\| book, b\.from, b\.to, \{ mode \}\)/,
    '算出来的 mode 要真的传下去，否则改了等于没改');
});

test('篇幅指令要有天花板——只给下限，模型就冲到 3997', async () => {
  const { buildReadFixInstruction } = await import('../src/readreview.mjs');
  const instr = buildReadFixInstruction([{ num: 22, kind: '篇幅', problem: '缺 76 字', fix: 'x' }]);
  assert.match(instr, /不得超过 3600/, '第 22 章就是这么从"不足"变成"超标"的');
  assert.match(instr, /补到刚过 3000 就停手/);
  assert.match(instr, /不要为了腾地方去删原有的情节/, '为补 76 字删掉 110 行已上架原文，是这次最实的教训');
});
