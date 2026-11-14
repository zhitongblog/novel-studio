// 番茄小说流量分析与诊断引擎（只读采集 + 渠道拆解 + 章节流失毒点定位 + 收益汇总 + 智能诊断）
//
// 核心能力：
//   1. 全账号作品流量大盘（fetchAllBooksTraffic）：
//      - 一次性拉取账号下全部作品（/api/author/stats/book_list/v0/）
//      - 批量并发拉取每本书的核心流量指标（/api/author/stats/book_common_v1/v0/）：
//        昨日阅读UV、14日在读人数、单日加书架、读完率、追读率、评分、官方流量解读
//      - 可选拉取活跃作品的昨日收益与累计稿费（/main/writer/profit React Fiber 极速切书）
//      - 自动与本地书架书目（books.mjs）关联，落盘 ~/.novel-studio/traffic-latest.json
//   2. 单书深度流量与留存诊断（fetchBookTrafficDetail）：
//      - 7/14/30天每日趋势（阅读UV、在读人数、评分、评论、加书架、催更、追更）
//      - 6大流量渠道构成（书城推荐、分类、书架、继续阅读、搜索、其他）及占比分析
//      - 章节级留存率与流失率曲线（/api/author/stats/chapter_list_v1/v0/ stats_type=3）：
//        精准定位「黄金前三章留存」「前30章留存」与「全书流失率最高的 Top 10 毒点章节」
//      - 章节级互动热度（stats_type=5,6,7）：定位段评/章评/催更最高的 Top 10 爆点章节
//      - 单书每日收益与累计收益明细
//      - 自动生成结构化诊断报告并落盘 books/<slug>/.studio/traffic.json 与 reviews/流量诊断报告.md

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { listBooksWithStats, getBook } from './books.mjs';
import { UnzooClient, listProfiles } from './fanqie.mjs';

const TRAFFIC_LATEST_FILE = path.join(CONFIG_DIR, 'traffic-latest.json');
const TRAFFIC_HISTORY_FILE = path.join(CONFIG_DIR, 'traffic-history.json');

