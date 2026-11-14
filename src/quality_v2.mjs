// StoryAlter × Novel Studio 融合模块：Quality v2 长篇质量保障引擎
// 1. CanonicalState（五层事实库：book_contract / world / character_runtime / narrative / timeline + 版本化 state_commits）
// 2. PayoffLedger（结构化伏笔账本：setup → pending_payoff → paid_off / failed / abandoned + 逾期扫描）
// 3. Patch-First Repair Engine（局部 Patch 优先修复引擎 + 模糊匹配 fallback + 章节/项目三级快照回滚）
// 4. ContextAssembly（写前按 Token 预算装弹五层状态与必读伏笔 + 同步更新 continuity_ledger.md 快照段）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureStructure, splitLedger, setProgress } from './ledgersnap.mjs';

export const STATE_LAYERS = ['book_contract', 'world', 'character_runtime', 'narrative', 'timeline'];

function studioDir(bookDir) {
  const d = path.join(bookDir, '.studio');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJsonOr(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function newUuid() {
  return crypto.randomUUID ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
}

// ============================================================================
// 1. Canonical State (五层事实库) + State Commits (不可变版本日志)
// ============================================================================

export function loadCanonicalState(bookDir) {
  const p = path.join(studioDir(bookDir), 'canonical_state.json');
  const raw = readJsonOr(p, null);
  const base = {
    book_contract: {},
    world: {},
    character_runtime: {},
    narrative: {},
    timeline: {},
  };
  if (!raw) return base;
  // 兼容从 StoryAlter PostgreSQL 导出的数组格式 [{layer, scope_key, data}]
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row && STATE_LAYERS.includes(row.layer)) {
        if (row.scope_key) {
          base[row.layer][row.scope_key] = row.data;
        } else if (row.data && typeof row.data === 'object') {
          base[row.layer] = { ...base[row.layer], ...row.data };
        }
      }
    }
    return base;
  }
  for (const layer of STATE_LAYERS) {
    if (raw[layer] && typeof raw[layer] === 'object') {
      base[layer] = raw[layer];
    }
  }
  return base;
}

export function saveCanonicalState(bookDir, state) {
  const p = path.join(studioDir(bookDir), 'canonical_state.json');
  writeJson(p, state);
  return state;
}

export function loadStateCommits(bookDir) {
  const p = path.join(studioDir(bookDir), 'state_commits.json');
  const list = readJsonOr(p, []);
  return Array.isArray(list) ? list : [];
}

function saveStateCommits(bookDir, commits) {
  const p = path.join(studioDir(bookDir), 'state_commits.json');
  writeJson(p, commits);
}

// 风险分级：角色死亡、核心契约变更、核心世界观覆写 → high（需人工审批或高亮）
export function classifyStateChangeRisk(layer, patch = {}, source = 'auto_extract') {
  if (source === 'user_edit') return 'low';
  if (layer === 'book_contract') return 'high';
  const str = JSON.stringify(patch);
  if (/死亡|deceased|dead|身亡|陨落|废除|境界跌落|世界规则变更/i.test(str)) {
    return 'high';
  }
  if (layer === 'world' || layer === 'character_runtime') {
    return 'medium';
  }
  return 'low';
}

export function commitStateChange(bookDir, {
  layer,
  scopeKey = '',
  patch = {},
  source = 'user_edit',
  sourceChapter = null,
  reason = '',
  autoApproveHighRisk = false,
} = {}) {
  if (!STATE_LAYERS.includes(layer)) {
    throw new Error(`无效的事实层: ${layer}（可选：${STATE_LAYERS.join(', ')}）`);
  }
  const state = loadCanonicalState(bookDir);
  const commits = loadStateCommits(bookDir);
  const riskLevel = classifyStateChangeRisk(layer, patch, source);
  const shouldCommitImmediately = riskLevel !== 'high' || source === 'user_edit' || autoApproveHighRisk;

  const prevSnapshot = JSON.parse(JSON.stringify(state[layer] || {}));
  const commit = {
    id: newUuid(),
    layer,
    scopeKey: scopeKey || null,
    prevData: prevSnapshot,
    patch,
    source,
    sourceChapter,
    riskLevel,
    status: shouldCommitImmediately ? 'committed' : 'pending_review',
    reason: reason || '',
    createdAt: new Date().toISOString(),
    reviewedAt: shouldCommitImmediately ? new Date().toISOString() : null,
  };

  if (shouldCommitImmediately) {
    if (scopeKey) {
      state[layer][scopeKey] = { ...(state[layer][scopeKey] || {}), ...patch };
    } else {
      state[layer] = { ...(state[layer] || {}), ...patch };
    }
    saveCanonicalState(bookDir, state);
  }

  commits.unshift(commit);
  if (commits.length > 500) commits.length = 500;
  saveStateCommits(bookDir, commits);
  return { commit, state };
}

