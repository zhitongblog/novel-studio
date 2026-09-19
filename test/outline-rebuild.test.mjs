// 「导入的图书如何生成合理的大纲」——原来的做法在物理上做不到。
//
// buildRebuildOutlineInstruction 第一步写着「通读 chapters/ 下所有已写章节（按文件名顺序）」。
// 而实际的书有多大（2026-09-19 实扫）：
//   《大乾女帝贴身神探》523 章 / 145 万字   → outlines/ 只有 卷01分章大纲.md（23KB）
//   《重生之我在岛国当天皇》358 章 / 104 万字 → 只有 卷01、卷02
//   《重生三国，我吕布杀出一片天》86 章       → 只有 1 个文件，1KB
// 没有模型装得下 145 万字。它只能读个开头就往下编——于是几百章是在【没有大纲】的情况下写的。
//
// 改成分层归纳，每一层的输入都有界：
//   ① 逐章摘要：一次喂 12 章，每章一行。结果缓存进 outlines/.chapter-digest.json，
//      可断点续、可增量（523 章的书加写 3 章，只要再跑 1 次）。
//   ② 按卷聚合：拿该卷的【摘要】生成分章大纲，不再碰正文。
// 实测（《代码逆子与宇宙沙盒》30 章）：摘要 258 秒 / 3 次调用，卷大纲 196 秒，产出可用。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listChapters, listVolumes, parseDigestLines, buildDigestPrompt,
  loadDigests, recordDigests, digestProgress, missingDigests, saveVolumeOutline, volumeDigestText,
} from '../src/outlinerebuild.mjs';

function mkBook(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsol-'));
  for (const [vol, names] of Object.entries(spec)) {
    const d = path.join(dir, 'chapters', vol);
    fs.mkdirSync(d, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(d, n), '正文内容若干。'.repeat(50));
  }
  return { title: '测试书', dir };
}
const rm = (b) => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} };

test('章节扫描：跨卷、按章号排序', () => {
  const b = mkBook({ 卷01: ['001_开场.txt', '002_推进.txt'], 卷02: ['003_转折.txt'] });
  try {
    const cs = listChapters(b);
    assert.deepEqual(cs.map(c => c.num), [1, 2, 3]);
    assert.deepEqual(cs.map(c => c.vol), ['卷01', '卷01', '卷02']);
    assert.equal(cs[0].name, '开场');
    assert.deepEqual(listVolumes(b), ['卷01', '卷02']);
  } finally { rm(b); }
});

test('模型漏了哪一章必须当场看得出来', () => {
  // 不核对的话，漏掉的那几章后面就【永远】没有大纲——而模型少写几行是常态
  const r = parseDigestLines('1|事件A|推进A|钩子A\n3|事件C|推进C|钩子C', [1, 2, 3]);
  assert.deepEqual(Object.keys(r.got).sort(), ['1', '3']);
  assert.deepEqual(r.missing, [2], '第 2 章漏了，要报出来好补跑');
});

test('模型编出来的章号要丢掉', () => {
  const r = parseDigestLines('1|真的|x|y\n99|不存在的章|x|y', [1]);
  assert.deepEqual(Object.keys(r.got), ['1']);
});

test('各种行首写法都要认（模型不会严格听话）', () => {
  const r = parseDigestLines('- 1|事件|推进|钩子\n第2章|事件|推进|钩子\n003｜事件｜推进｜钩子', [1, 2, 3]);
  assert.deepEqual(Object.keys(r.got).sort(), ['1', '2', '3'], '前缀符号、中文"第N章"、全角竖线、补零都要认');
});

test('空的/过短的梗概不算数', () => {
  const r = parseDigestLines('1|\n2|x\n3|正常的梗概内容', [1, 2, 3]);
  assert.deepEqual(r.missing, [1, 2], '写了等于没写的，要当成漏掉去补');
});

test('摘要是增量的——加写几章不用重来一遍', () => {
  const b = mkBook({ 卷01: ['001_a.txt', '002_b.txt', '003_c.txt'] });
  try {
    recordDigests(b, { 1: '第一章梗概', 2: '第二章梗概' });
    assert.equal(digestProgress(b).done, 2);
    assert.deepEqual(missingDigests(b).map(c => c.num), [3], '只差第 3 章，不该把 1、2 也算成要重跑');
    recordDigests(b, { 3: '第三章梗概' });
    assert.equal(digestProgress(b).missing, 0);
  } finally { rm(b); }
});

test('每批落盘——跑到一半断了，已完成的必须留下', () => {
  const b = mkBook({ 卷01: ['001_a.txt', '002_b.txt'] });
  try {
    recordDigests(b, { 1: '梗概一' });
    // 模拟"进程没了"：重新从磁盘读
    assert.equal(loadDigests(b)['1'], '梗概一', '523 章重来一遍的代价太大，必须落盘');
  } finally { rm(b); }
});

test('喂给卷大纲的是【摘要】，不是正文', () => {
  const b = mkBook({ 卷01: ['001_开场.txt', '002_推进.txt'] });
  try {
    recordDigests(b, { 1: '事件A｜推进A｜钩子A', 2: '事件B｜推进B｜钩子B' });
    const t = volumeDigestText(b, '卷01');
    assert.match(t, /1｜开场｜事件A/);
    assert.ok(!t.includes('正文内容若干'), '正文不能进来——这正是"通读全书"做不到的原因');
  } finally { rm(b); }
});

