// 「签约诊断」：书在番茄签约被拒时，查清编辑看到了什么、哪里不行、该改什么。
//
// 由来（2026-09-19）：《穿成王莽后》第二次签约被拒，拒信只有一句"作品质量暂未达到签约标准"。
// 作者问「看需要做哪些修改」「然后把你的处理机制变成一个完整的功能」。
// 手工查下来四样东西，全部固化进这个功能：
//   ① 番茄签约进度：申请 → 安全审核通过 → 签约评估拒绝，下次机会在 8 万字
//   ② 定时发布乱序：读者会从第 19 章直接跳到第 35 章（根因在发布器，一并修了）
//   ③ 客观指标：平均每段 50–70 字，网文范本约 16
//   ④ 编辑视角评估：必改 11 条，抽查全部属实（11 个时代错位词全在正文里、章号对得上）
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSignTimeline, scheduleDisorder, alignScheduleStart, objectiveFindings,
  listBookChapters, parseSignEval, buildSignEvalPrompt, chapterMetrics,
} from '../src/signdiag.mjs';

// 真实页面文字（王莽那本，2026-09-19 抓的）。
// ⚠️ 必须包含顶部的「签约说明」——第一版测试数据是从「签约流程」截起的，漏了那句
//「作品字数达到2万字…将获得申请签约资格」，于是测试全绿，真跑却把下次门槛读成 2 万字。
// 测试数据不真实，测试就会说谎。
const REAL_SIGN_PAGE = `签约说明
作品字数达到2万字或被编辑提签后，将获得申请签约资格；详见《签约问题全解》
签约作品可被用户在番茄小说等平台查看，在一定字数后获得全平台推荐，并享有广告分成、全勤奖等各种收益，详见《番茄小说网作家福利》
签约流程
第一次签约
展开
第二次签约
收起
申请提交成功
满足条件后即可提交签约申请，具体可参考《签约问题全解》。
2026-09-19 10:47
安全审核通过
符合规范的作品才能签约，具体可参考《番茄小说网内容安全须知》。
2026-09-19 12:26
签约评估拒绝
作品质量暂未达到签约标准，请再接再厉，我们会持续关注贵作。当您的作品字数达到八万字，可申请第三次签约，我们会对您的作品重新评审，感谢您对番茄小说⽹的支持。
2026-09-19 12:26
第三次签约
待开放
当作品字数达到八万字时，第三次签约入口将重新开放
© 2026`;

test('签约时间线：读出每一步、被拒、下次门槛', () => {
  const t = parseSignTimeline(REAL_SIGN_PAGE);
  assert.deepEqual(t.steps.slice(0, 3).map(s => s.step), ['申请提交成功', '安全审核通过', '签约评估拒绝']);
  assert.equal(t.steps[2].time, '2026-09-19 12:26');
  assert.equal(t.rejected, true);
  assert.equal(t.signed, false);
  assert.equal(t.nextApplyChars, 80000, '「八万字」要换算成 80000');
  assert.equal(t.attempts, 3,
    '同一个"第三次签约"在页面里出现好几次（小标题、正文、入口说明），直接计数会得 5——要去重');
});

// 王莽那本真实的定时表
const REAL_SCHEDULE = [[20, '09-30'], [21, '09-30'], [22, '09-30'], [23, '09-30'], [24, '09-30'], [25, '09-30'], [26, '09-30'], [27, '09-30'], [28, '09-30'],
  [29, '10-07'], [30, '10-07'], [31, '10-07'], [32, '10-07'], [33, '10-07'], [34, '10-07'], [35, '09-20'], [36, '09-20'],
  [37, '10-07'], [38, '10-07'], [39, '10-07'], [40, '10-07'], [41, '10-07'], [42, '10-07'], [43, '10-08'],
  [44, '10-01'], [45, '10-01'], [46, '10-01'], [47, '10-01'], [48, '10-01'], [49, '10-01'], [50, '09-21'], [51, '09-21']]
  .map(([n, d]) => ({ num: n, status: '待发布', time: `2026-${d} 22:00` }));