export function reviewStateCommit(bookDir, commitId, decision = 'approve') {
  const commits = loadStateCommits(bookDir);
  const hit = commits.find(c => c.id === commitId);
  if (!hit) throw new Error('找不到 state commit: ' + commitId);
  if (hit.status !== 'pending_review') throw new Error(`该 commit 状态已为 ${hit.status}`);

  const state = loadCanonicalState(bookDir);
  if (decision === 'approve' || decision === 'committed') {
    hit.status = 'committed';
    hit.reviewedAt = new Date().toISOString();
    if (hit.scopeKey) {
      state[hit.layer][hit.scopeKey] = { ...(state[hit.layer][hit.scopeKey] || {}), ...(hit.patch || {}) };
    } else {
      state[hit.layer] = { ...(state[hit.layer] || {}), ...(hit.patch || {}) };
    }
    saveCanonicalState(bookDir, state);
  } else {
    hit.status = 'rejected';
    hit.reviewedAt = new Date().toISOString();
  }
  saveStateCommits(bookDir, commits);
  return { commit: hit, state };
}

export function rollbackStateCommit(bookDir, commitId) {
  const commits = loadStateCommits(bookDir);
  const hit = commits.find(c => c.id === commitId);
  if (!hit) throw new Error('找不到 state commit: ' + commitId);
  if (!hit.prevData) throw new Error('该 commit 无可回滚的前置快照');

  const state = loadCanonicalState(bookDir);
  state[hit.layer] = JSON.parse(JSON.stringify(hit.prevData));
  saveCanonicalState(bookDir, state);
  hit.status = 'rolled_back';
  hit.reviewedAt = new Date().toISOString();
  saveStateCommits(bookDir, commits);
  return { commit: hit, state };
}

// ============================================================================
// 2. Payoff Ledger (伏笔账本)
// ============================================================================

export function loadPayoffLedger(bookDir) {
  const p = path.join(studioDir(bookDir), 'payoff_ledger.json');
  const list = readJsonOr(p, []);
  if (!Array.isArray(list)) return [];
  // 标准化字段名（兼容 StoryAlter PostgreSQL snake_case 导出）
  return list.map(item => ({
    id: item.id || newUuid(),
    type: item.type || 'foreshadow',
    title: item.title || '未命名伏笔',
    description: item.description || '',
    setupChapter: item.setupChapter ?? item.setup_chapter ?? null,
    setupExcerpt: item.setupExcerpt ?? item.setup_excerpt ?? '',
    expectedWindow: item.expectedWindow ?? item.expected_payoff_window ?? [],
    payoffChapter: item.payoffChapter ?? item.payoff_chapter ?? null,
    payoffExcerpt: item.payoffExcerpt ?? item.payoff_excerpt ?? '',
    state: item.state || 'setup', // 'setup' | 'pending_payoff' | 'paid_off' | 'failed' | 'abandoned'
    importance: Number(item.importance || 3),
    riskFlag: item.riskFlag ?? item.risk_flag ?? null, // 'late_payoff' | 'overdue' | 'contradicted' | null
    createdAt: item.createdAt || item.created_at || new Date().toISOString(),
    updatedAt: item.updatedAt || item.updated_at || new Date().toISOString(),
  }));
}

export function savePayoffLedger(bookDir, items) {
  const p = path.join(studioDir(bookDir), 'payoff_ledger.json');
  writeJson(p, items);
  return items;
}

