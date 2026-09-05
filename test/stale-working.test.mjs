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

console.log('— 刚开始 working、屏幕静止一小会儿，绝不能判陈旧 —');
// 这条一开始写反了：当时断言"静止几拍就该回退屏幕判据去续写"，把 bug 当成了规格。
// 真实后果（换骨那轮）：窗口刚起来 forSecs=0，"idle=true + 屏幕没动 + 字节没涨"天然成立 →
// 立刻判陈旧、agentState 置空 → confirmOnly 的收窗保护失效 → claude 还在读 36 章正文，
// 120 秒就被「✅ 本次任务完成」收掉。刚报过 working 的 hook 不可能是陈旧的。
const c = await run({ forSecs: 12, idle: true });
assert.strictEqual(c.length, 0, '刚起来 12 秒就催它/收它都是错的，实际发了 ' + JSON.stringify(c));
console.log('✓ 短时 working（12s）→ 一条都不发，等它真干活');

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

// —— 窗口刚起来那几拍，绝不能判成「hook 陈旧」——
// 现场（换骨那轮）：pane 刚建好，session.idle=true、屏幕还没动、字节还没涨——这三条【天然成立】。
// 没有最小年龄限制就会在 forSecs=0 时判定陈旧、把 agentState 置空，于是 confirmOnly 的收窗计数
// 失去保护，claude 还在读 36 章正文、屏幕没动，120 秒就被当成「✅ 本次任务完成」收掉。
console.log('— 刚起来的窗口不能判陈旧 —');
function runFresh(forSecs, confirmOnly) {
  const events = [];
  const mcp = {
    async sessionList() { return [{ id: 7, is_dead: false }]; },
    async screenText() { return IDLE; },
    async agentStatus() { return { state: 'working', forSecs, lastSignal: 'hook' }; },
    async sessionIdle() { return { idle: true, outBytes: 100, detectedAgent: 'claude' }; },
    async status() { return {}; },
    async submitText() {}, async enter() {}, async input() {},
  };
  const ap = new Autopilot(mcp, 7, {
    pollMs: 20, assumeStarted: true, idleConfirms: 2, confirmOnly,
    confirmDoneIdle: 3, confirmDoneIdleSignal: 3, maxAutoContinue: 5,
    continueText: '继续。', onLog: (e) => events.push(`${e.level || 'info'}|${e.msg}`),
    onDone: () => events.push('act|收窗了'),
  });
  ap.start();
  return new Promise(r => setTimeout(() => { ap.stop('测完'); r(events); }, 1500));
}
const fresh = await runFresh(3, true);           // 刚起来 3 秒
assert.ok(!fresh.some(e => e.includes('陈旧')), 'forSecs=3 绝不能判陈旧，实际 ' + JSON.stringify(fresh.slice(0, 3)));
assert.ok(!fresh.some(e => e.includes('收窗了')), '更不能因此把还在启动的窗口收掉');
console.log('✓ forSecs=3（刚起来）→ 不判陈旧、不收窗');
const old = await runFresh(3600, true);          // 卡了一小时
assert.ok(old.some(e => e.includes('陈旧')), 'forSecs=3600 才该判陈旧');
console.log('✓ forSecs=3600（真卡住）→ 照常识破');