test('没梗概的章节要照实写「暂无」，不能悄悄跳过', () => {
  const b = mkBook({ 卷01: ['001_a.txt', '002_b.txt'] });
  try {
    recordDigests(b, { 1: '有梗概' });
    assert.match(volumeDigestText(b, '卷01'), /暂无梗概/, '跳过的话，那一章在大纲里就凭空消失了');
  } finally { rm(b); }
});

test('卷名从模型输出里取，取不到就退回卷号', () => {
  const b = mkBook({ 卷01: ['001_a.txt'] });
  try {
    const f1 = saveVolumeOutline(b, '卷01', '# 卷01摇篮里的神明分章大纲\n\n## 本卷一句话走向\n从A到B。');
    assert.match(path.basename(f1), /摇篮里的神明/, '卷必须有名——发布番茄按卷名建卷');
    const f2 = saveVolumeOutline(b, '卷02', '没有标题的内容');
    assert.equal(path.basename(f2), '卷02分章大纲.md');
  } finally { rm(b); }
});

test('重建时同一卷的旧大纲要挪走——不能并排留着，也不能删', () => {
  // 吕布那本实况：新「卷01《一戟定关中》分章大纲.md」旁边还躺着旧的「卷01分章大纲.md」，
  // outlineFilesFor 按 /卷0*1/ 两份都会匹配上，拼在一起互相打架。
  const b = mkBook({ 卷01: ['001_a.txt'] });
  try {
    const od = path.join(b.dir, 'outlines');
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, '卷01分章大纲.md'), '作者手写的真内容，不能丢');
    fs.writeFileSync(path.join(od, '卷02分章大纲.md'), '别的卷，不该被碰');
    fs.writeFileSync(path.join(od, '卷10分章大纲.md'), '卷10 不是卷1，不该被碰');
    saveVolumeOutline(b, '卷01', '# 卷01一戟定关中分章大纲\n\n新内容');
    const top = fs.readdirSync(od).filter(f => f.endsWith('.md')).sort();
    assert.deepEqual(top, ['卷01一戟定关中分章大纲.md', '卷02分章大纲.md', '卷10分章大纲.md'],
      '顶层只该剩新的卷01 + 别的卷；卷10 不能被当成卷1 误伤');
    const arch = fs.readdirSync(path.join(od, '_旧版'));
    assert.equal(arch.length, 1);
    assert.equal(fs.readFileSync(path.join(od, '_旧版', arch[0]), 'utf8'), '作者手写的真内容，不能丢',
      '旧大纲可能是作者手写的，挪走而不是删除');
  } finally { rm(b); }
});

test('摘要 prompt 要把章数说死，好核对', () => {
  const b = mkBook({ 卷01: ['001_a.txt', '002_b.txt'] });
  try {
    const p = buildDigestPrompt(listChapters(b));
    assert.match(p, /一共 2 章，就输出 2 行/, '说死数量，模型少给就能当场发现');
    assert.match(p, /章号\|核心事件与冲突\|/, '格式要能被解析');
  } finally { rm(b); }
});


// —— 2026-09-19 作者问「重写大纲的问题都修好了吗」，核实发现的洞 ——

test('界面按钮必须走新管线——做好了不接上等于没做', () => {
  // 新管线做完后，「从正文补回设定和大纲」按钮【仍然调老端点】rebuild-outline，
  // 就是那条第一步写着"通读全书"的路。吕布那本是在命令行里跑的，作者在应用里点拿到的还是坏的。
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const i = app.indexOf("$('#btnRebuildOutline').addEventListener");
  // 不能用 indexOf('});') 找结尾：处理器内部 `{ book: CUR.slug });` 就会先撞上，切片被截短（第一版就这么误报）。
  // 取到下一个顶层监听器之前为止。
  const next = app.indexOf("\n$('#", i + 10);
  const seg = app.slice(i, next > 0 ? next : i + 3000);
  assert.ok(/rebuild-outline2/.test(seg), '按钮要调 rebuild-outline2');
  assert.ok(!/'\/api\/book\/rebuild-outline'/.test(seg), '按钮不能再调老的 rebuild-outline');
  assert.ok(/digest-progress/.test(app.slice(i, i + 2500)), '点之前要先看进度：正在跑就给"停下"，而不是再开一份');
});

test('重建指令第一步不能再要求"通读全书"', async () => {
  const { buildRebuildOutlineInstruction } = await import('../src/planner.mjs');
  const b = mkBook({ 卷01: ['001_a.txt'] });
  try {
    const noDigest = buildRebuildOutlineInstruction(b);
    assert.ok(!noDigest.includes('通读 chapters/ 下所有'), '145 万字的书，这一步是做不到的');
    assert.match(noDigest, /不许假装读完了全书/, '没有梗概时要老实说只读了一部分');
    recordDigests(b, { 1: '梗概' });
    const withDigest = buildRebuildOutlineInstruction(b);
    assert.match(withDigest, /chapter-digest\.json/, '有梗概就读梗概——几百章也就几万字，装得下');
  } finally { rm(b); }
});

console.log('\n全部通过 ✅  几百章的书，终于能靠分层归纳把大纲补回来了');
