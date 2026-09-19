// 「签约诊断」：书在番茄签约被拒 / 准备申请签约时，查清楚【编辑看到了什么、哪里不行、该改什么】。
//
// 由来（2026-09-19）：《穿成王莽后，我脑中有颗星球》第二次签约被拒——
//   申请提交成功 → 安全审核通过 → 签约评估拒绝「作品质量暂未达到签约标准」，
//   下一次机会在 8 万字。拒信是模板话，不说具体哪里不行。
// 作者问「看需要做哪些修改」「然后把你的处理机制变成一个完整的功能」。
//
// 这套机制分四块，每块都只报事实 + 给出口（同 checkup 的纪律）：
//   ① 番茄那边的签约进度：申请/安全审核/签约评估各一步的结果与时间，下次什么时候能再申请
//   ② 编辑看到的是哪几章：签约评估只看【已发布】的章节，待发布的不算
//   ③ 客观指标：段落长度、对话占比、章字数、省略号——不靠模型感觉，能量出来的先量
//   ④ 编辑视角的评估：让审稿模型按番茄签约的标准读已发布章节，给出【带章号】的修改清单
// 另外把【定时发布乱序】当成附带检查——王莽那本就是查签约时顺手发现的：
//   第 35、36 章排在明晚上线，第 20 章要等到 9/30，读者看完 19 章直接跳到 35。
//
// 纪律：全程只读。改番茄上的东西（重排定时、改书名简介）一律交给作者确认后另做。

import fs from 'node:fs';
import path from 'node:path';

// —— ③ 客观指标 ——
// 阈值出处：本项目实测的网文范本是 16.2 字/段；无范本时模型默认写到 36.1 字/段就已经
// "像记叙文"（见 voiceboot 的注释）。番茄是手机阅读，段落一长就是满屏字墙。
const PARA_OK = 30, PARA_BAD = 45;

export function chapterMetrics(file) {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const zh = (t.match(/[一-鿿]/g) || []).length;
  const paras = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const dia = (t.match(/[“「][^”」]*[”」]/g) || []).join('').length;
  return {
    chars: zh,
    paras: paras.length,
    avgPara: paras.length ? Math.round(zh / paras.length) : 0,
    dialogPct: t.length ? Math.round(dia / t.length * 100) : 0,
    ellipsis: (t.match(/……/g) || []).length,
    // 首段有没有在 200 字内给出冲突/悬念——黄金三章的第一道门
    opening: t.replace(/\s+/g, '').slice(0, 200),
  };
}

// 列出某本书的章节（num/name/file），按章号
export function listBookChapters(book) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = e.name.match(/^(\d{1,4})[_\-\s]*(.*)\.txt$/i);
      if (m) out.push({ num: parseInt(m[1], 10), name: m[2].trim(), file: p });
    }
  };
  walk(path.join(book.dir, 'chapters'));
  return out.sort((a, b) => a.num - b.num);
}

