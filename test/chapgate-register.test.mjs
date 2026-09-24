// 语域闸：口语密度 + 均句长。
//
// 这道闸的阈值不是拍脑袋定的，是 2026-09-23 拿《岳飞》卷01 的四个样本去腾讯朱雀
// AI 检测跑出来的。四个点连成一条很干净的曲线：
//
//   样本            人类率     口语/千字  均句长
//   001 原版         0%          0       25.9
//   006（agy 写）    0%          1.6      19.4
//   001 只换词      33.79%      21.9      26.2
//   001 全面重写    75.11%      30.5      20.7
//
// 下面每个 case 都是在守这条曲线——阈值动了，测试就会红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRegister, ORAL_MARKERS, ORAL_MARKERS_SANGUO, ORAL_MARKER_SETS, gateChapter } from '../src/chapgate.mjs';

// 造样本：以句号断句，控制均句长与口语词数量
const mk = (sent, n, oral = '') => Array.from({ length: n }, (_, i) =>
  (i === 0 && oral ? oral : '') + '甲'.repeat(sent)).join('。') + '。';

test('零口语标记 = 书面腔，判硬伤（实测这类样本人类率一律 0）', () => {
  const r = scanRegister(mk(20, 30));
  assert.equal(r.perK, 0);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /低于 5 的样本人类率一律为 0/);
});

test('口语标记 1.6/千字 仍判硬伤——agy 那章就卡在这里', () => {
  // 600 字里放 1 个标记 ≈ 1.7/千字
  const r = scanRegister('瞧' + '甲'.repeat(599));
  assert.ok(r.perK < 5, '应落在硬伤区，实际 ' + r.perK);
  assert.match(r.problems[0], /低于 5/);
});

test('只换词不够：口语够了但句子还长，仍不放行（对应实测的 33.79% 弱人类创作）', () => {
  // 均句长 26（>22），口语密度拉满
  const oral = '上头里头后头自个儿俩仨末了家什囫囵出溜杵着瞧搁没准味儿这地方啥咋了吧';
  const r = scanRegister(oral + mk(26, 20));
  assert.ok(r.perK >= 20, '口语密度应达标，实际 ' + r.perK);
  assert.ok(r.meanSent > 22, '均句长应超标，实际 ' + r.meanSent);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /均句长/.test(p)), '应当指出是句长的问题，而不是口语的问题');
});

test('口语够 + 句子短 = 放行（对应实测的 75.11% 强人类创作）', () => {
  const oral = '上头里头后头自个儿俩仨末了家什囫囵出溜杵着瞧搁没准味儿这地方啥咋了吧';
  const r = scanRegister(oral + mk(18, 20));
  assert.ok(r.perK >= 20, '口语密度 ' + r.perK);
  assert.ok(r.meanSent <= 22, '均句长 ' + r.meanSent);
  assert.equal(r.ok, true, '两项都达标却没放行：' + r.problems.join('；'));
});

test('阈值可调，但默认值就是实测标定出来的那两个', () => {
  const t = '瞧瞧瞧' + mk(19, 20);
  assert.equal(scanRegister(t, { minPerK: 0, maxMeanSent: 99 }).ok, true);
  // 默认 minPerK=20 / maxMeanSent=22 —— 改了默认值这里会红
  const sig = scanRegister('甲'.repeat(100));
  assert.ok(/低于 5/.test(sig.problems[0]));
  assert.match(scanRegister(mk(30, 10) + '瞧'.repeat(30)).problems.join(), /均句长/);
});

test('口语词表存在且非空；换书换背景要连表一起换（注释里写明了）', () => {
  assert.ok(Array.isArray(ORAL_MARKERS) && ORAL_MARKERS.length > 15);
  // 几个最典型的北方官话标记必须在表里
  for (const w of ['自个儿', '上头', '俩', '瞧', '搁']) {
    assert.ok(ORAL_MARKERS.includes(w), '词表里应有「' + w + '」');
  }
});

test('语域闸已接进 gateChapter，且能被 registerOff 关掉', () => {
  const bookish = mk(26, 30);
  const g = gateChapter({ text: bookish });
  assert.ok(g.register, 'gateChapter 应返回 register 结果');
  assert.ok(g.problems.some(p => /口语标记/.test(p)), '书面腔应被 gateChapter 报出来');
  const off = gateChapter({ text: bookish, registerOff: true });
  assert.ok(!off.problems.some(p => /口语标记/.test(p)), 'registerOff 应能关掉这道闸');
});