test('定时乱序：认出王莽那本插队的 10 章', () => {
  const d = scheduleDisorder(REAL_SCHEDULE);
  assert.deepEqual(d.outOfOrder.map(x => x.num), [35, 36, 44, 45, 46, 47, 48, 49, 50, 51]);
  assert.deepEqual(d.readerOrder.slice(0, 5), [35, 36, 50, 51, 20],
    '读者看完第 19 章，接下来会读到 35 → 36 → 50 → 51 → 20——要把这个顺序直接摆出来');
});

test('按章号顺序排的定时表不该报乱序', () => {
  const ok = [20, 21, 22, 23].map((n, i) => ({ num: n, status: '待发布', time: `2026-09-2${i} 22:00` }));
  assert.equal(scheduleDisorder(ok).outOfOrder.length, 0);
});

test('已发布的章不参与乱序判断', () => {
  const rows = [{ num: 19, status: '已发布', time: '' }, { num: 20, status: '待发布', time: '2026-09-20 22:00' }];
  assert.equal(scheduleDisorder(rows).outOfOrder.length, 0);
});

// —— 根因：发布器每轮都从"明天"排 ——

test('番茄上有待发布章节时，新章起排日不能早于最晚那章', () => {
  const now = new Date('2026-09-19T12:00:00');
  const a = alignScheduleStart(REAL_SCHEDULE, null, now);
  assert.equal(a.date, '2026-10-08', '最晚待发布是 10/8，新章不能排到它前面——否则就是王莽那本的 19→35 跳章');
  assert.equal(a.changed, true);
  assert.match(a.reason, /跳章/);
});

test('番茄上没有待发布章节时不干预——能当天发就当天发', () => {
  const a = alignScheduleStart([{ num: 19, status: '已发布', time: '' }], null, new Date('2026-09-19T12:00:00'));
  assert.equal(a.date, null);
  assert.equal(a.changed, false);
});

test('作者指定的日子比已排的还晚，就听作者的', () => {
  const a = alignScheduleStart(REAL_SCHEDULE, '2026-10-20', new Date('2026-09-19T12:00:00'));
  assert.equal(a.date, '2026-10-20');
  assert.equal(a.changed, false);
});

test('作者指定的日子比已排的早，要推后并说清为什么', () => {
  const a = alignScheduleStart(REAL_SCHEDULE, '2026-09-25', new Date('2026-09-19T12:00:00'));
  assert.equal(a.date, '2026-10-08');
  assert.equal(a.changed, true);
});

test('发布器入口在打开编辑页【之前】做对齐', () => {
  const src = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('发布前核对番茄上已排的定时');
  const j = src.indexOf('正在打开新建章节页面', i);
  assert.ok(i > 0 && j > i,
    'publishChapter 假设页面已停在编辑页；对齐要跳去章节管理读表，必须在打开编辑页之前做完');
  assert.ok(/alignScheduleStart\(rows, innerConfig\.scheduledStartDate\)/.test(src.slice(i, j)));
  assert.ok(/没能读到番茄上已排的定时/.test(src.slice(i, j)), '读不到要说出来——沉默会被当成"已经对齐过了"');
});

test('读定时表的浏览器端脚本里不许有被 shell 吃掉的残骸', () => {
  // 第一版是用 shell 里的 node -e 写进来的，反引号被 bash 当命令替换吃掉，落盘成 `const FIRE = ;`
  const src = fs.readFileSync(new URL('../src/fanqie.mjs', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf('async function readPendingSchedule'));
  assert.ok(!/const FIRE = ;/.test(seg.slice(0, 2000)));
  assert.ok(!/client\.evaluate\(\);/.test(seg.slice(0, 2000)), 'evaluate() 不能是空参数');
});

// —— 客观指标 ——

function mkBook(chs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nssign-'));
  fs.mkdirSync(path.join(dir, 'chapters', '卷01'), { recursive: true });
  for (const [name, body] of chs) fs.writeFileSync(path.join(dir, 'chapters', '卷01', name), body);
  return { title: '测试书', dir };
}
const rm = (b) => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} };

