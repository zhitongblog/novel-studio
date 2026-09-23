// 章节审校闸：写完一章之后，用代码把【人眼才看得出的毛病】捞出来。
//
// 由来：2026-09-20 写《岳飞：跟我讲规矩？那你们输定了》前六章，
// 指标（字数/段落/对话/省略号）全绿、抽样片段也好看，我说了两次"修好了"，
// 结果作者一追问、真去逐行通读，连查出三轮七类问题：
//   ① 006 三处套话（眼底翻起寒芒 / 面色阴狠如狼 / 眼眸宛若两泓冰封的深潭）
//   ② 004 结尾让主角连夜去找里正王荣，005 直接跳到截囚车——【那一夜凭空消失】
//   ③ 同一个里正，004 叫王荣、006 叫张保
//   ④ 006 把日期写成"十月初七"，而初七是第一章囚车过村口那天
//   ⑤ 称谓自相矛盾：001/002 写"五郎""兄弟里行五"，005 叫"大郎"、006 叫"长子"
//   ⑥ 距离自相矛盾：全书"二十里"，006 冒出"三十里外的汤阴县衙"
//   ⑦ 夹在对话中间的法条旁白（普法课）在 005/006 回潮
//
// 【这一条是本模块存在的理由】指标闸量的是形式，逻辑与连续性它一个都抓不到。
// 而上面七类里，只有 ① 能靠关键词抓，其余全要靠"跨章比对"。所以这里做的不是更多指标，
// 是【把上一章和台账当成答案纸，拿新章去对】。
//
// 纪律：只读、只报，绝不改正文。报出来的每一条都要给出可定位的行号或原文片段——
// 报一句"疑似不一致"而不指出在哪，等于把活儿又推回给人。

import fs from 'node:fs';
import path from 'node:path';

// ── 一、套话黑名单（与书内 CLAUDE.md 的「套句黑名单」同源） ──────────────
// 不是绝对禁用，是【高频出现即 AI 味】。命中就该换成具体动作/物件/后果。
// ⚠️【两条来之不易的判据，删之前先读完】
// 一、**要卡的是密度，不是总数。** 2026-09-20 我拿全书绝对数吓过人：说《崇祯》296 章里
//    「顿了顿」37 次是"最明显的 AI 指纹"——算下来 8 章才一次，完全正常。
//    真正的病是岳飞 006 那种：一章里三处（眼底翻起寒芒 + 面色阴狠如狼 + 宛若两泓冰封的深潭）。
//    所以报告要按【每章密度】给轻重，单章 ≥2 处才是事故。
// 二、**黑名单分题材。**「闻言」在现代言情里是 AI 腔，在历史小说里是正常文言
//    （"朱慈烺闻言一愣"没有任何问题）。所以规则可以按 kind 或按词关掉，见 gate.json 的 slopOff。
const SLOP_RULES = [
  ['神态套句', /嘴角(勾起|微扬|抽搐|扯了扯)|勾唇一笑|眸(光|子)?[^。，！？]{0,6}(闪过|流转)|眼[底中][^。，！？]{0,8}(闪过|寒芒|精光|翻起)|瞳孔[一猛]缩|心中[一猛](凛|紧|沉)|后背发凉|冷汗涔涔|挑了挑眉|眼神复杂/g],
  ['转场套话', /闻言|顿了顿|不置可否|意味深长|不动声色|云淡风轻|深吸一口气|若有所思|不为人知/g],
  // 「不得不说」只有当成转场感叹时才是病（"不得不说，这手棋…"）；
  // "怕死却不得不说真话的活口"是正常句子，所以要求它后面紧跟标点。
  ['解释腔', /某种程度上|不得不说[，,。！]|值得一提的是|显而易见|总而言之|换句话说|不知为何|莫名地|一丝不易察觉|有那么一瞬间/g],
  ['万能比喻', /(仿佛|宛若|宛如|犹如)[^。！？]{0,20}(深潭|寒冰|利刃|刀子|野兽|狼|虎|鹰|雕塑|凝固|静止|安静)/g],
  ['脸谱化', /面色(阴狠|狰狞|铁青)如?[狼虎鬼]?|阴狠如狼|狞笑一声|嘿嘿一笑/g],
];

