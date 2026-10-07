import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oralMode, oralSuggest, oralPromptSection } from '../src/oralgate.mjs';

test('oralMode: 关闭、旧配置兼容、门槛为 0 视同关闭', () => {
  assert.equal(oralMode(null), 'off');
  assert.equal(oralMode({ mode: 'off', minPerK: 15 }), 'off');
  assert.equal(oralMode({ minPerK: 15, maxPerWord: 2 }), 'fix');
  assert.equal(oralMode({ mode: 'report', minPerK: 5 }), 'report');
  assert.equal(oralMode({ mode: 'fix', minPerK: 0 }), 'off');
  assert.equal(oralMode({ mode: 'bogus', minPerK: 0 }), 'off');
});

test('oralPromptSection: 关着为空，开着写出门槛与单词上限', () => {
  assert.equal(oralPromptSection(null), '');
  assert.equal(oralPromptSection({ mode: 'off', minPerK: 10 }), '');
  const fix = oralPromptSection({ mode: 'fix', minPerK: 12, maxPerWord: 3 });
  assert.match(fix, /口语密度闸/);
  assert.match(fix, /每千字 12 个/);
  assert.match(fix, /最多 3 次/);
  assert.match(fix, /退回/);
  assert.match(oralPromptSection({ mode: 'report', minPerK: 4 }), /日志里提醒/);
});

test('oralSuggest: 前文不足 5 章建议关闭；够了按 25 分位给门槛，未标定只提醒', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oral-'));
  try {
    const vol = path.join(dir, 'chapters', 'v1');
    fs.mkdirSync(vol, { recursive: true });
    const body = '他杵在道边上，瞧着那辆车，啥也没说。俩人搁这儿等了挺久，末了还是走了。'.repeat(20);
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(vol, `${String(i).padStart(3, '0')}.txt`), body);
    let r = oralSuggest({ dir });
    assert.equal(r.stats.chapters, 3);
    assert.equal(r.suggest.mode, 'off');

    for (let i = 4; i <= 8; i++) fs.writeFileSync(path.join(vol, `${String(i).padStart(3, '0')}.txt`), body);
    r = oralSuggest({ dir });
    assert.equal(r.stats.chapters, 8);
    assert.equal(r.stats.from, 1);
    assert.equal(r.stats.to, 8);
    assert.equal(r.suggest.mode, 'report');
    assert.ok(r.suggest.minPerK >= 1);
    assert.equal(r.suggest.minPerK, Math.max(1, Math.round(r.stats.perKP25)));
    assert.ok(r.suggest.maxPerWord >= 2 && r.suggest.maxPerWord <= 4);

    fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify({ oralThresholds: { calibrated: true } }));
    assert.equal(oralSuggest({ dir }).suggest.mode, 'fix');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
