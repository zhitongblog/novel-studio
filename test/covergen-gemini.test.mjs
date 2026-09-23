// Gemini 封面生成里最贵的那个坑：trustedType 返回 ≠ 字打完了。
//
// 它是一个字一个字敲的（delayMs=22），封面提示词两三百字要敲五六秒，而调用早就返回。
// 第一版等 1.2 秒就去点发送 → 发出去的是【半截提示词】，剩下的字继续往框里落 →
// 判定"输入框没清空"→ 以为没提交 → 重试 → 再打一遍，越积越乱。
// 实测现场：框里先是上一轮的尾巴「图适合做书籍封面。」，点完发送后又冒出「面装疯卖傻，实则冷静…」。
// 所以提交前必须等【字数不再增长】。这里钉住这条判据。
import assert from 'node:assert';
import test from 'node:test';
import { waitTypingSettled } from '../src/covergen_gemini.mjs';

// 轮询压到毫秒级：测的是判据，不是真去等六秒
const FAST = { pollMs: 2, maxPolls: 40 };

// 假 client：按剧本一次次返回输入框里的内容，模拟"字还在陆续落进去"
function mkClient(frames) {
  let i = 0;
  return { evaluate: async () => frames[Math.min(i++, frames.length - 1)] };
}

test('字还在往里落时不算打完，落稳了才返回', async () => {
  const full = '一'.repeat(200);
  const frames = [
    full.slice(0, 20), full.slice(0, 60), full.slice(0, 120), full.slice(0, 180),
    full, full, full, full,
  ];
  const got = await waitTypingSettled(mkClient(frames), full.length, FAST);
  assert.equal(got.length, full.length, `应等到全部 200 字，实际只等到 ${got.length}`);
});

test('长度不再变但没到 85%（字符被合并等）→ 也要放行，不能死等', async () => {
  const stuck = '短了点';
  const got = await waitTypingSettled(mkClient([stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck]), 200, FAST);
  assert.equal(got, stuck, '卡住不涨就该放行，否则整个流程会吊死在这里');
});

test('一个字都没落进去 → 返回空，由上层重打一遍', async () => {
  const got = await waitTypingSettled(mkClient(['', '', '', '', '', '', '', '']), 100, FAST);
  assert.equal(got, '', '空框要如实返回空');
});
