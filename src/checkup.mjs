// 一本书的【体检】：把软件已经知道、但从来没说出口的异常，主动摆到作者面前。
//
// 由来：2026-09-18 这一天里，靠人工翻查才发现的问题——
//   · 《大乾女帝贴身神探》本地写到 525 章，番茄上只到 513 章，【12 章没发出去】
//   · 同一本书【缺第 353、364 章】（章名前后是连着的，是当时写的时候跳了号）
//   · 同一本书两周前被错标成「已完本」，而完本产物三样全缺、最后一章停在悬念上
//   · 《穿成王莽后》绑的是 agy，每次点写作都会静默改用窗口模式，日志里那句解释还被清掉了
// 这些结论所需要的材料【软件全都有】：章节文件在硬盘上、publishedMax 在配置里、
// 完本产物有 finaledone 在查、模型能力有 canRunHeadless 在判。
// 缺的只是"有人把它们摆出来"。
//
// 设计原则（这一条是整个体检模块存在的理由）：
// 【每条信息都要带着它的动作】——不报"523 章"，报"写到 525 章、12 章没发 → 去发"。
// 只报事实不给出口，等于把活儿又推回给作者。
//
// 纪律：
//   · 只读，绝不改任何东西；
//   · 查不了就【说查不了】，不要猜、不要沉默（沉默会被当成"没问题"）；
//   · 每条都要有 action，指向界面上真实存在的入口。

import fs from 'node:fs';
import path from 'node:path';
import { bookStats } from './books.mjs';
import { finaleArtifacts } from './finaledone.mjs';
import { canRunHeadless, getModel } from './models.mjs';

const chapNumOf = (name) => parseInt((String(name).match(/^(\d{1,4})/) || [])[1] || '0', 10);

// 扫出全书所有章号（按文件名前缀）
function chapterNumbers(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.txt')) continue;
      const n = chapNumOf(e.name);
      if (n > 0) out.push(n);
    }
  };
  walk(path.join(dir, 'chapters'));
  return out.sort((a, b) => a - b);
}

// level: 'bad'(该立刻处理) | 'warn'(该知道) | 'info'(顺带一提)
const issue = (level, key, text, action) => ({ level, key, text, action });