test('节奏闸量不到 AI 味——这条是实测结论，别再把 CV 当反 AI 指标', async () => {
  const src = await import('node:fs').then(m => m.readFileSync(new URL('../src/chapgate.mjs', import.meta.url), 'utf8'));
  // 006 的句长CV(0.767) 比原版 001(0.633) 还高，却是最差样本。这条教训必须留在代码里。
  assert.match(src, /句长CV 不是主因/);
  assert.match(src, /006/);
});

// ── 汉末三国表 ─────────────────────────────────────────────────
// 由来：2026-09-23 拿豫北表量《重生三国，我吕布杀出一片天》，113 章全判"整章书面腔"。
// 数值没错，结论没法用——汉末的人不说"自个儿""啥""咋"，往三国书里堆这些词是另一种假。

test('三国表收的是半文半白那一路词，不是奏章上的文言', () => {
  assert.ok(ORAL_MARKERS_SANGUO.length > 50);
  // 这八个词是这本书全书 0 次的口语骨架，正是这张表存在的理由
  for (const w of ['甚么', '怎地', '怎的', '晓得', '省得', '寻思', '也罢', '这厮']) {
    assert.ok(ORAL_MARKERS_SANGUO.includes(w), '三国表里应有「' + w + '」');
  }
  // 豫北那一路的词不许混进来——那是另一种假
  for (const w of ['自个儿', '啥', '咋', '味儿']) {
    assert.ok(!ORAL_MARKERS_SANGUO.includes(w), '「' + w + '」是豫北词，不该出现在三国表');
  }
});

test('误伤守闸：这五处是拿 37 万字全书验出来的，删了约束这里就红', () => {
  const pad = '甲'.repeat(200);
  const no = (t, why) => assert.equal(scanRegister(pad + t, { oralSet: '汉末三国' }).hits, 0, why);
  no('千钧一发之际', '「一发」只来自千钧一发');
  no('粥是我叫端的，好端端的', '「端的」只来自叫端的／好端端的');
  no('能说明他们去过相似的地方', '「似的」不许吃掉「相似的」');
  no('孩子缩在娘的怀里', '「娘的」是母亲不是骂人');
  no('朝拖他娘的兵扑过去', '「他娘的兵」是他母亲的兵，不是骂人');
  no('他下意识攥紧右手', '「攥」是旁白动词，这道闸量的是人物嘴里的口语');
});

test('「咱们」只算一次，不许被「咱」再数一遍', () => {
  const r = scanRegister('甲'.repeat(200) + '咱们', { oralSet: '汉末三国' });
  assert.equal(r.hits, 1, '实际 ' + r.hits);
});

test('未标定的表不许把话说得像实测过一样', () => {
  const bookish = mk(20, 30);
  const sg = scanRegister(bookish, { oralSet: '汉末三国' });
  assert.equal(sg.calibrated, false);
  assert.match(sg.problems[0], /未经朱雀标定/);
  assert.ok(!/人类率一律为 0/.test(sg.problems[0]), '没标定过的表不许借用实测结论的口气');
  // 标定过的那张仍然可以这么说
  assert.match(scanRegister(bookish).problems[0], /人类率一律为 0/);
  assert.equal(ORAL_MARKER_SETS['北方官话'].calibrated, '2026-09-23 朱雀四样本');
});

test('默认仍是北方官话——换表是 gate.json 的事，不许悄悄改老书的行为', () => {
  assert.equal(scanRegister('甲'.repeat(100)).oralSet, '北方官话');
  // 豫北词在三国表下不该加分，反之亦然
  const north = '自个儿啥咋味儿' + '甲'.repeat(200);
  assert.ok(scanRegister(north).hits > 0);
  assert.equal(scanRegister(north, { oralSet: '汉末三国' }).hits, 0);
});