// opts.ignoreKinds：按类关（历史书通常要关「转场套话」里的文言词）
// opts.ignoreWords：按词关（只想放过「闻言」而不想放过「顿了顿」时用）
export function scanSlop(text, { ignoreKinds = [], ignoreWords = [] } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    for (const [kind, re] of SLOP_RULES) {
      if (ignoreKinds.includes(kind)) continue;
      const m = line.match(new RegExp(re.source, 'g'));
      if (m) for (const w of m) {
        if (ignoreWords.some(x => w.includes(x))) continue;
        hits.push({ kind, word: w, line: i + 1 });
      }
    }
  });
  // severity：一章里出现两处以上才算事故，单处只作提示（见本段顶部判据一）
  return { hits, count: hits.length, severity: hits.length >= 2 ? 'bad' : hits.length ? 'note' : 'ok' };
}

// ── 二、禁用词（已经出过错、绝不许再出现的写法） ───────────────────────
// 这是最便宜也最有效的一道闸：每修好一处专名/数目矛盾，就把【错的那个写法】钉进禁用表。
// 同类错误从此再也犯不了第二次。
export function scanBanned(text, banned = []) {
  const lines = String(text || '').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    for (const b of banned) {
      const word = typeof b === 'string' ? b : b.word;
      const why = typeof b === 'string' ? '' : (b.why || '');
      if (word && line.includes(word)) hits.push({ word, why, line: i + 1 });
    }
  });
  return { hits, count: hits.length };
}

// ── 三、钩子接续：上一章结尾抛出的人/物，下一章必须接住 ─────────────────
// 004 结尾："他要去的那户人家姓王。"——然后 005 里【王荣出现 0 次】，那一夜就这么没了。
// 读者一定会问"为什么不去找在场的人作证"，而这个问题不答，后面的选择就不成立。
// 做法：取上一章末尾若干字里出现的【已登记专名】，看下一章开头有没有接。
// ⚠️【必须区分"新抛出的钩子"和"一直在场的人"】第一版没区分，于是 003 被误报：
// 002 结尾是姚氏和岳和在灶间说话，003 是岳飞独自进城，这两人不出现完全正常。
// 判据：**在上一章里只露了一两次、且露在结尾**的名字，才是冲着下一章去的钩子；
// 通篇都在的常驻角色（姚氏在 002 里出现四次）只是在场，不是钩子。
// 004 的王荣正好卡在这条线上——全章 2 次、末句才点名——所以它该报、也真报出来了。
// ⚠️【第二种误报：常驻角色在结尾露了个脸】2026-09-21 008 被误报：
// 007 结尾写王荣"缩着脖子溜回村道深处"——他只是个围观的背景人物，全章出现 2 次，
// 正好卡在 maxPrevMentions 里，于是被当成抛出的钩子；而 008 场景已经在相州，
// 王荣留在永和乡不出现完全正常。
// 判据补一条：**在此前各章累计露面够多的，是常驻角色，不是新钩子**。
// 王荣从 004 起累计出现 17 次（2+2+11+2），早就不是新面孔了；
// 而 004 里第一次点他名时累计只有 2 次，那次该报、也确实报了。
export function checkHookContinuity(prevText, nextText, names = [], { tailChars = 400, headChars = 1500, maxPrevMentions = 2, history = '', maxHistoryMentions = 5 } = {}) {
  const prev = String(prevText || '');
  const tail = prev.slice(-tailChars);
  const head = String(nextText || '').slice(0, headChars);
  const full = String(nextText || '');
  const countIn = (hay, n) => hay.split(n).length - 1;
  const hist = String(history || '');
  const raised = names.filter(n => n && tail.includes(n)
    && countIn(prev, n) <= maxPrevMentions
    && countIn(hist, n) <= maxHistoryMentions);
  const dropped = raised.filter(n => !full.includes(n));        // 整章都没出现 = 真的丢了
  const late = raised.filter(n => !dropped.includes(n) && !head.includes(n)); // 出现了但拖到很后面
  return { raised, dropped, late, ok: dropped.length === 0 };
}