export function checkupBook(book) {
  const out = [];
  if (!book?.dir) return { items: [], ok: false, unknown: '这本书没有目录，查不了' };

  let st; try { st = bookStats(book); } catch { st = null; }
  const nums = chapterNumbers(book.dir);
  const maxCh = nums.length ? nums[nums.length - 1] : 0;

  // ① 章号断档 / 重号 —— 章号是发布和续写的地基，断了后面全歪
  if (nums.length) {
    const seen = new Set();
    const dup = [];
    const miss = [];
    for (const n of nums) { if (seen.has(n)) dup.push(n); seen.add(n); }
    for (let i = 1; i <= maxCh; i++) if (!seen.has(i)) miss.push(i);
    if (miss.length) {
      const show = miss.slice(0, 8).join('、') + (miss.length > 8 ? ` 等 ${miss.length} 章` : '');
      out.push(issue('bad', 'missing-chapters',
        `缺第 ${show}——章名前后是连着的，多半是当时写的时候跳了号`,
        { label: '让它补写这几章', kind: 'cowrite' }));
    }
    if (dup.length) {
      out.push(issue('bad', 'dup-chapters',
        `第 ${[...new Set(dup)].join('、')} 章有重复——同一个章号两个文件，发布时必然发错`,
        { label: '去阅读台核对', kind: 'read' }));
    }
  }

  // ② 写了没发 —— publishedMax 是发布端记的高水位
  const pub = book.publish || {};
  if (pub.bookId && maxCh > 0) {
    const sent = Number(pub.publishedMax || 0);
    if (sent > 0 && maxCh > sent) {
      out.push(issue('warn', 'unpublished',
        `写到第 ${maxCh} 章，番茄上只到第 ${sent} 章——有 ${maxCh - sent} 章还没发出去`,
        { label: '去发布', kind: 'publish' }));
    }
  }

  // ②b 上次签约诊断留下的结论（诊断要开浏览器，体检只读它存下的摘要，不重新去番茄）
  //   · 定时乱序：王莽那本读者会从第 19 章直接跳到第 35 章
  //   · 签约被拒：离下次申请门槛还差多少字
  const sd = book.signDiag;
  if (sd) {
    const ageH = (Date.now() - Date.parse(sd.at || 0)) / 3600000;
    const stale = ageH > 72 ? `（${Math.round(ageH / 24)} 天前的诊断，可能已变化）` : '';
    if (sd.outOfOrder?.length) {
      out.push(issue('bad', 'schedule-disorder',
        `番茄上的定时发布顺序是乱的：第 ${sd.outOfOrder.slice(0, 6).join('、')}${sd.outOfOrder.length > 6 ? ' 等' : ''} 章会插到前面章节之前上线，读者实际会读到 ${(sd.readerOrder || []).slice(0, 5).join(' → ')} …${stale}`,
        { label: '看签约诊断', kind: 'signdiag' }));
    }
    if (sd.rejected && !sd.signed) {
      const gap = sd.nextApplyChars && sd.publicChars ? sd.nextApplyChars - sd.publicChars : 0;
      out.push(issue('warn', 'sign-rejected',
        `番茄签约评估被拒${sd.mustFix ? `，诊断出必改 ${sd.mustFix} 条` : ''}${gap > 0 ? `；公开字数离下次申请（${sd.nextApplyChars / 10000} 万字）还差约 ${(gap / 10000).toFixed(1)} 万字` : ''}${stale}`,
        { label: '看签约诊断', kind: 'signdiag' }));
    }
  }

  // ③ 状态与事实不符 —— 标着已完本却没有完本产物
  if (book.status === '已完本') {
    const art = finaleArtifacts(book);
    if (!art.ok) {
      out.push(issue('bad', 'fake-finale',
        `标着「已完本」，但完本产物还差：${art.missing.join('、')}——书其实没写完`,
        { label: '看完本清单', kind: 'finale' }));
    }
  }
  // 反过来：写到目标章数了却还挂着连载中，提醒一下（不是错，是到路口了）
  if (book.status !== '已完本' && book.targetChapters > 0 && maxCh >= book.targetChapters) {
    out.push(issue('info', 'reached-target',
      `已经写到目标的第 ${maxCh} 章（目标 ${book.targetChapters}）——可以考虑收尾了`,
      { label: '去完本', kind: 'finale' }));
  }

  // ④ 模型跑不了无头 —— 点「省钱模式」会被静默改道窗口模式，作者该提前知道
  if (book.model && !canRunHeadless(book.model)) {
    const m = getModel(book.model);
    if (m && m.kind !== 'web' && m.kind !== 'api') {
      out.push(issue('info', 'no-headless',
        `这本书用的是「${m.name}」，它跑不了省钱模式（凭据不落盘）——点写作会自动改用窗口模式`,
        { label: '换个模型', kind: 'settings' }));
    }
  }

  // ⑤ 番茄没绑 —— 写了不少却还没建作品，越晚越麻烦（主分类签约后不可改）
  if (!pub.bookId && maxCh >= 10) {
    out.push(issue('info', 'no-fanqie',
      `写到第 ${maxCh} 章了，还没在番茄建作品——主分类签约后不可改，早点定下来更稳`,
      { label: '去建作品', kind: 'publish' }));
  }

  // ⑥ 简介缺失 —— 番茄建书要 50–500 字，没有就卡在那一步
  const syn = String(book.synopsis || '').trim();
  if (!pub.bookId && maxCh >= 10 && syn.length < 50) {
    out.push(issue('info', 'no-synopsis',
      syn ? `简介只有 ${syn.length} 字，番茄要求 50–500 字` : '还没写简介——番茄建作品要 50–500 字',
      { label: '去写简介', kind: 'synopsis' }));
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return {
    items: out,
    ok: out.every(i => i.level === 'info'),
    counts: {
      bad: out.filter(i => i.level === 'bad').length,
      warn: out.filter(i => i.level === 'warn').length,
      info: out.filter(i => i.level === 'info').length,
    },
    maxChapter: maxCh,
    chapters: st?.chapters ?? nums.length,
  };
}
