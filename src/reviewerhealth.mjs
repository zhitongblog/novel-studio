// 审稿人的「近况」：谁刚刚成功过、谁刚刚废了，记下来，下次按这个排队。
//
// 由来（作者原话）：「如果跑大纲，为什么一定要用 codex」「claude 不行吗」。
// 答：不是一定要用，是被写死了——reviewerCandidates 里 push('codex') 排第一，
// 注释还写着"codex 输出干净真能跑通，gemini/qwen/claude 本机实测多半跑不了"。
//
// 那条注释是对着【某一刻】的状态写的，现在已经反过来了：
//   2026-09-19 实测：codex 额度用尽（要到 9/23 才恢复）；gemini 长 prompt 把命令行撑坏、
//   吐自己的帮助文本；而 claude 237 秒给出一份高质量审稿（挑出射声校尉秩级、
//   王商任大司马年份、淳于长位置矛盾，每条都带章号改法）。
//
// 这跟 5a805fc8 是同一个病——那次把「agy 走直连」写死，两天后网络翻个个儿，
// 那本书白跑几小时。教训一样：【别对着某一刻的环境过拟合】。
//
// 所以这里不再写死顺序，而是记账：谁最近成了就往前排，谁最近因为额度/未登录这类
// 【短期内不会自己好】的原因废了，就往后排一段时间。作者显式指定的模型永远优先，
// 记账不参与、也不覆盖他的选择。

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';

const FILE = path.join(CONFIG_DIR, 'reviewer-health.json');

// 「短期内不会自己好」的失败：额度用尽、未登录、密钥无效。
// 这类降级要持续久一点——每次审稿都去撞一次额度墙，代价是作者多等一两分钟。
const COOLDOWN_FATAL_MS = 6 * 3600 * 1000;   // 6 小时
// 超时/偶发错误：可能只是这次 prompt 特别大，短暂降级即可，别把能用的模型一棍子打死。
const COOLDOWN_SOFT_MS = 45 * 60 * 1000;     // 45 分钟

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}
function write(m) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(m, null, 2), 'utf8'); } catch {}
}

// kind: 'fatal'（额度/未登录，短期好不了）| 'soft'（超时/偶发）
export function noteReviewerFail(model, kind = 'soft', reason = '') {
  if (!model) return;
  const m = read();
  m[model] = { ok: false, kind, reason: String(reason || '').slice(0, 120), at: Date.now() };
  write(m);
}
export function noteReviewerOk(model) {
  if (!model) return;
  const m = read();
  m[model] = { ok: true, at: Date.now() };
  write(m);
}

// 失败原因是不是「短期内不会自己好」的那种
export function classifyFail(msg) {
  return /(usage limit|quota|额度|not authenticated|no auth type|请先(登录|配置)|未登录|invalid api key|401)/i.test(String(msg || ''))
    ? 'fatal' : 'soft';
}

// 给一串候选排队：最近成功的往前，处在冷却期的往后。相对顺序之外的都保持原样。
// 【绝不删候选】——再怎么不看好也要留着兜底：全都在冷却期时，总得有人去试。
export function orderByHealth(cands) {
  const m = read();
  const now = Date.now();
  const score = (id) => {
    const h = m[id];
    if (!h) return 0;                                   // 没记录：中性
    if (h.ok) return -1;                                // 最近成功过：往前
    const cd = h.kind === 'fatal' ? COOLDOWN_FATAL_MS : COOLDOWN_SOFT_MS;
    return (now - h.at) < cd ? 1 : 0;                   // 还在冷却期：往后；冷却完了回中性
  };
  // 稳定排序：同分保持原顺序，别把作者/默认的偏好打乱
  return cands.map((id, i) => ({ id, i, s: score(id) }))
    .sort((a, b) => (a.s - b.s) || (a.i - b.i))
    .map(x => x.id);
}

// 给人看的一行：现在谁能用、谁在冷却
export function reviewerHealthSummary() {
  const m = read(); const now = Date.now();
  const rows = Object.entries(m).map(([id, h]) => {
    if (h.ok) return `${id} ✓（${Math.round((now - h.at) / 60000)} 分钟前成功）`;
    const cd = h.kind === 'fatal' ? COOLDOWN_FATAL_MS : COOLDOWN_SOFT_MS;
    const left = Math.max(0, cd - (now - h.at));
    return left > 0 ? `${id} ✗ 冷却中（还剩 ${Math.round(left / 60000)} 分钟｜${h.reason || h.kind}）` : `${id} ·（冷却已过）`;
  });
  return rows.length ? rows.join('；') : '（还没有记录）';
}
