// 从番茄拉取整本书到本地 Novel Studio。
// 走番茄作者后台 API（页面内 fetch，带 cookie，无需 msToken）：
//   volume_list/v1            → 卷列表
//   chapter/chapter_list/v1   → 按卷取章目录（item_id/title/字数/状态）
//   edit_article/v0           → 取单章正文（HTML <p>）
// 导进来后这本就和本地书一样：完结收口、完本感言、A–E 全部可用（尤其是番茄独有书，如《重生岳云》）。
import fs from 'node:fs';
import path from 'node:path';
import { UnzooClient } from './fanqie.mjs';
import { createBook, getBook, setBookPublish } from './books.mjs';
import { loadConfig } from './config.mjs';

const API = 'https://fanqienovel.com/api/author';
const COMMON = 'aid=2503&app_name=muye_novel';

let _seq = 0;

// 在番茄页面内 fetch 一个接口（带 cookie），两步：发起 → 轮询 window。返回解析后的 JSON。
async function pageFetchJson(client, url, { timeoutMs = 20000 } = {}) {
  const key = '__nsimp_' + (++_seq);
  await client.evaluate(`(function(){window.${key}='PENDING';fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.text();}).then(function(t){window.${key}=t;}).catch(function(e){window.${key}='__ERR__'+((e&&e.message)||e);});return 'ok';})()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await client.sleep(400);
    const v = await client.evaluate(`window.${key}`);
    if (v && v !== 'PENDING') {
      try { await client.evaluate(`(function(){try{delete window.${key};}catch(e){window.${key}=undefined;}return 1;})()`); } catch {}
      if (typeof v === 'string' && v.startsWith('__ERR__')) throw new Error('番茄接口失败：' + v.slice(7));
      try { return (typeof v === 'string') ? JSON.parse(v) : v; } catch { throw new Error('番茄接口返回非 JSON（可能未登录/被拦截）'); }
    }
  }
  throw new Error('番茄接口超时');
}

// 批量取多章正文：一次 evaluate 内 Promise.all 并发 fetch（默认每批 6 章）。返回 {itemId: {title, content}}。
async function fetchContents(client, bookId, items) {
  const key = '__nsimp_' + (++_seq);
  const ids = JSON.stringify(items.map(i => String(i.itemId)));
  const base = `${API}/edit_article/v0/?${COMMON}&from_source=0&book_id=${bookId}&item_id=`;
  await client.evaluate(`(function(){window.${key}='PENDING';var ids=${ids};var base=${JSON.stringify(base)};Promise.all(ids.map(function(id){return fetch(base+id,{credentials:'include'}).then(function(r){return r.json();}).then(function(j){var d=(j&&j.data)||{};return {id:id,title:d.title||'',content:d.content||''};}).catch(function(e){return {id:id,err:((e&&e.message)||'err')};});})).then(function(arr){window.${key}=JSON.stringify(arr);}).catch(function(e){window.${key}='__ERR__'+((e&&e.message)||e);});return 'ok';})()`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await client.sleep(500);
    const v = await client.evaluate(`window.${key}`);
    if (v && v !== 'PENDING') {
      try { await client.evaluate(`(function(){try{delete window.${key};}catch(e){window.${key}=undefined;}return 1;})()`); } catch {}
      if (typeof v === 'string' && v.startsWith('__ERR__')) throw new Error('批量取正文失败：' + v.slice(7));
      let arr = []; try { arr = (typeof v === 'string') ? JSON.parse(v) : v; } catch { throw new Error('批量取正文返回非 JSON'); }
      const map = {};
      for (const it of arr) map[it.id] = it;
      return map;
    }
  }
  throw new Error('批量取正文超时');
}

// 番茄正文 HTML(<p>…</p>) → 纯文本，段落用空行分隔（与本地章节正文一致）。
export function fanqieHtmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/[＜<]\s*br\s*\/?\s*[＞>]/gi, '\n');
  s = s.replace(/[＜<]\s*\/\s*p\s*[＞>]/gi, '\n\n');     // </p> → 段落分隔
  s = s.replace(/[＜<]\s*p[^＞>]*[＞>]/gi, '');           // <p ...> 去掉
  s = s.replace(/[＜<][^＞>]+[＞>]/g, '');                // 其余标签去掉
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

const cnMap = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNum(s) {
  s = String(s || '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.indexOf('十') >= 0) { const [a, b] = s.split('十'); const t = a === '' ? 1 : (cnMap[a] ?? NaN); const u = b === '' ? 0 : (cnMap[b] ?? NaN); return (isNaN(t) || isNaN(u)) ? NaN : t * 10 + u; }
  return s.length === 1 && cnMap[s] != null ? cnMap[s] : NaN;
}
function volNumOf(volumeName, fallback) {
  const m = String(volumeName || '').match(/第\s*([0-9一二三四五六七八九十两]+)\s*卷/);
  if (m) { const n = cnToNum(m[1]); if (!isNaN(n)) return n; }
  return fallback;
}
function chapterNumOf(title, fallback) {
  const m = String(title || '').match(/第\s*(\d+)\s*章/);
  return m ? parseInt(m[1], 10) : fallback;
}
function pureTitle(title) {
  return String(title || '').replace(/^第\s*\d+\s*章[\s\.\-\_:：]*/, '').trim();
}
function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || '无题';
}

// 只读预览：要导入哪些卷、共多少章（不落地、不建书）。
export async function previewFanqieImport({ profilePath, bookId, onLog = () => {} } = {}) {
  if (!bookId) throw new Error('缺少 bookId');
  const client = new UnzooClient(profilePath || null, onLog || null);
  await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}?type=1`);
  await client.sleep(2500);
  const vl = await pageFetchJson(client, `${API}/volume/volume_list/v1?${COMMON}&book_id=${bookId}`);
  const volumes = (vl.data && (vl.data.volume_list || vl.data.list || vl.data.volumes)) || [];
  if (!volumes.length) return { ok: false, error: '未读到卷列表（确认账号已登录、bookId 正确）' };
  const total = volumes.reduce((s, v) => s + (v.item_count || 0), 0);
  return { ok: true, volumes: volumes.length, chapters: total, volNames: volumes.map(v => v.volume_name) };
}

