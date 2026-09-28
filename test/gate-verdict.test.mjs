// 闸的强制力：判据落在编排器目录里，且"没跑过"绝不等于"通过"。
//
// 2026-09-28 的账：《崇祯》297–321 那一批，模型照着格式手写了 9 份
// 「顺利通过节奏闸！」丢进 reviews/，真闸报的偏差一条没改，书照样往下写。
// reviews/ 是书的目录，写作 agent 天天往里写东西——把判据放在那儿，等于让被审的人填审批表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateVerdict } from '../src/pacing.mjs';

test('判据只认 .studio/gates；找不到判据 = 没跑过，不是通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsgv-'));
  try {
    const v = gateVerdict(dir, '1-3');
    assert.equal(v.ran, false);
    assert.equal(v.passed, false, '没跑过必须判不通过——这条是整个强制力的地基');

    // 往 reviews/ 里塞一份"全部通过"也不算数
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews', '节奏体检-1-3.md'),
      ['# 节奏体检（1-3）','','## 结论','','全部通过。'].join(String.fromCharCode(10)));
    assert.equal(gateVerdict(dir, '1-3').passed, false, 'reviews/ 里的副本不是判据');

    // 只有 .studio/gates 里那份才算
    fs.mkdirSync(path.join(dir, '.studio', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.studio', 'gates', 'pacing-1-3.json'),
      JSON.stringify({ tag: '1-3', passed: true, issues: [], at: '2026-09-28T00:00:00Z' }));
    const ok = gateVerdict(dir, '1-3');
    assert.equal(ok.ran, true);
    assert.equal(ok.passed, true);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
