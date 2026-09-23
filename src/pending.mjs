// 全局确认门用的"待确认"状态：审稿出意见后挂在这里，autopilot 据此暂停，等用户经端点决定。
//
// ⚠️【必须落盘】原来这里只有一个进程内 Map，注释还写着"引擎重启=会话也没了，内存即可"。
// 2026-09-15 证明这句是错的：《穿成王莽后》卷02 的主编审稿跑完、11 条意见等着作者挑，
// 当天引擎重启了六次（连装 1.9.4→1.9.9），待挑状态每次都蒸发——
// 而审稿报告 reviews/大纲审稿-卷02.md 好好躺在硬盘上 30KB。
// 报告都落盘了，"等你挑"这个状态没理由不落盘。丢了它，作者就得从头再审一遍或者人肉抄意见。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.novel-studio', 'pending');
const fileOf = (slug) => path.join(DIR, encodeURIComponent(String(slug)) + '.json');

const _pending = new Map(); // slug -> { kind, scope, file, critique, at }

// 启动时把盘上的待确认全部读回来（引擎崩了/重装了，作者回到界面还能接着挑）
(function restore() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (info && info.slug) _pending.set(info.slug, info);
      } catch {}
    }
  } catch {}
})();

export function setPending(slug, info) {
  if (!slug) return;
  const rec = { ...info, slug, at: Date.now() };
  _pending.set(slug, rec);
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(slug), JSON.stringify(rec), 'utf8'); } catch {}
}
export function getPending(slug) { return slug ? _pending.get(slug) || null : null; }
export function clearPending(slug) {
  if (!slug) return;
  _pending.delete(slug);
  try { fs.unlinkSync(fileOf(slug)); } catch {}
}
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
