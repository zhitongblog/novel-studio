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

// 北方官话口语/语气标记。岳飞那本背景是相州汤阴（豫北，近河北），用这一路的词。
// 换书换背景时【连这张表一起换】——吴语背景的书堆北方词，是另一种假。
export const ORAL_MARKERS = [
  // 方位·指代
  '上头', '里头', '后头', '外头', '这会儿', '那会儿', '这地方', '这号', '那号',
  // 人称·计数
  '自个儿', '俩', '仨', '统共', '拢共',
  // 动作·状态（北方官话里替代书面词的那些）
  '出溜', '杵着', '瞧', '搁', '寻思', '合计', '蔫', '攥', '拎',
  // 语气·转折
  '末了', '头一个', '一溜', '没准', '保不齐', '指不定', '横竖', '左不过',
  '偏生', '愣是', '生生', '硬是', '索性', '干脆',
  // 评价·否定
  '犯不上', '值当', '架不住', '禁不住', '不中用', '顶用', '不作数', '就算完',
  // 名物
  '家什', '囫囵', '味儿', '婆娘', '浑家', '后生', '娃子',
  // 时间
  '半晌', '老半天', '一气儿', '打哪', '赶明儿',
  // 疑问·句末
  '啥', '咋', '那就是说', '这就是说', '挺[久好多大远快慢]',
  '跟[^，。！？]{1,8}似的', '[^一-鿿]呢。', '了吧', '这么着', '那么着',
];

// 公文定式词。只用来把「引述的公文」从口语度统计里摘出去（见 scanRegister 里的公文豁免）。
// 宁可漏判也不能误判：不收「小人」「老大人」这类对白里也会出现的称谓——
// 试过一次，010 一章半数对话被误判成公文，占比冲到 32%。
// 跟口语表一样按书的背景走（见 ORAL_MARKER_SETS 里的 docFormula）。
const DOC_FORMULA_SONG = /验状|验骨|格目|尸格|供状|原供|榜文|大榜|批复|批回|抄录|骨陷|自后猛扑|坚木|依律|晓谕|钧令|申状|架阁|公条|画押|秋后处决|录问|别勘/;
// ⚠️ 汉末这张【没有跑过数据】，是照着宋代那张的思路拟的：收公文体裁名与定式词。
// 用它下结论之前先拿两三章验一遍误判率，别直接信。
const DOC_FORMULA_SANGUO = /表曰|奏曰|檄曰|诏曰|敕曰|策曰|上表|奏章|露布|符节|印绶|诏书|明诏|矫诏|军令状|军法从事|按律|有司/;

// 汉末三国口语标记（半文半白）。
//
// 【为什么非得另起一张表】2026-09-23 拿上面那张豫北表去量《重生三国，我吕布杀出一片天》，
// 113 章全判"整章书面腔"，63 章是 0/千字。数值没错，可结论没法用：
// 汉末的人不说"自个儿""啥""咋"，往三国书里堆这些词是另一种假，不是修好。
//
// 【表是怎么定的】拿 37 万字全书去探底，结果比任何理论都直白——
// 半文半白的口语骨架【整根缺失】：甚么 / 怎地 / 怎的 / 晓得 / 省得 / 寻思 / 也罢 /
// 这厮 这八个词，全书 0 次。用到的只有咱们(42) 某家(39) 后头(46)，各自 0.1/千字。
// 所以这张表收的就是这一路词：演义、水浒那种「人物嘴里说得出口」的白话，
// 而不是「尔等」「岂敢」这种写在奏章上的文言——后者这本书满篇都是，它正是病灶。
//
// 【避坑】单字词一律不收或加约束，否则书面词会被算成口语：
//   便（便宜从事）、且（况且）、某（某种）、罢（罢免）、休（休整）、莫（莫名）、
//   厮（厮杀，三国书里满篇都是）、搁（搁置）、鸟（真的鸟）。
//
// 【下面每一条带 (?<!…) 的，都是拿 37 万字全书验出来的误伤，删约束前先看例句】
//   一发   → 千钧「一发」，全是它，直接踢掉
//   端的   → 「粥是我叫端的」「好端端的」
//   似的   → 「相似的地方」
//   他娘的 → 「缩在娘的怀里」「拖他娘的兵」——是母亲不是骂人
//   攥     → 38 次全是旁白「攥紧」。一个词占掉总量三分之一，而旁白动词恰恰是
//            这道闸【不该给分】的东西：它量的是人物嘴里的口语，不是叙述腔。踢掉。
//   咱/咱们 → 不加约束会重复计数（「咱们」被数两次）
export const ORAL_MARKERS_SANGUO = [
  // 自称与称谓——口语的那一路
  '俺', '咱们', '咱(?!们)', '某家', '老子', '这厮', '那厮', '竖子', '匹夫', '鼠辈', '黄口小儿',
  // 疑问与语气
  '甚么', '作甚', '做甚', '是甚', '怎地', '怎的', '怎生', '难不成', '莫不是',
  '也罢', '罢了', '便罢', '就是了', '便是了', '不成[？?！!]', '(?<![什怎那这甚])么[？?]',
  // 否定与劝止
  '莫要', '休要', '休得', '不济', '不中用', '不打紧', '犯不着', '用不着', '值当', '省得', '免得',
  // 白话副词
  '索性', '偏生', '平白', '委实', '(?<![叫端])端的', '兀自', '好生', '生怕', '眼下', '只顾', '横竖', '当真',
  // 方位与杂词（跨时代通用口语）
  '里头', '外头', '上头', '后头', '底下', '没准', '末了', '打哪', '一溜', '这地方',
  // 动词口语
  '晓得', '寻思', '打量', '瞧', '瞅', '拾掇', '撒手', '拎',
  // 感叹与军中粗口
  '呸', '他娘的(?![兵卒军民怀手身])', '直娘贼', '撮鸟', '鸟人',
  // 结构与句尾
  '跟[^，。！？]{1,8}似的', '(?<![相类近])似的', '[^作了休罢]罢[。！]',
];

