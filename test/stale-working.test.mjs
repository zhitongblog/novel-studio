// 「陈旧 working」自测：agent 侧 hook 挂了，agent.status 永远停在 working，autopilot 再也不续写。
//
// 现场（《走进修仙》pane 7，2026-09-05）：写完 104–106 章后 claude 的 Stop 钩子报错
// （屏幕上一串 "Hookify error: Expecting ',' delimiter"），状态再没被复位：
//     agentStatus = { state: 'working', forSecs: 37577, lastSignal: 'hook' }   ← 卡了 10.4 小时
//     sessionIdle = { idle: true, outBytes 不涨 }                              ← 明说空闲
//     classify    = continue                                                   ← 屏幕判据说该续写
// 而忙判据 `busy = agentState === 'working'` 只认第一个 → 认定"它还在写"，一条指令都不发。
// 表现是【写完一批就再也不动了，日志一片空白】，人还以为是写完了。
import assert from 'node:assert';
import { Autopilot } from '../src/autopilot.mjs';

// 写完一批、停在输入态的真实屏幕（原样抄自 pane 7）
const IDLE = [
  '✻ Cooked for 21m 56s · done 23:42',
  'new task? /clear to save 157.1k tokens',
  '❯',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n');

function run({ forSecs, idle }) {
  const sent = [];
  const mcp = {
    async sessionList() { return [{ id: 7, is_dead: false }]; },
    async screenText() { return IDLE; },
    async agentStatus() { return { state: 'working', forSecs, lastSignal: 'hook' }; },
    async sessionIdle() { return { idle, outBytes: 836881, detectedAgent: 'claude' }; },
    async status() { return {}; },
    async submitText(_id, t) { sent.push(t); },
    async enter() {}, async input() {},
  };
  // assumeStarted = 引擎重启后重挂会话的走法（attach.mjs 就是这么挂的），线上正是这个场景
  const ap = new Autopilot(mcp, 7, {
    pollMs: 20, assumeStarted: true, idleConfirms: 2, maxAutoContinue: 5,
    continueText: '继续下一批。', onLog: () => {},
  });
  ap.start();
  return new Promise(r => setTimeout(() => { ap.stop('测完'); r(sent); }, 2500));
}

console.log('— hook 卡死 10.4 小时 —');
const a = await run({ forSecs: 37577, idle: true });
assert.ok(a.length && a[0].startsWith('继续'), `应识破陈旧 working 并续写，实际发了 ${JSON.stringify(a)}`);
console.log('✓ 识破 working 是陈旧状态 → 照常发续写');

console.log('— session.idle 说【不空闲】时不能乱来 —');
const b = await run({ forSecs: 37577, idle: false });
assert.strictEqual(b.length, 0, 'idle=false 时它可能真在干活，绝不能催');
console.log('✓ idle=false → 一条都不发（宁可等，也不打断在写的窗口）');

console.log('— 刚开始 working、屏幕静止一小会儿，也不能急着判陈旧 —');
const c = await run({ forSecs: 12, idle: true });
assert.ok(c.length && c[0].startsWith('继续'), '连续几拍静止后仍应回退屏幕判据');
console.log('✓ 短时 working + 连续静止 → 走去抖计数，最终仍能续写');

console.log('\n全部通过 ✅  hook 挂了不会再把窗口悄悄卡死');

// —— 卡住告警：窗口在、进程在、autopilot 也在，就是什么都不发生 ——
console.log('— 卡住告警 —');
function runStall(stallAlarmMs, confirmOnly) {
  const warns = [];
  const mcp = {
    async sessionList() { return [{ id: 7, is_dead: false }]; },
    async screenText() { return IDLE; },
    async agentStatus() { return { state: 'idle', forSecs: 30, lastSignal: 'hook' }; },
    async sessionIdle() { return { idle: true, outBytes: 100, detectedAgent: 'claude' }; },
    async status() { return {}; },
    async submitText() {}, async enter() {}, async input() {},
  };
  const ap = new Autopilot(mcp, 7, {
    pollMs: 20, assumeStarted: true, idleConfirms: 2, maxAutoContinue: 0, confirmOnly,
    stallAlarmMs, continueText: '继续。', onLog: (e) => { if (e.level === 'warn') warns.push(e.msg); },
  });
  ap._lastActiveAt = Date.now() - 60 * 60 * 1000;   // 假装一小时没动静
  ap.start();
  return new Promise(r => setTimeout(() => { ap.stop('测完'); r(warns); }, 300));
}
const w1 = await runStall(20 * 60 * 1000, false);
assert.ok(w1.some(m => m.includes('没有任何动静')), '静止一小时应报警，实际 ' + JSON.stringify(w1));
console.log('✓ 静止超阈值 → 日志里报一次警');
const w2 = await runStall(20 * 60 * 1000, true);
assert.ok(!w2.some(m => m.includes('没有任何动静')), 'confirmOnly 干完就该静止，不能报警');
console.log('✓ confirmOnly（复检/立项/改名）静止是正常的，不报警');
const w3 = await runStall(0, false);
assert.ok(!w3.some(m => m.includes('没有任何动静')), 'stallAlarmMs=0 应关闭告警');
console.log('✓ stallAlarmMs=0 可关掉');
