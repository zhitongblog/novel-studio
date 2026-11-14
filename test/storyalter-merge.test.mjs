import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  PRESET_ALTERS,
  loadBookAlter,
  saveBookAlter,
  recordAlterGrowth,
  buildAlterPromptSection,
  buildBookClonePrompt,
  buildPlotSimulationPrompt,
  applySimulatedBranchToOutline,
} from '../src/alter.mjs';

import {
  loadCanonicalState,
  commitStateChange,
  reviewStateCommit,
  rollbackStateCommit,
  loadPayoffLedger,
  addPayoffItem,
  updatePayoffItem,
  scanPayoffRisks,
  assembleQualityV2Context,
  syncQualityV2ToLedger,
  createRepairTask,
  applyRepairTask,
  rollbackRepairTask,
  getBookHealthReport,
} from '../src/quality_v2.mjs';

import { scaffoldBook } from '../src/scaffold.mjs';
import { buildBatchPack } from '../src/contextpack.mjs';

function makeTempBookDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-merge-test-'));
  const book = {
    id: 'test-book-1',
    title: '青云问道',
    slug: 'qingyun',
    dir,
    genre: '仙侠修真',
    standards: { totalWords: '100万字', volumes: '10', chaptersPerVolume: '20', targetCharsLo: 3000, targetCharsHi: 3600 },
  };
  scaffoldBook(book);
  fs.writeFileSync(path.join(dir, 'chapters', '卷01', '001青云门徒.txt'), '林川握紧断剑，左臂隐隐作痛。黑袍人留下的残破符纸还在怀里发烫。', 'utf8');
  return { dir, book };
}

test('StoryAlter Merge: Alter Persona (Soul/Brain/Body), Growth, Book Clone & Plot Simulation', () => {
  const { dir, book } = makeTempBookDir();

  assert.equal(loadBookAlter(dir), null);
  const saved = saveBookAlter(dir, 'shuangwen_blade');
  assert.equal(saved.name, PRESET_ALTERS.shuangwen_blade.name);

  const grown = recordAlterGrowth(dir, { chaptersAdded: 3, wordsAdded: 9600, learnedRule: '每章结尾必留悬念钩子' });
  assert.equal(grown.experience.totalChapters, 3);
  assert.equal(grown.experience.totalWords, 9600);
  assert.ok(grown.experience.learnedRules.includes('每章结尾必留悬念钩子'));

  const promptBlock = buildAlterPromptSection(dir);
  assert.ok(promptBlock.includes('热血爽文快刀手'));
  assert.ok(promptBlock.includes('每章结尾必留悬念钩子'));

  const clonePrompt = buildBookClonePrompt({ sampleText: '第一章 退婚...', targetTitle: '剑斩苍穹' });
  assert.ok(clonePrompt.includes('剑斩苍穹'));
  assert.ok(clonePrompt.includes('alterPersona'));

  const simPrompt = buildPlotSimulationPrompt(book, { focusQuestion: '黑袍人真实身份揭晓时机', chapterCount: 3 });
  assert.ok(simPrompt.includes('青云问道'));
  assert.ok(simPrompt.includes('黑袍人真实身份揭晓时机'));

  const applied = applySimulatedBranchToOutline(book, {
    id: 'A',
    title: '夜探藏经阁',
    beats: [
      { chapter: 2, event: '潜入藏经阁查符纸来历', advance: '发现长老内鬼线索', hook: '外面脚步声逼近' },
    ],
  }, 1);
  assert.equal(applied.addedBeats, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('StoryAlter Merge: Quality v2 (5-Layer Canonical State, Payoff Ledger, Patch Repair & ContextPack Integration)', () => {
  const { dir, book } = makeTempBookDir();

  // 1. Low/medium risk state commit -> auto committed
  const c1 = commitStateChange(dir, {
    layer: 'character_runtime',
    scopeKey: '林川',
    patch: { realm: '练气三层', injury: '左臂轻伤' },
    source: 'auto_extract',
  });
  assert.equal(c1.commit.status, 'committed');
  assert.equal(loadCanonicalState(dir).character_runtime['林川'].realm, '练气三层');

  // 2. High risk state commit (character death) -> pending_review until approved, then rollback
  const c2 = commitStateChange(dir, {
    layer: 'character_runtime',
    scopeKey: '二长老',
    patch: { status: '已身亡(dead)' },
    source: 'auto_extract',
  });
  assert.equal(c2.commit.riskLevel, 'high');
  assert.equal(c2.commit.status, 'pending_review');
  assert.equal(loadCanonicalState(dir).character_runtime['二长老'], undefined);

  const approved = reviewStateCommit(dir, c2.commit.id, 'approve');
  assert.equal(approved.commit.status, 'committed');
  assert.equal(loadCanonicalState(dir).character_runtime['二长老'].status, '已身亡(dead)');

  const rolled = rollbackStateCommit(dir, c2.commit.id);
  assert.equal(rolled.commit.status, 'rolled_back');
  assert.equal(loadCanonicalState(dir).character_runtime['二长老'], undefined);

  // 3. Payoff Ledger + Risk scan
  const p1 = addPayoffItem(dir, {
    title: '黑袍人神秘符纸',
    description: '怀中发烫的残破符纸指向后山禁地',
    setupChapter: 1,
    expectedWindow: [10, 20],
    importance: 5,
  });
  assert.equal(loadPayoffLedger(dir).length, 1);

  const scan = scanPayoffRisks(dir, 35);
  assert.equal(scan.flaggedOverdue, 1);

  // 4. Sync to continuity_ledger.md & assemble into buildBatchPack
  saveBookAlter(dir, 'mystery_architect');
  const syncRes = syncQualityV2ToLedger(dir, 1);
  assert.equal(syncRes.ok, true);
  const ledgerContent = fs.readFileSync(path.join(dir, 'continuity_ledger.md'), 'utf8');
  assert.ok(ledgerContent.includes('黑袍人神秘符纸'));
  assert.ok(ledgerContent.includes('练气三层'));

  const pack = buildBatchPack(book, { count: 2 });
  assert.ok(pack.prompt.includes('长篇质量保障 v2'));
  assert.ok(pack.prompt.includes('黑袍人神秘符纸'));
  assert.ok(pack.prompt.includes('诡秘悬疑布局师'));

  // 5. Patch-first repair & rollback
  const chRel = path.join('chapters', '卷01', '001青云门徒.txt');
  const task = createRepairTask(dir, {
    chapterRelPath: chRel,
    issueSummary: '修正受伤部位前后不一致',
    originalExcerpt: '左臂隐隐作痛',
    newExcerpt: '右肩旧伤隐隐作痛',
  });
  const applied = applyRepairTask(dir, task.id);
  assert.equal(applied.ok, true);
  assert.ok(fs.readFileSync(path.join(dir, chRel), 'utf8').includes('右肩旧伤隐隐作痛'));

  rollbackRepairTask(dir, task.id);
  assert.ok(fs.readFileSync(path.join(dir, chRel), 'utf8').includes('左臂隐隐作痛'));

  // 6. Resolve payoff & check health report
  updatePayoffItem(dir, p1.id, { state: 'paid_off', payoffChapter: 15 });
  const health = getBookHealthReport(dir, 15);
  assert.equal(health.paidOffRate, 1);
  assert.ok(health.overallScore >= 60);

  fs.rmSync(dir, { recursive: true, force: true });
});
