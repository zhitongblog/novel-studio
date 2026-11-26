// Unzoo 全本 TXT 小说采集服务与文风语料训练库（Full-Book TXT Corpus Service）
//
// 核心职能（专抓【全本完结 TXT 电子书】，绝不是只抓几章）：
// 1. 驱动 Unzoo 浏览器访问全本 TXT 电子书下载站矩阵（奇书网 9qishu.com / 80电子书 txt808.cc / 奇书网 qisuwang.com / 新书本 xbookben.cc）
//    + 百度全网直链检索（`site:9qishu.com` / `site:txt808.cc` / `全集TXT电子书下载`）；
// 2. 自动提交站内搜索 → 进入小说详情页 → 进入下载地址页 → 提取直链 `.txt` 文件地址（如 `https://down.qishu99.cc/.../xxx.txt`）；
// 3. 流式拉取【整本完结 `.txt` 原文件】（几百万字、十几 MB 全量落盘，支持 UTF-8 / GB18030 / GBK 自动识别转码，彻底无乱码），
//    存入 `D:\PM\storybook\corpus\`；
// 4. 由作者在界面上审阅已下载的全本 TXT 小说，勾选「⭐ 选为学习对象」，
//    或点「🎯 一键让目标书学习此风格 + 提炼写作分身（StoryAlter：Soul/Brain/Body）」。

import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { APP_DIR, CONFIG_DIR } from './paths.mjs';
import { listTabs, createTab, navigate, evaluate, launchProfile } from './unzoo.mjs';
import { addRef, saveCard, CARD_PROMPT } from './voiceprint.mjs';
import { saveBookAlter, loadGlobalAlters, saveGlobalAlter, extractAlterFromSamplePrompt, parseAlterJson } from './alter.mjs';
import { runCowrite } from './cowrite.mjs';
import { resolveGenModel } from './planner.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tabId = (t) => t && (t.id || t.tab_id);

// 内置热门题材的全本 TXT 代表作种子库（优先近几年番茄巅峰榜与新派快节奏爆款全本）
export const GENRE_NOVEL_PACKS = {
  '历史权谋': ['绍宋', '大奉打更人', '宰执天下', '庆余年', '唐砖', '赘婿', '晚明', '枭臣'],
  '仙侠修真': ['道诡异仙', '大奉打更人', '沧元图', '一念永恒', '剑来', '凡人修仙传', '仙逆', '蛊真人'],
  '都市爽文': ['我在精神病院学斩神', '夜的命名术', '全球高武', '亏成首富从游戏开始', '大王饶命', '修真聊天群', '第一序列'],
  '悬疑民俗': ['我在精神病院学斩神', '道诡异仙', '神秘复苏', '我有一座冒险屋', '深夜书屋', '诡秘之主', '长夜余火'],
  '玄幻高武': ['全球高武', '万族之劫', '深空彼岸', '牧神记', '沧元图', '圣墟', '完美世界', '蛊真人'],
  '科幻末世': ['长夜余火', '第一序列', '超神机械师', '黎明之剑', '轮回乐园', '吞噬星空', '全球进化'],
};

// 全本 TXT 下载站矩阵（优先收录 2022-2026 新派爆款的 txt80.cc，其次 9qishu 与 txt808）
const FULL_TXT_SITES = [
  { name: '八零新库(txt80.cc)', home: 'https://www.txt80.cc/', searchAction: 'https://www.txt80.cc/e/search/index.php' },
  { name: '奇书网(9qishu)', home: 'https://www.9qishu.com/', searchAction: 'https://www.9qishu.com/e/search/index.php' },
  { name: '80电子书(txt808)', home: 'https://www.txt808.cc/', searchAction: 'https://www.txt808.cc/e/search/index.php' },
];

const _lastSiteSearchAt = {};

const SERVICE_STATE = {
  running: false,
  stopRequested: false,
  currentTask: '',
  completed: 0,
  total: 0,
  downloaded: [],
  logs: [],
  startedAt: null,
};

function svcLog(level, msg) {
  const entry = { t: Date.now(), time: new Date().toTimeString().slice(0, 8), level, msg };
  SERVICE_STATE.logs.push(entry);
  if (SERVICE_STATE.logs.length > 150) SERVICE_STATE.logs.shift();
}

export function getCorpusServiceStatus() {
  return {
    ...SERVICE_STATE,
    genres: Object.keys(GENRE_NOVEL_PACKS),
    genrePacks: GENRE_NOVEL_PACKS,
  };
}

export function stopCorpusService() {
  if (SERVICE_STATE.running) {
    SERVICE_STATE.stopRequested = true;
    svcLog('warn', '⏹ 已收到停止请求，当前这本全本 TXT 下载完成后即停…');
  }
  return getCorpusServiceStatus();
}