test('段落太长要报必改，并且给出网文的参照数', () => {
  const longPara = ('这是一段很长很长的叙述，'.repeat(8) + '\n').repeat(40);
  const b = mkBook([['001_开场.txt', longPara]]);
  try {
    const r = objectiveFindings(listBookChapters(b));
    const f = r.findings.find(x => x.key === 'long-para');
    assert.ok(f && f.level === 'bad');
    assert.match(f.text, /16 字\/段/, '要给参照：网文范本约 16 字/段，否则作者不知道自己长了多少');
  } finally { rm(b); }
});

test('短段落不该误报', () => {
  const b = mkBook([['001_开场.txt', ('他站起来。\n“走。”\n门开了。\n').repeat(60)]]);
  try { assert.ok(!objectiveFindings(listBookChapters(b)).findings.find(x => x.key === 'long-para')); } finally { rm(b); }
});

test('章节指标能量出来', () => {
  const b = mkBook([['001_a.txt', '他说：“走吧。”\n她没动。\n']]);
  try {
    const m = chapterMetrics(listBookChapters(b)[0].file);
    assert.equal(m.paras, 2);
    assert.ok(m.dialogPct > 0);
  } finally { rm(b); }
});

// —— 编辑评估 ——

test('评估 prompt：黄金三章给全文，其余抽样，并带上客观指标', () => {
  const chs = Array.from({ length: 10 }, (_, i) => [`${String(i + 1).padStart(3, '0')}_章${i + 1}.txt`, '正文'.repeat(100)]);
  const b = mkBook(chs);
  try {
    const list = listBookChapters(b);
    const p = buildSignEvalPrompt(b, list, objectiveFindings(list));
    assert.match(p, /黄金三章（全文）/);
    assert.match(p, /第1章/); assert.match(p, /第3章/);
    assert.match(p, /客观指标（已量好/, '已经量好的数字喂进去，别让模型再数一遍（它数不准）');
    assert.match(p, /\[必改\]/, '输出格式要能被解析');
  } finally { rm(b); }
});

test('评估结果能拆成结构化条目', () => {
  const t = [
    '- [必改] 第1章开头500字没有冲突 → 第一句就上淳于长敲门',
    '- [建议] 章名改成带钩子的直白标题',
    '- [可保留] 吮疽死局这个开局有史实做底',
    '【书名建议】《穿成王莽，我靠外星算力改命》',
    '【简介建议】我穿成了王莽……',
    '【总评】卖点前两万字没兑现',
  ].join('\n');
  const r = parseSignEval(t);
  assert.deepEqual(r.items.map(i => i.level), ['必改', '建议', '可保留']);
  assert.match(r.title, /外星算力/);
  assert.match(r.verdict, /没兑现/);
});

// —— 接线 ——

test('体检会把诊断结论摆出来（不用每次开浏览器）', async () => {
  const { checkupBook } = await import('../src/checkup.mjs');
  const b = mkBook([['001_a.txt', '正文']]);
  try {
    b.signDiag = { at: new Date().toISOString(), rejected: true, signed: false, nextApplyChars: 80000, publicChars: 63000, outOfOrder: [35, 36, 50, 51], readerOrder: [35, 36, 50, 51, 20], mustFix: 11 };
    const r = checkupBook(b);
    const dis = r.items.find(i => i.key === 'schedule-disorder');
    assert.ok(dis && dis.level === 'bad', '定时乱序要当硬伤报——读者会跳章');
    assert.match(dis.text, /35 → 36 → 50/);
    const rej = r.items.find(i => i.key === 'sign-rejected');
    assert.ok(rej);
    assert.match(rej.text, /1\.7 万字/, '直接算出离下次申请还差多少，别让作者自己减');
    assert.equal(dis.action.kind, 'signdiag');
  } finally { rm(b); }
});

test('界面有按钮、体检动作接得住', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.ok(html.includes('id="btnSignDiag"'), '要有入口');
  // 放在「查一查」里——它是只读的，不该和发布/重写一起待在危险区
  const i = html.indexOf('id="dwCheck"'), j = html.indexOf('<details', i + 10);
  assert.ok(html.slice(i, j).includes('id="btnSignDiag"'), '签约诊断是只读的，放在「查一查」里');
  assert.ok(/signdiag:\s*\(\)/.test(app), '体检的「看签约诊断」按钮要有对应的处理，否则点了没反应');
  assert.ok(/sign-diagnose/.test(app));
});
