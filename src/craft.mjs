// 叙事结构规范 —— 治「写得像记叙文」。
//
// 【为什么单独一个模块】
// 原来的 STYLE_GUARD 全是【句子层面】的约束（句长、实锚密度、别用套话）。句子层面再怎么调，
// 也治不了"像记叙文"——因为记叙文和小说的差别根本不在句子，在结构：
//
//     记叙文 = 事件按时间罗列（然后…然后…）＋ 叙述距离恒定 ＋ 场景结束时什么都没变
//     小说   = 场景单元（目标→阻碍→结果比预期更糟）＋ 距离有远近 ＋ 每个场景都有价值翻转
//
// 所以这里给的是【骨架】，不是文风。两者叠加才有用：结构决定"抓不抓人"，文风决定"读着舒不舒服"。
//
// 依据两条：
//   · 通用叙事学：Dwight Swain 的 Scene(目标-冲突-灾难) / Sequel(反应-两难-决定)；
//   · 中文网文/移动端的实际约束：黄金三章、章末钩子、3–5 章一个爽点、段落别超 5 行。
// 【已删】CHAPTER_ARCH / NARRATIVE_CAMERA / HOOK_MENU / MOBILE_READ / craftSpec /
// GOLDEN_OPENING / openingSection —— 一整套"一章该长什么样"的结构与排版规范
//（主体是 2–5 句的段落、单句成段是重锤、一章最多十来处、第一句不要从天气或回忆开场…）。
// 全部零引用且早已停用：它们规定的是审美，而审美只能来自本书的 style_refs/ 范本。
// 只保留下面两个仍被「♻️ 重排本章」这个手动工具用到的函数。

// 【改过】原来三条阈值是写死的纯文学取值（单行段 ≤35%、平均段长 ≥28、连续单行 <8）。
// 作者认可的网文样章是 76% 短段、16 字/段、连续十几段单行——会被这三条整章判废。
// 现在阈值一律从本书范本量：ref = { avgPara, tinyPct }。
// 没范本时才退回旧值，且此时只该由作者手动触发（「♻️ 重排本章」），不参与任何自动闸。
export function paragraphHealth(text, ref = null) {
  const ps = String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (ps.length < 5) return { ok: true, reason: 'too-short-to-judge' };
  const hz = (x) => (x.match(/[\u4e00-\u9fff]/g) || []).length;
  const lens = ps.map(hz);
  const total = lens.reduce((a, b) => a + b, 0);
  const tiny = lens.filter(x => x <= 10).length;
  const tinyPct = tiny / ps.length;
  const avg = total / ps.length;

  // 最长的一串"连续单行段"——机关枪感主要来自这个，比平均值更能说明问题
  let run = 0, maxRun = 0;
  for (const L of lens) { if (L <= 10) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }

  const problems = [];
  // 目标值：有范本按范本（留 1.6 倍余量，闸是拦明显跑偏的，不是拿范本卡每一章），没范本用旧默认
  const tinyLim = ref && ref.tinyPct != null ? Math.min(0.9, ref.tinyPct + 0.15) : 0.35;
  const avgLim = ref && ref.avgPara ? ref.avgPara / 1.6 : 28;
  const runLim = ref ? 999 : 8;   // 连续单行段是网文的常见手法，有范本时不判这条
  if (tinyPct > tinyLim) problems.push(`${Math.round(tinyPct * 100)}% 的段落不到 10 字（本书标准 ≤${Math.round(tinyLim * 100)}%）`);
  if (avg < avgLim) problems.push(`平均段长仅 ${avg.toFixed(0)} 字（本书标准 ≥${avgLim.toFixed(0)}）`);
  if (maxRun >= runLim) problems.push(`有连续 ${maxRun} 段都只有一行（健康值 <${runLim}）`);

  return {
    ok: problems.length === 0,
    paras: ps.length, avgLen: +avg.toFixed(1), tinyPct: +(tinyPct * 100).toFixed(0), maxRun,
    problems,
  };
}

// 打回重排的指令。只让它【合并段落】，不许改字——避免"重排"变成又写一遍、把好句子改没了。
export function reflowInstruction(h, num, title) {
  return [
    `这一章的【段落呼吸】不合格，需要重新分段。检测到：`,
    ...h.problems.map(x => '· ' + x),
    ``,
    `请把正文【重新分段】后原样输出：`,
    `1. 【向本书 style_refs/ 里范本的换行密度看齐】——范本段落多厚，这一章就多厚。`,
    `   本书没有范本时，才按通则：把连续的单行短段合并成 2–5 句的段落（同一个动作序列、同一段描写、同一个人的话与他的动作，应该在一段里）。`,
    `2. 单句成段用在转折、要害、情绪落点上——【用多少次也看范本】，不要按固定次数卡。`,
    `3. 【一个字都不要改】：不许增删改写任何文字、不许调整语序，只动换行。`,
    `4. 对话仍是一人一段，但说话人的动作神情要并进他那一段。`,
    ``,
    `输出仍用分隔符包裹：`,
    `<<<CHAPTER 章号=${num} 标题=${title}>>>`,
    `（重新分段后的完整正文）`,
    `<<<END>>>`,
  ].join('\n');
}