export function readCachedTrafficOverview() {
  try {
    if (!fs.existsSync(TRAFFIC_LATEST_FILE)) return null;
    return JSON.parse(fs.readFileSync(TRAFFIC_LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function readCachedBookTraffic(bookOrSlug) {
  const book = typeof bookOrSlug === 'string' ? getBook(bookOrSlug) : bookOrSlug;
  if (!book?.dir) return null;
  try {
    const fp = path.join(book.dir, '.studio', 'traffic.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

// 自动选择可用番茄 Profile：优先传入的 profilePath → 已打开番茄的 profile → 书架上配得最多的 profile
export async function resolveFanqieProfile(preferredProfile = '') {
  if (preferredProfile && fs.existsSync(preferredProfile)) return preferredProfile;
  try {
    const profRes = await listProfiles();
    const profiles = profRes?.profiles || [];
    const withFanqie = profiles.find(p => p.fanqieTabs > 0 || p.hasFanqie);
    if (withFanqie?.path) return withFanqie.path;
  } catch {}
  const books = listBooksWithStats();
  const counts = new Map();
  for (const b of books) {
    const pp = b.publish?.profilePath;
    if (pp) counts.set(pp, (counts.get(pp) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [pp, n] of counts) {
    if (n > bestN) { best = pp; bestN = n; }
  }
  return best || 'C:\\Users\\lixd2\\AppData\\Local\\Unzoo\\User Data\\Profile_mcp-gemini';
}

// 在页面内执行异步函数并轮询结果（规避 browser_evaluate 同步返回限制，同时复用页面 bdms 签名拦截器）
async function evalAsync(client, asyncIifeCode, timeoutMs = 25000) {
  const key = '__nsTraffic_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const wrapped = `(function(){
    window[${JSON.stringify(key)}] = { status: "pending" };
    Promise.resolve().then(function(){
      return (${asyncIifeCode})();
    }).then(function(data){
      window[${JSON.stringify(key)}] = { status: "done", data: data };
    }).catch(function(err){
      window[${JSON.stringify(key)}] = { status: "error", error: String(err && err.message || err) };
    });
  })()`;
  await client.evaluate(wrapped);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await client.sleep(450);
    const poll = await client.evaluate(`(function(){
      var v = window[${JSON.stringify(key)}];
      if (!v || v.status === "pending") return "";
      delete window[${JSON.stringify(key)}];
      return JSON.stringify(v);
    })()`);
    if (poll) {
      const parsed = JSON.parse(poll);
      if (parsed.status === 'error') throw new Error(parsed.error || '页面异步调用失败');
      return parsed.data;
    }
  }
  throw new Error('番茄数据接口调用超时（' + Math.round(timeoutMs / 1000) + 's）');
}

// 确保当前标签页位于番茄作家后台（以激活同源 Cookie 与 bdms 签名）
async function ensureWriterDataPage(client) {
  await client.ensureTabId();
  const href = String(await client.evaluate('location.href') || '');
  if (!href.includes('fanqienovel.com/main/writer')) {
    await client.navigate('https://fanqienovel.com/main/writer/data');
    await client.sleep(3500);
  }
}

// 在收益页 (/main/writer/profit?tab=1) 通过 React Fiber changeBook 极速读取指定书籍列表的收益
async function fetchBooksIncomeMap(client, bookIds, onLog = () => {}) {
  const incomeMap = new Map();
  if (!bookIds.length) return incomeMap;

  onLog({ level: 'info', msg: `正在读取 ${bookIds.length} 本作品的番茄收益数据…` });
  await client.navigate('https://fanqienovel.com/main/writer/profit?tab=1');
  await client.sleep(3500);

  // 确保切在「每日收益」页签
  await client.evaluate(`(function(){
    var t = [].slice.call(document.querySelectorAll(".arco-tabs-header-title, span, div")).find(function(e){
      return (e.innerText||"").trim() === "每日收益" && e.children.length <= 1;
    });
    if (t) t.click();
  })()`);
  await client.sleep(1000);

  for (const bookId of bookIds) {
    try {
      const switched = await client.evaluate(`(function(){
        var b = document.querySelector(".daily-income button.book-select-switch") || document.querySelector("button.book-select-switch");
        if (!b) return "no-btn";
        var k = Object.keys(b).find(function(x){ return x.indexOf("__reactFiber") === 0 || x.indexOf("__reactInternalInstance") === 0; });
        if (!k) return "no-fiber";
        var cur = b[k];
        while (cur && !(cur.memoizedProps && cur.memoizedProps.changeBook)) cur = cur.return;
        if (!cur) return "no-prop";
        cur.memoizedProps.changeBook({ book_id: ${JSON.stringify(String(bookId))} });
        return "ok";
      })()`);
      if (switched !== 'ok') continue;
      await client.sleep(1100);
      const raw = await client.evaluate(`(function(){
        var box = document.querySelector(".daily-income") || document.body;
        return box ? (box.innerText || "") : "";
      })()`);
      const parsed = parseDailyIncomeDomText(raw);
      incomeMap.set(String(bookId), parsed);
    } catch {}
  }
  return incomeMap;
}

export function parseDailyIncomeDomText(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let yesterdayIncome = 0;
  let yesterdayIncr = '--';
  let totalIncome = 0;
  let totalIncr = '--';

  const yIdx = lines.indexOf('昨日番茄收益');
  if (yIdx >= 0) {
    yesterdayIncome = parseFloat(String(lines[yIdx + 1] || '0').replace(/,/g, '')) || 0;
    const biIdx = lines.indexOf('比上日', yIdx);
    if (biIdx >= 0 && biIdx <= yIdx + 4) yesterdayIncr = lines[biIdx + 1] || '--';
  }
  const tIdx = lines.indexOf('累计番茄收益');
  if (tIdx >= 0) {
    totalIncome = parseFloat(String(lines[tIdx + 1] || '0').replace(/,/g, '')) || 0;
    const biIdx = lines.indexOf('比上日', tIdx);
    if (biIdx >= 0 && biIdx <= tIdx + 4) totalIncr = lines[biIdx + 1] || '--';
  }

  // 解析每日明细行：YYYY-MM-DD \t 总计 \t 阅读收益 \t 听书收益 \t 互动收益
  const dailyRows = [];
  const rowRe = /(\d{4}-\d{2}-\d{2})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/g;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    dailyRows.push({
      date: m[1],
      total: parseFloat(m[2].replace(/,/g, '')) || 0,
      read: parseFloat(m[3].replace(/,/g, '')) || 0,
      audio: parseFloat(m[4].replace(/,/g, '')) || 0,
      interact: parseFloat(m[5].replace(/,/g, '')) || 0,
    });
  }
  const sum7d = Number(dailyRows.slice(0, 7).reduce((s, r) => s + r.total, 0).toFixed(2));
  return {
    yesterdayIncome,
    yesterdayIncr,
    totalIncome,
    totalIncr,
    sum7d,
    dailyRows,
  };
}

// 单书概要级智能诊断（用于全书架流量总览表）
export function diagnoseBookTrafficSummary(b) {
  const words = Number(b.words || 0);
  const wWan = Number((words / 10000).toFixed(1));
  const dailyUV = Number(b.dailyReaders || 0);
  const active14d = Number(b.activeReaders14d || 0);
  const compRate = parseFloat(b.completionRate || '0') || 0;
  const shelf = Number(b.shelfDaily || 0);
  const isFinished = b.status === '已完结';

  let tier = '🌱 新书蓄水期';
  let tierCode = 'seed';
  if (dailyUV >= 30 || active14d >= 200) {
    tier = '🔥 头部主力';
    tierCode = 'top';
  } else if (dailyUV >= 5 || active14d >= 20) {
    tier = '📈 爬坡推荐期';
    tierCode = 'growing';
  } else if (words >= 300000 && dailyUV < 5) {
    tier = isFinished ? '📦 完本长尾' : '⚠️ 流量停滞';
    tierCode = isFinished ? 'tail' : 'stalled';
  }

  const tags = [];
  const actions = [];

  // 书架转化率
  const shelfRate = dailyUV >= 10 ? Number(((shelf / dailyUV) * 100).toFixed(1)) : null;
  if (shelfRate !== null) {
    if (shelfRate >= 6) tags.push(`高加架率(${shelfRate}%)`);
    else if (shelfRate < 3 && dailyUV >= 20) {
      tags.push(`加架偏低(${shelfRate}%)`);
      actions.push('书架转化率低于3%，建议开启「多书名实验」测试吸睛书名与封面');
    }
  }

  // 读完率
  if (compRate >= 5) {
    tags.push(`留存佳(${compRate}%)`);
  } else if (compRate > 0 && compRate < 2 && active14d >= 20) {
    tags.push(`读完率偏低(${compRate}%)`);
    actions.push('读完率低于2%，建议点开「深度诊断」定位前30章高流失毒点章节');
  }

  // 字数节点诊断
  if (!isFinished) {
    if (words < 100000) {
      actions.push(`当前 ${wWan} 万字，优先稳定日更冲过 10 万字首秀验证线`);
    } else if (words >= 200000 && words < 500000 && dailyUV < 10) {
      actions.push(`处于 20~50 万字节点（${wWan}w），可开启「20-50万字多书名实验」撬动书城推荐池`);
    } else if (words >= 800000 && words < 1100000) {
      actions.push(`逼近百万字大关（${wWan}w），冲刺 100 万字解锁「100万字多书名实验」与完本权重池`);
    } else if (words >= 1200000 && dailyUV < 5 && active14d < 30) {
      actions.push(`已达 ${wWan} 万字且连载日UV仅 ${dailyUV}，建议评估收尾完结吃「完本长尾推荐」或改名救书`);
    }
  } else {
    if (dailyUV >= 20) {
      actions.push(`完本长尾表现稳健（日UV ${dailyUV} / 在读 ${active14d}），可开同题材续作承接老读者`);
    }
  }

  if (!actions.length) {
    actions.push(b.subIntro || b.mainIntro || '保持稳定日更节奏，持续观察推荐池放量');
  }

  return {
    tier,
    tierCode,
    shelfRate,
    tags,
    primaryAction: actions[0] || '',
    actions,
  };
}

// 抓取全账号所有书籍的流量总览
export async function fetchAllBooksTraffic({ profilePath = '', includeIncome = true, onLog = () => {} } = {}) {
  const resolvedProfile = await resolveFanqieProfile(profilePath);
  const client = new UnzooClient(resolvedProfile, onLog, 'fanqienovel.com', '番茄');
  await ensureWriterDataPage(client);

  onLog({ level: 'info', msg: '正在从番茄数据中心拉取全账号作品列表与核心流量指标…' });

  const rawBooks = await evalAsync(client, `async function(){
    var listRes = await fetch("/api/author/stats/book_list/v0/?aid=2503&app_name=muye_novel&page_count=-1&page_index=0&image_fmt_list=160x214").then(function(r){ return r.json(); });
    var books = (listRes && listRes.data && listRes.data.stats_book_list) || [];
    var results = new Array(books.length);
    var idx = 0;
    async function worker(){
      while (idx < books.length) {
        var i = idx++;
        var b = books[i];
        var cm = await fetch("/api/author/stats/book_common_v1/v0/?aid=2503&app_name=muye_novel&book_id=" + b.book_id + "&stats_type=1")
          .then(function(r){ return r.json(); })
          .catch(function(){ return null; });
        var d = (cm && cm.data) || {};
        var cover = (b.thumb_url_list && b.thumb_url_list[0] && b.thumb_url_list[0].main_url) || "";
        results[i] = {
          bookId: String(b.book_id),
          title: String(b.book_name || ""),
          words: Number(b.word_number || 0),
          status: b.creation_status === 0 ? "已完结" : "连载中",
          signed: b.authorize_type === 1,
          coverUrl: cover,
          activeReaders14d: Number(d.reader_uv_14day_cnt ?? b.read_count ?? 0),
          activeReadersIncr: String(d.reader_uv_14day_incr || "0"),
          dailyReaders: Number(d.reader_uv_daily || 0),
          dailyReadersIncr: String(d.reader_uv_daily_incr || "0"),
          shelfDaily: Number(d.shelf_cnt_daily || 0),
          shelfDailyIncr: String(d.shelf_cnt_daily_incr || "0"),
          completionRate: String(d.read_completion_rate || "0"),
          completionRateIncr: String(d.read_completion_rate_incr || "0"),
          pursueRate: String(d.pursue_read_rate || "0"),
          score: String(d.mark_score || b.mark_score || ""),
          mainIntro: String(d.main_intro || "").replace(/<[^>]+>/g, ""),
          subIntro: String(d.sub_intro || "").replace(/<[^>]+>/g, ""),
          statsColTime: d.stats_col_time ? Number(d.stats_col_time) * 1000 : null
        };
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    return results.filter(Boolean);
  }`, 35000);

  // 可选：拉取活跃书籍（dailyReaders > 0 或 activeReaders14d >= 10）的番茄收益
  let incomeMap = new Map();
  if (includeIncome) {
    const activeIds = rawBooks
      .filter(b => b.dailyReaders > 0 || b.activeReaders14d >= 10)
      .map(b => b.bookId);
    try {
      incomeMap = await fetchBooksIncomeMap(client, activeIds, onLog);
    } catch (e) {
      onLog({ level: 'warn', msg: '读取收益数据部分跳过：' + e.message });
    }
  }

  // 关联本地书架
  const localBooks = listBooksWithStats();
  const byBookId = new Map();
  const byTitle = new Map();
  for (const lb of localBooks) {
    if (lb.publish?.bookId) byBookId.set(String(lb.publish.bookId), lb);
    if (lb.title) byTitle.set(String(lb.title).trim(), lb);
    if (lb.publish?.bookName) byTitle.set(String(lb.publish.bookName).trim(), lb);
  }

  const enriched = rawBooks.map(b => {
    const local = byBookId.get(b.bookId) || byTitle.get(b.title.trim()) || null;
    const inc = incomeMap.get(b.bookId) || null;
    const item = {
      ...b,
      localSlug: local ? local.slug : null,
      localTitle: local ? local.title : null,
      localChapters: local ? (local.stats?.chapters || 0) : null,
      yesterdayIncome: inc ? inc.yesterdayIncome : null,
      totalIncome: inc ? inc.totalIncome : null,
      income7d: inc ? inc.sum7d : null,
    };
    item.diagnosis = diagnoseBookTrafficSummary(item);
    return item;
  });

  enriched.sort((a, b) =>
    (b.dailyReaders - a.dailyReaders) ||
    (b.activeReaders14d - a.activeReaders14d) ||
    ((b.totalIncome || 0) - (a.totalIncome || 0)) ||
    (b.words - a.words)
  );

  const summary = {
    totalBooks: enriched.length,
    serializingBooks: enriched.filter(b => b.status === '连载中').length,
    finishedBooks: enriched.filter(b => b.status === '已完结').length,
    totalWords: enriched.reduce((s, b) => s + (b.words || 0), 0),
    totalDailyReaders: enriched.reduce((s, b) => s + (b.dailyReaders || 0), 0),
    totalActiveReaders14d: enriched.reduce((s, b) => s + (b.activeReaders14d || 0), 0),
    totalShelfDaily: enriched.reduce((s, b) => s + (b.shelfDaily || 0), 0),
    totalYesterdayIncome: Number(enriched.reduce((s, b) => s + (b.yesterdayIncome || 0), 0).toFixed(2)),
    totalCumulativeIncome: Number(enriched.reduce((s, b) => s + (b.totalIncome || 0), 0).toFixed(2)),
    topCount: enriched.filter(b => b.diagnosis?.tierCode === 'top').length,
    growingCount: enriched.filter(b => b.diagnosis?.tierCode === 'growing').length,
    stalledCount: enriched.filter(b => b.diagnosis?.tierCode === 'stalled').length,
  };

  const payload = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    profilePath: resolvedProfile,
    summary,
    books: enriched,
  };

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TRAFFIC_LATEST_FILE, JSON.stringify(payload, null, 2), 'utf8');
    // 记录每日历史快照（按 YYYY-MM-DD 去重保留最近 60 天）
    const dayKey = payload.fetchedAt.slice(0, 10);
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(TRAFFIC_HISTORY_FILE, 'utf8')) || []; } catch {}
    hist = hist.filter(h => h.day !== dayKey);
    hist.push({
      day: dayKey,
      fetchedAt: payload.fetchedAt,
      summary,
      topBooks: enriched.slice(0, 15).map(b => ({
        bookId: b.bookId,
        title: b.title,
        dailyReaders: b.dailyReaders,
        activeReaders14d: b.activeReaders14d,
        shelfDaily: b.shelfDaily,
        completionRate: b.completionRate,
        yesterdayIncome: b.yesterdayIncome,
      })),
    });
    if (hist.length > 60) hist = hist.slice(-60);
    fs.writeFileSync(TRAFFIC_HISTORY_FILE, JSON.stringify(hist, null, 2), 'utf8');
  } catch {}

  onLog({
    level: 'act',
    msg: `✅ 全账号流量分析完成：共 ${summary.totalBooks} 本书，昨日总阅读UV ${summary.totalDailyReaders}，14日在读 ${summary.totalActiveReaders14d}，单日加书架 ${summary.totalShelfDaily}`,
  });

  return payload;
}

// 抓取单本书的深度流量、渠道构成、章节留存毒点与收益诊断
export async function fetchBookTrafficDetail({
  profilePath = '',
  bookId = '',
  slug = '',
  days = 14,
  includeIncome = true,
  onLog = () => {},
} = {}) {
  const localBook = slug ? getBook(slug) : null;
  const targetBookId = String(bookId || localBook?.publish?.bookId || '').trim();
  const preferredProfile = profilePath || localBook?.publish?.profilePath || '';
  const resolvedProfile = await resolveFanqieProfile(preferredProfile);

  if (!targetBookId) {
    throw new Error('缺少番茄 bookId（请先在发布设置中绑定番茄作品，或从全账号流量中心点击对应作品）');
  }

  const client = new UnzooClient(resolvedProfile, onLog, 'fanqienovel.com', '番茄');
  await ensureWriterDataPage(client);

  onLog({ level: 'info', msg: `正在拉取作品（bookId=${targetBookId}）的近 ${days} 天流量趋势、渠道构成与章节留存数据…` });

  const raw = await evalAsync(client, `async function(){
    var bid = ${JSON.stringify(targetBookId)};
    var nDays = ${Number(days) || 14};
    var cmRes = await fetch("/api/author/stats/book_common_v1/v0/?aid=2503&app_name=muye_novel&book_id=" + bid + "&stats_type=1").then(function(r){ return r.json(); });
    var cm = (cmRes && cmRes.data) || {};
    // 统计截止时间戳（秒）：默认取 stats_col_time，无则取昨日零点
    var endSec = Number(cm.stats_col_time) || (Math.floor(Date.now() / 86400000) * 86400 - 86400);
    var startSec = endSec - (nDays - 1) * 86400;

    var results = await Promise.all([
      fetch("/api/author/stats/book_increase_v2/v0/?aid=2503&app_name=muye_novel&book_id=" + bid + "&start_date=" + startSec + "&end_date=" + endSec + "&stats_types=1%2C3%2C4%2C19%2C2%2C17%2C14").then(function(r){ return r.json(); }).catch(function(){ return null; }),
      fetch("/api/author/stats/book_increase_v2/v0/?aid=2503&app_name=muye_novel&book_id=" + bid + "&start_date=" + startSec + "&end_date=" + endSec + "&stats_types=24%2C27%2C26%2C25%2C28%2C29").then(function(r){ return r.json(); }).catch(function(){ return null; }),
      fetch("/api/author/stats/chapter_list_v1/v0/?aid=2503&app_name=muye_novel&book_id=" + bid + "&stats_type=3&page_count=500&page_index=0&latest_count=500").then(function(r){ return r.json(); }).catch(function(){ return null; }),
      fetch("/api/author/stats/chapter_list_v1/v0/?aid=2503&app_name=muye_novel&book_id=" + bid + "&stats_type=5%2C6%2C7&page_count=100&page_index=0&latest_count=100").then(function(r){ return r.json(); }).catch(function(){ return null; })
    ]);

    return {
      common: cm,
      startSec: startSec,
      endSec: endSec,
      nDays: nDays,
      trendRaw: (results[0] && results[0].data) || {},
      sourceRaw: (results[1] && results[1].data) || {},
      chapRateRaw: (results[2] && results[2].data) || {},
      chapEngageRaw: (results[3] && results[3].data) || {}
    };
  }`, 35000);

  // 生成日期序列
  const dates = [];
  for (let i = 0; i < raw.nDays; i++) {
    const sec = raw.startSec + i * 86400;
    const d = new Date((sec + 8 * 3600) * 1000);
    dates.push(d.toISOString().slice(0, 10));
  }

  // 解析核心趋势（1:阅读人数, 3:在读人数, 4:评分, 19:评论, 2:加书架, 17:催更, 14:追更）
  const tList = raw.trendRaw?.data_list || [];
  const toNumArr = (arr) => (Array.isArray(arr) ? arr.map(v => parseFloat(v || '0') || 0) : []);
  const trendSeries = {
    dates,
    dailyReaders: toNumArr(tList[0]),
    activeReaders: toNumArr(tList[1]),
    score: toNumArr(tList[2]),
    comments: toNumArr(tList[3]),
    shelfAdds: toNumArr(tList[4]),
    urgeCount: toNumArr(tList[5]),
    followCount: toNumArr(tList[6]),
  };

  // 解析流量渠道构成（24:书城, 27:分类, 26:书架, 25:继续阅读, 28:搜索, 29:其他）
  const sList = raw.sourceRaw?.data_list || [];
  const channelDefs = [
    { key: 'bookstore', name: '书城推荐', idx: 0 },
    { key: 'category', name: '分类频道', idx: 1 },
    { key: 'bookshelf', name: '书架追读', idx: 2 },
    { key: 'continueRead', name: '继续阅读', idx: 3 },
    { key: 'search', name: '搜索流量', idx: 4 },
    { key: 'other', name: '其他来源', idx: 5 },
  ];
  const channelBreakdown = channelDefs.map(ch => {
    const series = toNumArr(sList[ch.idx]);
    const sum = series.reduce((a, b) => a + b, 0);
    const latest = series.length ? series[series.length - 1] : 0;
    return { key: ch.key, name: ch.name, sum, latest, series };
  });
  const totalChannelUV = channelBreakdown.reduce((s, c) => s + c.sum, 0);
  for (const ch of channelBreakdown) {
    ch.sharePct = totalChannelUV > 0 ? Number(((ch.sum / totalChannelUV) * 100).toFixed(1)) : 0;
  }

  // 解析章节留存率与流失毒点（stats_type=3）
  // 注意：番茄接口返回的 loss_rate 是「100 - 累计读完率」（即从第1章算起的累计总流失率），
  // 真正的「单章流失」必须用「上一章留存率 - 本章留存率」(dropPoints) 与「当章相对流失率」(relDropRate) 计算！
  const rawChapRates = raw.chapRateRaw?.chapter_stats_list || [];
  const chapRateList = rawChapRates.map((c, idx) => {
    const titleStr = String(c.title || '');
    const mNum = titleStr.match(/^第\s*(\d+)\s*章/);
    const num = mNum ? parseInt(mNum[1], 10) : (Number(c.indice ?? idx) + 1);
    const comp = c.read_completion_rate !== '' && c.read_completion_rate != null ? parseFloat(c.read_completion_rate) : null;
    const cumLoss = c.loss_rate !== '' && c.loss_rate != null ? parseFloat(c.loss_rate) : null;
    return {
      num,
      itemId: String(c.item_id || ''),
      title: titleStr,
      words: Number(c.word_number || 0),
      completionRate: comp,
      cumLossRate: cumLoss,
      dropPoints: 0,
      relDropRate: 0,
      publishTime: c.publish_time ? new Date(Number(c.publish_time) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
    };
  });

  for (let i = 0; i < chapRateList.length; i++) {
    const cur = chapRateList[i];
    const prevComp = i === 0 ? 100 : chapRateList[i - 1].completionRate;
    if (cur.completionRate != null && prevComp != null && prevComp > 0) {
      const diff = Math.max(0, prevComp - cur.completionRate);
      cur.dropPoints = Number(diff.toFixed(2));
      cur.relDropRate = prevComp >= 1 ? Number(((diff / prevComp) * 100).toFixed(1)) : 0;
    }
    // 兼容旧字段名 lossRate = 单章净流失百分点
    cur.lossRate = cur.dropPoints;
  }

  const validLossChaps = chapRateList.filter(c => c.dropPoints > 0);
  // 黄金前3章与前10章、前30章留存
  const chap3 = chapRateList.find(c => c.num === 3) || chapRateList[2];
  const chap10 = chapRateList.find(c => c.num === 10) || chapRateList[9];
  const chap30 = chapRateList.find(c => c.num === 30) || chapRateList[29];

  // 流失率最高的 Top 12 毒点章节（按单章净流失百分点 dropPoints 排序，精准抓出真正劝退读者的章节）
  const topDropoffChapters = [...validLossChaps]
    .sort((a, b) => (b.dropPoints - a.dropPoints) || (b.relDropRate - a.relDropRate))
    .slice(0, 12);

  // 解析章节互动热度（stats_type=5,6,7）
  const chapEngageList = (raw.chapEngageRaw?.chapter_stats_list || []).map((c, idx) => {
    const titleStr = String(c.title || '');
    const mNum = titleStr.match(/^第\s*(\d+)\s*章/);
    const num = mNum ? parseInt(mNum[1], 10) : (Number(c.indice ?? idx) + 1);
    const chapComments = Number(c.comment_chapter_cnt || 0);
    const paraComments = Number(c.comment_paragraph_cnt || 0);
    const urgeCnt = Number(c.reminder_cnt || 0);
    return {
      num,
      itemId: String(c.item_id || ''),
      title: titleStr,
      words: Number(c.word_number || 0),
      chapComments,
      paraComments,
      urgeCnt,
      totalEngage: chapComments + paraComments + urgeCnt,
    };
  });
  const topEngageChapters = [...chapEngageList]
    .filter(c => c.totalEngage > 0)
    .sort((a, b) => b.totalEngage - a.totalEngage)
    .slice(0, 10);

  // 可选：拉取该书收益
  let income = null;
  if (includeIncome) {
    try {
      const map = await fetchBooksIncomeMap(client, [targetBookId], onLog);
      income = map.get(targetBookId) || null;
    } catch {}
  }

  const cm = raw.common || {};
  const rawDiagTitle = String(raw.chapRateRaw?.diag_title || '');
  const isRealDiag = rawDiagTitle && !/暂不符合|暂无/.test(rawDiagTitle);
  const overview = {
    bookId: targetBookId,
    title: String(cm.book_name || localBook?.title || ''),
    dailyReaders: Number(cm.reader_uv_daily || 0),
    dailyReadersIncr: String(cm.reader_uv_daily_incr || '0'),
    activeReaders14d: Number(cm.reader_uv_14day_cnt || 0),
    activeReadersIncr: String(cm.reader_uv_14day_incr || '0'),
    shelfDaily: Number(cm.shelf_cnt_daily || 0),
    shelfDailyIncr: String(cm.shelf_cnt_daily_incr || '0'),
    completionRate: String(cm.read_completion_rate || '0'),
    completionRateIncr: String(cm.read_completion_rate_incr || '0'),
    pursueRate: String(cm.pursue_read_rate || '0'),
    score: String(cm.mark_score || ''),
    mainIntro: String(cm.main_intro || '').replace(/<[^>]+>/g, ''),
    subIntro: String(cm.sub_intro || '').replace(/<[^>]+>/g, ''),
    officialDiagTitle: isRealDiag ? rawDiagTitle : '',
    officialDiagDetail: isRealDiag ? String(raw.chapRateRaw?.diag_detail || '') : '',
    golden3Retention: chap3?.completionRate ?? null,
    chap10Retention: chap10?.completionRate ?? null,
    chap30Retention: chap30?.completionRate ?? null,
    totalChaptersTracked: Number(raw.chapRateRaw?.total_count || chapRateList.length || 0),
  };

  const diagnosis = buildDeepBookDiagnosis({
    overview,
    trendSeries,
    channelBreakdown,
    topDropoffChapters,
    topEngageChapters,
    income,
  });

  const detail = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    profilePath: resolvedProfile,
    bookId: targetBookId,
    slug: localBook?.slug || slug || null,
    overview,
    income,
    trendSeries,
    channelBreakdown,
    chapterRetention: {
      officialDiagTitle: overview.officialDiagTitle,
      officialDiagDetail: overview.officialDiagDetail,
      golden3Retention: overview.golden3Retention,
      chap10Retention: overview.chap10Retention,
      chap30Retention: overview.chap30Retention,
      topDropoffChapters,
      allChapters: chapRateList,
    },
    chapterEngagement: {
      topEngageChapters,
      recentChapters: chapEngageList.slice(-30).reverse(),
    },
    diagnosis,
  };

  // 若关联到了本地书籍，落盘到 .studio/traffic.json 并生成 reviews/流量诊断报告.md
  const matchedBook = localBook || listBooksWithStats().find(b => String(b.publish?.bookId) === targetBookId || b.title === overview.title);
  if (matchedBook?.dir) {
    try {
      const studioDir = path.join(matchedBook.dir, '.studio');
      fs.mkdirSync(studioDir, { recursive: true });
      fs.writeFileSync(path.join(studioDir, 'traffic.json'), JSON.stringify(detail, null, 2), 'utf8');
      const revDir = path.join(matchedBook.dir, 'reviews');
      fs.mkdirSync(revDir, { recursive: true });
      fs.writeFileSync(path.join(revDir, '流量诊断报告.md'), formatTrafficDiagnosisMarkdown(detail), 'utf8');
    } catch {}
  }

  onLog({
    level: 'act',
    msg: `✅ 《${overview.title}》深度流量诊断完成：日UV ${overview.dailyReaders}，在读 ${overview.activeReaders14d}，读完率 ${overview.completionRate}%，定位 ${topDropoffChapters.length} 个高流失章节`,
  });

  return detail;
}

function buildDeepBookDiagnosis({ overview, trendSeries, channelBreakdown, topDropoffChapters, topEngageChapters, income }) {
  const findings = [];
  const actions = [];

  // 1. 流量趋势与规模
  const uvArr = trendSeries.dailyReaders || [];
  const sumUV = uvArr.reduce((a, b) => a + b, 0);
  const avgUV = uvArr.length ? Number((sumUV / uvArr.length).toFixed(1)) : 0;
  const firstHalf = uvArr.slice(0, Math.floor(uvArr.length / 2));
  const secondHalf = uvArr.slice(Math.floor(uvArr.length / 2));
  const avg1 = firstHalf.length ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
  const avg2 = secondHalf.length ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
  const trendPct = avg1 > 0 ? Number((((avg2 - avg1) / avg1) * 100).toFixed(1)) : 0;

  findings.push({
    category: '流量盘面',
    level: overview.dailyReaders >= 30 ? 'good' : (overview.dailyReaders >= 5 ? 'warn' : 'bad'),
    title: `近 ${uvArr.length} 日日均阅读 UV ${avgUV}（最新单日 ${overview.dailyReaders}，14日在读 ${overview.activeReaders14d}）`,
    detail: `后半周期较前半周期变化 ${trendPct >= 0 ? '+' : ''}${trendPct}%。${overview.mainIntro ? '官方提示：' + overview.mainIntro + '。' : ''}`,
  });

  // 2. 渠道结构分析
  const bookstore = channelBreakdown.find(c => c.key === 'bookstore');
  const search = channelBreakdown.find(c => c.key === 'search');
  const bookshelf = channelBreakdown.find(c => c.key === 'bookshelf');
  if (bookstore && search) {
    const recShare = bookstore.sharePct;
    const searchShare = search.sharePct;
    const shelfShare = bookshelf ? bookshelf.sharePct : 0;
    findings.push({
      category: '流量构成',
      level: recShare >= 25 ? 'good' : (recShare >= 10 ? 'warn' : 'bad'),
      title: `书城推荐占 ${recShare}%｜书架追读占 ${shelfShare}%｜搜索占 ${searchShare}%`,
      detail: recShare < 15
        ? '书城算法推荐流占比偏低（<15%），当前流量主要靠书架老读者与被动搜索/长尾，未进入算法强推池。'
        : '书城推荐流运转正常，算法正在持续给书城曝光。',
    });
    if (recShare < 15) {
      actions.push('【撬动书城推荐池】当前书城推荐流占比仅 ' + recShare + '%，建议通过「多书名实验」更换高点击率书名+带字封面，提升书城曝光点击率（CTR）。');
    }
  }

  // 3. 黄金三章与章节流失毒点分析
  if (overview.officialDiagTitle) {
    findings.push({
      category: '官方留存预警',
      level: 'bad',
      title: overview.officialDiagTitle,
      detail: overview.officialDiagDetail || '番茄后台检测到该章节读完率出现明显断崖下滑。',
    });
    actions.push(`【修复官方点名掉点章】番茄后台点名预警「${overview.officialDiagTitle}」，请立即检查该章及前1章是否存在节奏拖沓、设定劝退或视角跳脱，并定点重写。`);
  }

  if (overview.golden3Retention != null) {
    findings.push({
      category: '开篇留存',
      level: overview.golden3Retention >= 50 ? 'good' : (overview.golden3Retention >= 35 ? 'warn' : 'bad'),
      title: `黄金第3章留存率 ${overview.golden3Retention}%` + (overview.chap10Retention != null ? `｜第10章留存率 ${overview.chap10Retention}%` : ''),
      detail: overview.golden3Retention < 45
        ? '前3章流失超过55%，读者点进来后在前三章大量弃书，开篇冲突、金手指兑现或主角立人设偏慢。'
        : '黄金前三章留存表现合格，开篇能抓人。',
    });
  }

  const earlyDrops = topDropoffChapters.filter(c => c.num <= 30).slice(0, 5);
  if (earlyDrops.length) {
    const dropStr = earlyDrops.map(c => `第${c.num}章《${c.title.replace(/^第\d+章\s*/, '')}》(流失${c.lossRate}%)`).join('、');
    findings.push({
      category: '前30章毒点',
      level: 'bad',
      title: `前30章最高流失章节：${dropStr}`,
      detail: '前30章直接决定新书期首秀与算法推荐晋级，单章流失率过高会直接拉垮整书读完率。',
    });
    actions.push(`【定点修前30章毒点】重点复核并重写前30章流失率最高的章节：${dropStr}，砍掉铺垫水词、强化章末钩子与当章爽点兑现。`);
  }

  // 4. 书架转化率与互动
  const shelfSum = (trendSeries.shelfAdds || []).reduce((a, b) => a + b, 0);
  const shelfConv = sumUV >= 20 ? Number(((shelfSum / sumUV) * 100).toFixed(1)) : null;
  if (shelfConv != null) {
    findings.push({
      category: '加书架转化',
      level: shelfConv >= 6 ? 'good' : (shelfConv >= 3 ? 'warn' : 'bad'),
      title: `近 ${uvArr.length} 日累计阅读 ${sumUV} 人 → 加书架 ${shelfSum} 人（加架转化率 ${shelfConv}%）`,
      detail: shelfConv >= 6
        ? '阅读转书架转化率极高（≥6%），说明核心受众非常吃这套题材与人设，只要扩大曝光就能起飞。'
        : '加架转化率偏低，读者点进来看了几章没点加入书架，通常是简介预期与开篇正文不符或前5章钩子不够硬。',
    });
  }

  // 5. 收益表现
  if (income && (income.totalIncome > 0 || income.yesterdayIncome > 0)) {
    findings.push({
      category: '稿费收益',
      level: income.yesterdayIncome >= 3 ? 'good' : 'warn',
      title: `昨日收益 ¥${income.yesterdayIncome.toFixed(2)}｜近7日合计 ¥${income.sum7d.toFixed(2)}｜累计收益 ¥${income.totalIncome.toFixed(2)}`,
      detail: income.dailyRows?.[0]
        ? `最新单日构成：阅读收益 ¥${income.dailyRows[0].read.toFixed(2)} + 听书收益 ¥${income.dailyRows[0].audio.toFixed(2)} + 互动收益 ¥${income.dailyRows[0].interact.toFixed(2)}`
        : '',
    });
  }

  return {
    avgDailyUV: avgUV,
    trendPct,
    shelfConvPct: shelfConv,
    findings,
    actions,
  };
}

export function formatTrafficDiagnosisMarkdown(detail) {
  const { overview, income, channelBreakdown, chapterRetention, chapterEngagement, diagnosis } = detail;
  const lines = [];
  lines.push(`# 📊 《${overview.title}》番茄流量与留存深度诊断报告`);
  lines.push(`> 采集时间：${detail.fetchedAt} ｜ 番茄 BookID：\`${detail.bookId}\`\n`);

  lines.push(`## 一、核心流量与收益盘面`);
  lines.push(`| 指标 | 当前数值 | 环比变化 | 说明 |`);
  lines.push(`| :--- | :--- | :--- | :--- |`);
  lines.push(`| **昨日阅读人数 (UV)** | **${overview.dailyReaders}** | ${overview.dailyReadersIncr}% | 近 ${detail.trendSeries.dates.length} 日日均 ${diagnosis.avgDailyUV} |`);
  lines.push(`| **14日在读人数** | **${overview.activeReaders14d}** | ${overview.activeReadersIncr}% | 平台展示在读规模 |`);
  lines.push(`| **单日加书架** | **${overview.shelfDaily}** | ${overview.shelfDailyIncr}% | 周期加架率 ${diagnosis.shelfConvPct ?? '--'}% |`);
  lines.push(`| **整体读完率** | **${overview.completionRate}%** | ${overview.completionRateIncr}% | 黄金第3章留存 ${overview.golden3Retention ?? '--'}% |`);
  lines.push(`| **作品评分** | **${overview.score || '暂无'}** | -- | 追读率 ${overview.pursueRate}% |`);
  if (income) {
    lines.push(`| **昨日番茄收益** | **¥${income.yesterdayIncome.toFixed(2)}** | ${income.yesterdayIncr} | 近7日合计 ¥${income.sum7d.toFixed(2)} |`);
    lines.push(`| **累计番茄收益** | **¥${income.totalIncome.toFixed(2)}** | ${income.totalIncr} | 历史累计稿费 |`);
  }
  lines.push('');

  lines.push(`## 二、核心诊断结论与可执行建议`);
  for (const f of diagnosis.findings) {
    const icon = f.level === 'good' ? '🟢' : (f.level === 'warn' ? '🟡' : '🔴');
    lines.push(`- ${icon} **【${f.category}】${f.title}**：${f.detail}`);
  }
  if (diagnosis.actions.length) {
    lines.push(`\n### 🛠️ 下一步优化动作`);
    diagnosis.actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  lines.push('');

  lines.push(`## 三、流量渠道构成（近 ${detail.trendSeries.dates.length} 日）`);
  lines.push(`| 渠道名称 | 周期累计读者 | 最新单日 | 占比 |`);
  lines.push(`| :--- | :--- | :--- | :--- |`);
  for (const ch of channelBreakdown) {
    lines.push(`| ${ch.name} | ${ch.sum} | ${ch.latest} | **${ch.sharePct}%** |`);
  }
  lines.push('');

  if (chapterRetention.topDropoffChapters.length) {
    lines.push(`## 四、章节流失率 Top 毒点定位（重点修文目标）`);
    if (chapterRetention.officialDiagTitle) {
      lines.push(`> ⚠️ **番茄官方预警**：**${chapterRetention.officialDiagTitle}** —— ${chapterRetention.officialDiagDetail}\n`);
    }
    lines.push(`| 排名 | 章号 | 章节标题 | 字数 | 单章净流失(百分点) | 当章相对流失率 | 剩余留存率 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    chapterRetention.topDropoffChapters.forEach((c, i) => {
      lines.push(`| #${i + 1} | 第${c.num}章 | ${c.title} | ${c.words} | **🔴 -${c.dropPoints}%** | ${c.relDropRate}% | ${c.completionRate}% |`);
    });
    lines.push('');
  }

  if (chapterEngagement.topEngageChapters.length) {
    lines.push(`## 五、读者互动最高 Top 爆点章节（高爽点范本）`);
    lines.push(`| 排名 | 章号 | 章节标题 | 段评数 | 章评数 | 催更数 | 总互动 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    chapterEngagement.topEngageChapters.forEach((c, i) => {
      lines.push(`| #${i + 1} | 第${c.num}章 | ${c.title} | ${c.paraComments} | ${c.chapComments} | ${c.urgeCnt} | **🔥 ${c.totalEngage}** |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}
