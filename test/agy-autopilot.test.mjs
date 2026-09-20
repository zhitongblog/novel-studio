// agy（Google Antigravity CLI）在 pane 里被 autopilot 驱动的识别自测。
//
// 实测 agy 1.1.27 启动后第一个拦路框（屏幕原样）：
//     Do you trust the contents of this project?
//     Antigravity CLI requires permission to read, edit, and execute files here.
//     > Yes, I trust this folder
//       No, exit
//       ↑/↓ Navigate · enter Confirm
//
// 和 claude 的信任框同形，但【光标是半角 >】，不是 ❯/›。autopilot 原来的 CURSOR_RE 只认 ❯ › ➤，
// 于是这个框既数不出 cursorRadio、也进不了 cursorMenu 分支 → 落到 yn 分支往 TUI 里打一个 "y" 再回车。
// 这次 agy 的高亮恰好停在 "Yes" 上，回车正好是对的——纯属运气。claude 那个框默认停在 "No, exit"，
// 同样的路径就是 autopilot 亲手把刚起来的 agent 关掉（已经栽过一次）。
//
// 所以：半角 > 也要算光标，但【只在同屏出现方向键/回车确认提示时】才算——
// 否则 agent 正文里一行 markdown 引用 "> 他说……" 就会被当成待选项。
import assert from 'node:assert';
import test from 'node:test';
import { Autopilot, optionChoice, cursorRe } from '../src/autopilot.mjs';
import fs from 'node:fs';

const ap = new Autopilot({}, 1, { confirmOnly: true });
const tailOf = (s) => s.split(/\r?\n/).filter(l => l.trim()).slice(-40).join('\n');
const kindOf = (s) => ap.classify(tailOf(s));
const linesOf = (s) => tailOf(s).split('\n');

const TRUST_AGY = [
  'Accessing workspace:',
  'C:\\Users\\Alex\\AppData\\Local\\Novel Studio\\books\\重生之我在岛国当天皇',
  'Do you trust the contents of this project?',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  '> Yes, I trust this folder',
  '  No, exit',
  '  ↑/↓ Navigate · enter Confirm',
].join('\n');

// 同一个框，但默认高亮停在否定项（claude 就是这样，agy 改版也完全可能这样）
const TRUST_AGY_NEG = [
  'Do you trust the contents of this project?',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  '> No, exit',
  '  Yes, I trust this folder',
  '  ↑/↓ Navigate · enter Confirm',
].join('\n');

test('agy 信任框要认成 menu，不能掉进 yn 分支往 TUI 里打 y', () => {
  const r = kindOf(TRUST_AGY);
  assert.equal(r.kind, 'menu', `应为 menu，实际 ${r.kind}（${r.reason}）`);
});

test('高亮已在 Yes 上：什么都不用改，回车即可', () => {
  const c = optionChoice(linesOf(TRUST_AGY));
  assert.deepEqual(c, {}, '高亮本来就是肯定项，应返回空对象=照旧回车');
});

test('高亮停在 No, exit：必须方向键走到 Yes，绝不闭眼回车', () => {
  const c = optionChoice(linesOf(TRUST_AGY_NEG));
  assert.ok(c.move, `应给出方向键走法，实际 ${JSON.stringify(c)}`);
  assert.equal(c.move.dir, 'down');
  assert.equal(c.move.steps, 1);
  assert.ok(!c.danger, '肯定项就在下一行，不该判成看不明白');
});

test('没有方向键提示时，半角 > 不算光标（正文里的 markdown 引用不许当选项）', () => {
  const prose = [
    '我把那段改成了：',
    '> 他说这话时没有抬头。',
    '> 院子里的雪还在下。',
    '已写入 chapters/卷01/012_雪夜.txt。',
  ].join('\n');
  const CUR = cursorRe(prose.split('\n'));
  assert.ok(!CUR.test('> 他说这话时没有抬头。'), '无导航提示时半角 > 不得被当成光标');
  const r = kindOf(prose);
  assert.notEqual(r.kind, 'menu', `正文引用不该被认成菜单，实际 ${r.kind}（${r.reason}）`);
});

