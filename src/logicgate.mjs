// 全文逻辑自检闸：让「每写若干章体检一次全书逻辑」这件事真的发生。
//
// 【它本来就存在，只是几乎从没跑过】autopilot 有 fullCheckEvery（默认每 5 次续写插一次
// 全文逻辑自检），规范里也写了该怎么做、结果写进 reviews/全文逻辑自检-至NNN.md。
// 可判据是 `this.continueCount % fullCheckEvery === 0`，而 continueCount 在
// Autopilot 的构造函数里初始化为 0——【每次会话重开就归零】。
//
// 会话重开有多频繁？2026-09-25 一晚上就重启了 6 次应用，每次写三章就停/换模型。
// 实测后果：《重生三国，我吕布杀出一片天》152 章，reviews/ 里
// 【只有一份】全文逻辑自检报告（至 134 章），按每 5 批本该有十来份。
//
// 代价可量：全书阅读复核挑出 264 条逻辑问题，127/152 章中招（84%），
// 其中 77 条是明确的跨章矛盾——兵力数字对不上、没挨打的人身上有伤、
// 密信内容自己变了、部队从陈仓瞬移到长安。
//
// 【修法：把计数挂到书上】书目录里本来就有现成的锚——上一份报告文件名里的章号。
// 判据换成「当前最高章号 − 上次自检时的章号 ≥ N」，重启多少次都不影响。
//
// 这是同一个病灶今晚的第五次发作：机制存在，但够不到实际的写作。
// 前四次分别是——节奏闸只挂在无状态模式、口语表闸换了模型没换、
// 长句天花板只在闸里没进规范、禁用词只声明一次没进自检清单。

import fs from 'node:fs';
import path from 'node:path';

// 读 reviews/ 里最近一次全文逻辑自检覆盖到第几章。没跑过返回 0。
export function lastFullCheckChapter(bookDir) {
  let files = [];
  try { files = fs.readdirSync(path.join(bookDir, 'reviews')); } catch { return 0; }
  let max = 0;
  for (const f of files) {
    const m = /^全文逻辑自检-至(\d+)\.md$/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// 已经发过一次自检指令、但作者还没落报告时，别每批都再发一遍。
// key: bookDir → 上次【发出指令】时的最高章号
const sentAt = new Map();

export function resetFullCheckSent(bookDir) { sentAt.delete(bookDir); }

// 该不该插一次全文逻辑自检？
//   everyChapters：隔多少章查一次。默认 15 —— 对齐旧的「每 5 批 × 每批 3 章」。
// 返回 { due, since, last }，due=true 表示这一拍应当把自检指令顶替掉「继续」。
export function fullCheckDue(bookDir, maxChapter, { everyChapters = 15 } = {}) {
  const now = Number(maxChapter) || 0;
  if (!bookDir || now <= 0) return { due: false, since: 0, last: 0 };
  const last = lastFullCheckChapter(bookDir);
  const since = now - last;
  if (since < everyChapters) { sentAt.delete(bookDir); return { due: false, since, last }; }
  // 【防重复发】作者可能没落报告（那样 last 不动），若每批都重发，
  // 写作就会卡在自检上不往下走。所以同一批进度只发一次，等写出新章再说。
  const prevSent = sentAt.get(bookDir) || 0;
  if (now <= prevSent) return { due: false, since, last, alreadySent: true };
  sentAt.set(bookDir, now);
  return { due: true, since, last };
}
