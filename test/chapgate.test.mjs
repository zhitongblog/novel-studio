// 章节审校闸：每一条测试都钉着 2026-09-20 真实踩过的一个坑。
// 背景见 src/chapgate.mjs 顶部——六章正文指标全绿，逐行通读却查出三轮七类问题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSlop, scanBanned, checkHookContinuity, scanExposition,
  namesFromLedger, gateChapter, checkAliases, scanStereotype, scanRhythm,
} from '../src/chapgate.mjs';

test('节奏规整：段落长度过于均匀要被抓出来（引擎写的 005–007 就是这样）', () => {
  // 每段都是两句、长短差不多——读起来是节拍器。实测 006 的段长变异系数只有 0.12。
  const even = Array.from({ length: 20 }, (_, i) =>
    `马荣走进院子里看了一眼那口米缸。他伸手把缸盖掀开又盖上第${i}次。`).join('\n');
  const r = scanRhythm(even);
  assert.ok(r.paraCV < 0.5, `应判为过于均匀，实得 CV=${r.paraCV}`);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.includes('节拍器')));
});

test('节奏规整：人写的那种长短交错不许被误伤', () => {
  // 取自 001 的真实节奏：长段叙述 + 单句重锤交替，段长变异系数 0.98
  const human = [
    '囚车是辆破板车，两个轮子一高一低，走一步咯噔一下。车上的人五花大绑，脖子上套着枷，枷是新的，木头茬子还白着——说明是相州府里临时赶制的。汤阴这样的小县，平日里连副像样的枷都备不齐，真要用，得现打。',
    '围着看的人不少，没人吭声。',
    '岳飞把手里那块冷饼又咬了一口。饼是粟做的，掺了麸，硌牙。他一边嚼一边在心里过那几条：人赃并获、供状已画押、相州府已批秋后处决。',
    '这是个死案。',
    '死案也不是不能翻。',
    '他把手翻过来，又翻回去。三天了，三天里他一直在等这双手变回去，等一个他自己都知道不会来的结果。',
    '慢到自己都觉得不对劲。',
    '一个十二岁的孩子，看见同村人被押去砍头，第一反应不该是这个。第一反应该是腿软，该是跟着人群哭，该是躲回娘身后去。可他蹲在这儿，脑子里在排一样别的东西——排程序。',
    '二十七年。一万天。',
    '他忽然很清楚地想：这一万天，总得从今天开始算。',
    '不是从投军那天开始，不是从提枪上马那天开始。',
    '是从这条村路开始。',
  ].join('\n');
  const r = scanRhythm(human);
  assert.ok(r.paraCV >= 0.5, `人写的节奏不该被判均匀，实得 CV=${r.paraCV}`);
  assert.ok(r.sentCV >= 0.55, );
});

test('节奏规整：段落太少的片段不判（不够统计）', () => {
  assert.equal(scanRhythm('一段。\n两段。\n三段。').ok, true);
});

test('句式扎堆：007 那个「他X声道：」模具必须被量出来', () => {
  // 下面每一句都是 007 的原文。指标全绿，读着却像批量生产——病就在这个模具上。
  const t = [
    '马荣从鼻子里挤出一声冷哼，满眼蔑视。他寒声道：“永和乡的泥腿子若算安分，天底下就没坐牢的配军了。”',
    '姚氏死死护在门前，毫无惧色。她高声质问道：“县衙办差也得讲名目。”',
    '马荣冷眼横着姚氏，满脸凶光。他厉声喝道：“老妇休得阻拦。”',
    '一名弓手用刀鞘推开老汉的肩膀。他嘴里恶狠狠骂道：“滚一边去。”',
    '岳飞抬起头，迎着马荣的双眼。他语气十分平静：“是我递的水。”',
    '马荣反手一转佩刀。他厉声喝问：“你同那死囚说了甚么鬼话？”',
    '岳飞平声开口。他应道：“我送碗水与他润喉。”',
    '弓手提着刀走回院中。他躬身回禀：“甚么底稿也没有。”',
    '差官展开黄麻公牒。他冷声质问：“马都头在此作甚？”',
  ].join('\n');
  const r = scanStereotype(t);
  assert.ok(r.ratio > 0.3, `模具占比应超 30%，实得 ${r.ratio}`);
  assert.ok(r.problems.some(p => p.includes('模具')));
  assert.equal(r.ok, false);
});

