// 自纠进度心跳：节奏闸/快照闸退回自纠时，界面上要看得见"在改、改了哪几章、结束没有"。
//
// 由来：2026-10-02《重生岳雷》379–381 节奏闸未过 → 退回自纠，无头调用跑了好几分钟，
// 日志停在「⛔ 本批退回作者就地自纠」一句不动，作者以为写到一半停了（"自己检查自己不通过，但没有下一步"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chapterFilesInRange, watchFix, issueBrief } from '../src/statelessWriter.mjs';

function mkBook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixp-'));
  const v = path.join(dir, 'chapters', '卷04');
  fs.mkdirSync(v, { recursive: true });
  for (const [n, t] of [[378, '来牒'], [379, '逃户'], [380, '旧籍'], [381, '里正簿']]) fs.writeFileSync(path.join(v, `${n}${t}.txt`), '正文', 'utf8');
  fs.writeFileSync(path.join(v, '简介.txt'), 'x', 'utf8');
  return dir;
}

test('chapterFilesInRange 只取区间内的章节文件', () => {
  const got = chapterFilesInRange(mkBook(), 379, 381).map(f => f.label).sort();
  assert.deepEqual(got, ['第379章', '第380章', '第381章']);
});

test('watchFix 开始/心跳/结束都有日志，结束时报出改过的章', async () => {
  const dir = mkBook();
  const logs = [];
  const files = chapterFilesInRange(dir, 379, 381);
  const done = watchFix(files, '节奏自纠', e => logs.push(e), { timeoutMs: 60000, everyMs: 20 });
  assert.match(logs[0].msg, /节奏自纠开始/);
  await new Promise(r => setTimeout(r, 30));
  const fp = files.find(f => f.label === '第380章').fp;
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(fp, later, later);
  await new Promise(r => setTimeout(r, 50));
  const res = done({ ok: true });
  assert.ok(logs.some(e => /节奏自纠中…已用/.test(e.msg)), '应有心跳');
  assert.ok(logs.some(e => /已改：第380章/.test(e.msg)), '心跳应报出改过的章');
  assert.deepEqual(res.changed, ['第380章']);
  assert.match(logs[logs.length - 1].msg, /节奏自纠结束：用时 .*改了 第380章/);
  // 结束后不再心跳
  const n = logs.length;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(logs.length, n);
});

test('watchFix 没改任何文件时报 warn，超时会注明', () => {
  const logs = [];
  const done = watchFix(chapterFilesInRange(mkBook(), 379, 379), '节奏自纠', e => logs.push(e), { everyMs: 100000 });
  done({ ok: false, killed: true });
  const last = logs[logs.length - 1];
  assert.equal(last.level, 'warn');
  assert.match(last.msg, /超时被中止.*一个文件都没改/);
});

test('issueBrief 优先报 error 级问题', () => {
  const s = issueBrief({ issues: [{ level: 'warn', msg: '偏长' }, { level: 'error', msg: '文风机械：数目堆砌：379(每265字)' }] });
  assert.match(s, /数目堆砌/);
  assert.doesNotMatch(s, /偏长/);
  assert.equal(issueBrief({}), '');
});

// 口语密度闸：只对 standards.oral 配了阈值的书生效；书面腔、口语词扎堆都要报出来。
import { registerIssues, buildRegisterFixInstruction } from '../src/statelessWriter.mjs';
function mkOralBook(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oral-'));
  fs.mkdirSync(path.join(dir, 'chapters', '卷03'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', '卷03', '500测试章.txt'), text, 'utf8');
  return dir;
}
test('书面腔章节被口语密度闸报出来', () => {
  const formal = '他站在码头边上，望着远处的江面，心中思索着接下来应当如何应对这一局面。\n'.repeat(120);
  const r = registerIssues(mkOralBook(formal), 500, 500, { minPerK: 15, maxPerWord: 2 });
  assert.equal(r.length, 1);
  assert.match(r[0].bits.join('；'), /口语 .*\/千字（要 ≥15）/);
});
test('口语词超过每章上限也报', () => {
  const heavy = '他瞧了瞧外头，又瞧了瞧里头，自个儿瞧着江面发呆，瞧了半晌才回过神来，觉得这事儿还得慢慢掂量。\n'.repeat(60);
  const r = registerIssues(mkOralBook(heavy), 500, 500, { minPerK: 15, maxPerWord: 2 });
  assert.ok(r[0] && /口语词用太多：.*瞧×/.test(r[0].bits.join('；')), JSON.stringify(r));
});
test('自纠指令里写明每词上限与"只改语言"', () => {
  const s = buildRegisterFixInstruction([{ file: '500测试章.txt', bits: ['口语 3/千字（要 ≥15）'] }], { minPerK: 15, maxPerWord: 2 });
  assert.match(s, /只改语言，不改情节/);
  assert.match(s, /每章最多 2 次/);
  assert.match(s, /500测试章\.txt：口语 3\/千字/);
});
