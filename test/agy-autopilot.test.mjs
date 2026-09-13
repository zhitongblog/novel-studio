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