// ── 四、旁白解说（普法课）───────────────────────────────────────────
// 本书最忌讳、也最容易回潮的毛病：把法条整段讲给读者听。
// 005 一度有三处夹在对话中间的法条旁白，006 有一处。特征很稳定：
//   段落里法条词密集 + 没有引号（不是人物在说）+ 没有动作（不是在做事）。
const LAW_WORDS = /刑统|律法|律条|按律|依律|依制|律制|条例|格目|论处|朝廷|国法|祖宗家法|凡[^。]{0,12}者|违者/g;
const ACTION_WORDS = /[他她]\s*(把|抬|低|伸|转|站|坐|蹲|走|跑|指|摸|递|抓|按|推|拉|停|看|问|说|笑|扯|捏|夹|描|抄)/;

export function scanExposition(text, { minLen = 40, minLawHits = 2 } = {}) {
  const paras = String(text || '').split(/\r?\n/).map((s, i) => ({ s: s.trim(), line: i + 1 })).filter(p => p.s);
  const hits = [];
  for (const p of paras) {
    if (p.s.length < minLen) continue;
    if (/[「」『』“”"]/.test(p.s)) continue;              // 有人在说话 → 不是旁白
    if (ACTION_WORDS.test(p.s)) continue;                 // 有人在做事 → 不是干讲
    const law = (p.s.match(LAW_WORDS) || []).length;
    if (law >= minLawHits) hits.push({ line: p.line, law, text: p.s.slice(0, 60) });
  }
  return { hits, count: hits.length };
}

// ── 五之前：句式扎堆（说话提示语模具）─────────────────────────────
// 2026-09-20 岳飞 007：指标全绿（字数/段落/对话/省略号/套话都过），读起来却像批量生产。
// 量出来才知道病在哪——46 句对话里有 30 句套的是同一个模具：
//     「动作 + 四字神态。他/她 + X 声道：」
//     马荣从鼻子里挤出一声冷哼，满眼蔑视。他寒声道：…
//     姚氏死死护在门前，毫无惧色。她高声质问道：…
//     一名弓手用刀鞘推开老汉的肩膀。他嘴里恶狠狠骂道：…
// 对照：001–006 这个模具出现 0–1 次，占比 0%；007 占到 65%。
// 书内 CLAUDE.md 早写着「同一种句式不许扎堆」，但那是说给人听的，没人量它就守不住。
// 【为什么不能只看总数】一章里出现三五次很正常，说话总得有提示语；
// 病的是它【占掉了大部分对话】——所以判据是占比，不是次数。
const SAID_TAG = /[他她][^。！？\n]{0,8}(道|问|喝|骂|叫|答|禀|宣|说)[：:]/g;
const MOOD_TAG = /[，,](满[脸眼身][^\s。，]{1,3}|神色[^\s。，]{1,3}|语调[^\s。，]{1,3}|语气[^\s。，]{1,4}|眼中[^\s。，]{1,4})[。，]/g;

export function scanStereotype(text, { maxRatio = 0.3, maxMood = 6 } = {}) {
  const t = String(text || '');
  const said = (t.match(SAID_TAG) || []).length;
  const mood = (t.match(MOOD_TAG) || []).length;
  const dialogues = Math.round((t.match(/[“”]/g) || []).length / 2);
  const ratio = dialogues ? said / dialogues : 0;
  const problems = [];
  if (dialogues >= 8 && ratio > maxRatio) problems.push(`${dialogues} 句对话里有 ${said} 句套「他X声道：」的模具（${Math.round(ratio * 100)}%，上限 ${Math.round(maxRatio * 100)}%）`);
  if (mood > maxMood) problems.push(`四字神态后缀 ${mood} 处（满脸X／神色X／语调X，上限 ${maxMood}）`);
  return { said, mood, dialogues, ratio: +ratio.toFixed(2), problems, ok: problems.length === 0 };
}

// ── 六、节奏规整度（burstiness）──────────────────────────────────
// 2026-09-20 加。触发它的是一篇讲番茄 AI 检测的文章，里面提到平台查三层：
//   词频与句式习惯 / **段落节奏是否过于规整** / 长篇前后设定是否矛盾。
// 前后两层我们已经有闸，中间这层是个洞——而一量才发现，洞里正躺着最严重的问题：
//
//   章        段长CV   单句段%   长句(>25字)%   执笔
//   001–003   0.92–0.98  57–63%    30–36%      人
//   005–007   0.12–0.23   1–8%      9–13%      引擎
//
// 引擎写的章，段落长度几乎完全均匀、单句段绝迹、长句只有人写的三分之一——每段都是两句、
// 长短差不多，读起来是节拍器。而这些章的字数/字每段/短段占比/对话占比【全是绿的】。
// 这就是 AI 检测里说的 burstiness（突发性）：人写东西长短不均，机器写得匀。
// 书内 CLAUDE.md 早写着"每隔几段必须有一个二十五字以上的长句把节奏拉开"，
// 但那是说给人听的——没人量它就守不住。
//
// 三条判据（阈值取自人写的 001–003 与引擎写的 005–007 之间那道明显的沟）：
//   段长变异系数 ≥0.5｜**句长变异系数 ≥0.55**｜长句占比 ≥20%
//
// ⚠️【"单句成段占比"是一条错的判据，别再加回来】第一版用过它（下限 15%），
// 结果拿它去指导重排，机械地把段末短句一律拆成独立段——改出来是【逐句换行】，
// 正是 deslop.mjs 专治的那个病。指标绿了，读起来比原稿还差。
// 错在哪：人写的 001 单句成段占 63%，但那里头多是【一个三五十字的长句独立成段】，
// 不是把短句拆开。"单句段"既可能来自长句独立，也可能来自逐句换行，它分不开这两者。
// 真正把人和机器分开的是【句长的变异系数】——人写的句子有长有短（CV 0.63–0.69），
// 机器写的句句差不多长（CV 0.35–0.42）。这个量骗不过去，也不会奖励逐句换行。
const hzCount = (s) => (String(s).match(/[一-鿿]/g) || []).length;
const cvOf = (arr) => {
  if (!arr.length) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (!m) return 0;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length) / m;
};

// ⚠️【句长 CV 的下限必须随对话密度浮动】2026-09-20 实测四章，这是一条干净的负相关：
//     003 对话段  0% → 句长CV 0.69
//     006 对话段 31% → 句长CV 0.67
//     004 对话段 40% → 句长CV 0.59
//     005 对话段 52% → 句长CV 0.53
// 原因很实在：一句台词天生就是十到二十五个字，不像叙述能从三个字伸到六十个字。
// 对话越多，句长的自由度越小，CV 必然被压下来。
// 拿叙述章的尺子去量对峙戏，量出来的"不合格"是尺子的问题——这个错今天已经犯了三次
// （前两次是"对话占比 <35%"和"平均段长 ≥28"），所以这里直接把分档写进代码。
// ⚠️【每条标准都必须有上限，不能只给下限】这是今天撞了五次的同一个模式：
//   给模型"对话要够" → 它写到 46%；"平均段长 ≥28" → 它写到 84 字一段；
//   "要有单句成段" → 它逐句换行；"句长要有起伏" → 它写出 136 字的句子。
//   **给下限，它就冲天花板。** 所以 minLongSent 必须配一个 maxVeryLong。
//   基线：001–007 里 >80 字的句子共 0–1 个／章，>120 字的【一个都没有】；
//   008 一章就有 8 个 >80、5 个 >120（最长 136 字）——手机上读一句 130 字是窒息的。
export function scanRhythm(text, { minParaCV = 0.5, minSentCV = 0.55, minLongSent = 0.2, dialogueHeavy = 0.4, sentCVRelaxed = 0.5, maxVeryLong = 2, veryLongAt = 80 } = {}) {
  const t = String(text || '');
  const paras = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (paras.length < 10) return { problems: [], ok: true, paraCV: 0, sentCV: 0, longSentRatio: 0, dlgRatio: 0 };
  const paraCV = cvOf(paras.map(hzCount).filter(n => n > 0));
  const sents = t.split(/[。！？”]/).map(hzCount).filter(n => n > 1);
  const sentCV = cvOf(sents);
  const longSentRatio = sents.length ? sents.filter(n => n > 25).length / sents.length : 0;
  const dlgRatio = paras.filter(p => /[「」『』“”]/.test(p)).length / paras.length;
  const heavy = dlgRatio >= dialogueHeavy;
  const sentFloor = heavy ? sentCVRelaxed : minSentCV;

  const problems = [];
  const pct = (x) => Math.round(x * 100) + '%';
  if (paraCV < minParaCV) problems.push(`段落长度过于均匀（变异系数 ${paraCV.toFixed(2)}，下限 ${minParaCV}）——每段都差不多长，读起来像节拍器`);
  if (sentCV < sentFloor) problems.push(`句子长度过于均匀（变异系数 ${sentCV.toFixed(2)}，下限 ${sentFloor}${heavy ? '，本章对话占 ' + pct(dlgRatio) + ' 已按对话密集章放宽' : ''}）——句句一般长，这是机器写作最硬的指纹`);
  if (longSentRatio < minLongSent) problems.push(`长句太少（>25字的句子只占 ${pct(longSentRatio)}，下限 ${pct(minLongSent)}）——缺少把节奏拉开的长句`);
  const veryLong = sents.filter(n => n > veryLongAt).length;
  if (veryLong > maxVeryLong) problems.push(`句子拉得过头：${veryLong} 句超过 ${veryLongAt} 字（上限 ${maxVeryLong} 句，最长 ${Math.max(...sents)} 字）——手机上读一句上百字是窒息的`);
  return { veryLong, paraCV: +paraCV.toFixed(2), sentCV: +sentCV.toFixed(2), longSentRatio: +longSentRatio.toFixed(2), dlgRatio: +dlgRatio.toFixed(2), problems, ok: problems.length === 0 };
}

// ── 五、从台账里取【已登记专名】────────────────────────────────────
// 台账「人物现状」段里用 **粗体** 标着每个人的名字。事实卡列了谁，引擎就守住谁；
// 没列的它就自由发挥——006 把里正写成"张保"，正因为我的核对表里漏了王荣。
// 所以专名表必须【从台账自动长出来】，而不是我每次手写一份。
export function namesFromLedger(ledgerText) {
  const snap = String(ledgerText || '').split('LEDGER_HISTORY_BELOW')[0];
  const out = new Set();
  const take = (raw) => {
    const cleaned = String(raw)
      .replace(/（[^）]*）|\([^)]*\)/g, '')   // 去掉「岳和（父）」「刘协（汉献帝）」里的括注
      .replace(/\*\*/g, '')
      .replace(/[：:。.]/g, '');
    // 一条里可能并列几个人：「- 张辽、马超：各领精骑两翼」
    for (const part of cleaned.split(/[、,，\/]/)) {
      const n = part.trim();
      // 只要像名字的：2–6 字、不含空格、不是整句话
      if (n && n.length >= 2 && n.length <= 6 && !/[的了是在和与把被]/.test(n)) out.add(n);
    }
  };
  for (const m of snap.matchAll(/\*\*([^*]{1,12})\*\*/g)) take(m[1]);

  // 【为什么还要认「- 吕布：」这种写法】2026-09-23 拿这道闸去查《重生三国，我吕布杀出一片天》，
  // 开头印的是「专名表 0 个」——113 章的书一个人名都没长出来，钩子闸整本空转。
  // 根因：上面只认粗体，而这本的台账人物现状写的是「- 吕布：以车骑将军…」，没有星号。
  // 本机十本书里有三本是这个写法（吕布 / 大乾女帝 / 重生美利坚），即三本书的钩子闸一直是哑的。
  // 只在【人物现状】那一节里认这种写法：别的节（未回收伏笔 / 欠债与承诺）条目开头是事件不是人名。
  const lines = snap.split(/\r?\n/);
  let inChars = false;
  for (const line of lines) {
    const h = /^#{2,6}\s*(.+)$/.exec(line);
    if (h) { inChars = /人物/.test(h[1]); continue; }
    if (!inChars) continue;
    const item = /^\s*[-*+]\s*(.+?)[：:]/.exec(line);
    if (item) take(item[1]);
  }
  return [...out];
}

