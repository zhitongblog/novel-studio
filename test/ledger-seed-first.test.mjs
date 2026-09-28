// 开写前必须先看台账快照。
//
// 写后闸（snapshotGate）只在【写完一批之后】跑，所以一本从没迁移过台账的书，
// 第一批是顶着「已写到第 000 章」的空快照开写的。
// 2026-09-28《我本凡人，奈何AI要修仙》：222 章、台账 12.3 万字符从没分过区，
// 每批只喂得进前 8000 字符（inspect 实测 fedRatio 6%）——写到 222 章还在照开篇的旧账写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('startWriting 在开写前检查快照，缺了就先补快照而不是直接写新章', () => {
  const src = fs.readFileSync(new URL('../src/writer.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export async function startWriting');
  assert.ok(i > 0, '找得到入口');
  const head = src.slice(i, i + 3000);
  assert.ok(/needsSeed/.test(head), '入口必须查 needsSeed');
  assert.ok(/ensureStructure/.test(head), '入口必须幂等补两区结构');
  const seedPos = head.indexOf('seedFirst = seedInstruction');
  const usePos = head.indexOf('if (seedFirst) instruction = seedFirst;');
  assert.ok(seedPos > 0 && usePos > seedPos, '快照缺失时要把补快照顶替成本轮第一条指令');
});