test('句式扎堆：001–006 那种写法不许被误伤', () => {
  // 对话直接跟在动作后面，不套提示语模具——这是前六章的常态
  const t = [
    '“那哪成。”老汉笑了一声，“左邻右舍总得叫来两个站着看。”',
    '岳飞把炭条换到左手，右手在腿上搓了搓。',
    '“没有就是没搜过。”老汉说得很干脆，“搜过没搜过，不看你嘴，看纸。”',
    '王荣的手在门闩上停住了。',
    '“我一家老小，吃的是县里的饭。”',
    '他把棉袄的带子系紧，那两处破绽就贴在胸口上，走一步蹭一下。',
    '“喊了又怎样，谁理你。”',
    '老太太在后头追，一路追到村外的土坡底下才彻底爬不动。',
    '“大郎。”',
    '“那家人，惹不起。”',
  ].join('\n');
  const r = scanStereotype(t);
  assert.equal(r.ok, true, '前六章的写法不该被判扎堆');
  assert.equal(r.said, 0);
});

test('句式扎堆：对话太少的章不判——说话总得有提示语，三五次很正常', () => {
  const t = '他低声道：“走。”\n两人摸黑出了村。';
  assert.equal(scanStereotype(t).ok, true);
});

test('套话：006 里真实出现过的三处必须被抓住', () => {
  const t = [
    '知县咀嚼着这几个字，眼底翻起一片惊疑不定的寒芒。',
    '马荣松开弓手，面色阴狠如狼，喝了一声。',
    '岳飞盘腿坐着，眼眸宛若两泓冰封的深潭。',
  ].join('\n');
  const r = scanSlop(t);
  assert.equal(r.count, 3);
  assert.deepEqual(r.hits.map(h => h.line), [1, 2, 3]);
  assert.ok(r.hits.some(h => h.kind === '神态套句'));
  assert.ok(r.hits.some(h => h.kind === '脸谱化'));
  assert.ok(r.hits.some(h => h.kind === '万能比喻'));
});

test('套话：改写后的正文不许再被判为套话（不能误伤）', () => {
  const t = [
    '知县把这几个字在嘴里过了一遍，手指在案上叩了两下，停住了。',
    '马荣松开弓手，把手在袍子上蹭了两下。',
    '他借着昏暗的天光把棉袄里子摊平，一个字一个字往下看。',
  ].join('\n');
  assert.equal(scanSlop(t).count, 0);
});

test('禁用词：错过一次的写法钉进表里，从此再也犯不了第二次', () => {
  const banned = [
    { word: '赵四', why: '死者是周德昌，早稿编过赵四' },
    { word: '张保', why: '里正是王荣，006 一度写成张保' },
    { word: '五郎', why: '岳飞是长子，家里称大郎' },
    { word: '三十七两', why: '全书一律用贯' },
  ];
  const r = scanBanned('客商赵四死了，里正张保按了手印，三十七两银子。', banned);
  assert.equal(r.count, 3);
  assert.deepEqual(r.hits.map(h => h.word), ['赵四', '张保', '三十七两']);
  assert.ok(r.hits[0].why.includes('周德昌'));
  assert.equal(scanBanned('客商周德昌，里正王荣，三十七贯。', banned).count, 0);
});

test('钩子接续：004 结尾抛出王荣、005 整章没有——正是那一夜凭空消失的真实案例', () => {
  const prev = '他把棉袄的带子系紧。出了城他不回家。他要去的那户人家姓王荣。';
  const nextBad = '官道上的硬泥被车辙翻起。岳飞赤着双脚，顺着河堤一路往北跑，要去截囚车。';
  const r1 = checkHookContinuity(prev, nextBad, ['王荣', '李阿牛']);
  assert.deepEqual(r1.raised, ['王荣']);
  assert.deepEqual(r1.dropped, ['王荣']);
  assert.equal(r1.ok, false);

  const nextGood = '昨夜他没回家。里正王荣披着衣裳出来，听完前两句就要关门。';
  const r2 = checkHookContinuity(prev, nextGood, ['王荣', '李阿牛']);
  assert.deepEqual(r2.dropped, []);
  assert.equal(r2.ok, true);
});

