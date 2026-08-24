// 卷名生成：写作时某卷没有卷名（目录名/大纲/bible 都取不到副标题）时，用 API 文本模型从该卷正文/大纲/bible
// 生成一个 4–6 字有意境的副标题，并【写回 novel_bible.md 的卷名清单】(格式 卷NN《xxx》，与 bibleVolSubtitle 读法一致)。
// 番茄要求分卷必须有名字——有了这个，建卷/改卷名就不会再因空副标题卡住。
import fs from 'node:fs';
import path from 'node:path';
import { chatComplete, pickProvider } from './apichat.mjs';
import { loadPublishChapters, outlineVolSubtitle, bibleVolSubtitle, bookVolNum } from './publish.mjs';

const BIBLE = 'novel_bible.md';
const SECTION = '## 卷名清单（自动生成）';
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// 挑模型的逻辑收到 apichat.pickProvider 了（含本地模型），这里不再自己维护一份名单。

// 某卷【目录名】自带的副标题（"卷03_静海旧火"/"卷03静海旧火" → "静海旧火"；"卷03" → ""）
// ⚠️去前缀要一次吃光"卷"+数字，别用 \d+(.+) 那种会回溯把数字漏给副标题(实测"卷01"→误得"1")。
function dirSubtitle(book, volNum) {
  const chs = loadPublishChapters(book);
  const dirs = [...new Set(chs.filter(c => bookVolNum(c.vol) === volNum).map(c => c.vol))];
  for (const d of dirs) {
    const sub = String(d).replace(/^卷\s*\d+/, '').replace(/^[_\-．.、:：\s]+/, '').trim();
    if (sub && !/^\d+$/.test(sub)) return sub.slice(0, 16);
  }
  return '';
}

// 取某卷【已有卷名】：目录名 → 大纲文件名/H1 → bible。都没有返回 ''。
export function existingVolName(book, volNum) {
  return dirSubtitle(book, volNum) || outlineVolSubtitle(book, volNum) || bibleVolSubtitle(book, volNum) || '';
}

// 扫 bible 里已登记的 卷NN《xxx》→ { num: name }，用于避免新卷名与其他卷重名。
function knownVolNames(book) {
  const bible = readSafe(path.join(book.dir, BIBLE));
  const out = {};
  for (const m of bible.matchAll(/卷\s*0*(\d+)(?!\d)\s*《([^》]{1,16})》/g)) out[parseInt(m[1], 10)] = m[2].trim();
  return out;
}

// bible 摘要（卖点/主角/时代），给出题模型定调
function bibleDigest(book) {
  const b = readSafe(path.join(book.dir, BIBLE));
  const pick = (h) => { const m = b.match(new RegExp('##\\s*' + h + '\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)')); return m ? m[1].trim().replace(/\s+/g, ' ') : ''; };
  return [
    pick('一句话卖点') && ('卖点：' + pick('一句话卖点').slice(0, 200)),
    pick('主角') && ('主角：' + pick('主角').slice(0, 160)),
    pick('时代世界观') && ('时代：' + pick('时代世界观').slice(0, 160)),
  ].filter(Boolean).join('\n');
}

// 取该卷正文样本：首/中/尾章开头各截一段，给模型抓这一卷的情节基调。
function volContentSample(book, volNum) {
  const chs = loadPublishChapters(book).filter(c => bookVolNum(c.vol) === volNum && c.content).sort((a, b) => a.num - b.num);
  if (!chs.length) return '';
  const idx = [...new Set([0, Math.floor(chs.length / 2), chs.length - 1])];
  return idx.map(i => {
    const c = chs[i];
    return `【第${c.num}章 开头】` + String(c.content).replace(/\s+/g, ' ').slice(0, 300);
  }).join('\n');
}

// 该卷的大纲要点（若有大纲文件）
function volOutline(book, volNum) {
  const odir = path.join(book.dir, 'outlines');
  let files = []; try { files = fs.readdirSync(odir).filter(f => /\.md$/i.test(f)); } catch { return ''; }
  const hit = files.find(f => new RegExp(`^卷\\s*0*${volNum}(?!\\d)`).test(f));
  if (!hit) return '';
  return readSafe(path.join(odir, hit)).replace(/\s+/g, ' ').slice(0, 600);
}

// 把生成的卷名写回 bible 的「卷名清单」段（卷NN《xxx》，两位数补零）。已有该卷行则替换，否则追加；没段就新建段。
export function writeVolNameToBible(book, volNum, name) {
  const bp = path.join(book.dir, BIBLE);
  let bible = readSafe(bp);
  const pad = String(volNum).padStart(2, '0');
  const line = `卷${pad}《${name}》`;
  const lineRe = new RegExp(`卷\\s*0*${volNum}(?!\\d)\\s*《[^》]*》`);
  if (lineRe.test(bible)) {
    bible = bible.replace(lineRe, line);                       // 替换已有该卷登记
  } else if (bible.includes(SECTION)) {
    bible = bible.replace(SECTION, `${SECTION}\n- ${line}`);   // 段已存在 → 插一行
  } else {
    bible = bible.replace(/\s*$/, '') + `\n\n${SECTION}\n- ${line}\n`;  // 没段 → 末尾建段
  }
  fs.writeFileSync(bp, bible, 'utf8');
  return line;
}