// ── 汇总：跑一章的全部闸 ────────────────────────────────────────────
// ⚠️【钩子闸只适合单线叙事，多线书要关掉】
// 实测：岳飞新书前期是单线（一个案子一路查下去），它准确抓到了 004→005 那一夜的断裂；
// 而《崇祯》是多线（朱由检、李若琏、白缨几条线交替推进），上一章结尾提到崔安、
// 下一章切到另一条线，是正常手法不是断裂——它在那本书上报了 21 章，几乎全是误报。
// 所以多线书在 gate.json 里设 hookOff:true。
// ── 语域闸（口语度）──────────────────────────────────────────────
//
// 这一道是【实测数据逼出来的】，不是我拍脑袋加的。2026-09-23 拿《岳飞》卷01 的样本
// 去腾讯朱雀 AI 检测跑了一组对照，结果是：
//
//   版本                        人类率   口语/千字  均句长  句长CV
//   001 原版（书面文学腔）        0%        0       25.9   0.633
//   006（agy 写的）              0%        1.3     19.4   0.767
//   001 只换词（句读段落全不动）  33.79%    19.3     26.2   0.634
//   001 全面重写                 75.11%    27.5     20.7   0.797
//
// 三条结论，每一条都推翻了我们之前的假设：
//
//  ① **句长CV 不是主因。** 006 的 CV 是 0.767，比原版 001 的 0.633 还高、直逼重写版，
//     可它是最差的样本（0% 人类率，57% 被判定为 AI）。下面那道 scanRhythm 量的东西
//     在 AI 味这件事上【基本无效】——它能治"读起来单调"，治不了"像机器写的"。
//  ② **真正的变量是口语密度。** 口语标记低于 5/千字的样本，人类率一律是 0。
//     只把词换成口语（一个字的句读都没动），人类率就从 0 跳到 33.79%。
//  ③ **光换词不够。** 只换词那版均句长仍是 26.2、CV 仍是 0.634，只拿到"弱人类创作"。
//     再把句子放短、把结构放松、允许写几句没有信息功能的闲话，才到 75.11%"强人类创作"。
//
// 所以这道闸量两样：口语标记密度 + 均句长。两样都不达标才叫失守。
//
// ⚠️ 这不是"写差一点去骗检测器"。那句被加进去的闲话——「他娘天不亮烙的，烙糊了一块，
// 他没说」——没有情节功能，却让人物立起来了（他知道娘辛苦，所以不说）。
// 我们之前那个"每一句都在做功"的精准文学腔，既是 AI 指纹，也是番茄读者的门槛。

