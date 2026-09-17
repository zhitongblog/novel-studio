// 【落章播报】窗口模式下作者看不见任何进度——日志停在"autopilot 已启动"就再也不动，
// 而那段空白里章节其实一章章在往下掉。
//
// 2026-09-17 王莽实证：13:12 点开写，037/038/039 分别在 13:15/13:17/13:17 落盘，
// 面板却从 13:12:47 一直静到 13:20 —— 写得好好的书，被作者判定成"点了没反应"。
//
// 无状态模式每批都报「无状态写作：第 302–304 章」，窗口模式一行都没有。
// 差的不是能力，是【没人去看硬盘】：autopilot 只盯屏幕，屏幕不动它就不吭声，
// 而落章是文件系统上的事实——agy 的 agent.status 卡在 working 那种情况下，
// 屏幕判据全废，章节却照样在落。所以播报只认章号，不读屏、不碰 MCP。

// 水位涨了该说什么？没涨就返回 null（调用方据此决定发不发）。
// prev = 上次播报时的最高章号；st = bookStats() 的结果。
export function chapterProgressLine(prev, st) {
  const max = st?.maxChapter || 0;
  if (!(max > prev)) return null;
  const n = max - prev;
  const pad = (x) => String(x).padStart(3, '0');
  const tail = `全书 ${st?.chapters ?? 0} 章 / ${st?.kb ?? 0}KB`;
  return n === 1
    ? `✍ 第 ${pad(max)} 章已落盘（${tail}）`
    : `✍ 第 ${pad(prev + 1)}–${pad(max)} 章已落盘（${n} 章 · ${tail}）`;
}

// 第一次见到一本书时【只记水位、不播报】。
// 不这么做的后果：引擎一重启，看门狗头一轮就把已有的三百章当成"刚写的"刷一屏——
// 那比不播报还糟，因为它是假进度，会盖掉真正该看见的东西。
export function isFirstSight(prev) {
  return prev == null;
}
