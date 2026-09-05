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
import { Autopilot, stripBox, optionChoice } from '../src/autopilot.mjs';

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

// 2026-09-04 从卡死现场（pane 2）原样抄下来的屏幕。claude 把信任目录框整个重写了：
// 没有方框、没有编号、未选中那行一个记号都没有，而且【默认高亮就是 No, exit】。
// 旧代码在这里会命中 "Enter to confirm" 里的 confirm → 走 yn → 打 y 再回车 → 正好选中 No, exit，
// 等于 autopilot 亲手把刚起来的 agent 关掉。
const TRUST_NEW = [
  '== Novel Studio :: 《走进修仙：我把金丹练成了核反应》 / Claude Code ==',
  '[proxy] 本会话已启用 http://127.0.0.1:7897',
  '[agent] 启动 claude ，初始指令已注入…',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' C:\\Users\\Alex\\AppData\\Local\\Novel Studio\\books\\走进修仙：我把金丹练成了核反应',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your',
  " own code, a well-known open source project, or work from your team). If not,",
  ' take a moment to review what\'s in this folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const tn = kindOf(TRUST_NEW);
assert.strictEqual(tn.kind, 'menu', `新版信任框应认成 menu，实际 ${tn.kind}`);
assert.ok(!tn.pick, '这个框没有编号，按不了编号');
assert.deepStrictEqual(tn.move, { dir: 'down', steps: 1 }, '必须先下移一格到 "Yes, I trust this folder" 再回车');
console.log('✓ 新版信任目录框（无框无编号、默认停在 No, exit）：下移 1 格再回车');

console.log('— 不能误伤正常空闲屏 —');
assert.strictEqual(kindOf(IDLE).kind, 'continue', '空闲屏应继续驱动写作');
console.log('✓ 写完一批的空闲屏仍判 continue');
assert.strictEqual(kindOf(SUMMARY).kind, 'continue', 'agent 输出里的编号总结不是待选菜单');
console.log('✓ 输出总结里的 "1. 2." 不会被当菜单去回车');

console.log('— 工具函数 —');
assert.strictEqual(stripBox('│ ❯ 1. Yes                    │'), '❯ 1. Yes');
assert.strictEqual(stripBox('│ │  12 - 旧的一行   │ │'), '12 - 旧的一行');
assert.deepStrictEqual(optionChoice(['❯ 1. Yes', '  2. No']), {}, '高亮已是肯定项 → 照旧回车');
assert.deepStrictEqual(optionChoice(['  1. No, exit', '❯ 2. Yes, I accept']), {});
assert.deepStrictEqual(optionChoice(['❯ 1. 取消', '  2. 确认执行']), { pick: '2' });
assert.deepStrictEqual(optionChoice(['❯ No, exit', '  Yes, I trust this folder']), { move: { dir: 'down', steps: 1 } });
assert.deepStrictEqual(optionChoice(['  Yes, proceed', '❯ No, exit']), { move: { dir: 'up', steps: 1 } });
console.log('✓ stripBox / optionChoice 正确');

// —— 弹窗残影：agent 已退出、窗口回到 shell 提示符，滚动历史里还留着刚才那个框 ——
// 现场（pane 2）：claude 选了 No, exit 后退出，PowerShell 提示符被 80 列折成两行，
// 旧代码看不出"回到 shell 了"（❯ 还在，agentTui 恒真），会继续对着裸命令行按键 → 一串空 PS> 提示符。
import { endsAtShellPrompt } from '../src/autopilot.mjs';
console.log('— 弹窗残影 / 已回到 shell —');
const GHOST = [
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
  'PS C:\\Users\\Alex\\AppData\\Local\\Novel Studio\\books\\走进修仙：我把金丹练成了核反应',
  '>',
].join('\n');
assert.strictEqual(kindOf(GHOST).kind, 'none', '回到 shell 后一个键都不能按');
console.log('✓ agent 退出后残留的弹窗不再被当成待选菜单');
assert.ok(endsAtShellPrompt('PS C:\\Users\\Alex\\books\\某某书\n>'), '折行的 PS 提示符要认得出');
assert.ok(endsAtShellPrompt('PS D:\\code\\story> '), '不折行的也要认得出');
assert.ok(!endsAtShellPrompt(TRUST_NEW), '真弹窗不能被当成 shell 提示符');
assert.ok(!endsAtShellPrompt(IDLE), 'claude 的输入态不是 shell 提示符');
console.log('✓ endsAtShellPrompt 认得出折行的提示符，且不误伤真弹窗');

console.log('\n全部通过 ✅  claude 换了同意问法/画了方框/退出后留残影，autopilot 都接得住');

// —— claude 回显的历史指令行不是菜单选项 ——
// 现场：屏幕上有两条 "❯ 继续下一批。动笔前先重建上下文：…"（几百字一行），照样命中 ^\s*❯\s+\S，
// 凑够 hasMenu 后撞上任意 selectionHint 就被判「提示型菜单」，每 5 秒往输入框敲一次回车
// （日志刷了十几条"回车采纳推荐项 ｜ 提示型菜单"）。真菜单的选项都是一行几个字。
console.log('— 回显的长指令不能当选项 —');
const ECHO = [
  '● 三章已写完，自检通过。',
  '❯ 继续下一批。动笔前先重建上下文：读 continuity_ledger.md，再读最近 2 章正文与本卷 outlines/ 中对应章号段的分章大纲；据此确认当前最新章号、主角处境、未回收伏笔、欠债与伤势。',
  '❯ 对《走进修仙》做一次【复检】，范围：全书。本次复检的【重点要求】：只处理 2.1 结丹写了三遍这一条，按报告给的方案合并，其余一律不动。请按文件名顺序逐章通读该范围内的正文。',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents 请选择',
].join('\n');
assert.notStrictEqual(kindOf(ECHO).kind, 'menu', '几百字的回显指令行不是待选项，不能去回车');
console.log('✓ 长回显行被排除，不再被判成「提示型菜单」');
// 但真选项（短）照样要认出来
const REAL = ['请选择一项：', '❯ 是，继续', '  否，退出'].join('\n');
assert.strictEqual(kindOf(REAL).kind, 'menu', '短选项仍应认成菜单');
console.log('✓ 短选项照常认得出');