// 北方官话口语/语气标记。本书背景是相州汤阴（豫北，近河北），用这一路的词。
// 换书换背景时【连这张表一起换】——吴语背景的书堆北方词，是另一种假。
export const ORAL_MARKERS = [
  '上头', '里头', '后头', '外头', '自个儿', '俩', '仨', '打哪', '末了', '家什',
  '囫囵', '出溜', '杵着', '瞧', '搁', '头一个', '一溜', '没准', '味儿', '这地方',
  '就算完', '不作数', '啥', '咋', '那就是说', '这就是说', '挺[久好多大远]',
  '跟[^，。！？]{1,8}似的', '[^一-鿿]呢。', '了吧',
];

export function scanRegister(text, { minPerK = 20, maxMeanSent = 22 } = {}) {
  const t = String(text || '');
  const chars = (t.match(/[一-鿿]/g) || []).length || 1;
  let hits = 0;
  const found = [];
  for (const w of ORAL_MARKERS) {
    const m = t.match(new RegExp(w, 'g'));
    if (m) { hits += m.length; found.push(w.replace(/\[\^[^\]]+\][^ ]*/, '…') + '×' + m.length); }
  }
  const perK = +(hits / chars * 1000).toFixed(1);
  const sents = t.split(/[。！？…\n]+/).map(x => x.trim()).filter(Boolean);
  const meanSent = sents.length ? +(sents.reduce((a, b) => a + b.length, 0) / sents.length).toFixed(1) : 0;
  const problems = [];
  // 低于 5/千字的，实测人类率一律是 0——这条是硬伤，不是提醒
  if (perK < 5) problems.push(`口语标记只有 ${perK}/千字（实测低于 5 的样本人类率一律为 0，整章是书面腔）`);
  else if (perK < minPerK) problems.push(`口语标记 ${perK}/千字，低于 ${minPerK}（只换词那版 19.3 也才拿到"弱人类创作"）`);
  if (meanSent > maxMeanSent) problems.push(`均句长 ${meanSent} 字，超过 ${maxMeanSent}（句子太长是书面腔的另一半）`);
  return { perK, hits, meanSent, found: found.slice(0, 20), problems, ok: problems.length === 0 };
}