// 汇总客观指标并给出【能量出来的】结论。不下"文笔好不好"这种判断——那是模型的活。
export function objectiveFindings(chapters) {
  const rows = chapters.map(c => ({ ...c, m: chapterMetrics(c.file) })).filter(r => r.m);
  const findings = [];
  if (!rows.length) return { rows, findings };
  const avg = (k) => Math.round(rows.reduce((s, r) => s + r.m[k], 0) / rows.length);
  const avgPara = avg('avgPara');
  if (avgPara >= PARA_BAD) {
    findings.push({ level: 'bad', key: 'long-para',
      text: `平均每段 ${avgPara} 字——番茄是手机阅读，本项目实测的网文范本是 16 字/段。这个长度在手机上就是满屏字墙，读者和编辑第一眼的观感都会是"难读"`,
      fix: '拆段：一个动作、一句对白、一个转折各自成段；每段尽量不超过 3 行（手机上约 40 字）' });
  } else if (avgPara >= PARA_OK) {
    findings.push({ level: 'warn', key: 'long-para',
      text: `平均每段 ${avgPara} 字，偏长（网文范本约 16 字/段）`,
      fix: '关键冲突和对白处拆短段' });
  }
  const lowDia = rows.filter(r => r.m.dialogPct < 15);
  if (lowDia.length) {
    findings.push({ level: 'warn', key: 'low-dialog',
      text: `对话很少的章节：${lowDia.map(r => '第' + r.num + '章(' + r.m.dialogPct + '%)').join('、')}——大段叙述、没有人物交锋，节奏会显得慢`,
      fix: '把叙述里的信息改成人物对话或交锋来交代' });
  }
  const shortCh = rows.filter(r => r.m.chars < 2000);
  if (shortCh.length) {
    findings.push({ level: 'warn', key: 'short-chapter',
      text: `偏短的章节：${shortCh.map(r => '第' + r.num + '章(' + r.m.chars + '字)').join('、')}`,
      fix: '番茄单章通常 2000 字以上' });
  }
  const ell = rows.filter(r => r.m.ellipsis >= 8);
  if (ell.length) {
    findings.push({ level: 'warn', key: 'ellipsis',
      text: `省略号扎堆：${ell.map(r => '第' + r.num + '章(' + r.m.ellipsis + '处)').join('、')}——而且都在开头几章，正是编辑最先读到的地方`,
      fix: '跑一遍排版矫正（deslop），保留真正需要停顿的地方' });
  }
  return { rows, findings, avgPara, avgDialog: avg('dialogPct'), avgChars: avg('chars') };
}

// —— ④ 编辑视角的评估 prompt ——
// 喂法：前三章全文（黄金三章是签约评估最看重的），其余已发布章节抽几章截断，
// 加上客观指标和书名简介。控制在 2.5 万字左右——claude 实测 1 万字审稿约 120 秒。
export function buildSignEvalPrompt(book, published, objective) {
  const read = (c, max) => { let t = ''; try { t = fs.readFileSync(c.file, 'utf8'); } catch {} return t.length > max ? t.slice(0, max) + '\n……（截断）' : t; };
  const golden = published.slice(0, 3);
  const rest = published.slice(3);
  const pick = rest.length <= 4 ? rest : [rest[Math.floor(rest.length * 0.25)], rest[Math.floor(rest.length * 0.5)], rest[Math.floor(rest.length * 0.75)], rest[rest.length - 1]];
  const metricLines = (objective.rows || []).map(r => `第${r.num}章「${r.name}」${r.m.chars}字 均段${r.m.avgPara}字 对话${r.m.dialogPct}% 省略号${r.m.ellipsis}`).join('\n');
  return [
    '你是番茄小说的资深签约编辑。下面这本书【刚被拒签】，平台给的理由只有一句"作品质量暂未达到签约标准"。',
    `请站在签约编辑的位置，读编辑当时看到的内容（已发布的第 ${published[0]?.num}–${published[published.length - 1]?.num} 章），判断它为什么没过，以及【具体该怎么改】。`,
    '',
    `书名：《${book.title}》`,
    `分类：${book.category ? book.category.channel + ' · ' + book.category.mainCategory : '（未知）'}`,
    `简介：${book.synopsis || '（无）'}`,
    '',
    '# 客观指标（已量好，别再数一遍）',
    metricLines,
    '',
    '# 签约评估看的东西（逐条对照）',
    '1. 黄金三章：第一章前 500 字有没有抓人的冲突/悬念？主角身份和金手指（本书卖点）是否在前三章就亮出来并且让读者期待？',
    '2. 卖点兑现：书名和简介承诺的核心卖点，正文里来得够不够早、够不够足？',
    '3. 爽点密度：每 2–3 章有没有一次读者能感到的进展或胜利？还是长时间铺垫、压抑不兑现？',
    '4. 节奏：有没有慢热、背景交代过多、流水账、一件小事拖好几章？',
    '5. 手机可读性：段落长度、对话密度、信息是否好吸收（番茄读者在手机上看）。',
    '6. 人设：主角的目标、动机、性格辨识度是否清楚？读者为什么要追着他看？',
    '7. 题材匹配：这是番茄的这个分类，读者想要的爽感，正文有没有给到？有没有写成另一种书？',
    '8. 文笔：有没有 AI 味（套句、过度书面、四字词堆砌、空泛比喻）？',
    '',
    '# 输出格式（中文，直接给结论，每条一行）',
    '- [必改] 问题 → 具体怎么改（给到章号和做法）   ← 不改大概率还会被拒的',
    '- [建议] 问题 → 怎么改',
    '- [可保留] 做得好的地方（一两条即可，改稿时别改丢了）',
    '然后单独给三行：',
    '【书名建议】给 2–3 个更有番茄味的候选（保留卖点，15 字以内）',
    '【简介建议】改写一版简介（150 字左右，第一句就亮卖点）',
    '【总评】一句话：离签约最大的差距是什么',
    '',
    '# 正文：黄金三章（全文）',
    ...golden.map(c => `\n## 第${c.num}章 ${c.name}\n` + read(c, 6000)),
    '',
    '# 正文：后续抽样（截断）',
    ...pick.filter(Boolean).map(c => `\n## 第${c.num}章 ${c.name}\n` + read(c, 2200)),
  ].join('\n');
}

