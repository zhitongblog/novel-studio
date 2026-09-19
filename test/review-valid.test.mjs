// 「审稿功能无效」——不是没跑，是跑出来的垃圾被当成合格审稿【存了下来】。
//
// 2026-09-19 现场复现：审《穿成王莽后》卷02，日志显示"审稿完成"，
// 而 reviews/大纲审稿-卷02.md 是 29KB 的：
//   codex 启动横幅 → 【整个 prompt 原样回显】 → 最后一行 "ERROR: You've hit your usage limit"
// 一条真意见都没有。
//
// 为什么没被拦下：旧 looksBad 只看【前 600 字】，而错误在 29KB 回显之后的末尾。
// 这正是 939ac90b 那个病的根——那次修的是"回显的 prompt 被拆成 25 条意见"（治下游），
// 回显【整份被当成审稿收下】这一层一直没堵。
//
// 扫全部 552 份报告：7 份被污染，其中包括《大乾女帝》的完本审稿（27KB）——
// 而完本闸就是拿那份"审稿"在做决定的。
//
// 修完之后四个审稿人还是全废，于是又挖出两条：
//   · agy 根本不该进候选（canRunHeadless 早判定它不行），白等一轮
//   · 超时 180 秒太短：claude 审 1 万字大纲要 120 秒，真实 prompt 更大必然超时，
//     而它是本机唯一还能干这活的模型（codex 额度尽、gemini 长 prompt 撑坏）
// 两条都修完，实测 237 秒拿到一份真审稿。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { invalidReview, isPromptEcho, stripNoise, reviewerCandidates } from '../src/editor.mjs';


// 用一份【够长的】prompt：真实审稿 prompt 是上万字，isPromptEcho 对太短的输入会直接早退
//（短输出本来就会被"太短"那条拦住，不需要回显检测）。第一版这里只写了 100 字，
// 结果测的是早退分支，不是回显检测本身。
const REAL_PROMPT = '你是一名极挑剔的资深网文主编，正在开写前审核一本长篇网文的大纲。\n'
  + '# 设定圣经\n' + '主角王莽，现代人穿越，双魂共存，新朝改革与权谋斗争。'.repeat(20)
  + '\n# 待审大纲\n' + '第031章 临终荐举；第032章 星核超频。'.repeat(20)
  + '\n# 输出格式\n把每一条意见单独成行，行首用严重度标签。\n'
  + '全部条目之后，另起一行给：【总评】可直接开写 / 需修订后开写 —— 一句话说明最关键的那个改动。';
const GOOD = [
  '[硬伤] 官制错了：射声营主官是射声校尉，不是骑都尉 → 031 章改成拜射声校尉，058 章再转骑都尉。',
  '[隐患] 星核超频的代价只写了头痛，分量不够 → 050 章让它夺走一段关键记忆。',
  '[建议] 卷末钩子可以更狠。',
  '【总评】需修订后开写 —— 最关键是把官制理顺。',
].join('\n');

test('额度用尽的输出必须判无效——哪怕错误在 29KB 之后的末尾', () => {
  const junk = 'Reading prompt from stdin...\nOpenAI Codex v0.149.1\n' + 'x'.repeat(20000) +
    "\nERROR: You've hit your usage limit. Upgrade to Pro";
  assert.equal(invalidReview(junk, ''), true,
    '旧版只看前 600 字，错误在末尾就漏了——于是 29KB 垃圾被当成合格审稿存下来');
});

test('CLI 自曝家门的横幅 = 拿到的不是模型的回答', () => {
  for (const banner of ['Reading prompt from stdin...', 'OpenAI Codex v0.149.1', 'workdir: C:\\tmp', 'sandbox: danger-full-access']) {
    assert.equal(invalidReview(banner + '\n' + 'a'.repeat(500), ''), true, `「${banner}」该判无效`);
  }
});

test('把 prompt 原样退回来，不算审稿', () => {
  const echo = '一堆前言\n' + REAL_PROMPT + '\nERROR: quota';
  assert.equal(isPromptEcho(echo, REAL_PROMPT), true);
  assert.equal(invalidReview(echo, REAL_PROMPT), true);
});