// 口语表按书背景切换。gate.json 里写 `"oralSet": "汉末三国"`，
// 或者直接写 `"oralMarkers": ["…"]` 自带一张表（自带的优先）。
//
// ⚠️【两组阈值的分量不一样，别混着读】
// 「北方官话」那组的 5 / 20 是 2026-09-23 拿四个样本去腾讯朱雀实测标定出来的（见上面那张表）。
// 「汉末三国」这组【没有实测数据】——这个题材的口语密度上限本来就低于现代白话，
// 硬套 20/千字 是逼着书往假里写。这里的 3 / 12 是暂定值，唯一依据是全书探底的分布，
// 【用它下结论之前，请先拿两三章去朱雀跑一次再把数定死】。跑之前它只配当相对指标：
// 比的是"这一章比全书中位数差多少"，不是"够不够 12"。
//
// display / examples 是【给写作模板用的】：src/skill.mjs 把它们渲进 AGENTS.md/CLAUDE.md，
// 也就是 agy/codex/claude 真正读到的规范。放在这里是为了不让两边漂开——
// 闸换了表而模型没换，这本书只会被一直判红而永远改不动。
export const ORAL_MARKER_SETS = {
  '北方官话': {
    markers: ORAL_MARKERS, hardFloor: 5, minPerK: 20, calibrated: '2026-09-23 朱雀四样本',
    docFormula: DOC_FORMULA_SONG,
    display: '', examples: [],   // 空 = 用模板里原有那一段（豫北是默认，措辞已被 register-standard 测试钉死）
  },
  '汉末三国': {
    markers: ORAL_MARKERS_SANGUO, hardFloor: 3, minPerK: 12, calibrated: false,
    docFormula: DOC_FORMULA_SANGUO,
    display: '俺、咱们、某家、这厮、那厮、竖子、匹夫、甚么、作甚、怎地、怎的、怎生、难不成、'
      + '也罢、罢了、就是了、莫要、休要、不济、不打紧、犯不着、省得、免得、索性、偏生、委实、'
      + '兀自、好生、眼下、只顾、横竖、当真、里头、外头、后头、底下、没准、末了、晓得、寻思、'
      + '打量、瞧、瞅、拾掇、撒手、拎、呸、……么？、不成？',
    examples: [
      '「你可知罪？」→「你晓得自己犯了甚么事么？」',
      '「此人不足为惧。」→「这厮不济事，怕他作甚。」',
      '「我并未见过他。」→「某家压根没见过这人。」',
      '「不必多言，依计行事。」→「莫要多说，照着办就是了。」',
    ],
  },
};
export const DEFAULT_ORAL_SET = '北方官话';