// 把模型的评估拆成结构化的条目，方便界面逐条展示/勾选
export function parseSignEval(text) {
  const items = [];
  let title = '', synopsis = '', verdict = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^[-*•]?\s*\[(必改|建议|可保留)\]\s*(.+)$/))) items.push({ level: m[1], text: m[2].trim() });
    else if ((m = l.match(/^【书名建议】\s*(.*)$/))) title = m[1].trim();
    else if ((m = l.match(/^【简介建议】\s*(.*)$/))) synopsis = m[1].trim();
    else if ((m = l.match(/^【总评】\s*(.*)$/))) verdict = m[1].trim();
  }
  return { items, title, synopsis, verdict };
}

// —— 定时发布乱序检测 ——
// rows: [{num, status, time}]，time 形如 "2026-09-20 22:00"。
// 乱序 = 某个待发布章节的上线时间【早于】比它章号小的另一个待发布章节。
// 读者看到的顺序是按上线时间来的，章号小的晚上线，就会跳章。
export function scheduleDisorder(rows) {
  const pend = rows.filter(r => r.status === '待发布' && r.time).map(r => ({ ...r, t: Date.parse(r.time.replace(' ', 'T')) })).filter(r => !isNaN(r.t)).sort((a, b) => a.num - b.num);
  const bad = [];
  let maxT = -Infinity, maxAt = null;
  for (const r of pend) {
    if (r.t < maxT) bad.push({ num: r.num, time: r.time, before: maxAt });
    if (r.t >= maxT) { maxT = r.t; maxAt = r.num; }
  }
  // 按上线时间排，看读者实际会读到的顺序
  const readerOrder = [...pend].sort((a, b) => (a.t - b.t) || (a.num - b.num)).map(r => r.num);
  return { outOfOrder: bad, readerOrder, pendingCount: pend.length, first: readerOrder[0] ?? null };
}

