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
