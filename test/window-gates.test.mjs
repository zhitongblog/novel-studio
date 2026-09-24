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