export function corpusRoot() {
  const parent = path.dirname(APP_DIR);
  const candidate = path.join(parent, 'corpus');
  try {
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch {
    const fallback = path.join(CONFIG_DIR, 'corpus');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function metaFilePath() {
  return path.join(corpusRoot(), 'corpus_index.json');
}

function safeFileName(name) {
  return String(name || '未命名小说')
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 70) || '未命名小说';
}

// 自动识别 UTF-8 / GB18030 / GBK 字节流并解码为无乱码中文文本
export function decodeBufferAuto(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

// 计算全本 TXT 的客观文风画像（针对几百万字的全本大文件，字数与章数全量统计，句长/段长抽样前中后 30 万字极速计算，防止 20MB 正则卡顿）
export function analyzeCorpusText(rawText) {
  const text = String(rawText || '');
  const totalLen = text.length;
  // 粗算全本汉字总数（抽样比例或分块统计）
  let hanzi = 0;
  if (totalLen <= 500000) {
    hanzi = (text.match(/[一-鿿]/g) || []).length;
  } else {
    const sample1 = text.slice(0, 200000);
    const ratio = ((sample1.match(/[一-鿿]/g) || []).length) / sample1.length;
    hanzi = Math.round(totalLen * ratio);
  }

  // 全本章节数统计
  const chapMatches = text.match(/(?:^|\n)\s*(?:={2,}\s*)?第\s*[0-9零一二三四五六七八九十百千万]+\s*[章节回集卷]/g);
  const chapterCount = Math.max(1, chapMatches ? chapMatches.length : Math.round(hanzi / 3200));

  // 取前中段 12 万字计算句长、段长、对话率
  const startOffset = totalLen > 200000 ? 15000 : 0;
  const sample = text.slice(startOffset, startOffset + 120000).replace(/\r\n/g, '\n');
  const sampleHz = (sample.match(/[一-鿿]/g) || []).length || 1;
  const paras = sample.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 2);
  const sents = sample.split(/[。！？…\n]+/).map(s => (s.match(/[一-鿿]/g) || []).length).filter(n => n > 1);
  const meanSent = sents.length ? +(sents.reduce((a, b) => a + b, 0) / sents.length).toFixed(1) : 0;
  const avgPara = paras.length ? +(sampleHz / paras.length).toFixed(1) : 0;
  const dlgParas = paras.filter(p => /[“”「」『』"]/.test(p)).length;
  const dlgRatio = paras.length ? +(dlgParas / paras.length).toFixed(2) : 0;
  const bangPerK = +(((sample.match(/！|!/g) || []).length / sampleHz) * 1000).toFixed(1);

  return {
    chars: hanzi,
    sizeMb: +(Buffer.byteLength(text, 'utf8') / (1024 * 1024)).toFixed(2),
    isFullBook: hanzi >= 50000,
    paras: paras.length,
    chapterCount,
    meanSent,
    avgPara,
    dlgRatio,
    bangPerK,
  };
}

// 从全本 TXT 中抽取最适合当文风范本的 2~3 段核心样章（跳过序章/第1章设定铺垫，取前中段第 3~15 章里张力最足的完整片段）
export function extractBestSamples(rawText, { count = 2, maxCharsEach = 1400 } = {}) {
  const full = String(rawText || '').replace(/\r\n/g, '\n');
  // 只在前 15 万字里切章挑选，速度快且保证是开局黄金期文风
  const text = full.slice(0, 150000).trim();
  if (!text) return [];
  const chapRegex = /(?:^|\n)\s*(?:={2,}\s*)?(第\s*[0-9零一二三四五六七八九十百千万]+\s*[章节回][^\n]{0,35})\s*(?:={2,})?\n+/g;
  const parts = [];
  let lastIdx = 0;
  let lastTitle = '开篇样段';
  let m;
  while ((m = chapRegex.exec(text)) !== null) {
    if (m.index > lastIdx + 500) {
      parts.push({ title: lastTitle, body: text.slice(lastIdx, m.index).trim() });
    }
    lastTitle = m[1].replace(/=/g, '').trim();
    lastIdx = m.index + m[0].length;
    if (parts.length >= 12) break;
  }
  if (lastIdx < text.length && parts.length < 12) {
    parts.push({ title: lastTitle, body: text.slice(lastIdx, lastIdx + 10000).trim() });
  }
  const valid = parts.filter(p => (p.body.match(/[一-鿿]/g) || []).length >= 1000);
  const pool = valid.length ? valid : [{ title: '精选正文', body: text.slice(2000, 15000) || text }];
  const picks = [];
  if (pool.length >= 5) {
    picks.push(pool[2], pool[4]); // 选第3章和第5章
  } else if (pool.length >= 3) {
    picks.push(pool[1], pool[2]);
  } else {
    picks.push(...pool.slice(0, count));
  }
  return picks.slice(0, count).map((p, idx) => ({
    title: p.title || `样段${idx + 1}`,
    text: p.body.slice(0, maxCharsEach).trim(),
  }));
}

export function listCorpusItems() {
  const root = corpusRoot();
  let metaMap = {};
  try {
    if (fs.existsSync(metaFilePath())) {
      metaMap = JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')) || {};
    }
  } catch { metaMap = {}; }

  let files = [];
  try {
    files = fs.readdirSync(root).filter(f => /\.txt$/i.test(f));
  } catch { return []; }

  const out = [];
  let dirty = false;
  for (const f of files) {
    const fp = path.join(root, f);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    let item = metaMap[f];
    if (!item || item.mtimeMs !== Math.floor(st.mtimeMs) || item.metrics?.sizeMb === undefined) {
      let raw = '';
      try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const metrics = analyzeCorpusText(raw);
      const previewSlice = raw.slice(0, 3000).replace(/\s+/g, ' ').slice(0, 220);
      item = {
        file: f,
        title: (item && item.title) || f.replace(/\.txt$/i, ''),
        author: (item && item.author) || '',
        genre: (item && item.genre) || '',
        sourceUrl: (item && item.sourceUrl) || '本地全本TXT',
        approved: item ? !!item.approved : false,
        tags: (item && item.tags) || [],
        metrics,
        preview: previewSlice,
        mtimeMs: Math.floor(st.mtimeMs),
        createdAt: (item && item.createdAt) || new Date(st.mtimeMs).toISOString(),
      };
      metaMap[f] = item;
      dirty = true;
    }
    out.push(item);
  }
  if (dirty) {
    try { fs.writeFileSync(metaFilePath(), JSON.stringify(metaMap, null, 2), 'utf8'); } catch {}
  }
  return out.sort((a, b) => (b.approved - a.approved) || ((b.metrics?.chars || 0) - (a.metrics?.chars || 0)));
}

export function saveCorpusItem({ title, author = '', genre = '', sourceUrl = '', content, approved = false, tags = [] }) {
  const cleanText = cleanNovelGarbage(content);
  const sampleCheck = cleanText.slice(0, 20000);
  if ((sampleCheck.match(/[一-鿿]/g) || []).length < 500) {
    throw new Error('下载的 TXT 有效中文正文不足，已跳过');
  }
  const root = corpusRoot();
  const fname = safeFileName(title) + '.txt';
  const fp = path.join(root, fname);
  fs.writeFileSync(fp, cleanText, 'utf8');
  const st = fs.statSync(fp);

  let metaMap = {};
  try { metaMap = JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')) || {}; } catch {}
  const metrics = analyzeCorpusText(cleanText);
  const item = {
    file: fname,
    title: String(title || fname.replace(/\.txt$/i, '')).trim(),
    author: String(author || '').trim(),
    genre: String(genre || '').trim(),
    sourceUrl: String(sourceUrl || '').trim(),
    approved: !!approved,
    tags: Array.isArray(tags) ? tags : [],
    metrics,
    preview: cleanText.slice(0, 3000).replace(/\s+/g, ' ').slice(0, 220),
    mtimeMs: Math.floor(st.mtimeMs),
    createdAt: metaMap[fname]?.createdAt || new Date().toISOString(),
  };
  metaMap[fname] = item;
  fs.writeFileSync(metaFilePath(), JSON.stringify(metaMap, null, 2), 'utf8');
  return item;
}

export function readCorpusFile(file, { maxChars = 60000 } = {}) {
  const safe = path.basename(String(file || ''));
  const fp = path.join(corpusRoot(), safe);
  if (!fs.existsSync(fp)) throw new Error('语料文件不存在：' + safe);
  const st = fs.statSync(fp);
  // 对几兆的全本 TXT，只流式读前 maxChars 字符供弹窗预览，秒开不卡顿
  const fd = fs.openSync(fp, 'r');
  try {
    const readBytes = maxChars > 0 ? Math.min(st.size, maxChars * 4) : st.size;
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, 0);
    const text = buf.toString('utf8');
    return {
      file: safe,
      totalBytes: st.size,
      totalLength: st.size,
      content: maxChars > 0 ? text.slice(0, maxChars) : text,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function toggleCorpusApproval(file, approved) {
  const safe = path.basename(String(file || ''));
  let metaMap = {};
  try { metaMap = JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')) || {}; } catch {}
  if (!metaMap[safe]) {
    listCorpusItems();
    try { metaMap = JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')) || {}; } catch {}
  }
  if (!metaMap[safe]) throw new Error('找不到语料条目：' + safe);
  metaMap[safe].approved = approved !== undefined ? !!approved : !metaMap[safe].approved;
  fs.writeFileSync(metaFilePath(), JSON.stringify(metaMap, null, 2), 'utf8');
  return metaMap[safe];
}

export function deleteCorpusItem(file) {
  const safe = path.basename(String(file || ''));
  const fp = path.join(corpusRoot(), safe);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  let metaMap = {};
  try { metaMap = JSON.parse(fs.readFileSync(metaFilePath(), 'utf8')) || {}; } catch {}
  delete metaMap[safe];
  try { fs.writeFileSync(metaFilePath(), JSON.stringify(metaMap, null, 2), 'utf8'); } catch {}
  return { ok: true, deleted: safe };
}

// 清洗全本 TXT 首尾与行内的常见电子书站点广告（对大文件做极速正则替换，不拆数万行数组防止内存膨胀）
export function cleanNovelGarbage(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/^[^\n]{0,120}(?:奇书网|80电子书|八零电子书|知轩藏书|qishu|txt808|8080txt|更多txt|电子书免费下载|声明：本书由)[^\n]*\n?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

// ── 获取或创建专用的 Unzoo 采集标签页（绝不抢占 fanqienovel.com 等正在工作的标签页！）──
let _dedicatedCrawlerTabId = null;

async function getDedicatedCrawlerTab(initialUrl = 'https://www.txt80.cc/') {
  const tabs = await listTabs();
  if (_dedicatedCrawlerTabId) {
    const alive = tabs.find(t => String(tabId(t)) === String(_dedicatedCrawlerTabId));
    if (alive && !/fanqienovel\.com\/main\/writer/i.test(alive.url || '')) {
      return tabId(alive);
    }
  }
  const reusable = tabs.find(t => {
    const u = String(t.url || '');
    return /txt80\.cc|txt80\.com|txt02\.com|3yt\.org|9qishu\.com|txt808\.cc|qisuwang|baidu\.com|qimao\.com|10000txt/i.test(u) && !/fanqienovel\.com\/main\/writer/i.test(u);
  }) || tabs.find(t => !/fanqienovel\.com\/main\/writer|127\.0\.0\.1|localhost/i.test(t.url || ''));
  if (reusable) {
    _dedicatedCrawlerTabId = tabId(reusable);
    return _dedicatedCrawlerTabId;
  }
  const activeProfile = tabs[0]?.profile_id || tabs[0]?.profile_path || 'default';
  try {
    const newTid = await createTab(initialUrl, activeProfile);
    await sleep(1800);
    _dedicatedCrawlerTabId = newTid;
    return newTid;
  } catch {
    if (tabs[0]?.profile_path) {
      try { await launchProfile(tabs[0].profile_path); await sleep(1500); } catch {}
    }
    const newTid = await createTab(initialUrl, activeProfile);
    await sleep(1800);
    _dedicatedCrawlerTabId = newTid;
    return newTid;
  }
}

// ── 全本直链 `.txt` 高速流式下载器（无截断，完整拉取整本几 MB ~ 二十几 MB 的 .txt 文件并自动转码）──
export async function fetchFullTxtDirect(url, { onLog = () => {}, maxMb = 45 } = {}) {
  onLog({ level: 'act', msg: `⬇️ 正在下载全本 TXT 文件：${decodeURIComponent(url)}` });
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Referer': new URL(url).origin + '/',
    },
    signal: AbortSignal.timeout(120000), // 给足 120 秒下载十几 MB 的全本大文件
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') && !/\.txt(\?|$)/i.test(url)) {
    throw new Error('目标链接返回的是网页而非 TXT 文件');
  }

  const ab = await resp.arrayBuffer();
  const maxBytes = maxMb * 1024 * 1024;
  const buf = Buffer.from(ab.byteLength > maxBytes ? ab.slice(0, maxBytes) : ab);
  const sizeMb = (buf.length / (1024 * 1024)).toFixed(2);
  const decoded = decodeBufferAuto(buf);

  if (/<html|<body|<!doctype/i.test(decoded.slice(0, 600))) {
    throw new Error('下载内容是 HTML 错误页而非 TXT 小说');
  }
  const sampleHz = (decoded.slice(0, 20000).match(/[一-鿿]/g) || []).length;
  if (sampleHz < 500) {
    throw new Error('下载的文件不含有效中文小说正文');
  }
  onLog({ level: 'info', msg: `📦 全本 TXT 下载完成（文件体积 ${sizeMb} MB）` });
  return decoded;
}

// ── 从一个全本 TXT 网站的【书籍详情页】或【下载地址页】解析出最终的 `.txt` 直链并全本下载 ──
export async function resolveAndDownloadFullTxtFromBookPage({ tid, bookPageUrl, customTitle = '', genre = '', onLog = () => {} }) {
  // 0. 若直接就是 .txt 链接
  if (/\.txt(\?|$)/i.test(bookPageUrl)) {
    const content = await fetchFullTxtDirect(bookPageUrl, { onLog });
    const guessName = customTitle || decodeURIComponent(path.basename(new URL(bookPageUrl).pathname)).replace(/\.txt$/i, '') || '全本TXT小说';
    return saveCorpusItem({ title: guessName, genre, sourceUrl: bookPageUrl, content });
  }

  await navigate(tid, bookPageUrl);
  await sleep(2200);

  // 1. 提取当前详情页上的信息：书名、作者、是否有直接的 `.txt` 链接，或者是否有“进入小说下载地址”(`/down/txt...html`)跳板页
  const pageInfo = await evaluate(tid, `(() => {
    const h1 = document.querySelector('h1, .title h1, .book-title');
    let rawTitle = (h1 ? h1.innerText : document.title || '').trim();
    const mTitle = rawTitle.match(/《([^》]+)》/);
    const bookTitle = mTitle ? mTitle[1].trim() : rawTitle.split(/[\\-_｜|—，,]/)[0].replace(/小说.*|TXT.*|全集.*|全本.*/gi, '').trim();

    let author = '';
    const bodyText = document.body ? document.body.innerText : '';
    const mAuth = bodyText.match(/(?:小说作者|作\\s*者)[：:]\\s*([^\\n\\r\\s｜|]+)/);
    if (mAuth) author = mAuth[1].trim();

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const directTxts = [];
    const downPages = [];
    for (const a of anchors) {
      const href = a.href || '';
      const txt = (a.innerText || a.title || '').trim();
      if (/\\.txt(\\?|$)/i.test(href)) {
        directTxts.push(href);
      } else if (/\\/down\\/|down\\.php|进入小说下载地址|下载地址|打包下载|全本下载/i.test(href + ' ' + txt) && /^https?:/i.test(href) && !/javascript:/i.test(href)) {
        downPages.push(href);
      }
    }
    return { bookTitle, author, directTxts, downPages };
  })()`, 15000);

  if (!pageInfo) throw new Error('无法解析书籍详情页');
  const finalTitle = customTitle || pageInfo.bookTitle || '全本小说';
  let txtUrls = [...(pageInfo.directTxts || [])];

  // 2. 如果详情页上是两步跳转（如 9qishu / txt808 的 `/down/txt5c9204qishu.html`），进入下载页拿真 `.txt` 直链
  if (!txtUrls.length && pageInfo.downPages && pageInfo.downPages.length > 0) {
    const downPageUrl = pageInfo.downPages[0];
    onLog({ level: 'act', msg: `🔗 进入《${finalTitle}》全本 TXT 下载通道页：${downPageUrl}` });
    await navigate(tid, downPageUrl);
    await sleep(2000);
    const downInfo = await evaluate(tid, `(() => {
      const urls = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = a.href || '';
        const txt = (a.innerText || '').trim();
        if (/\\.txt(\\?|$)/i.test(href) || (/下载到电脑|右键另存|本地下载|TXT下载/i.test(txt) && /^https?:/i.test(href))) {
          urls.push(href);
        }
      }
      return urls;
    })()`, 15000) || [];
    txtUrls.push(...downInfo);
  }

  txtUrls = [...new Set(txtUrls.filter(u => /^https?:/i.test(u)))];
  // 优先走高速稳定镜像（如 d.txt80.la / d.txt80.com / txt.qishu77.com），避免慢节点超时等待
  txtUrls.sort((a, b) => {
    const score = (u) => (/txt80\.la|d\.txt80\.com|qishu77|txt808/i.test(u) ? 2 : /qishu99/i.test(u) ? 0 : 1);
    return score(b) - score(a);
  });
  if (!txtUrls.length) {
    throw new Error(`页面未提供直链全本 .txt 下载地址（${bookPageUrl}）`);
  }

  // 3. 依次尝试页面上的直链镜像（如 down.qishu99.cc / txt.qishu77.com / down.txt808.cc）下载全本 TXT
  let lastErr = null;
  for (const tu of txtUrls) {
    try {
      const fullContent = await fetchFullTxtDirect(tu, { onLog });
      let realTitle = finalTitle;
      try {
        const urlFile = decodeURIComponent(new URL(tu).pathname.split('/').pop() || '').replace(/\.txt$/i, '').trim();
        if (urlFile && (!realTitle || /玄幻奇幻|武侠仙侠|都市言情|历史军事|科幻灵异|网游竞技|全本小说/.test(realTitle))) {
          realTitle = urlFile;
        }
      } catch {}
      const saved = saveCorpusItem({
        title: realTitle,
        author: pageInfo.author || '',
        genre,
        sourceUrl: tu,
        content: fullContent,
      });
      const wan = (saved.metrics.chars / 10000).toFixed(1);
      onLog({
        level: 'info',
        msg: `✅ 全本《${saved.title}》下载入库成功：${saved.metrics.sizeMb} MB / ${wan} 万字 / 约 ${saved.metrics.chapterCount} 章！`,
      });
      return saved;
    } catch (e) {
      lastErr = e;
      onLog({ level: 'warn', msg: `镜像 [${tu.slice(0, 45)}] 响应异常（${e.message}），尝试备用下载节点…` });
    }
  }
  throw lastErr || new Error('所有 TXT 下载节点均未能拉取成功');
}

// ── 核心服务：通过 Unzoo 在【全本 TXT 下载站矩阵 + 百度 site: 直链检索】自动搜索并下载全本 TXT ──
export async function searchAndDownloadNovelsViaUnzoo({ keyword, genre = '', maxBooks = 1, profilePath = '', onLog = () => {} } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('请输入要搜索下载的全本小说名或题材关键词');

  if (profilePath) {
    try { await launchProfile(profilePath); await sleep(1000); } catch {}
  }

  const tid = await getDedicatedCrawlerTab('https://www.9qishu.com/');
  const bookPageCandidates = [];

  // 第一通道：直接驱动 Unzoo 在全本 TXT 下载站（txt80.cc / 9qishu.com / txt808.cc）提交站内搜索表单
  for (const site of FULL_TXT_SITES) {
    if (bookPageCandidates.length >= maxBooks) break;
    try {
      const elapsed = Date.now() - (_lastSiteSearchAt[site.home] || 0);
      if (elapsed < 31000 && _lastSiteSearchAt[site.home]) {
        const waitMs = 31500 - elapsed;
        onLog({ level: 'info', msg: `⏳ 等待 ${site.name} 搜索冷却 (${Math.ceil(waitMs / 1000)}s)…` });
        await sleep(waitMs);
      }
      onLog({ level: 'act', msg: `🔍 [${site.name}] 正在检索全本 TXT：《${kw}》…` });
      await navigate(tid, site.home);
      await sleep(1600);
      _lastSiteSearchAt[site.home] = Date.now();
      await evaluate(tid, `(() => {
        const inp = document.querySelector('input[name="keyboard"], input[name="searchkey"], input[name="q"]');
        const form = inp ? inp.closest('form') : document.querySelector('form[action*="search"]');
        if (inp && form) {
          inp.value = ${JSON.stringify(kw)};
          form.submit();
        }
      })()`, 10000);
      await sleep(2600);

      // 若站点提示 30 秒搜索间隔，自动礼貌等待 31 秒后重提一次
      const bodyTxt = await evaluate(tid, `(document.body && document.body.innerText || '').slice(0, 300)`, 8000) || '';
      if (/搜索时间间隔/.test(bodyTxt)) {
        onLog({ level: 'info', msg: `⏳ ${site.name} 触发 30 秒检索间隔，等待后重试…` });
        await sleep(31000);
        await navigate(tid, site.home);
        await sleep(1500);
        _lastSiteSearchAt[site.home] = Date.now();
        await evaluate(tid, `(() => {
          const inp = document.querySelector('input[name="keyboard"], input[name="searchkey"], input[name="q"]');
          const form = inp ? inp.closest('form') : document.querySelector('form[action*="search"]');
          if (inp && form) {
            inp.value = ${JSON.stringify(kw)};
            form.submit();
          }
        })()`, 10000);
        await sleep(2600);
      }

      const links = await evaluate(tid, `(() => {
        const out = [];
        const seen = new Set();
        const anchors = Array.from(document.querySelectorAll('a[href*="txt"], a[href*="/book/"], a[href*="/down/"]'));
        for (const a of anchors) {
          const href = a.href || '';
          const text = (a.innerText || a.title || '').trim();
          if (!/txt\\d+\\.html/i.test(href) || seen.has(href)) continue;
          if (!text || /热门|排行|推荐|玄幻奇幻|武侠仙侠|都市言情|都市小说|女生言情|军事历史|历史军事|科幻灵异|网游竞技|女生频道|同人小说|耽美同人|文学名著|其他小说/.test(text)) continue;
          seen.add(href);
          out.push({ title: text, url: href });
        }
        return out.slice(0, 12);
      })()`, 12000) || [];

      // 过滤掉与搜索词完全无关的侧边栏推荐链接，并优先排精确匹配《书名》的结果
      const matchedLinks = links.filter(lk => lk.title.includes(kw));
      matchedLinks.sort((a, b) => {
        const cleanA = (a.title.match(/《([^》]+)》/)?.[1] || a.title).trim();
        const cleanB = (b.title.match(/《([^》]+)》/)?.[1] || b.title).trim();
        const aExact = (cleanA === kw ? 10 : a.title.includes(`《${kw}》`) ? 8 : 1) - cleanA.length * 0.1;
        const bExact = (cleanB === kw ? 10 : b.title.includes(`《${kw}》`) ? 8 : 1) - cleanB.length * 0.1;
        return bExact - aExact;
      });
      for (const lk of matchedLinks) bookPageCandidates.push(lk);
    } catch (e) {
      onLog({ level: 'warn', msg: `${site.name} 搜索跳过：${e.message}` });
    }
  }

  // 第二通道：若站内搜索未命中，驱动 Unzoo 用【百度 (www.baidu.com)】定向搜索全本 TXT 下载站页
  if (bookPageCandidates.length === 0) {
    const baiduQuery = `${kw} 全集TXT电子书下载 下载到电脑`;
    onLog({ level: 'act', msg: `🔍 [百度全本检索] 正在百度搜索：「${baiduQuery}」…` });
    await navigate(tid, `https://www.baidu.com/s?wd=${encodeURIComponent(baiduQuery)}`);
    await sleep(2800);
    const baiduLinks = await evaluate(tid, `(() => {
      const out = [];
      const blocks = Array.from(document.querySelectorAll('#content_left .result, #content_left .c-container'));
      for (const b of blocks) {
        const a = b.querySelector('h3 a, a');
        if (!a) continue;
        const title = (a.innerText || '').trim();
        const mu = b.getAttribute('mu') || a.getAttribute('data-mdurl') || a.href || '';
        if (!/^https?:/i.test(mu)) continue;
        if (/9qishu|qishu|txt808|8080txt|qisuwang|xbookben|txt\\d+\\.html/i.test(mu)) {
          out.push({ title, url: mu });
        }
      }
      return out.slice(0, 6);
    })()`, 12000) || [];
    for (const lk of baiduLinks) bookPageCandidates.push(lk);
  }

  if (!bookPageCandidates.length) {
    throw new Error(`未在全本 TXT 电子书站检索到《${kw}》的全本 TXT 资源`);
  }

  const downloaded = [];
  for (const cand of bookPageCandidates) {
    if (downloaded.length >= maxBooks || SERVICE_STATE.stopRequested) break;
    try {
      const mName = cand.title.match(/《([^》]+)》/);
      const cleanName = mName ? mName[1].trim() : cand.title.replace(/全本.*|全集.*|TXT.*|电子书.*|下载.*/gi, '').trim() || kw;
      const saved = await resolveAndDownloadFullTxtFromBookPage({
        tid,
        bookPageUrl: cand.url,
        customTitle: cleanName,
        genre: genre || kw,
        onLog,
      });
      downloaded.push(saved);
    } catch (e) {
      onLog({ level: 'warn', msg: `候选页 [${cand.title.slice(0, 22)}] 下载未果（${e.message}），尝试下一条…` });
    }
  }

  if (!downloaded.length) {
    throw new Error(`找到《${kw}》的 ${bookPageCandidates.length} 个下载页，但直链均未能拉取成功`);
  }
  return downloaded;
}

// 兼容单 URL 下载调用（支持直接传入 9qishu/txt808 详情页 URL 或直链 .txt URL 下载全本）
export async function downloadNovelByUrlViaUnzoo({ url, customTitle = '', genre = '', profilePath = '', onLog = () => {} } = {}) {
  if (profilePath) {
    try { await launchProfile(profilePath); await sleep(1000); } catch {}
  }
  const tid = await getDedicatedCrawlerTab(url);
  return resolveAndDownloadFullTxtFromBookPage({
    tid,
    bookPageUrl: url,
    customTitle,
    genre,
    onLog,
  });
}

// 模式 1：从 Unzoo 已打开的 TXT 下载页或阅读页采集
const NON_NOVEL_DOMAIN_RE = /127\.0\.0\.1|localhost|mail\.google\.com|qiye\.aliyun\.com|x\.com|twitter\.com|weibo\.com|aws\.amazon\.com|mp\.toutiao\.com|iqiyi\.com|youku\.com|bilibili\.com|douyin\.com|gemini\.google\.com|chatgpt\.com|claude\.ai|doaipm\.com|fanqienovel\.com\/main\/writer/i;

export async function downloadTxtFromOpenTabs({ profilePath = '', customTitle = '', onLog = () => {} } = {}) {
  if (profilePath) {
    try { await launchProfile(profilePath); await sleep(1000); } catch {}
  }
  const tabs = await listTabs();
  const items = [];
  for (const t of tabs) {
    const u = String(t.url || '');
    if (!/^https?:/i.test(u) || NON_NOVEL_DOMAIN_RE.test(u)) continue;
    if (/9qishu|qishu|txt808|8080txt|qisuwang|xbookben|\.txt/i.test(u)) {
      try {
        const saved = await resolveAndDownloadFullTxtFromBookPage({
          tid: tabId(t),
          bookPageUrl: u,
          customTitle,
          onLog,
        });
        items.push(saved);
      } catch (e) {
        onLog({ level: 'warn', msg: `跳过标签页 ${u.slice(0, 45)}：${e.message}` });
      }
    }
  }
  if (!items.length) {
    throw new Error('未在当前打开的 Unzoo 标签页中检测到全本 TXT 下载页。请直接使用上方的「全自动全本 TXT 采集服务」！');
  }
  return items;
}

// ── 全自动批量全本 TXT 下载后台服务 ──
export function startCorpusAutoService({ genres = [], keywords = [], booksPerQuery = 1, profilePath = '' } = {}) {
  if (SERVICE_STATE.running) {
    return { ok: false, error: '全本 TXT 自动采集服务已在运行中，请查看实时进度', status: getCorpusServiceStatus() };
  }

  const queue = [];
  const existing = new Set(listCorpusItems().filter(x => (x.metrics?.chars || 0) >= 50000).map(x => x.title));

  for (const g of genres) {
    const pack = GENRE_NOVEL_PACKS[g] || [g];
    const fresh = pack.filter(name => !existing.has(name));
    const picks = (fresh.length ? fresh : pack).slice(0, Math.max(1, Number(booksPerQuery || 3)));
    for (const bookName of picks) {
      queue.push({ keyword: bookName, genre: g });
    }
  }
  for (const kw of keywords) {
    const clean = String(kw || '').trim();
    if (clean) queue.push({ keyword: clean, genre: clean });
  }

  if (!queue.length) {
    for (const [g, pack] of Object.entries(GENRE_NOVEL_PACKS)) {
      const pick = pack.find(name => !existing.has(name)) || pack[0];
      queue.push({ keyword: pick, genre: g });
    }
  }

  SERVICE_STATE.running = true;
  SERVICE_STATE.stopRequested = false;
  SERVICE_STATE.completed = 0;
  SERVICE_STATE.total = queue.length;
  SERVICE_STATE.downloaded = [];
  SERVICE_STATE.logs = [];
  SERVICE_STATE.startedAt = new Date().toISOString();
  SERVICE_STATE.currentTask = `准备通过 Unzoo 全自动下载 ${queue.length} 部【全本完结 TXT】电子书…`;
  svcLog('info', `🚀 全本 TXT 自动采集服务已启动：目标 ${queue.length} 部全本小说（${queue.map(q => `《${q.keyword}》`).join('、')}）`);

  (async () => {
    try {
      for (let i = 0; i < queue.length; i++) {
        if (SERVICE_STATE.stopRequested) {
          svcLog('warn', '⏹ 采集服务已按作者指令停止');
          break;
        }
        const task = queue[i];
        SERVICE_STATE.currentTask = `[${i + 1}/${queue.length}] 正在检索并下载全本 TXT：《${task.keyword}》(${task.genre})…`;
        svcLog('act', SERVICE_STATE.currentTask);
        try {
          const items = await searchAndDownloadNovelsViaUnzoo({
            keyword: task.keyword,
            genre: task.genre,
            maxBooks: 1,
            profilePath,
            onLog: (e) => svcLog(e.level || 'info', e.msg),
          });
          for (const it of items) {
            SERVICE_STATE.downloaded.push({
              title: it.title,
              file: it.file,
              chars: it.metrics?.chars || 0,
              sizeMb: it.metrics?.sizeMb || 0,
              genre: it.genre,
            });
          }
        } catch (e) {
          svcLog('warn', `⚠️ 《${task.keyword}》全本下载跳过：${e.message}`);
        }
        SERVICE_STATE.completed = i + 1;
      }
      svcLog('info', `🎉 全本 TXT 采集服务运行完毕！成功下载 ${SERVICE_STATE.downloaded.length} 部完整全本 TXT 电子书入库，请勾选您认可的作品作为学习对象。`);
    } catch (e) {
      svcLog('error', `❌ 采集服务异常终止：${e.message}`);
    } finally {
      SERVICE_STATE.running = false;
      SERVICE_STATE.currentTask = '';
    }
  })();

  return { ok: true, status: getCorpusServiceStatus() };
}

// ── 由作者选定全本 TXT 语料后：一键设为某本书的「文风范本 (style_refs)」+「提炼写作分身 (StoryAlter)」 ──
export async function applyCorpusToBook({ file, book, extractCard = true, extractAlter = true, saveToGlobalAlter = true, model = '', cfg = {}, onLog = () => {} }) {
  const safe = path.basename(String(file || ''));
  const fp = path.join(corpusRoot(), safe);
  if (!fs.existsSync(fp)) throw new Error('语料文件不存在：' + safe);
  // 只读取前 20 万字用于提取黄金样章，避免把 20MB 整本塞进内存切分
  const { content: headText } = readCorpusFile(safe, { maxChars: 200000 });
  const items = listCorpusItems();
  const meta = items.find(x => x.file === safe) || { title: safe.replace(/\.txt$/i, '') };

  toggleCorpusApproval(safe, true);

  const samples = extractBestSamples(headText, { count: 2, maxCharsEach: 1400 });
  const addedRefs = [];
  if (book && book.dir) {
    for (let i = 0; i < samples.length; i++) {
      const refName = `${meta.title}_样章${i + 1}`;
      const rf = addRef(book, refName, samples[i].text);
      addedRefs.push(rf);
    }
    onLog({ level: 'info', msg: `🖋️ 已将全本《${meta.title}》的 ${addedRefs.length} 段黄金样章挂入《${book.title}》的 style_refs/` });
  }

  const useModel = resolveGenModel(model || book?.model || cfg?.defaultModel) || 'agy';
  let cardText = '';
  let alterPersona = null;

  if (extractCard && book && book.dir && samples.length) {
    try {
      onLog({ level: 'act', msg: `🧠 正在从《${meta.title}》提炼文风手法卡（style_card.md）…` });
      const sampleJoined = samples.map(s => s.text).join('\n\n---\n\n');
      const out = await runCowrite(useModel, CARD_PROMPT + '\n\n' + sampleJoined, cfg, 180000);
      if (out && out.trim().length >= 60) {
        cardText = out.trim();
        saveCard(book, cardText);
      }
    } catch (e) {
      onLog({ level: 'warn', msg: `手法卡提炼跳过：${e.message}` });
    }
  }

  if (extractAlter && samples.length) {
    try {
      onLog({ level: 'act', msg: `🎭 正在从《${meta.title}》深度提炼三维写作分身（Soul 灵魂 / Brain 大脑 / Body 躯体）…` });
      const sampleJoined = samples.map(s => s.text).join('\n\n');
      const prompt = extractAlterFromSamplePrompt({
        sampleText: sampleJoined,
        sourceTitle: meta.title,
        genre: meta.genre || book?.genre || '',
      });
      const out = await runCowrite(useModel, prompt, cfg, 180000);
      alterPersona = parseAlterJson(out, meta.title);
      if (alterPersona) {
        if (saveToGlobalAlter) {
          saveGlobalAlter(alterPersona);
        }
        if (book && book.dir) {
          saveBookAlter(book.dir, alterPersona);
          onLog({ level: 'info', msg: `🎭 已为《${book.title}》绑定专属写作分身：【${alterPersona.name}】` });
        }
      }
    } catch (e) {
      onLog({ level: 'warn', msg: `写作分身自动提炼跳过：${e.message}` });
    }
  }

  return {
    ok: true,
    corpusFile: safe,
    corpusTitle: meta.title,
    addedRefs,
    cardText,
    alterPersona,
  };
}
