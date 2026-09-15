// 「按已有审稿报告改大纲」：把落盘的报告重新摆回"待逐条挑"的状态。
//
// 由来（2026-09-15，《穿成王莽后，我脑中有颗星球》）：主编审稿在卷边界跑完，
// 30KB 的 reviews/大纲审稿-卷02.md 好好躺在硬盘上，里面 11 条意见条条要命
//（时间线不成立：公元前26年刘秀还没出生；全书规模账 900×3300≈297万 对不上 600万目标…）。
// 但那个"逐条挑"的暂停态存在【内存】里，当天引擎重启了六次，状态没了 →
// 报告在、入口没了，只能人肉把意见抄进指令。
// 报告是文件、早就落盘了，没道理只有卷边界那一次机会。
import assert from 'node:assert';
import test from 'node:test';
import { parseReviewItems, critiqueOf } from '../src/editor.mjs';

// 真报告的形状（取自王莽卷02 那份的开头几行）
const REPORT = [
  '# 大纲审稿（卷02）',
  '',
  '> 审稿人：主编模型 codex（作者：agy）',
  '',
  '- [硬伤] 时间线根本不成立：公元前26年刘秀尚未出生 → 039–041取消刘秀一家和刘玄叛乱，移至卷04前后。',
  '- [硬伤] 淳于长在049章被赐死，与设定圣经规定的078章收网问斩冲突 → 048–049改为抓获外围死士，留到078章伏诛。',
  '- [隐患] 反派集体自证其罪会严重降智 → 让王商使用可切割代理人，主角必须靠利益分化取胜。',
  '- [建议] 白水信标、皇嗣证人与漠北石碑同时争抢暗线注意力 → 卷02只推进星核侵蚀与一处地磁异常。',
  '【总评】需修订后开写 —— 最关键的是把时间线与权力台阶压回公元前26年的京畿整军局。',
].join('\n');

test('从落盘的报告里拆出可挑的条目', () => {
  const items = parseReviewItems(REPORT);
  assert.equal(items.length, 4, `应拆出 4 条，实际 ${items.length}`);
  assert.deepEqual(items.map(i => i.severity), ['硬伤', '硬伤', '隐患', '建议']);
  assert.match(items[0].text, /刘秀尚未出生/);
});

test('总评不算一条意见（它是结论，不是可执行项）', () => {
  const items = parseReviewItems(REPORT);
  assert.ok(!items.some(i => /总评/.test(i.text)), '总评混进待挑列表会让作者以为要"照它改"');
});

test('报告文件名要能还原出审稿范围（载入后动作条要显示是哪一卷）', () => {
  const name = '大纲审稿-卷02.md';
  const scope = (name.match(/^大纲审稿-(.+)\.md$/) || [])[1];
  assert.equal(scope, '卷02');
});

test('不是大纲审稿报告的文件名一律不收（别让路径乱穿）', () => {
  for (const bad of ['../../novel_bible.md', '复检-全书.md', '大纲审稿-卷02.md.txt', '']) {
    assert.ok(!/^大纲审稿-.*\.md$/.test(bad.split(/[\\/]/).pop() || ''), `${bad} 不该通过校验`);
  }
  assert.ok(/^大纲审稿-.*\.md$/.test('大纲审稿-卷02.md'));
});

// 报告文件里【不止有审稿意见】：CLI 会把收到的 prompt 原样回显在后面，
// 那段 prompt 里既有"输出格式模板"，也带着整段意见本身。
// 2026-09-15 实测：王莽卷02 那份 11 条真意见，直接拆整个文件会拆成 25 条（11×2 + 3 条模板）。
// 把模板行当成"作者挑定的意见"喂回去改大纲，等于让它照着
//「一句话写清：问题是什么 → 具体怎么改」去改书——纯噪音。
const REPORT_WITH_ECHO = [
  REPORT,
  '',
  'Reading prompt from stdin...',
  'OpenAI Codex v0.149.1',
  '你是一名极挑剔的资深网文主编，正在【开写前】审核一本长篇网文的大纲。',
  '输出格式：',
  '- [硬伤] 一句话写清：问题是什么 → 具体怎么改（给到卷/章号或具体手法）',
  '- [隐患] …（同上，一行写完）',
  '- [建议] …（同上，一行写完）',
  '',
  REPORT,          // CLI 回显里常把上一次的意见整段带出来
].join(String.fromCharCode(10));

test('回显的 prompt 要截掉：模板行与重复条都不能当成意见', () => {
  const all = parseReviewItems(REPORT_WITH_ECHO);
  const clean = parseReviewItems(critiqueOf(REPORT_WITH_ECHO));
  assert.ok(all.length > clean.length, `截断应当减少条目：整份 ${all.length}、截断后 ${clean.length}`);
  assert.equal(clean.length, 4, `截断后应只剩正文那 4 条，实际 ${clean.length}`);
  assert.ok(!clean.some(i => /一句话写清|同上，一行写完/.test(i.text)), '模板行绝不能混进待挑列表');
});

test('没有回显的干净报告，截断不该误伤', () => {
  assert.equal(parseReviewItems(critiqueOf(REPORT)).length, 4);
});