// 主函数：为 book 的第 volNum 卷生成卷名。
//   已有卷名且 !force → 直接返回现有（不重复生成、不调用模型）。
//   否则用模型生成 4–6 字副标题（避开与其他卷重名），写回 bible，返回 { ok, name, from }。
export async function generateVolumeName(book, volNum, { cfg, force = false, onLog = () => {} } = {}) {
  const log = (msg, level = 'info') => { try { onLog({ level, msg }); } catch {} };
  volNum = parseInt(volNum, 10);
  if (!book?.dir || !(volNum >= 1)) return { ok: false, error: '缺少书或卷号' };

  const had = existingVolName(book, volNum);
  if (had && !force) return { ok: true, name: had, from: 'existing' };

  const provider = pickProvider(cfg);
  if (!provider) return { ok: false, error: '未配置任何 API 文本模型（智谱/DeepSeek/通义），无法生成卷名——请在「设置」里填一个 API Key。' };

  const known = knownVolNames(book);
  const avoid = Object.entries(known).filter(([n]) => Number(n) !== volNum).map(([, v]) => v);
  const sample = volContentSample(book, volNum);
  const outline = volOutline(book, volNum);
  if (!sample && !outline) return { ok: false, error: `第${volNum}卷还没有正文/大纲，无法据此起卷名（先写点内容或列大纲）` };

  log(`用 ${provider} 为第${volNum}卷起卷名…`, 'act');
  const sys = '你是网文资深主编，最擅长起有意境、有冲突张力的卷名。只输出卷名本身，不要引号、书名号、标点、解释。';
  const user =
    `为下面这本书的【第${volNum}卷】起一个卷名（副标题）。要求：\n` +
    `① 4–6 个汉字，有意境/有冲突张力，贴合本卷情节与基调；\n` +
    `② 不带"卷/第N卷/："等前缀，不带标点，只给副标题本体；\n` +
    (avoid.length ? `③ 不得与本书其他卷名重复或雷同：${avoid.join('、')}；\n` : '') +
    `\n【全书设定】\n${bibleDigest(book) || '(略)'}\n` +
    (outline ? `\n【本卷大纲要点】\n${outline}\n` : '') +
    (sample ? `\n【本卷正文片段】\n${sample}\n` : '');

  let raw = '';
  try {
    // maxTokens 要给足：glm-4.5-flash 是【思考模型】，会先用掉一批 token 推理，给太少(如 60/256)会被推理吃光、
    // content 返回空（踩过）。卷名虽短，也留 2048 的余量。
    const r = await chatComplete({ provider, cfg, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.9, maxTokens: 2048, onLog });
    raw = (r?.content || '').trim();
  } catch (e) { return { ok: false, error: '模型出卷名失败：' + (e.message || e) }; }

  // 清洗：去引号/书名号/前缀/标点，取纯汉字副标题，限 2–8 字
  let name = raw.replace(/["'“”‘’《》〈〉\[\]（）()]/g, '')
    .replace(/^第?\s*[0-9一二三四五六七八九十百]+\s*卷\s*[:：]?/, '')
    .replace(/[，,。.!！?？:：;；\s]/g, '')
    .trim().slice(0, 8);
  if (!name || name.length < 2) return { ok: false, error: `模型返回的卷名不可用（"${raw.slice(0, 30)}"）` };

  const written = writeVolNameToBible(book, volNum, name);
  log(`✅ 第${volNum}卷卷名：${name}（已写入 bible：${written}）`, 'act');
  return { ok: true, name, from: 'generated', bibleLine: written };
}

// 写作途中调用（batch 结束时）：扫全书卷，给【已写够 minChapters 章、却还没卷名】的卷自动起名写回 bible。
// 自节流：绝大多数 batch 没有"新到阈值的无名卷"→ 只做几次文件读、不调模型；每次最多起 limit 个名(默认1)避免突发。
// 返回已起名的 [{num,name}]。best-effort：调用方 try/catch 包住，别让它拖垮写作循环。
export async function ensureVolumeNames(book, { cfg, minChapters = 3, limit = 1, onLog = () => {} } = {}) {
  if (!book?.dir) return [];
  const chs = loadPublishChapters(book);
  const counts = new Map();
  for (const c of chs) { const n = bookVolNum(c.vol); if (n != null) counts.set(n, (counts.get(n) || 0) + 1); }
  const done = [];
  for (const [num, cnt] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (done.length >= limit) break;
    if (cnt < minChapters) continue;
    if (existingVolName(book, num)) continue;         // 已有名字 → 跳过（便宜，不调模型）
    try {
      const r = await generateVolumeName(book, num, { cfg, onLog });
      if (r.ok && r.from === 'generated') done.push({ num, name: r.name });
    } catch { /* best-effort */ }
  }
  return done;
}