export function addPayoffItem(bookDir, input) {
  const list = loadPayoffLedger(bookDir);
  const item = {
    id: newUuid(),
    type: input.type || 'foreshadow',
    title: String(input.title || '').trim() || '新伏笔',
    description: String(input.description || '').trim(),
    setupChapter: input.setupChapter != null ? Number(input.setupChapter) : null,
    setupExcerpt: input.setupExcerpt || '',
    expectedWindow: Array.isArray(input.expectedWindow) ? input.expectedWindow.map(Number) : [],
    payoffChapter: null,
    payoffExcerpt: '',
    state: input.state || 'pending_payoff',
    importance: Math.min(5, Math.max(1, Number(input.importance || 3))),
    riskFlag: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  list.push(item);
  savePayoffLedger(bookDir, list);
  return item;
}

export function updatePayoffItem(bookDir, id, patch) {
  const list = loadPayoffLedger(bookDir);
  const hit = list.find(x => x.id === id || x.title === id);
  if (!hit) throw new Error('找不到伏笔条目: ' + id);
  Object.assign(hit, patch, { updatedAt: new Date().toISOString() });
  if (hit.state === 'paid_off' || hit.state === 'abandoned') {
    hit.riskFlag = null;
  }
  savePayoffLedger(bookDir, list);
  return hit;
}

// 扫描逾期或超期未动静的伏笔
export function scanPayoffRisks(bookDir, currentChapter = 0) {
  const list = loadPayoffLedger(bookDir);
  let flaggedLate = 0;
  let flaggedOverdue = 0;
  for (const item of list) {
    if (item.state === 'paid_off' || item.state === 'abandoned' || item.state === 'failed') {
      item.riskFlag = null;
      continue;
    }
    const winEnd = Array.isArray(item.expectedWindow) && item.expectedWindow.length >= 2
      ? Number(item.expectedWindow[1])
      : (item.setupChapter ? Number(item.setupChapter) + 30 : 0);

    if (currentChapter > 0 && winEnd > 0 && currentChapter > winEnd + 10) {
      item.riskFlag = 'overdue';
      flaggedOverdue++;
    } else if (currentChapter > 0 && winEnd > 0 && currentChapter > winEnd) {
      item.riskFlag = 'late_payoff';
      flaggedLate++;
    } else if (currentChapter > 0 && item.setupChapter && currentChapter - item.setupChapter >= 25) {
      item.riskFlag = 'late_payoff';
      flaggedLate++;
    } else {
      item.riskFlag = null;
    }
  }
  savePayoffLedger(bookDir, list);
  return { total: list.length, flaggedLate, flaggedOverdue, items: list };
}

// ============================================================================
// 3. Context Assembly (生成前装弹 & 同步回 continuity_ledger.md 快照段)
// ============================================================================

export function assembleQualityV2Context(bookDir, { currentChapter = 0, maxChars = 3500 } = {}) {
  const state = loadCanonicalState(bookDir);
  const payoffs = loadPayoffLedger(bookDir);

  const lines = [];
  const layerLabels = {
    book_contract: '【书契约与核心红线】',
    world: '【当前世界观与规则（已确立）】',
    character_runtime: '【角色运行时状态（生死/境界/伤势/知情边界）】',
    narrative: '【叙事约束与不可违反项】',
    timeline: '【关键时间线锚点】',
  };

  let filledLayers = 0;
  for (const layer of STATE_LAYERS) {
    const data = state[layer];
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) continue;
    filledLayers++;
    lines.push(layerLabels[layer]);
    for (const [k, v] of Object.entries(data)) {
      const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
      lines.push(`- ${k}：${valStr}`);
    }
    lines.push('');
  }

  const activePayoffs = payoffs
    .filter(p => p.state === 'setup' || p.state === 'pending_payoff')
    .sort((a, b) => (b.importance || 3) - (a.importance || 3));

  if (activePayoffs.length > 0) {
    lines.push('【未回收伏笔账本（Payoff Ledger · 必读）】');
    for (const p of activePayoffs.slice(0, 15)) {
      const setupTag = p.setupChapter ? `第${p.setupChapter}章埋` : '已埋设';
      const winTag = Array.isArray(p.expectedWindow) && p.expectedWindow.length === 2
        ? `，期望第${p.expectedWindow[0]}-${p.expectedWindow[1]}章回收`
        : '';
      const riskTag = p.riskFlag ? ` ⚠️[${p.riskFlag}]` : '';
      lines.push(`- [重要度★${p.importance || 3}｜${setupTag}${winTag}] **${p.title}**${riskTag}：${p.description || p.setupExcerpt || ''}`);
    }
    lines.push('');
  }

  const block = lines.join('\n').trim();
  if (!block) return { promptBlock: '', filledLayers: 0, activePayoffs: 0 };

  const header = `## 🛡️ 长篇质量保障 v2（五层事实库 + 伏笔账本硬约束）\n`;
  const full = header + (block.length > maxChars ? block.slice(0, maxChars) + '\n…（已按预算截断）' : block);
  return {
    promptBlock: full,
    filledLayers,
    activePayoffs: activePayoffs.length,
  };
}