test('❯ 那套老光标照旧有效（别为了 agy 把 claude 搞坏）', () => {
  const claudeTrust = [
    'Do you trust the files in this folder?',
    '❯ No, exit',
    '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const c = optionChoice(linesOf(claudeTrust));
  assert.ok(c.move && c.move.dir === 'down' && c.move.steps === 1, `claude 信任框回归：${JSON.stringify(c)}`);
});

// 实测 agy 的两个常驻页脚（1.2.2）：干活 "esc to cancel"；空闲 "? for shortcuts"；
// 两态右下角都有 "Gemini 3.8 Flash · high"。这些是 agentIdleFooter 护栏的依据——
// 认不出就会把 agy 自己输出的编号清单当成审批菜单去回车/打 y。
const AGY_IDLE = [
  '● Edit(~/books/agy联调测试书/novel_bible.md)',
  '● Bash([Console]::OutputEncoding = [System.Text.Encoding]::UTF8; git status) (ctrl+o to expand)',
  '【手法就绪：等作者给情节】',
  '1. 先定主角的处境',
  '2. 再定第一章的钩子',
  '>',
  '? for shortcuts                                            Gemini 3.8 Flash · high',
].join(String.fromCharCode(10));

const AGY_BUSY = [
  '▸ Thought for 1s, 922 tokens',
  '● Bash(pwd',
  '⣽  Reading file...',
  'esc to cancel                                              Gemini 3.8 Flash · high',
].join(String.fromCharCode(10));

test('agy 空闲屏里的编号清单是它的输出，不得当成菜单', () => {
  const r = kindOf(AGY_IDLE);
  assert.notEqual(r.kind, 'menu', `不该是 menu，实际 ${r.kind}（${r.reason}）`);
  assert.notEqual(r.kind, 'yn', `不该往输入框打 y，实际 ${r.kind}（${r.reason}）`);
});

test('agy 干活中的屏幕不得被判成"写完了"', () => {
  const ap2 = new Autopilot({}, 1, { confirmOnly: true });
  assert.equal(ap2.looksIdleWaiting(AGY_BUSY), false, '"esc to cancel" 还挂着就是在干活');
});

test('信任框的页脚里已经有 Gemini 模型行，照样要认成 menu', () => {
  const withFooter = TRUST_AGY + String.fromCharCode(10) + '? for shortcuts                     Gemini 3.8 Flash · high';
  const r = kindOf(withFooter);
  assert.equal(r.kind, 'menu', `页脚不该把信任框挡掉，实际 ${r.kind}（${r.reason}）`);
});

// —— 环境坏了就别催了（2026-09-15 现场）——
// agy 窗口连不上 googleapis：每一轮都回同一句 Eligibility check failed…userinfo: EOF。
// 屏幕看着像"空闲"，autopilot 于是一遍遍发"继续"——发了八次，几个小时一个字没写，
// 日志里全是「检测到空闲 → 自动发送继续（第 N 次）」。这和额度用尽是同一类：催它没有任何意义。
const ENV_FAIL_SCREEN = [
  '> 继续下一批。动笔前先重建上下文：读 continuity_ledger.md…',
  '',
  '⚠ Eligibility Check',
  '  ⎿  Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF',
  '',
  '>',
  '? for shortcuts                                            Gemini 3.8 Flash · high',
].join(String.fromCharCode(10));

test('连着两拍报环境级失败 → 停下，而不是继续催', async () => {
  const ap2 = new Autopilot({}, 1, { confirmOnly: true });
  assert.ok(Autopilot.ENV_FAIL.test(ENV_FAIL_SCREEN), '这块屏幕必须能被认出是环境级失败');
  let stopped = null;
  ap2.stop = (r) => { stopped = r; };
  // 第一拍不停（可能是上一轮的残影），第二拍才停
  ap2._envFail = 1;
  const screen = ENV_FAIL_SCREEN;
  if (Autopilot.ENV_FAIL.test(screen)) {
    ap2._envFail++;
    if (ap2._envFail >= 2) ap2.stop('agent 报环境级失败、催也没用：Eligibility check failed');
  }
  assert.ok(stopped, '第二拍就该停');
  assert.match(String(stopped), /环境级失败/);
});

test('环境级失败要算【终止性】停止——补挂一个新的 autopilot 也是白搭', () => {
  const reason = 'agent 报环境级失败、催也没用：Eligibility check failed: Get "…/userinfo": EOF';
  assert.ok(Autopilot.TERMINAL.test(reason) || Autopilot.ENV_FAIL.test(reason),
    '不算终止性的话，孤儿看门狗会 60 秒补挂一个，然后立刻撞上同样的错，来回刷');
});

test('正常写作的屏幕不会被误判成环境失败', () => {
  const ok = ['● Edit(chapters/卷02/031_承明请缨.txt)', '写完 3 章，已更新索引与台账。', '>', '? for shortcuts'].join(String.fromCharCode(10));
  assert.ok(!Autopilot.ENV_FAIL.test(ok));
});

test('断连/超时属于临时故障：要立刻重催，而不是判死也不是干等', () => {
  // 2026-09-20 实证：claude 打出"现在动笔"后撞上 API Error: Connection lost mid-response，
  // 一个字没写就停在提示符前，空等了三个小时。
  const src = fs.readFileSync(new URL('../src/autopilot.mjs', import.meta.url), 'utf8');
  const re = Autopilot.TRANSIENT;
  assert.ok(re, '要有 TRANSIENT 模式');
  assert.ok(re.test('API Error: Connection lost mid-response'), '断连要认出来');
  assert.ok(re.test('Request timed out'), '超时要认出来');
  assert.ok(!re.test('Eligibility check failed'), '环境级失败归 ENV_FAIL，别混进来');
  assert.ok(Autopilot.ENV_FAIL.test('Eligibility check failed'), 'ENV_FAIL 照旧管环境级失败');
  // 不能无限重催
  assert.match(src, /_transient > 6/, '催不动就得停，否则白烧 token');
  assert.ok(src.includes('次重催'), '日志要说清这是第几次重催');
});