export function gateChapter({ text, prevText = '', history = '', names = [], banned = [], slopOff = {}, expoOff = false, hookOff = false, stereoOff = false, rhythmOff = false, registerOff = false } = {}) {
  const slop = scanSlop(text, slopOff);
  const stereo = stereoOff ? { problems: [], ok: true, said: 0, mood: 0, dialogues: 0, ratio: 0 } : scanStereotype(text);
  const rhythm = rhythmOff ? { problems: [], ok: true, paraCV: 0, longSentRatio: 0, oneSentRatio: 0 } : scanRhythm(text);
  const register = registerOff ? { problems: [], ok: true, perK: 0, meanSent: 0, hits: 0, found: [] } : scanRegister(text);
  const ban = scanBanned(text, banned);
  const expo = expoOff ? { hits: [], count: 0 } : scanExposition(text);
  const hook = (prevText && !hookOff) ? checkHookContinuity(prevText, text, names, { history }) : { raised: [], dropped: [], late: [], ok: true };
  // problems = 必须改的；notes = 看一眼就行的（单处套话属于此类，见 scanSlop 顶部判据一）
  const problems = [], notes = [];
  if (ban.count) problems.push(`禁用词 ${ban.count} 处`);
  if (slop.severity === 'bad') problems.push(`套话 ${slop.count} 处`);
  else if (slop.count) notes.push(`套话 ${slop.count} 处`);
  if (!hook.ok) problems.push(`上一章抛出的「${hook.dropped.join('、')}」这一章没接`);
  if (expo.count) problems.push(`疑似普法旁白 ${expo.count} 段`);
  for (const p of stereo.problems) problems.push(p);
  for (const p of rhythm.problems) problems.push(p);
  for (const p of register.problems) problems.push(p);
  return { slop, banned: ban, exposition: expo, hook, stereo, rhythm, register, ok: problems.length === 0, problems, notes };
}

// ── 跨章专名一致性：同一个角色有没有被写成两个名字 ──────────────────────
// 靠的是【别名对】配置：把"应该是同一个人/同一个数"的两种写法配成一对，
// 只要两边在全书里都出现过，就是矛盾。比死记硬背一张名单可靠。
export function checkAliases(chapterTexts = [], aliasPairs = []) {
  const all = chapterTexts.join('\n');
  const conflicts = [];
  for (const [a, b, why] of aliasPairs) {
    const inA = all.includes(a), inB = all.includes(b);
    if (inA && inB) {
      const where = (w) => chapterTexts.map((t, i) => (t.includes(w) ? i + 1 : 0)).filter(Boolean);
      conflicts.push({ a, b, why: why || '', aAt: where(a), bAt: where(b) });
    }
  }
  return { conflicts, ok: conflicts.length === 0 };
}

// ── 读一本书卷目录下的所有章节 ──────────────────────────────────────
export function loadVolumeChapters(bookDir, vol) {
  const dir = path.join(bookDir, 'chapters', vol);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d+.*\.txt$/i.test(f)).sort(); } catch { return []; }
  return files.map(f => ({
    file: f,
    num: parseInt(f, 10),
    text: (() => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })(),
  }));
}