// 把结构化的五层事实库与未回收伏笔同步写进 continuity_ledger.md 的「📌 当前态快照」
export function syncQualityV2ToLedger(bookDir, maxChapter = 0) {
  ensureStructure(bookDir);
  const ledgerFile = path.join(bookDir, 'continuity_ledger.md');
  if (!fs.existsSync(ledgerFile)) return { ok: false, reason: 'no-ledger' };
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  const sp = splitLedger(raw);
  if (!sp.ok) return { ok: false, reason: 'split-failed' };

  const state = loadCanonicalState(bookDir);
  const payoffs = loadPayoffLedger(bookDir);

  let snap = sp.snapshot;
  if (maxChapter > 0) {
    snap = setProgress(snap, maxChapter);
  }

  // 在 LEDGER_HISTORY_BELOW 注释行之前注入/更新「### 五层事实库与伏笔账本同步区」
  const syncHeader = '### 五层事实库与伏笔账本（Quality v2 自动同步）';
  const charEntries = Object.entries(state.character_runtime || {}).map(
    ([name, info]) => `- **${name}**：${typeof info === 'object' ? JSON.stringify(info) : info}`
  );
  const pendingEntries = payoffs
    .filter(p => p.state === 'setup' || p.state === 'pending_payoff')
    .map(p => `- [${p.state}${p.riskFlag ? '·' + p.riskFlag : ''}] **${p.title}**：${p.description || p.setupExcerpt || ''}`);

  const syncSection = [
    syncHeader,
    ...(charEntries.length ? charEntries : ['- （角色运行时状态待抽取）']),
    ...(pendingEntries.length ? pendingEntries : ['- （暂无待回收伏笔）']),
    '',
  ].join('\n');

  const markRe = /^[^\S\n]*<!--[^\n]*LEDGER_HISTORY_BELOW[^\n]*-->[^\S\n]*$/m;
  const existingSyncRe = /### 五层事实库与伏笔账本（Quality v2 自动同步）[\s\S]*?(?=^### |^[^\S\n]*<!--[^\n]*LEDGER_HISTORY_BELOW)/m;

  if (existingSyncRe.test(snap)) {
    snap = snap.replace(existingSyncRe, syncSection);
  } else {
    snap = snap.replace(markRe, (m) => `${syncSection}${m}`);
  }

  fs.writeFileSync(ledgerFile, snap + sp.history, 'utf8');
  return { ok: true };
}

// ============================================================================
// 4. Snapshot (三级快照：project / volume / chapter) & Patch-First Repair Engine
// ============================================================================

function snapshotsDir(bookDir) {
  const d = path.join(studioDir(bookDir), 'snapshots');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function createSnapshot(bookDir, { scope = 'chapter', scopeId = '', trigger = 'manual', description = '' } = {}) {
  const id = newUuid();
  const payload = {};

  if (scope === 'chapter' && scopeId) {
    // scopeId 可以是相对于 bookDir 的路径（如 chapters/卷01/001开局.txt）或绝对路径
    const abs = path.isAbsolute(scopeId) ? scopeId : path.join(bookDir, scopeId);
    if (!fs.existsSync(abs)) throw new Error('找不到要快照的章节文件: ' + scopeId);
    payload.relPath = path.relative(bookDir, abs);
    payload.content = fs.readFileSync(abs, 'utf8');
  } else {
    // project 级快照：备份 novel_bible.md, continuity_ledger.md, chapter_index.md 及 .studio 核心状态
    for (const f of ['novel_bible.md', 'continuity_ledger.md', 'chapter_index.md']) {
      const fp = path.join(bookDir, f);
      if (fs.existsSync(fp)) payload[f] = fs.readFileSync(fp, 'utf8');
    }
    payload.canonicalState = loadCanonicalState(bookDir);
    payload.payoffLedger = loadPayoffLedger(bookDir);
  }

  const snap = {
    id,
    scope,
    scopeId,
    trigger,
    description,
    payload,
    createdAt: new Date().toISOString(),
  };

  writeJson(path.join(snapshotsDir(bookDir), `${id}.json`), snap);
  return snap;
}

export function listSnapshots(bookDir) {
  const dir = snapshotsDir(bookDir);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJsonOr(path.join(dir, f), null))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(({ payload, ...meta }) => meta);
  } catch {
    return [];
  }
}