// 新一轮发布应该从哪天开始排，才不会插到已排章节前面。
//
// 根因（2026-09-19 王莽实证）：FanqiePublisher.start() 在没指定起始日期时，
// currentScheduleDay 固定设成"明天"——完全不看番茄上已经排着的待发布章节是哪天。
// 前几轮把第 20–34 章排到了 9/30、10/7；后来一轮发第 35、36、50、51 章，
// 又从"明天"开始，排到了 9/20、9/21——后写的章反而先上线，读者看完 19 章直接跳到 35。
//
// 规则：
//   · 番茄上没有待发布章节 → 不干预（沿用原逻辑：能当天发就当天发）
//   · 有待发布章节 → 新章【也必须走定时】（直接上线同样会跳到旧章前面），
//     起始日 = max(明天, 最晚那章待发布的日子, 作者指定的日子)
// 同一天同一时刻的章按创建顺序上线；本工具按章号升序发，所以同日不会乱。
export function alignScheduleStart(rows, requested, now = new Date()) {
  const toDay = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const pend = (rows || []).filter(r => r && r.status === '待发布' && toDay(r.time));
  if (!pend.length) return { date: requested || null, changed: false, reason: '番茄上没有待发布的章节，不用对齐' };
  const latest = pend.map(r => toDay(r.time)).sort().pop();
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  const tomorrow = `${tmr.getFullYear()}-${String(tmr.getMonth() + 1).padStart(2, '0')}-${String(tmr.getDate()).padStart(2, '0')}`;
  const want = toDay(requested);
  const pick = [tomorrow, latest, want].filter(Boolean).sort().pop();
  const maxPendingNum = Math.max(...pend.map(r => r.num || 0));
  return {
    date: pick,
    changed: pick !== want,
    reason: `番茄上还有 ${pend.length} 章待发布（排到第 ${maxPendingNum} 章，最晚 ${latest}）——新章从 ${pick} 起排，不能插到它们前面，否则读者会跳章`,
  };
}

// 把番茄签约管理页的文字解析成时间线
export function parseSignTimeline(pageText) {
  const t = String(pageText || '');
  const steps = [];
  const re = /(申请提交成功|安全审核通过|安全审核未通过|签约评估通过|签约评估拒绝|签约成功|待开放)\s*\n([\s\S]*?)(?=\n(?:申请提交成功|安全审核通过|安全审核未通过|签约评估通过|签约评估拒绝|签约成功|第[一二三四五六七八九十]+次签约|©)|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const body = m[2].trim();
    const time = (body.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [])[0] || '';
    steps.push({ step: m[1], time, text: body.replace(time, '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  const rejected = steps.some(s => s.step === '签约评估拒绝');
  const signed = steps.some(s => s.step === '签约成功') || /已签约/.test(t);
  // 【下次门槛要找对那一句】签约页顶部有一段通用说明
  //「作品字数达到2万字或被编辑提签后，将获得申请签约资格」——直接取第一个匹配会读成 2 万字。
  // 2026-09-19 实测就是这么错的：单测用的页面文字是截过的，不含顶部说明，所以没抓到；
  // 真跑一遍才露出来。要的是被拒后那句「当您的作品字数达到八万字，可申请第三次签约」/
  //「当作品字数达到八万字时，第三次签约入口将重新开放」——后面跟着"可申请/第N次签约/入口"的那个。
  let nextWan = '';
  const all = [...t.matchAll(/字数达到([一二三四五六七八九十\d]+)万字([^。\n]{0,24})/g)];
  const specific = all.find(m => /可申请|第[一二三四五六七八九十]+次签约|入口|重新开放/.test(m[2]));
  if (specific) nextWan = specific[1];
  else if (all.length > 1) nextWan = all[all.length - 1][1];   // 通用说明总在最前，具体门槛在后
  else if (all.length === 1 && !/或被编辑提签/.test(all[0][2])) nextWan = all[0][1];
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const next = nextWan ? (cn[nextWan] || parseInt(nextWan, 10) || 0) * 10000 : 0;
  // 数【去重后】的"第N次签约"——同一个"第三次签约"在页面里会出现好几次
  //（小标题一次、"可申请第三次签约"一次、"第三次签约入口"一次），直接计数会得出 5 次
  const attempts = new Set(t.match(/第[一二三四五六七八九十]+次签约/g) || []).size;
  return { steps, rejected, signed, nextApplyChars: next, attempts };
}