test('回显之后【真的有审稿】就该收下——别把正常情况也误杀', () => {
  // 有些 CLI 会先回显再作答。回显后有实质内容的，是有效审稿。
  const echoThenAnswer = REAL_PROMPT + '\n\n' + GOOD + '\n' + '补充说明若干。'.repeat(20);
  assert.equal(isPromptEcho(echoThenAnswer, REAL_PROMPT), false, '回显后有真内容，不能判成回显');
  assert.equal(invalidReview(echoThenAnswer, REAL_PROMPT), false);
});

test('正常审稿不许被误判', () => {
  assert.equal(invalidReview(GOOD + '\n' + '细节展开。'.repeat(30), REAL_PROMPT), false);
});

test('未登录 / 额度 / 用法错，统统拦下', () => {
  const cases = [
    'No auth type is selected. Please configure an auth type.',
    'ERROR: quota exceeded, try again later',
    'usage: claude [options]',
    'Error: invalid api key',
  ];
  for (const c of cases) assert.equal(invalidReview(c + '\n' + 'y'.repeat(400), ''), true, `「${c.slice(0, 24)}」该拦下`);
});

test('太短的不算审稿', () => {
  assert.equal(invalidReview('好的，没问题。', ''), true, '正常审稿都几百字以上');
});

test('node 噪音行要先清掉再判', () => {
  const noisy = '(node:12345) ExperimentalWarning: blah\n' + GOOD + '\n' + '展开。'.repeat(40);
  assert.ok(!stripNoise(noisy).startsWith('(node:'));
  assert.equal(invalidReview(noisy, REAL_PROMPT), false, '噪音不该把一份好审稿拖下水');
});

// —— 为什么四个审稿人会全废 ——

test('跑不了无头的模型不进审稿候选', () => {
  const src = fs.readFileSync(new URL('../src/editor.mjs', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf('export function reviewerCandidates'));
  assert.ok(/canRunHeadless\(id\)/.test(seg.slice(0, 900)),
    'agy 的凭据不落盘、每次都要人贴授权码，进候选的唯一结果是白等一轮再报个让人困惑的"输出无效"');
  // agy 当作者时也不能被兜底塞回来
  assert.ok(!reviewerCandidates('agy', { editorReview: {} }).includes('agy'));
});

test('审稿超时不能是 180 秒', () => {
  const cfgSrc = fs.readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8');
  const m = cfgSrc.match(/timeoutMs:\s*(\d+)/);
  assert.ok(m && Number(m[1]) >= 400000,
    'claude 审 1 万字大纲实测 120 秒，真实 prompt 更大必然超时；而它是本机唯一还能干这活的模型。' +
    '四个候选全废，作者看到的就是"审稿功能无效"');
});

test('存过旧配置的人也要被迁移——改 DEFAULTS 对他们没用', () => {
  const src = fs.readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf('export function loadConfig'));
  assert.ok(/timeoutMs === 180000/.test(seg.slice(0, 1200)),
    '存下来的旧值会盖在默认值上——不迁移的话，这个 bug 对老用户等于没修');
  assert.ok(/DEFAULTS\.editorReview\.timeoutMs/.test(seg.slice(0, 1200)));
});

test('完本审稿也要走同一套校验——它原来一道都没有', () => {
  const src = fs.readFileSync(new URL('../src/editor.mjs', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf('export async function reviewEnding'));
  assert.ok(/invalidReview\(raw, prompt\)/.test(seg.slice(0, 2500)),
    '大乾女帝的完本审稿就是 27KB 的 codex 横幅+回显+额度错误，而完本闸拿它在做决定');
  assert.ok(/unavailable: true/.test(seg.slice(0, 2500)),
    '拿不到有效审稿要明说拿不到，不能让调用方以为"审过了"');
});

console.log('\n全部通过 ✅  垃圾不再被当成审稿收下，能干活的模型也终于等得起了');