export function restoreSnapshot(bookDir, snapshotId) {
  const p = path.join(snapshotsDir(bookDir), `${snapshotId}.json`);
  const snap = readJsonOr(p, null);
  if (!snap) throw new Error('找不到快照: ' + snapshotId);

  if (snap.scope === 'chapter' && snap.payload?.relPath) {
    const dst = path.join(bookDir, snap.payload.relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, snap.payload.content || '', 'utf8');
    return { restoredScope: 'chapter', file: snap.payload.relPath };
  }

  for (const f of ['novel_bible.md', 'continuity_ledger.md', 'chapter_index.md']) {
    if (typeof snap.payload?.[f] === 'string') {
      fs.writeFileSync(path.join(bookDir, f), snap.payload[f], 'utf8');
    }
  }
  if (snap.payload?.canonicalState) saveCanonicalState(bookDir, snap.payload.canonicalState);
  if (snap.payload?.payoffLedger) savePayoffLedger(bookDir, snap.payload.payoffLedger);
  return { restoredScope: snap.scope };
}

// 把审计问题分类为 local (用局部 patch) / cross_section / cross_chapter
export function classifyAuditIssue(issue = {}) {
  const desc = String(issue.description || issue.problem || '');
  if (issue.AffectedChapters?.length > 1 || /跨章|前几章|整卷|全书设定冲突/.test(desc)) {
    return { classification: 'cross_chapter', strategy: 'rewrite_section' };
  }
  if ((issue.originalExcerpt || '').length > 600) {
    return { classification: 'cross_section', strategy: 'rewrite_section' };
  }
  return { classification: 'local', strategy: 'patch' };
}

// 安全应用局部 Patch（支持精确匹配 + 忽略空白/标点微差的模糊匹配 fallback）
export function applyTextPatch(content, { originalExcerpt, newExcerpt }) {
  const src = String(content || '');
  const orig = String(originalExcerpt || '').trim();
  const replacement = String(newExcerpt ?? '');
  if (!orig) return { ok: false, error: 'originalExcerpt 不能为空' };

  // 1. 精确匹配
  const exactIdx = src.indexOf(orig);
  if (exactIdx >= 0) {
    const newContent = src.slice(0, exactIdx) + replacement + src.slice(exactIdx + orig.length);
    return { ok: true, mode: 'exact', newContent };
  }

  // 2. 忽略行首尾空白与换行差异的正则模糊匹配
  const escaped = orig
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  try {
    const re = new RegExp(escaped, 'm');
    const m = src.match(re);
    if (m && m.index != null) {
      const newContent = src.slice(0, m.index) + replacement + src.slice(m.index + m[0].length);
      return { ok: true, mode: 'fuzzy_whitespace', newContent };
    }
  } catch {}

  return { ok: false, error: '未能在章节正文中定位到 originalExcerpt' };
}

export function loadRepairTasks(bookDir) {
  const p = path.join(studioDir(bookDir), 'repair_tasks.json');
  const list = readJsonOr(p, []);
  return Array.isArray(list) ? list : [];
}

function saveRepairTasks(bookDir, list) {
  const p = path.join(studioDir(bookDir), 'repair_tasks.json');
  writeJson(p, list);
}

