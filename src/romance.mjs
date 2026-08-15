// 感情线预设：建书时选一档，规则注入该书的写作规范（AGENTS.md 等），让 AI 照此拿捏分寸。
//
// 为什么要做成选项：感情线是网文的核心留存手段之一，但「写多浓」因书而异——权谋悬疑可以不写，
// 都市重生不写就等于丢了一半读者。以前全靠每本书临时在指令里交代，交代过就忘：《重生94》
// 053–118 那 66 章里何艳出现 95 次，却一次真正的心动都没有——写规范里没有这一条，AI 就把
// 感情线写成了背景板。
//
// 【贯穿所有档位的红线，不随档位放宽】——写进每一档的 rules 里，不给模型自由裁量：
//   1. 未成年角色（不满 18 岁）一律只到「少年心动」：距离、觉察、未完成的动作、物件寄情。
//      不写身体、不写亲密行为。这是法律红线，不是平台尺度问题。
//   2. 任何档位都不写露骨性行为、生殖器官、性过程。平台零容忍，封书代价远大于那点刺激。
//   3. 不写强迫、交易、师生等权力不对等关系里的亲密戏。
// 越线的代价是整本书下架，攒下的追读一夜归零——这条要让模型自己知道。

export const ROMANCE_LEVELS = [
  {
    id: 'none', name: '不写感情线', short: '纯事业/权谋/悬疑，感情只作背景一句带过',
    rules: '本书不铺感情线。异性角色按功能人物写（对手、伙伴、上级、客户），不给暧昧笔墨、不写心动、不设三角。'
      + '涉及婚恋只作背景交代（「他媳妇」「他家那口子」），一句带过，不展开。',
  },
  {
    id: 'light', name: '淡（点到为止）', short: '有感情线但克制，几十章推进一小步',
    rules: '感情线存在但克制：几十章推进一小步，靠一两个细节维持（一句话、一个物件、一次并肩），'
      + '不设三角、不写吃醋、不做感情高潮。异性角色首先是有自己欲望的人，其次才是感情对象。',
  },
  {
    id: 'warm', name: '暧昧（推荐）', short: '张力足、暧昧感强，靠留白与物件承载，不写身体',
    rules: '感情线是本书的主要留存手段之一，要**有张力、有暧昧、有让读者追更的牵挂**，但一律走「留白」路线：\n'
      + '  · **写距离不写身体**：两人之间从三步到一步、谁先退开、坐后座时手扶哪儿——距离的变化就是关系的变化。\n'
      + '  · **未完成的动作**：手伸出去又收回、话说一半咽回去、想碰没碰。读者补完的永远比写出来的浓。\n'
      + '  · **让第三个人点破**：当事人越沉默越有张力，暧昧靠旁人的嘴放大（有人看见了、传开了、起哄了）。\n'
      + '  · **用物件承载**：一条毛巾、三张纸条、一辆借出去的车——物件在谁手里、放在哪儿，就是关系走到哪儿。\n'
      + '  · **写觉察不写身材**：他注意到她手腕上那道红印、今天换了白短袖——「注意到」本身就是心动，不许往下描摹身体。\n'
      + '  · **三角与吃醋**：新异性出场时给旧的一个反应（一个动作、一句反常的话），但不点破。\n'
      + '每 3–5 章至少一次可感的关系推进或暧昧节拍，**绝不能几十章只有功能性对话**。',
  },
  {
    id: 'bold', name: '浓 · 色而不淫（成年角色）', short: '亲吻/亲密该有就有，写感官不写器官，写张力不写过程',
    rules: '感情戏是本书主线之一，篇幅和分量要给足。**标准是「色而不淫」——不是回避，是写而不露**：\n'
      + '  · **仅限成年角色**。角色未成年时一律按「暧昧」档写，成年之后再放开。这条没有例外。\n'
      + '  · **该发生的要发生**：接吻、拥抱、共处一夜都可以写、可以点明。恋爱写得不亲不碰，人物是假的，读者也不信。\n'
      + '  · **写感官，不写器官**：呼吸乱了半拍、颈侧的温度、指尖停在纽扣上的那一下犹豫、衣料摩擦的声响、'
      + '她头发上的皂角味。这些比任何直白描写都更有情欲张力，而且过审。**绝不出现身体部位的名称与动作过程。**\n'
      + '  · **写克制的瞬间**：想碰没碰、碰了又收回、话说到一半被打断。情欲的张力全在"差一点"上，'
      + '一旦写全了，反而没了。\n'
      + '  · **写事后，不写事中**：真到了那一步，用一个转场（雨声、灯灭、翻倒的搪瓷缸）过去，'
      + '力气花在次日清晨的一个细节上——谁先醒的、谁没敢看谁、一件被叠好的衣服。事后一句顶事中一千字。\n'
      + '  · **情绪重量优先**：读者该记住的是"他们之间从此不一样了"，不是"发生了什么"。\n'
      + '  · 底线仍在：不写露骨过程、不写生理细节、不用情色化的比喻（把身体比作食物/器物那类）。'
      + '越线的代价是整本书下架——写到八分收手，是本事，不是怯懦。',
  },
];

