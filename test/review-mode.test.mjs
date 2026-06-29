// 逐批审核（半自动写作模式）状态机自测：用假 MCP 驱动真 Autopilot + 真 pending store。
// 覆盖：①审核模式到点会暂停(不自动续写)、设待确认、注入暂停指令；②用户裁决后恢复并推进批次；
//       ③全自动模式连续续写不暂停；④运行中热切回全自动会放行当前暂停。
import assert from 'node:assert';
import { Autopilot } from '../src/autopilot.mjs';
import {
  setReviewEvery, getReviewEvery, setReviewDefault, getReviewDefault,
  setResume, takeResume, setPending, getPending, clearPending, hasPending,
} from '../src/pending.mjs';

// —— 一块“写完一批、回到输入态、在等下一步”的稳定屏幕（让 classify→continue）——
const IDLE = [
  'codex gpt-5 medium · /books/demo',
  '已写完本批 3 章并更新台账。',
  '❯ ',
].join('\n');

// 假 MCP：记录注入，屏幕恒为 IDLE（稳定 → autopilot 判定空闲）
function makeMcp() {
  const sent = [];
  return {
    sent,
    async sessionList() { return [{ id: 1, is_dead: false }]; },
    async screenText() { return IDLE; },
    async status() { return { busy: false }; },
    async submitText(_id, text) { sent.push(text); },
    async enter() { sent.push('<ENTER>'); },
  };
}

// 像 writer.mjs 那样接线一本书的 autopilot 选项
function wire(slug, mcp) {
  const onBatchReview = async ({ n, defaultText }) => {
    setReviewDefault(slug, defaultText);
    setPending(slug, { kind: 'batch-review', n, chapters: n * 3 });
    return '本批已写完。请【暂停】等用户审核后再继续。';
  };
  return new Autopilot(mcp, 1, {
    pollMs: 1, idleConfirms: 2, maxAutoContinue: 40,
    continueText: '继续下一批（默认指令）',
    fullCheckEvery: 0, paceCheckEvery: 0, styleCheckEvery: 0,
    stopOnPhrases: [],
    assumeStarted: true,                  // agent 已在跑：空闲即可驱动
    onLog: () => {},
    reviewEvery: () => getReviewEvery(slug),
    onBatchReview,
    takeReviewResume: () => takeResume(slug),
    isPending: () => hasPending(slug),
  });
}

// 直接打 _tick，绕过 start() 的真实 setTimeout 轮询
async function ticks(ap, n) { for (let i = 0; i < n; i++) await ap._tick(); }

async function testReviewPauseAndResume() {
  const slug = 'demo-review';
  clearPending(slug); setReviewEvery(slug, 1);   // 每批审核
  const mcp = makeMcp();
  const ap = wire(slug, mcp);

  // 两拍稳定后到达审核点 → 应暂停：注入“暂停”指令、设待确认、未自动续写
  await ticks(ap, 2);
  assert.equal(hasPending(slug), true, '到点应进入待审核');
  assert.equal(getPending(slug).kind, 'batch-review');
  assert.equal(ap.continueCount, 0, '审核暂停时不应推进批次');
  assert.equal(mcp.sent.length, 1, '只应注入一条“暂停”指令');
  assert.match(mcp.sent[0], /暂停/);
  assert.equal(getReviewDefault(slug), '继续下一批（默认指令）', '应暂存默认续写文案');

  // 暂停期间再多拍：被 isPending 门挡住，不应有任何新注入
  await ticks(ap, 3);
  assert.equal(mcp.sent.length, 1, '待审核期间不应继续注入');

  // 模拟端点“批准并附加要求”：default + 要求 → setResume + clearPending
  const req = '让主角这一批吃个瘪，节奏放慢';
  setResume(slug, `先严格执行我对下一批的【额外要求】：${req}。在满足该要求的前提下，${getReviewDefault(slug)}`);
  clearPending(slug);

  // 下一拍：恢复门注入续写指令并推进批次
  await ticks(ap, 1);
  assert.equal(ap.continueCount, 1, '裁决后应推进一批');
  assert.equal(mcp.sent.length, 2);
  assert.match(mcp.sent[1], /额外要求/);
  assert.match(mcp.sent[1], new RegExp(req.slice(0, 6)));

  // 写完这一批又到下一个审核点 → 再次暂停（每批审核）
  ap.lastRespondedHash = null;            // 模拟屏幕已翻篇
  await ticks(ap, 2);
  assert.equal(hasPending(slug), true, '下一批又应进入待审核');
  console.log('✓ 审核模式：暂停 → 裁决(含要求) → 推进 → 再暂停');
}

async function testAutoModeNeverPauses() {
  const slug = 'demo-auto';
  clearPending(slug); setReviewEvery(slug, 0);   // 全自动
  const mcp = makeMcp();
  const ap = wire(slug, mcp);

  await ticks(ap, 2);
  assert.equal(hasPending(slug), false, '全自动不应进入待审核');
  assert.equal(ap.continueCount, 1, '全自动应直接续写一批');
  assert.equal(mcp.sent[0], '继续下一批（默认指令）');
  console.log('✓ 全自动模式：连续续写，不暂停');
}

async function testHotSwitchToAutoReleases() {
  const slug = 'demo-switch';
  clearPending(slug); setReviewEvery(slug, 1);
  const mcp = makeMcp();
  const ap = wire(slug, mcp);

  await ticks(ap, 2);
  assert.equal(hasPending(slug), true, '先进入待审核');

  // 端点“切回全自动”的等价动作：放行当前暂停 + 关审核
  setResume(slug, getReviewDefault(slug));
  clearPending(slug);
  setReviewEvery(slug, 0);

  await ticks(ap, 1);
  assert.equal(ap.continueCount, 1, '切回全自动后应放行续写');

  // 此后不再暂停
  ap.lastRespondedHash = null;
  await ticks(ap, 2);
  assert.equal(hasPending(slug), false, '全自动后不应再暂停');
  assert.equal(ap.continueCount, 2);
  console.log('✓ 运行中热切回全自动：放行当前暂停并连续写');
}

await testReviewPauseAndResume();
await testAutoModeNeverPauses();
await testHotSwitchToAutoReleases();
console.log('\n全部通过 ✅  逐批审核状态机正确');