export function createRepairTask(bookDir, {
  chapterRelPath,
  issueSummary = '',
  originalExcerpt = '',
  newExcerpt = '',
} = {}) {
  const cls = classifyAuditIssue({ description: issueSummary, originalExcerpt });
  const tasks = loadRepairTasks(bookDir);
  const task = {
    id: newUuid(),
    chapterRelPath,
    issueSummary,
    classification: cls.classification,
    strategy: cls.strategy,
    patch: { originalExcerpt, newExcerpt },
    status: 'pending',
    snapshotId: null,
    createdAt: new Date().toISOString(),
    appliedAt: null,
  };
  tasks.unshift(task);
  saveRepairTasks(bookDir, tasks);
  return task;
}

export function applyRepairTask(bookDir, taskId) {
  const tasks = loadRepairTasks(bookDir);
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('找不到修复任务: ' + taskId);
  if (task.status !== 'pending') throw new Error(`任务状态为 ${task.status}，无法重复应用`);

  const abs = path.join(bookDir, task.chapterRelPath);
  if (!fs.existsSync(abs)) throw new Error('章节文件不存在: ' + task.chapterRelPath);

  const snap = createSnapshot(bookDir, {
    scope: 'chapter',
    scopeId: task.chapterRelPath,
    trigger: 'pre_repair',
    description: `Patch 修复前快照: ${task.issueSummary.slice(0, 60)}`,
  });
  task.snapshotId = snap.id;

  const oldText = fs.readFileSync(abs, 'utf8');
  const res = applyTextPatch(oldText, task.patch || {});
  if (!res.ok) {
    task.status = 'failed';
    task.errorMessage = res.error;
    saveRepairTasks(bookDir, tasks);
    return { ok: false, task, error: res.error };
  }

  fs.writeFileSync(abs, res.newContent, 'utf8');
  task.status = 'applied';
  task.matchMode = res.mode;
  task.appliedAt = new Date().toISOString();
  saveRepairTasks(bookDir, tasks);
  return { ok: true, task, snapshotId: snap.id, matchMode: res.mode };
}

export function rollbackRepairTask(bookDir, taskId) {
  const tasks = loadRepairTasks(bookDir);
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('找不到修复任务: ' + taskId);
  if (task.status !== 'applied' || !task.snapshotId) {
    throw new Error('只有已应用且带快照的任务才能回滚');
  }
  restoreSnapshot(bookDir, task.snapshotId);
  task.status = 'rolled_back';
  saveRepairTasks(bookDir, tasks);
  return task;
}

// ============================================================================
// 5. Project Health Report (项目健康度评分)
// ============================================================================

export function getBookHealthReport(bookDir, maxChapter = 0) {
  const state = loadCanonicalState(bookDir);
  const commits = loadStateCommits(bookDir);
  const payoffs = loadPayoffLedger(bookDir);
  const tasks = loadRepairTasks(bookDir);
  const snaps = listSnapshots(bookDir);

  const contextLayersFilled = STATE_LAYERS.filter(
    l => state[l] && Object.keys(state[l]).length > 0
  ).length;

  const totalPayoffs = payoffs.length;
  const paidOffCount = payoffs.filter(p => p.state === 'paid_off').length;
  const pendingPayoffs = payoffs.filter(p => p.state === 'setup' || p.state === 'pending_payoff').length;
  const overduePayoffs = payoffs.filter(p => p.riskFlag === 'overdue' || p.riskFlag === 'late_payoff').length;
  const paidOffRate = totalPayoffs > 0 ? paidOffCount / totalPayoffs : 1;

  const pendingReviewCommits = commits.filter(c => c.status === 'pending_review').length;
  const pendingRepairs = tasks.filter(t => t.status === 'pending').length;

  const overallScore = Math.round(
    (contextLayersFilled / 5) * 30 +
    (totalPayoffs > 0 ? paidOffRate * 30 : 30) +
    Math.max(0, 20 - pendingReviewCommits * 3 - overduePayoffs * 2) +
    Math.max(0, 20 - pendingRepairs * 3)
  );

  return {
    overallScore,
    maxChapter,
    contextLayersFilled,
    totalPayoffs,
    pendingPayoffs,
    paidOffCount,
    overduePayoffs,
    paidOffRate: Number(paidOffRate.toFixed(2)),
    totalCommits: commits.length,
    pendingReviewCommits,
    pendingRepairs,
    lastSnapshotAt: snaps[0]?.createdAt || null,
  };
}