test('oralSet 能从 gateChapter 穿下去（gate.json 就是这么接的）', () => {
  const sanguo = '“甚么？”那厮怎地不晓得省得寻思也罢' + mk(18, 10);
  const a = gateChapter({ text: sanguo });                        // 豫北表：一个都认不出
  const b = gateChapter({ text: sanguo, oralSet: '汉末三国' });
  assert.ok(b.register.perK > a.register.perK, '换表之后口语密度应当涨：' + a.register.perK + ' → ' + b.register.perK);
  // 自带词表优先于 oralSet
  const c = gateChapter({ text: '甲'.repeat(100) + '喏喏喏', oralMarkers: ['喏'] });
  assert.equal(c.register.hits, 3);
});

// ── 公文豁免 ──────────────────────────────────────────────────────────
// 2026-09-24 加。008《知见人》是公堂章，整章 19.5/千字，差一点点。
// 但那一章有 34% 的篇幅是宋代验状、供状、榜文原文——要把整章顶到 20，
// 就得去改一份验状的措辞，那是错的：公文本来就该是公文腔。
// 逐章量了一遍才定这条规则：15 章里公文占比 0%–24% 的有 14 章，只有 008 到 34%，
// 而它剥掉公文后的叙述是 23.6，本身过线。所以只在「公文多 且 叙述达标」时放行。

// 造夹具：sents 句、每句 fill 个无标记的字，其中 oralSents 句带一个口语词。
// 这样能把口语密度调到真章的区间（17–26/千字），而不是几百——夹具不真实，
// 测出来的阈值也不作数。
const MK = ['里头', '自个儿', '末了', '这会儿', '老半天', '没准'];
const mkNarr = (sents, oralSents, fill = 20) => Array.from({ length: sents },
  (_, i) => (i < oralSents ? MK[i % MK.length] : '') + '甲'.repeat(fill)).join('。') + '。';
// 公文段：宋代定式词齐全，一个口语标记都没有
const mkDoc = (n) => Array.from({ length: n },
  () => '验状载周德昌顶后脑骨遭方角坚木自后猛扑骨陷长一寸四分依律晓谕四乡' + '乙'.repeat(8)).join('。') + '。';

test('公文占比高、但叙述本身够口语 → 放行（008 公堂章）', () => {
  const r = scanRegister(mkNarr(30, 14) + '\n' + mkDoc(10));
  assert.ok(r.docRatio > 0.25, `公文占比应超过 25%，实际 ${r.docRatio}`);
  assert.ok(r.narrPerK >= 20, `叙述口语度应达标，实际 ${r.narrPerK}`);
  assert.ok(r.perK < 20 && r.perK > 5, `整章应被公文拖到 5~20 之间，实际 ${r.perK}`);
  assert.equal(r.docExempt, true);
  assert.ok(!r.problems.some((p) => p.includes('口语标记')), `不该再报口语密度不足：${r.problems}`);
});

test('公文多、但叙述本身也不口语 → 照样拦，并且说明是叙述的问题', () => {
  const r = scanRegister(mkNarr(30, 7) + '\n' + mkDoc(10));
  assert.ok(r.docRatio > 0.25, `公文占比 ${r.docRatio}`);
  assert.ok(r.narrPerK > 5 && r.narrPerK < 20, `叙述应在 5~20 之间，实际 ${r.narrPerK}`);
  assert.equal(r.docExempt, false);
  assert.ok(!r.ok, '叙述本身不口语就不能因为有公文而放行');
  const msg = r.problems.find((p) => p.includes('口语标记'));
  assert.ok(msg && msg.includes('叙述本身不够口语'), `应点明是叙述的问题，实际：${msg}`);
});

test('公文少的章不走豁免（防止规则被滥用）', () => {
  const r = scanRegister(mkNarr(40, 8) + '\n验状一纸，依律晓谕。');
  assert.ok(r.docRatio <= 0.25, `公文占比 ${r.docRatio} 不该触发豁免`);
  assert.equal(r.docExempt, false);
  assert.ok(!r.ok, '公文不够多就该照常拦');
});

test('判别只认公文定式，不认对白里的称谓（否则半章对话会被误判成公文）', () => {
  const dialog = '“回老大人，小民是同村乡邻。”\n“小人不敢欺瞒老大人。”\n“大老爷明鉴，小人冤枉啊！”';
  const r = scanRegister(dialog);
  assert.equal(r.docRatio, 0, `「老大人」「小人」不该算公文，实际占比 ${r.docRatio}`);});
