// Unterm 0.65 适配自测：钉住两类回归。
// ① 认 pane：0.65 起 session.list 是【全机器】的 pane 列表，绝不能取"第一个活 pane"（会挂到别的书的窗口）。
// ② autopilot 忙闲判定：改用 agent.status（hook 上报）+ session.idle 的输出字节，而不是猜屏幕。
//    覆盖"长思考不被误判成干完"（圣经生成失败那个案子）与"在写的时候不抢答续写征询"（一夜滚 44 章那个案子）。
import assert from 'node:assert';
import { Autopilot } from '../src/autopilot.mjs';
import { waitForPane } from '../src/writer.mjs';

const DIR_A = 'D:\\books\\aaa';
const DIR_B = 'D:\\books\\bbb';
const pane = (id, cwd) => ({ id, is_dead: false, shell: { cwd } });

async function testWaitForPane() {
  // 全局 pane 列表里，第一个 pane 是【别的书】的窗口
  const mcp = { async sessionList() { return [pane(1, DIR_A), pane(2, DIR_B)]; } };

  // ① 新出现 + 目录匹配 → 认 2（老写法会返回 1，等于挂到 A 书的窗口上）
  assert.strictEqual(await waitForPane(mcp, 3000, { beforePaneIds: new Set(['1']), cwd: DIR_B }), 2);

  // ② 快照没拿到（空集合）时，靠目录唯一匹配也能认对
  assert.strictEqual(await waitForPane(mcp, 3000, { beforePaneIds: new Set(), cwd: DIR_B }), 2);

  // ③ 目录对不上任何 pane → 宁可返回 null 让上层重试，也绝不猜一个
  assert.strictEqual(await waitForPane(mcp, 600, { beforePaneIds: new Set(['1', '2']), cwd: 'D:\\books\\ccc' }), null);

  // ④ 路径分隔符/大小写/尾斜杠不一致也要认得出
  assert.strictEqual(await waitForPane(mcp, 3000, { beforePaneIds: new Set(['1']), cwd: 'd:/BOOKS/bbb/' }), 2);
  console.log('✓ 认 pane：按"新出现 + shell.cwd"认，绝不回退到第一个 pane');
}

// 造一个可编排的假 MCP：状态由外部对象驱动
function makeMcp(state) {
  const sent = [];
  return {
    sent,
    async sessionList() { return [pane(1, DIR_A)]; },
    async screenInfo() { return { text: state.screen, rows: state.rows ?? 38, cols: 140, nonEmpty: state.screen.split('\n').filter(l => l.trim()).length }; },
    async screenText() { return state.screen; },
    async status() { return {}; },                       // 0.65：session.status 已经没有 busy 字段
    async agentStatus() { return state.agent ? { state: state.agent } : null; },
    async sessionIdle() { return { idle: state.agent !== 'working', outBytes: state.bytes, detectedAgent: 'claude' }; },
    async submitText(_id, t) { sent.push(t); },
    async enter() { sent.push('<ENTER>'); },
    async input() {},
  };
}

const IDLE_SCREEN = ['claude · /books/aaa', '已写完本批。', '❯ '].join('\n');

function confirmOnlyAp(mcp, done) {
  return new Autopilot(mcp, 1, {
    pollMs: 3000, idleConfirms: 2, confirmOnly: true,
    confirmDoneIdle: 40, confirmDoneIdleSignal: 12,
    stopOnPhrases: [], onLog: () => {}, onDone: done,
  });
}

async function ticks(ap, n) { for (let i = 0; i < n; i++) await ap._tick(); }

// 长思考（bible ~8 分钟）：agent.status=working 且输出字节在涨 → 绝不能判"干完了"收窗
async function testLongThinkingNotKilled() {
  const state = { screen: IDLE_SCREEN, agent: 'working', bytes: 1000 };
  const mcp = makeMcp(state);
  let doneCalled = false;
  const ap = confirmOnlyAp(mcp, () => { doneCalled = true; });
  for (let i = 0; i < 60; i++) { state.bytes += 5; await ap._tick(); }   // 60 拍 = 180s
  assert.strictEqual(doneCalled, false, '长思考期间不能收窗');
  assert.deepStrictEqual(mcp.sent, [], '长思考期间不能注入任何东西');
  console.log('✓ 长思考（working + 输出在涨）不会被误判成任务完成');
}

// 真干完了：agent.status=idle 且输出字节不再涨 → 12 拍即可收窗（有权威状态，不必死等 120s）
async function testDoneCollapses() {
  const state = { screen: IDLE_SCREEN, agent: 'idle', bytes: 5000 };
  const mcp = makeMcp(state);
  let reason = null;
  const ap = confirmOnlyAp(mcp, (r) => { reason = r; });
  await ticks(ap, 11);
  assert.strictEqual(reason, null, '不到阈值不能收窗');
  await ticks(ap, 2);
  assert.strictEqual(reason, '任务完成');
  console.log('✓ agent.status=idle + 输出静止 → 按权威阈值收窗');
}

// 屏幕瞬时塌成 1×1 空屏（0.65 实测过）：整拍跳过，不能被当成"屏幕没变化"一路累加空闲
async function testDegenerateScreenSkipped() {
  const state = { screen: '', rows: 1, agent: 'idle', bytes: 7000 };
  const mcp = makeMcp(state);
  let doneCalled = false;
  const ap = confirmOnlyAp(mcp, () => { doneCalled = true; });
  await ticks(ap, 30);
  assert.strictEqual(doneCalled, false, '残缺读屏不能计入空闲');
  console.log('✓ 1×1 空屏残缺读数被跳过，不计入空闲');
}

// 它正在写的时候屏幕上出现"要不要接着写下一段？"（流式输出中间态）→ 不抢答；
// 直到 agent.status 变成 waiting（真的停下来等人）才应答，且【作者主导】模式下回绝
async function testNoAnswerWhileWorking() {
  const ask = ['claude · /books/aaa', '这一段写完了。', '要不要接着写下一段？'].join('\n');
  const state = { screen: ask, agent: 'working', bytes: 100 };
  const mcp = makeMcp(state);
  const ap = confirmOnlyAp(mcp, () => {});
  for (let i = 0; i < 6; i++) { state.bytes += 3; await ap._tick(); }
  assert.deepStrictEqual(mcp.sent, [], '还在写的时候不能抢答续写征询');

  state.agent = 'waiting';                 // 真的停下来在等人了
  await ap._tick();
  assert.strictEqual(mcp.sent.length, 1, 'waiting 时应当一拍就应答');
  assert.match(mcp.sent[0], /不用继续|停下/, '作者主导模式下要回绝续写');
  console.log('✓ working 时不抢答；waiting 时一拍应答并回绝续写');
}

await testWaitForPane();
await testLongThinkingNotKilled();
await testDoneCollapses();
await testDegenerateScreenSkipped();
await testNoAnswerWhileWorking();
console.log('\n全部通过 ✅  Unterm 0.65 适配正确');