// 正式导入：拉全书 → 建本地书 → 写章节 + 索引 → 配好番茄发布配置。
// limit>0 时只导前 N 章（联调用）。返回 { ok, slug, title, volumes, chapters }。
export async function importFromFanqie({ profilePath, bookId, title, model, onLog = () => {}, limit = 0 } = {}) {
  const log = (level, msg) => { try { onLog({ level, source: 'import', msg }); } catch {} };
  if (!bookId) throw new Error('缺少 bookId');
  const cfg = loadConfig();
  const client = new UnzooClient(profilePath || null, onLog || null);

  log('act', '连接番茄，读取卷与章节目录…');
  await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}?type=1`);
  await client.sleep(3000);

  // 书名（优先入参，否则取 book_detail）
  let bookTitle = (title || '').trim();
  if (!bookTitle) {
    try { const bd = await pageFetchJson(client, `${API}/book/book_detail/v0/?${COMMON}&book_id=${bookId}`); bookTitle = (bd.data && (bd.data.book_name || bd.data.title || bd.data.name)) || ''; } catch {}
  }
  if (!bookTitle) bookTitle = '番茄导入_' + bookId;

  // 卷列表
  const vl = await pageFetchJson(client, `${API}/volume/volume_list/v1?${COMMON}&book_id=${bookId}`);
  const volumes = (vl.data && (vl.data.volume_list || vl.data.list || vl.data.volumes)) || [];
  if (!volumes.length) throw new Error('未读到卷列表');
  log('info', `共 ${volumes.length} 卷：${volumes.map(v => v.volume_name).join('、')}`);

  // 逐卷取章目录
  const plan = [];
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i];
    const cl = await pageFetchJson(client, `${API}/chapter/chapter_list/v1?${COMMON}&book_id=${bookId}&volume_id=${v.volume_id}&page_index=0&page_count=2000&status=0`);
    const list = (cl.data && (cl.data.item_list || cl.data.list || cl.data.chapter_list || cl.data.items)) || [];
    const chapters = list.map((c, idx) => ({
      num: chapterNumOf(c.title, c.index || idx + 1),
      title: c.title || `第${c.index || idx + 1}章`,
      itemId: c.item_id,
      words: c.word_number || 0,
    })).filter(c => c.itemId).sort((a, b) => a.num - b.num);
    plan.push({ volName: v.volume_name, volNum: volNumOf(v.volume_name, i + 1), chapters });
  }
  const totalCh = plan.reduce((s, p) => s + p.chapters.length, 0);
  log('info', `目录就绪：${plan.length} 卷 / ${totalCh} 章，开始拉正文…`);

  // 建书
  let book;
  try { book = createBook({ title: bookTitle, genre: '（番茄导入）', model: model || cfg.defaultModel }, cfg); }
  catch (e) { throw new Error('建本地书失败：' + e.message + '（同名书已存在？可先删除或改名）'); }
  log('act', `已建本地书《${book.title}》→ ${book.dir}`);

  // 写章节正文
  const cdir = path.join(book.dir, 'chapters');
  const indexRows = [];
  let done = 0, failed = 0;
  outer:
  for (const vol of plan) {
    const volDir = '卷' + String(vol.volNum).padStart(2, '0');
    const vAbs = path.join(cdir, volDir);
    fs.mkdirSync(vAbs, { recursive: true });
    for (let k = 0; k < vol.chapters.length; k += 6) {
      if (limit && done >= limit) break outer;
      const chunk = vol.chapters.slice(k, k + 6);
      let got = {};
      try { got = await fetchContents(client, bookId, chunk); }
      catch (e) { log('warn', `取正文批次失败（${e.message}），重试一次…`); try { got = await fetchContents(client, bookId, chunk); } catch (e2) { log('error', '该批正文再次失败，跳过：' + e2.message); } }
      for (const ch of chunk) {
        if (limit && done >= limit) break outer;
        const g = got[String(ch.itemId)] || {};
        const text = fanqieHtmlToText(g.content || '');
        if (!text) { failed++; log('warn', `第${ch.num}章 正文为空，跳过（item ${ch.itemId}）`); continue; }
        const fname = String(ch.num).padStart(3, '0') + '_' + sanitizeName(pureTitle(ch.title)) + '.txt';
        fs.writeFileSync(path.join(vAbs, fname), text, 'utf8');
        indexRows.push({ num: ch.num, name: pureTitle(ch.title) || ch.title, vol: volDir, file: fname });
        done++;
        if (done % 20 === 0 || done === totalCh) log('info', `已拉取 ${done}/${limit || totalCh} 章…`);
      }
    }
  }

  // chapter_index.md
  indexRows.sort((a, b) => a.num - b.num);
  const idxNums = indexRows.map(r => r.num);
  const lo = idxNums.length ? String(Math.min(...idxNums)).padStart(3, '0') : '001';
  const hi = idxNums.length ? String(Math.max(...idxNums)).padStart(3, '0') : '000';
  const idx = [
    `# 《${book.title}》章节索引（chapter_index.md）`, '',
    `> 从番茄导入：全书章号 ${lo}–${hi}，共 ${indexRows.length} 章。`, '',
    '| 全局章号 | 章名 | 卷 | 路径 | 状态 |', '|---|---|---|---|---|',
    ...indexRows.map(r => `| ${String(r.num).padStart(3, '0')} | ${r.name} | ${r.vol} | chapters/${r.vol}/${r.file} | 已写 |`),
  ].join('\n');
  try { fs.writeFileSync(path.join(book.dir, 'chapter_index.md'), idx + '\n', 'utf8'); } catch {}

  // 配好番茄发布配置 → 完结收口/完本感言可直接用
  try { setBookPublish(book.slug, { profilePath, bookId, bookName: book.title }); } catch {}

  log('act', `✅ 导入完成：《${book.title}》${plan.length} 卷 / ${done} 章${failed ? `（${failed} 章正文为空已跳过）` : ''}。番茄发布配置已自动绑定，可直接用完结收口/完本感言。`);
  log('act', '从番茄导入结束');
  return { ok: true, slug: book.slug, title: book.title, volumes: plan.length, chapters: done, failed };
}