test('钩子接续：上一章没提的人不算被抛出，不许无中生有地报警', () => {
  const r = checkHookContinuity('他转身往家走。', '岳飞见到了姚氏。', ['王荣', '马荣']);
  assert.deepEqual(r.raised, []);
  assert.equal(r.ok, true);
});

test('钩子接续：一直在场的常驻角色不算钩子——003 被误报过一次', () => {
  // 002 通篇都是姚氏和岳和在灶间，结尾也是他们；003 是岳飞独自进城，两人不出现很正常。
  const prev = [
    '姚氏蹲在灶前添柴。岳和坐在门槛上编草绳。',
    '姚氏添柴的手停在半空。岳和把草绳搁在膝上。',
    '岳和已经把那根草绳捡起来了。姚氏的手却很稳。',
    '姚氏说：大郎，那家人，惹不起。',
  ].join('\n');
  const next = '天没亮岳飞就出了门。从永和乡到汤阴县城二十里。';
  const r = checkHookContinuity(prev, next, ['姚氏', '岳和']);
  assert.deepEqual(r.raised, [], '通篇在场的人不该被当成抛出的钩子');
  assert.equal(r.ok, true);

  // 而只在末尾点一次名的，仍然要报
  const prev2 = '他把棉袄系紧，怀里还有三文钱。出了城他不回家。他要去的那户人家姓王荣。';
  const r2 = checkHookContinuity(prev2, next, ['王荣']);
  assert.deepEqual(r2.dropped, ['王荣']);
});

test('普法旁白：夹在对话中间干讲法条的那种段落要被抓出来', () => {
  const t = [
    '“那就是栽赃！”岳飞厉声打断他。',
    '大宋刑律如铁，验尸必合供状。伤痕与口供不符而强行定罪，主审官按律要以故入人罪论处。',
    '李阿牛听懂了要害，浑浊的眼睛里窜起一簇光。',
  ].join('\n');
  const r = scanExposition(t);
  assert.equal(r.count, 1);
  assert.equal(r.hits[0].line, 2);
});

test('普法旁白：法条由人物说出口、或夹在动作里，都不算干讲', () => {
  const spoken = '“搜民户起赃，得召邻保来看着，末了画字具结。”老汉说得很干脆。';
  assert.equal(scanExposition(spoken).count, 0);
  const acted = '他把炭条停在那一行上，想起刑统里写着搜检民宅须召邻保同见，缺这一样便算不得真赃。';
  assert.equal(scanExposition(acted).count, 0);
});

test('专名表从台账自动长出来——漏登记就是 006 写出张保的根因', () => {
  const ledger = [
    '## 📌 当前态快照',
    '- 进度：已写到第 006 章',
    '### 人物现状',
    '- **岳飞**（前世李向东）：十二岁。',
    '- **姚氏**（母）：不识字，硬气。',
    '- **王荣**：永和乡里正，搜检当天在场。',
    '- **马荣**：汤阴县都头。',
    '<!-- LEDGER_HISTORY_BELOW -->',
    '- **不该被读到的历史区人物**：略',
  ].join('\n');
  const names = namesFromLedger(ledger);
  assert.ok(names.includes('岳飞'));
  assert.ok(names.includes('王荣'));
  assert.ok(names.includes('马荣'));
  assert.ok(!names.includes('不该被读到的历史区人物'), '历史区不许进专名表');
});

const NL = String.fromCharCode(10);
test('专名表也认「- 吕布：」这种不加粗的台账——三本书的钩子闸曾因此整本空转', () => {
  const ledger = [
    '## 📌 当前态快照',
    '- 进度：已写到第 113 章',
    '### 人物现状（含全部已出场姓名，绝不改名、绝不串名）',
    '- 吕布：以车骑将军明光玄铠亲临司徒府吊唁王允。',
    '- 刘协（汉献帝）：十三岁，积郁寒邪倒灌肺窍。',
    '- 张辽、马超：各领精骑两翼呼应。',
    '### 未回收伏笔 / 待查',
    '- 武关解围与南阳战事：三千五百生力铁骑突袭桥蕤。',
    '<!-- LEDGER_HISTORY_BELOW -->',
    '### 人物现状',
    '- 历史区的人：不许进表',
  ].join(NL);
  const names = namesFromLedger(ledger);
  assert.ok(names.includes('吕布'));
  assert.ok(names.includes('刘协'), '括注要剥掉，留「刘协」');
  assert.ok(names.includes('张辽') && names.includes('马超'), '一条里并列的几个人要拆开');
  assert.ok(!names.includes('进度'), '「进度」在人物节之外，不许进表');
  assert.ok(!names.includes('历史区的人'), '历史区不许进专名表');
  // 未回收伏笔那一节的条目开头是事件不是人名
  assert.ok(!names.some(n => n.includes('武关')), '伏笔节不许进表');
});