export function scanRegister(text, { minPerK, maxMeanSent = 22, hardFloor, markers, oralSet, maxShare = 0.22, maxDocRatio = 0.25 } = {}) {
  const t = String(text || '');
  const set = ORAL_MARKER_SETS[oralSet] || ORAL_MARKER_SETS[DEFAULT_ORAL_SET];
  const table = markers && markers.length ? markers : set.markers;
  const floor = hardFloor ?? set.hardFloor;
  const pass = minPerK ?? set.minPerK;
  const chars = (t.match(/[一-鿿]/g) || []).length || 1;
  let hits = 0;
  const found = [];
  const byWord = [];
  for (const w of table) {
    const m = t.match(new RegExp(w, 'g'));
    if (m) {
      hits += m.length;
      byWord.push([w, m.length]);
      found.push(w.replace(/[^[^]]+][^ ]*/, '…') + '×' + m.length);
    }
  }
  const perK = +(hits / chars * 1000).toFixed(1);
  const sents = t.split(/[。！？…\n]+/).map(x => x.trim()).filter(Boolean);
  const meanSent = sents.length ? +(sents.reduce((a, b) => a + b.length, 0) / sents.length).toFixed(1) : 0;
  byWord.sort((a, b) => b[1] - a[1]);
  const top = byWord[0] || ['', 0];
  const share = hits ? +(top[1] / hits).toFixed(3) : 0;
  // 【公文豁免】2026-09-24 加。008 公堂章全章只有 19.5，往上推就得去改一份宋代验状的措辞——那是错的。
  // 逐章量了一遍：15 章里公文占比 0%–24% 的有 14 章，只有 008 到了 34%，它的叙述部分是 23.6，本身过线。
  // 所以按「叙述口语度」判，而不是按整章。判别只认公文定式词（验状/格目/供状/榜文/骨陷…），
  // 不认「小人」「老大人」——那些对白里也有，会把半章对话误判成公文（010 试过，误判到 32%）。
  const lines = t.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const docFormula = set.docFormula || DOC_FORMULA_SONG;
  const docLines = lines.filter((x) => docFormula.test(x));
  const docChars = docLines.join('').length;
  const allChars = lines.join('').length || 1;
  const docRatio = +(docChars / allChars).toFixed(3);
  const narr = lines.filter((x) => !docFormula.test(x)).join('\n');
  const narrChars = (narr.match(/[一-鿿]/g) || []).length || 1;
  let narrHits = 0;
  for (const w of table) narrHits += (narr.match(new RegExp(w, 'g')) || []).length;
  const narrPerK = +(narrHits / narrChars * 1000).toFixed(1);

  const problems = [];
  // 未标定的表不许把话说得像实测过一样——报出来的口气也要跟着降级
  const why = set.calibrated
    ? `实测低于 ${floor} 的样本人类率一律为 0，整章是书面腔`
    : `低于暂定值 ${floor}；${oralSet || DEFAULT_ORAL_SET}表未经朱雀标定`;
  // 公文多、而剥掉公文之后叙述本身达标 → 放行（见上面那段注释）
  const docExempt = docRatio > maxDocRatio && narrPerK >= pass;
  if (perK < floor) problems.push(`口语标记只有 ${perK}/千字（${why}）`);
  else if (perK < pass && !docExempt) {
    const tail = docRatio > maxDocRatio
      ? `；本章公文占 ${Math.round(docRatio * 100)}%，剥掉公文后叙述也只有 ${narrPerK}/千字，是叙述本身不够口语`
      : '';
    const basis = set.calibrated ? '只换词那版 19.3 也才拿到"弱人类创作"' : '暂定值，未经朱雀标定';
    problems.push(`口语标记 ${perK}/千字，低于 ${pass}（${basis}）${tail}`);
  }
  if (meanSent > maxMeanSent) problems.push(`均句长 ${meanSent} 字，超过 ${maxMeanSent}（句子太长是书面腔的另一半）`);
  // 【分散度】2026-09-24 加：番茄签约被拒，责编原话「"自个儿""杵""瞧"到处出现……一看就是批量替换的痕迹」。
  // 查下来「里头」一个词占了全书口语标记的三分之一，011 一章 9.5/千字。
  // 根因是词表太窄——要顶到 20/千字只能反复用同几个词，闸自己逼出了口癖。
  // 所以密度和分散度必须一起管：单个词不得超过全部标记的 22%。
  if (hits >= 20 && share > maxShare) {
    problems.push(`「${top[0]}」一个词占了全部口语标记的 ${Math.round(share * 100)}%（${top[1]}/${hits}，上限 ${Math.round(maxShare * 100)}%）——堆同一个词是另一种机械感，换着说`);
  }
  return {
    perK, hits, meanSent, topWord: top[0], topShare: share,
    docRatio, narrPerK, docExempt,
    found: found.slice(0, 20), problems, ok: problems.length === 0,
    oralSet: oralSet || DEFAULT_ORAL_SET, calibrated: set.calibrated,
  };
}

export function gateChapter({ text, prevText = '', history = '', names = [], banned = [], slopOff = {}, expoOff = false, hookOff = false, stereoOff = false, rhythmOff = false, registerOff = false, oralSet, oralMarkers, minPerK, hardFloor, maxShare } = {}) {
  const slop = scanSlop(text, slopOff);
  const stereo = stereoOff ? { problems: [], ok: true, said: 0, mood: 0, dialogues: 0, ratio: 0 } : scanStereotype(text);
  const rhythm = rhythmOff ? { problems: [], ok: true, paraCV: 0, longSentRatio: 0, oneSentRatio: 0 } : scanRhythm(text);
  // 阈值也要透下去：gate.json 里 oralThresholds 是探底导出的（novel gate --probe-oral），
  // 只传表不传阈值，等于拿自带表配着豫北的 20/千字 用——换了表跟没换一样。
  const register = registerOff ? { problems: [], ok: true, perK: 0, meanSent: 0, hits: 0, found: [] } : scanRegister(text, { oralSet, markers: oralMarkers, minPerK, hardFloor, maxShare });
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