export const DEFAULT_ROMANCE = 'warm';

export function getRomance(id) {
  return ROMANCE_LEVELS.find(r => r.id === id) || null;
}

// 解析建书/设置传入的值 → 自包含对象（存进 book.romance）。未知值回落到推荐档。
export function resolveRomance(input) {
  if (input === null || input === undefined || input === '') return null;
  const pick = (r) => ({ id: r.id, name: r.name, short: r.short, rules: r.rules });
  if (typeof input === 'string') { const r = getRomance(input); return r ? pick(r) : null; }
  if (input.rules) return { id: input.id || 'custom', name: input.name || '自定义', short: input.short || '', rules: input.rules };
  if (input.id) { const r = getRomance(input.id); return r ? pick(r) : null; }   // 前端常传 {id}，别漏
  return null;
}

// 生成注入写作规范的那一节。三种入参都认：'warm' / {id:'warm'} / 完整对象（含 rules）。
// 老书没存过 romance → 回落到推荐档，保证任何书都有明确的感情线口径，不留给模型自由裁量。
export function romanceVoice(romance) {
  let r = null;
  if (typeof romance === 'string') r = getRomance(romance);
  else if (romance && romance.rules) r = romance;
  else if (romance && romance.id) r = getRomance(romance.id);
  if (!r) r = getRomance(DEFAULT_ROMANCE);
  return r ? { name: r.name, rules: r.rules } : null;
}

// 红线段落：所有档位共用，永远注入（连 none 档也注入——防止模型自作主张加戏越线）。
export const ROMANCE_REDLINE = [
  '**感情线红线（任何档位都不放宽，越线整本书会被下架）**：',
  '- **未成年角色（不满 18 岁）一律只到「少年心动」**：距离、觉察、未完成的动作、物件寄情；不写身体、不写亲密行为。这是法律红线，不是平台尺度。',
  '- 任何档位都**不写露骨性行为、生殖器官、性过程**；需要交代时用场景转换或次日的细节带过。',
  '- 不写强迫、交易、以及师生/上下级这类权力不对等关系里的亲密戏。',
  '- 简介与书名同样受此约束：**物化异性的招徕语（「随便挑选」「无数美女」这类）比正文更容易触发审核**，因为它挂在书封页上。',
].join('\n');

// 单章级覆盖：写这一章时临时指定尺度，不改全书档位。
// 为什么要单章可选：全书档位定的是基调，但具体到某一章——初吻、独处的那一夜、久别重逢——
// 分寸是要临场拿捏的。作者的话：「恋爱不可能不做爱，不亲亲，色而不淫才是我们要达到的水准」。
// 返回可直接拼进写作指令的一段；bookRomance 是该书的基线档位，chapterRomance 是本章的临时档位。
export function chapterRomanceSection(bookRomance, chapterRomance) {
  const base = romanceVoice(bookRomance);
  const one = chapterRomance ? romanceVoice(chapterRomance) : null;
  const lines = [];
  if (one && base && one.name !== base.name) {
    lines.push(`【本章感情线尺度：${one.name}】（本书基线是「${base.name}」，这一章按下面这档写）`);
    lines.push(one.rules);
  } else if (base) {
    lines.push(`【感情线尺度：${base.name}】`);
    lines.push(base.rules);
  }
  lines.push('');
  lines.push(ROMANCE_REDLINE);
  return lines.join('\n');
}