test('别名冲突：同一个里正被写成两个名字，只要两边都出现过就报', () => {
  const chapters = ['榜文夹注写着本村里正王荣。', '小人张保，便是本乡里正。'];
  const r = checkAliases(chapters, [['王荣', '张保', '同一个里正']]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts[0].aAt, [1]);
  assert.deepEqual(r.conflicts[0].bAt, [2]);
  // 改好之后不许再报
  assert.equal(checkAliases(['里正王荣', '小人王荣'], [['王荣', '张保']]).ok, true);
});

test('gateChapter：一章全干净时 ok，问题都摆进 problems', () => {
  // registerOff：这几个用例测的是套话/禁用词/钩子，样本只有十几个字，
  // 而语域闸按【每千字】算口语密度——短样本上那个数没有意义，会必然报警。
  // 语域闸自己的用例在 chapgate-register.test.mjs 里，用的是够长的样本。
  const clean = '岳飞把炭条换到左手，右手在腿上搓了搓。他得先弄清一件事：不是他记岔了。';
  assert.equal(gateChapter({ text: clean, registerOff: true }).ok, true);

  const dirty = [
    '知县眼底翻起一片寒芒。',
    '马荣面色阴狠如狼。',
    '客商赵四死于脑后一击。',
  ].join('\n');
  const r = gateChapter({
    text: dirty,
    prevText: '他要去的那户人家姓王荣。',
    names: ['王荣'],
    banned: [{ word: '赵四', why: '死者是周德昌' }],
    registerOff: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.includes('禁用词')));
  assert.ok(r.problems.some(p => p.includes('套话')));
  assert.ok(r.problems.some(p => p.includes('王荣')));
});

test('要卡的是密度不是总数：单章一处只作提示，两处才算事故', () => {
  // 由来：我拿《崇祯》296 章里「顿了顿」37 次说成"最明显的 AI 指纹"——
  // 算下来 8 章才一次，完全正常。真正的病是岳飞 006 那种：一章里三处。
  const one = '知县眼底翻起一片寒芒，把抄件摔在案上。';
  const r1 = gateChapter({ text: one, registerOff: true });
  assert.equal(r1.slop.severity, 'note');
  assert.equal(r1.ok, true, '单处套话不该判整章不合格');
  assert.ok(r1.notes.some(n => n.includes('套话')));

  const two = '知县眼底翻起一片寒芒。\n马荣面色阴狠如狼。';
  const r2 = gateChapter({ text: two, registerOff: true });
  assert.equal(r2.slop.severity, 'bad');
  assert.equal(r2.ok, false);
});

test('黑名单分题材：历史书可以关掉「闻言」这类正常文言，但不放过真套话', () => {
  const t = '朱慈烺颈侧还渗血，闻言一愣，随即点头。\n李若琏眼底闪过一丝诧异。';
  assert.equal(scanSlop(t).count, 2);
  const off = scanSlop(t, { ignoreWords: ['闻言'] });
  assert.equal(off.count, 1);
  assert.equal(off.hits[0].kind, '神态套句');
  assert.equal(scanSlop(t, { ignoreKinds: ['转场套话'] }).count, 1);
});

test('「不得不说」只有当转场感叹时才算病，正常句子不许误伤', () => {
  assert.equal(scanSlop('他需要一个怕死却不得不说真话的活口。').count, 0);
  assert.equal(scanSlop('不得不说，这手棋走得漂亮。').count, 1);
});

