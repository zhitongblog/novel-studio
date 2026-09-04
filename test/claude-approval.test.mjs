// Claude Code 审批弹窗识别自测。
//
// 病根（作者报"复检点了没反应、窗口自己关了"）：审批弹窗画在 ╭─╮│…│╰─╯ 方框里，
// 每行真正的开头是 │ 而不是选项本身，所有菜单正则 ^\s*[❯›]… 全部落空；
// 同时 claude 把改文件的问句从 "Do you want to proceed?" 换成了
// "Do you want to make this edit to xxx?"，旧的关键词也不再命中。
// 两下一叠加：弹窗既不算菜单也不算提问 → 被当成"空闲"，在 confirmOnly（复检/立项/AI改名）下
// 更会被 doneIdle 计数当成【任务完成】把窗口收掉，界面显示"✅ 本次任务完成"，实际一个字没改。
//
// 覆盖：①四种带框弹窗都要认成 menu；②默认高亮是否定项时改按编号；
//      ③正常空闲屏幕不能被误判成弹窗（否则永远不续写）。
import assert from 'node:assert';
import { Autopilot, stripBox, affirmativeOption } from '../src/autopilot.mjs';

const ap = new Autopilot({}, 1, { confirmOnly: true });
// autopilot 送进 classify 的就是"去掉空行后的屏幕尾部"，这里照抄同一道预处理
const tailOf = (s) => s.split(/\r?\n/).filter(l => l.trim()).slice(-40).join('\n');
const kindOf = (s) => ap.classify(tailOf(s));

const box = (...rows) => [
  '╭────────────────────────────────────────────────────────────╮',
  ...rows.map(r => '│ ' + r.padEnd(58) + ' │'),
  '╰────────────────────────────────────────────────────────────╯',
].join('\n');

const EDIT = box(
  'Edit file',
  '  chapters/第012章.md',
  '',
  'Do you want to make this edit to 第012章.md?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No, and tell Claude what to do differently (esc)',
);
const CREATE = box(
  'Create file',
  '  reviews/复检-全书.md',
  '',
  'Do you want to create 复检-全书.md?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No, and tell Claude what to do differently (esc)',
);
const BASH = box(
  'Bash command',
  '  git add -A && git commit -m "复检"',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for git commit commands",
  '  3. No, and tell Claude what to do differently (esc)',
);
const TRUST = box(
  'Do you trust the files in this folder?',
  '',
  'D:\\books\\某某书',
  '',
  '❯ 1. Yes, proceed',
  '  2. No, exit',
);
// bypass 警告框的默认高亮是【否定项】——闭眼回车 = 直接退出 agent
const BYPASS = box(
  'WARNING: Claude Code running in Bypass Permissions mode',
  '',
  'Claude Code will not ask before running commands.',
  '',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
);
// 写完一批、回到输入态：这是【要续写】的屏幕，绝不能被当成弹窗
const IDLE = ['claude · D:\\books\\某某书', '已写完本批 3 章并更新台账。', '❯ '].join('\n');
// agent 的输出总结里也会出现 "1. … 2. …"，那不是待选菜单
const SUMMARY = [
  'claude sonnet-5 default · D:\\books\\某某书',
  '本批修正了 2 处：',
  '  1. 第 12 章伤势与台账不符',
  '  2. 第 15 章时间线早了一天',
  '❯ ',
].join('\n');

console.log('— 带框审批弹窗 —');
for (const [name, scr] of [['改文件', EDIT], ['新建文件', CREATE], ['跑命令', BASH], ['信任目录', TRUST]]) {
  const r = kindOf(scr);
  assert.strictEqual(r.kind, 'menu', `${name}弹窗应认成 menu，实际 ${r.kind}`);
  assert.ok(!r.pick, `${name}弹窗高亮的就是肯定项，应直接回车`);
  console.log(`✓ ${name}：${r.reason} → 回车采纳高亮项`);
}

console.log('— 默认高亮是否定项 —');
const by = kindOf(BYPASS);
assert.strictEqual(by.kind, 'menu');
assert.strictEqual(by.pick, '2', 'bypass 警告默认停在 "1. No, exit"，必须改按 2');
console.log(`✓ bypass 警告：不闭眼回车（那是 exit），改选第 ${by.pick} 项`);

console.log('— 不能误伤正常空闲屏 —');
assert.strictEqual(kindOf(IDLE).kind, 'continue', '空闲屏应继续驱动写作');
console.log('✓ 写完一批的空闲屏仍判 continue');
assert.strictEqual(kindOf(SUMMARY).kind, 'continue', 'agent 输出里的编号总结不是待选菜单');
console.log('✓ 输出总结里的 "1. 2." 不会被当菜单去回车');

console.log('— 工具函数 —');
assert.strictEqual(stripBox('│ ❯ 1. Yes                    │'), '❯ 1. Yes');
assert.strictEqual(stripBox('│ │  12 - 旧的一行   │ │'), '12 - 旧的一行');
assert.strictEqual(affirmativeOption(['❯ 1. Yes', '  2. No']), null, '高亮已是肯定项 → 不用挑');
assert.strictEqual(affirmativeOption(['  1. No, exit', '❯ 2. Yes, I accept']), null);
assert.strictEqual(affirmativeOption(['❯ 1. 取消', '  2. 确认执行']), '2');
console.log('✓ stripBox / affirmativeOption 正确');

console.log('\n全部通过 ✅  claude 换了同意问法/画了方框，autopilot 照样接得住');
