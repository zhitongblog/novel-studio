// 开写指令必须把【起点章号】写死。
//
// 血泪（《大宋第一女帝：我成了李清照》2026-09-06）：新书那条指令原来只写
// "请阅读 AGENTS.md 与 novel_bible.md，续写下一批 3 章并自检"，【一个字都没说从第几章开始】。
// 第一次点没问题；但会话撞上模型用量上限死掉后再点一次「开始写作」，新窗口的 agent 上下文是空的，
// 读完 bible 就"续写下一批"——它眼里的下一批就是 001，于是把开篇从头重写了一遍：
//   001红烛未剪 / 002火印        （09:10 第一批）
//   001新妇不睡 / 002西壁第三格 / 003不存在的年号 / 004我救你   （09:17 第二批，从 001 重来）
// 两个 001 是同一场新婚夜的两个版本，chapter_index.md 里两个 001、两个 002 并排登记成"已写"。
//
// 这里不跑服务端，只锁住指令文本该有的几个要素——它们是防重号的唯一保障。
import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
// 截出 doWrite 里挑指令的那一段
const at = src.indexOf('const already = bookStats(book);');
// 注意从 at 之后再找结尾——`const slug = book.slug;` 在文件更靠前处也出现过，
// 直接 indexOf 会取到前面那个，slice 出来是空串（第一版就栽在这）。
const seg = at < 0 ? '' : src.slice(at, src.indexOf('const slug = book.slug;', at));
assert.ok(seg && seg.length > 200, '没找到开写指令那段代码，测试需要跟着改');

console.log('— 已有章节时 —');
for (const [what, needle] of [
  ['告诉它已经写到第几章', '已经写到第'],
  ['告诉它从第几章起写', '章起的下一批'],
  ['禁止重写已写章节', '严禁重写或改动任何已写章节'],
  ['禁止重复使用已有章号', '严禁重复使用已有章号'],
  ['动笔前先读索引与台账', 'chapter_index.md 与 continuity_ledger.md'],
  ['取章名前查重', '确保不与已有章名重复'],
]) {
  assert.ok(seg.includes(needle), `开写指令缺少「${what}」——少了它就可能从 001 重写`);
  console.log(`✓ ${what}`);
}

console.log('— 空书时 —');
assert.ok(seg.includes('从第 001 章开始写第一批'), '空书要明确从 001 起，别含糊说"下一批"');
console.log('✓ 空书明确从 001 起');

console.log('— 起点来自服务端实算，不靠 agent 自己数 —');
assert.ok(seg.includes('bookStats(book)') && seg.includes('maxChapter'), '起点必须由服务端算出最高章号后写进指令');
console.log('✓ 用 bookStats 的 maxChapter 算起点');

console.log('— 导入的书仍走 buildResumeInstruction —');
assert.ok(seg.includes('buildResumeInstruction'), '导入书那条一直是对的，不能改掉');
console.log('✓ 导入书分支保留');

console.log('\n全部通过 ✅  再点一次「开始写作」不会从 001 重写');