test('节奏规整：句长 CV 的下限随对话密度浮动——别拿叙述章的尺子量对峙戏', () => {
  // 2026-09-20 实测：003 对话 0%→CV 0.69；006 31%→0.67；004 40%→0.59；005 52%→0.53。
  // 一句台词天生十到二十五字，对话越多句长自由度越小，CV 必然被压下来。
  const narr = Array.from({ length: 14 }, (_, i) =>
    i % 3 === 0 ? '他停住了。'
    : i % 3 === 1 ? '岳飞把炭条换到左手，右手在腿上搓了搓，指缝里的黑印怎么搓也搓不掉。'
    : '风从街口灌进来，吹得榜纸哗啦作响，他抬手按住榜角，等风过去了再描。').join('\n');
  const rn = scanRhythm(narr);
  assert.ok(rn.dlgRatio < 0.4, '这是叙述章');

  // 同样的句长起伏，换成对话密集章：下限放宽到 0.5，不该被判不合格
  const dlg = Array.from({ length: 14 }, (_, i) =>
    i % 2 === 0 ? '“是我递的水。”' : '马荣反手一转佩刀，冰凉的鞘口直指岳飞咽喉，逼得他退无可退。').join('\n');
  const rd = scanRhythm(dlg);
  assert.ok(rd.dlgRatio >= 0.4, '这是对话密集章');
  const relaxed = rd.problems.find(p => p.includes('句子长度'));
  if (relaxed) assert.ok(relaxed.includes('已按对话密集章放宽'), '放宽时要在报告里说明白');
});

test('节奏规整：长句也要有上限——给下限模型就冲天花板', () => {
  // 2026-09-20/21 撞了五次的同一个模式：给"对话要够"它写到 46%，给"平均段长≥28"它写到 84 字，
  // 给"要有单句成段"它逐句换行，给"句长要有起伏"它写出 136 字的句子。
  // 基线：001–007 每章 >80 字的句子 0–1 句，>120 字的一句都没有；008 一章 8 句 >80、5 句 >120。
  const okText = Array.from({ length: 16 }, (_, i) =>
    i % 4 === 0 ? '他停住了。'
    : i % 4 === 1 ? '岳飞把炭条换到左手，右手在腿上搓了搓，指缝里的黑印怎么也搓不掉。'
    : i % 4 === 2 ? '风从街口灌进来，吹得榜纸哗啦作响。'
    : '他抬手按住榜角，等风过去了再描，一个字一个字地往下摹，描到第三行忽然停住。').join('\n');
  assert.ok(!scanRhythm(okText).problems.some(p => p.includes('拉得过头')), '正常长句不该被判过头');

  const tooLong = Array.from({ length: 12 }, () =>
    '推官一把扯开绑绳，将汤阴县呈报提刑按察司的原案卷宗申状与榜文底样刷地展开，与公案上的破棉袄并排摊在一起，左边是盖着汤阴县正印的大红官卷，右边是佃户少年用灶膛炭条抄录的破袄里子，两下一对字字对应。').join('\n');
  const r = scanRhythm(tooLong);
  assert.ok(r.veryLong > 2);
  assert.ok(r.problems.some(p => p.includes('拉得过头')), '一章八句上百字必须报');
});

test('钩子接续：常驻角色在结尾露个脸，不算新抛出的钩子', () => {
  // 2026-09-21 008 的误报：007 结尾写王荣"缩着脖子溜回村道深处"，他只是围观的背景人物，
  // 全章 2 次正好卡进阈值；而 008 场景已在相州，王荣留在永和乡不出现完全正常。
  const prev = '马荣一甩铁甲大袖退出院门。篱笆外围看的村邻慌忙退开，王荣缩着脖子，擦着冷汗溜回了村道深处。';
  const next = '四十里官道。岳飞跟着差官进了相州城，按察分司的仪门比汤阴县衙高出一倍。';
  // 没有历史：仍判为钩子（这是 004 第一次点王荣名时的情形，该报）
  assert.equal(checkHookContinuity(prev, next, ['王荣']).ok, false);
  // 有历史、且王荣已累计露面 17 次：是常驻角色，不报
  const history = Array.from({ length: 17 }, () => '王荣').join('，');
  assert.equal(checkHookContinuity(prev, next, ['王荣'], { history }).ok, true);
});
