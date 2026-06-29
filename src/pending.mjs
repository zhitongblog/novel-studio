// 全局确认门用的"待确认"状态：审稿出意见后挂在这里，autopilot 据此暂停，等用户经端点决定。
// 进程内内存即可（待确认是临时的、跟着活跃写作会话走；引擎重启=会话也没了）。
const _pending = new Map(); // slug -> { kind, scope, file, critique, at }

export function setPending(slug, info) {
  if (!slug) return;
  _pending.set(slug, { ...info, at: Date.now() });
}
export function getPending(slug) { return slug ? _pending.get(slug) || null : null; }
export function clearPending(slug) { if (slug) _pending.delete(slug); }
export function hasPending(slug) { return !!(slug && _pending.has(slug)); }

// ——— 写作模式 · 逐批审核（半自动）———
// reviewEvery：每写够 N 批就停下等用户审核（0 = 全自动，不停）。运行时可热切换，autopilot 每拍实时读。
const _reviewEvery = new Map();   // slug -> integer
export function setReviewEvery(slug, n) {
  if (!slug) return;
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v > 0) _reviewEvery.set(slug, v); else _reviewEvery.delete(slug);
}
export function getReviewEvery(slug) { return slug ? (_reviewEvery.get(slug) || 0) : 0; }

// 审核点暂停时，autopilot 把"本应自动发送的续写文案"存这里，供端点据此构造"批准并继续"的指令。
const _reviewDefault = new Map();  // slug -> text
export function setReviewDefault(slug, text) { if (slug) _reviewDefault.set(slug, String(text || '')); }
export function getReviewDefault(slug) { return slug ? (_reviewDefault.get(slug) || '') : ''; }

// 用户裁决后，端点把"下一批要发的指令(默认/含用户要求)"存这里，autopilot 取走并注入、推进计数。
const _resume = new Map();          // slug -> text
export function setResume(slug, text) { if (slug) _resume.set(slug, String(text || '')); }
export function takeResume(slug) {
  if (!slug) return null;
  const v = _resume.has(slug) ? _resume.get(slug) : null;
  _resume.delete(slug);
  return v;
}
