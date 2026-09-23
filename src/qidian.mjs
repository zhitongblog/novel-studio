// 发布到起点（阅文作家专区 write.qq.com）。
//
// 与番茄那条线的关系：复用同一个 UnzooClient（同一套 profile / 标签页 / 反检测），
// 但起点的后台结构完全不同，所以单独一个模块，不去动已经稳定的 fanqie.mjs。
//
// 2026-09-21 实地摸出来的路径与结构（下面每一条都是在真实后台上验证过的）：
//   作品列表   https://write.qq.com/portal/dashboard/books
//              书卡 .g-prodution-item，里面能读到：编辑组、连载状态、书名、最新章、更新时间
//              每张卡的链接里带 CBID：/CBID/(\d+)
//   章节列表   https://write.qq.com/portal/booknovels/chaptertmp/CBID/{cbid}?entry=publish
//              章节条目 .search-res-item，文本形如「第44章 楚婉儿的初次相遇」
//   新建章节   https://write.qq.com/portal/booknovels/chaptertmp/CBID/{cbid}/addType/1.html
//              标题   #inputTitle（placeholder 明说要「章节号与章节名」，如「第十章 天降奇缘2」）
//              正文   TinyMCE：iframe#mce_0_ifr —— 【同源可访问，body.isContentEditable=true】
//                     所以能直接用 tinymce API 写，不必像番茄那样跟富文本框硬碰
//              卷     .volume-list（第一卷 / 公众章节）
//              按钮   保存 / 发布
//
// ⚠️ 纪律：本模块里【只有 publishChapterToQidian 会改动线上内容】，其余全是只读。
// 发布是不可逆的（读者立刻可见），所以调用方必须显式传 confirm:true 才会真发。

import { UnzooClient } from './fanqie.mjs';

const HOST = 'write.qq.com';
const BOOKS_URL = 'https://write.qq.com/portal/dashboard/books';
const chapterListUrl = (cbid) => `https://write.qq.com/portal/booknovels/chaptertmp/CBID/${cbid}?entry=publish`;
const newChapterUrl = (cbid) => `https://write.qq.com/portal/booknovels/chaptertmp/CBID/${cbid}/addType/1.html`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 「第44章 楚婉儿的初次相遇」→ 44。也认中文数字（起点上两种写法都有：第26章 / 第二十一章）。
const CN = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
function cnToNum(s) {
  s = String(s || '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // 支持到「九百九十九」这一量级，够用
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (CN[ch] != null) { num = CN[ch]; continue; }
    if (ch === '十') { section += (num || 1) * 10; num = 0; continue; }
    if (ch === '百') { section += (num || 1) * 100; num = 0; continue; }
  }
  total = section + num;
  return total || NaN;
}
export function chapterNumOf(title) {
  // 字符类里必须带「零」：起点上真有「第一百零八章」这种写法，漏了会整章解析成 0，
  // 而 0 会被增量发布当成「线上还没有这章」→ 重复发。
  const m = String(title || '').match(/第\s*([0-9零一二三四五六七八九十百两]+)\s*章/);
  if (!m) return 0;
  const n = cnToNum(m[1]);
  return Number.isFinite(n) ? n : 0;
}

// 等页面上某个选择器真的出现（起点是前端渲染的，导航完成 ≠ 内容就绪）
async function waitFor(client, selector, { timeoutMs = 20000, pollMs = 500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await client.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (ok) return true;
    await sleep(pollMs);
  }
  return false;
}

async function ensureLoggedIn(client) {
  const url = String(await client.evaluate('location.href') || '');
  if (/passport|login|\/login/i.test(url)) {
    throw new Error('起点作家专区未登录（页面跳到了登录页）。请先在该 Unzoo 账号窗口登录 write.qq.com 后重试。');
  }
}

// ── 只读①：列出该账号下的作品 ────────────────────────────────────
// 返回 [{ cbid, title, status, group, latestChapter, latestNum, updatedAt }]
export async function getQidianBooks({ profilePath, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  const client = new UnzooClient(profilePath || null, onLog || null, HOST, '起点作家专区', BOOKS_URL);
  log('打开起点作品管理…', 'act');
  await client.navigate(BOOKS_URL);
  await sleep(2500);
  await ensureLoggedIn(client);
  if (!(await waitFor(client, '.g-prodution-item'))) {
    return { ok: false, error: '没读到作品列表（页面结构可能变了，或该账号没有作品）', books: [] };
  }
  const raw = await client.evaluate(`(function(){
    var out = [];
    document.querySelectorAll('.g-prodution-item').forEach(function(el){
      var txt = (el.textContent||'').replace(/\\s+/g,' ').trim();
      var a = el.querySelector('a[href*="CBID/"]');
      var m = a && a.href.match(/CBID\\/(\\d+)/);
      out.push({ cbid: m ? m[1] : '', text: txt });
    });
    return JSON.stringify(out);
  })()`);
  let items = [];
  try { items = JSON.parse(String(raw || '[]')); } catch {}
  const books = items.filter(x => x.cbid).map(x => {
    const t = x.text;
    // 卡片文本形如：「第八编辑组 连载中 韩信，这一世，我不做齐王 第26章 陈胜死讯 2026-01-25 10:59 更新 收藏 5 …」
    const group = (t.match(/第[一-龥]+编辑组/) || [''])[0];
    // 状态词表要全：漏一个，那个词就会被下面的书名切分当成书名的一部分。
    // 实测《重返1994》是「读者不可见」，漏掉它时书名读成了「读者不可见 重返1994」。
    const status = (t.match(/连载中|已完本|锁定\/屏蔽|读者不可见|审核中|已上架|太监/) || [''])[0];
    const latestChapter = (t.match(/第\s*[0-9一二三四五六七八九十百两]+\s*章[^0-9]{0,30}/) || [''])[0].trim();
    const updatedAt = (t.match(/\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}/) || [''])[0];
    // 书名：夹在状态和「第N章」之间的那一段
    let title = t;
    if (group) title = title.split(group).pop();
    if (status) title = title.split(status).pop();
    if (latestChapter) title = title.split(latestChapter)[0];
    title = title.trim();
    return { cbid: x.cbid, title, status, group, latestChapter, latestNum: chapterNumOf(latestChapter), updatedAt };
  });
  log(`读到 ${books.length} 本：${books.map(b => b.title + '(' + (b.status || '?') + ')').join('、')}`);
  return { ok: true, books };
}

// ── 只读②：读某本书在起点上已发布到第几章 ──────────────────────────
// 这是增量发布的地基：发之前必须知道线上到哪了，否则会重复发。
// 章节条目 .search-res-item，文本形如「第44章 楚婉儿的初次相遇」。
export async function getQidianMaxChapter({ profilePath, cbid, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!cbid) throw new Error('缺少 cbid');
  const client = new UnzooClient(profilePath || null, onLog || null, HOST, '起点作家专区', BOOKS_URL);
  await client.navigate(chapterListUrl(cbid));
  await sleep(2500);
  await ensureLoggedIn(client);
  if (!(await waitFor(client, '.search-res-item', { timeoutMs: 20000 }))) {
    return { ok: false, error: '没读到章节列表（页面未就绪或该书还没有章节）', maxChapter: 0, titles: [] };
  }
  // ⚠️ 起点的章节列表是懒加载的，先把列表滚到底，否则只读得到最近十几章。
  await client.evaluate(`(function(){
    var box = document.querySelector('.capter-list, [class*="chapter-list"], .search-res-list');
    if (box) { box.scrollTop = box.scrollHeight; }
    window.scrollTo(0, document.body.scrollHeight);
    return 1;
  })()`);
  await sleep(1200);
  const raw = await client.evaluate(`(function(){
    var out = [];
    document.querySelectorAll('.search-res-item').forEach(function(el){
      var t = (el.textContent||'').replace(/\\s+/g,' ').trim();
      if (t) out.push(t);
    });
    return JSON.stringify(out);
  })()`);
  let titles = [];
  try { titles = JSON.parse(String(raw || '[]')); } catch {}
  const nums = titles.map(chapterNumOf).filter(n => n > 0);
  const maxChapter = nums.length ? Math.max(...nums) : 0;
  log(`起点上已发到第 ${maxChapter} 章（读到 ${titles.length} 条章节记录）`);
  return { ok: true, maxChapter, count: titles.length, titles };
}

// ── 写①：把一章写进起点后台 ───────────────────────────────────────
//
// 与番茄那条线最大的不同：起点用的是 TinyMCE，且【挂在 window 上、iframe 同源】，
// 所以能直接调官方 API setContent —— 不必像番茄的 Lexical 那样靠模拟键盘一个字一个字敲
// （那条路踩过丢字的坑，见 fanqie.mjs 的注释）。
//
// 两档，默认是可逆的那档：
//   mode:'draft'   只点【保存】——存成草稿，读者看不到，随时能改能删。
//   mode:'publish' 点【发布】——不可逆，所以【必须显式传 confirm:true】才会真点。
//
// 段落处理：正文按空行/换行切段，每段包一层 <p>。
// 不自己加全角缩进——起点前台会自己排版，我们再加就成了双重缩进。
export async function publishChapterToQidian({
  profilePath, cbid, title, content, mode = 'draft', confirm = false, onLog,
} = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!cbid) throw new Error('缺少 cbid');
  if (!title) throw new Error('缺少章节标题');
  const body = String(content || '').trim();
  if (!body) throw new Error('正文是空的');
  if (mode === 'publish' && !confirm) {
    throw new Error('发布不可逆，需显式传 confirm:true');
  }

  const paras = body.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);
  const chars = (body.match(/[一-鿿]/g) || []).length;
  log(`准备写入「${title}」：${paras.length} 段 / ${chars} 个汉字`, 'act');

  const client = new UnzooClient(profilePath || null, onLog || null, HOST, '起点作家专区', BOOKS_URL);
  await client.navigate(newChapterUrl(cbid));
  await sleep(4000);
  await ensureLoggedIn(client);
  if (!(await waitFor(client, '#inputTitle', { timeoutMs: 25000 }))) {
    throw new Error('新建章节页没加载出来（#inputTitle 未出现）');
  }
  // TinyMCE 是异步初始化的，等它真的挂上来
  const mceReady = await waitForFn(client,
    `(typeof window.tinymce !== 'undefined' && window.tinymce.editors && window.tinymce.editors.length > 0)`,
    { timeoutMs: 25000 });
  if (!mceReady) throw new Error('TinyMCE 编辑器没初始化出来');

  // 标题：两级写入。
  //
  // 实测（2026-09-21）在这个页面上 browser_click 和 browser_type 双双失败，标题框始终是空的
  // ——不是"打进去了没校验到"那种误报，是真没打进去。所以不能只靠真实键盘那一条路。
  // 兜底走 React 受控组件的标准注入法：拿到 HTMLInputElement.prototype 上的原生 value setter
  // 来赋值（绕开 React 自己装的 value tracker），再派发 input 事件让 React 认这次变更。
  // 直接 i.value = x 是【没用】的：React 的 tracker 会认为值没变，onChange 根本不触发，
  // 点保存时提交上去的仍是空标题。
  await writeTitle(client, title, log);
  await sleep(600);

  // 正文：走 TinyMCE 官方 API。setContent 之后补一次 change，让页面知道内容脏了
  // （不补的话「保存」按钮可能仍是禁用态）。
  const html = paras.map(p => '<p>' + p
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>').join('');
  await client.evaluate(`(function(){
    var ed = window.tinymce.editors[0];
    ed.setContent(${JSON.stringify(html)});
    ed.fire('change'); ed.fire('input');
    if (ed.undoManager) ed.undoManager.add();
    return 1;
  })()`);
  await sleep(1200);

  // 真判据：把标题和正文从页面读回来，确认写进去了
  const checkRaw = await client.evaluate(`(function(){
    var ed = window.tinymce.editors[0];
    var text = (ed.getContent({format:'text'})||'');
    return JSON.stringify({
      title: (document.querySelector('#inputTitle')||{}).value || '',
      chars: (text.match(/[\\u4e00-\\u9fff]/g)||[]).length,
      paras: (ed.getContent()||'').split('</p>').length - 1
    });
  })()`);
  let check = {};
  try { check = JSON.parse(String(checkRaw || '{}')); } catch {}
  log(`读回：标题「${check.title}」正文 ${check.chars} 字 / ${check.paras} 段`);
  if (check.title !== title) {
    throw new Error(`标题没写对：期望「${title}」实际「${check.title}」`);
  }
  // 允许少量误差（标点/空白不计入汉字统计），但差太多说明正文被截了
  if (!(check.chars >= chars * 0.95)) {
    throw new Error(`正文写入不完整：本地 ${chars} 字，页面上只有 ${check.chars} 字`);
  }

  // 点按钮
  const wantText = mode === 'publish' ? '发布' : '保存';
  log(mode === 'publish' ? '点【发布】——线上会立刻生效' : '点【保存】——存草稿，可逆', 'act');
  const clicked = await client.evaluate(`(function(){
    var bs = [].slice.call(document.querySelectorAll('button'));
    var b = bs.filter(function(x){ return (x.textContent||'').trim() === ${JSON.stringify(wantText)} && x.offsetParent; })[0];
    if (!b) return 'notfound';
    if (b.disabled) return 'disabled';
    b.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') throw new Error(`【${wantText}】按钮点不了：${clicked}`);
  await sleep(3500);

  // 结果判定：起点保存/发布后会跳走或弹提示，两者都认
  const after = await client.evaluate(`(function(){
    var toast = document.querySelector('.ui-toast, .toast, [class*="message"], [class*="tips"]');
    return JSON.stringify({
      url: location.href,
      toast: toast ? (toast.textContent||'').trim().slice(0,60) : ''
    });
  })()`);
  let a = {};
  try { a = JSON.parse(String(after || '{}')); } catch {}
  // 成功判据。实测起点保存后【不跳页】，只是给 URL 追加 #ccid=<新章节ID>——
  // 那个 ccid 就是后台给这一章分配的 ID，出现即代表章节已经建出来了（已在章节列表里核实过）。
  // 所以不能只看"有没有离开编辑页"，那条判据太严，会把成功的保存报成"结果不确定"。
  const url = String(a.url || '');
  const gotCcid = /[#?&]ccid=\d+/.test(url);
  const leftEditor = !/addType/.test(url);
  const okToast = /成功|已保存|已发布/.test(String(a.toast || ''));
  const ok = gotCcid || leftEditor || okToast;
  log(ok ? `${wantText}成功${a.toast ? '：' + a.toast : '（已离开编辑页）'}`
         : `${wantText}结果不确定：url=${a.url} toast=${a.toast}`, ok ? 'info' : 'warn');
  return { ok, mode, title, chars: check.chars, toast: a.toast || '', url: a.url || '' };
}

// 写标题：先试真实键盘，读回不对再用原生 setter 注入。两条路都写不进去才算失败。
async function writeTitle(client, title, log) {
  const readBack = () => client.evaluate(`(document.querySelector('#inputTitle')||{}).value || ''`);
  try {
    await client.trustedType('#inputTitle', title);
    await sleep(500);
    if (String(await readBack()) === title) return 'typed';
  } catch (e) {
    const msg = String(e?.message || e);
    // 页面没开、框找不到这类是真失败，原样抛；只有输入/校验类才继续走兜底
    if (!/not_verified|verify|未观察到|browser_type|browser_click|timeout/i.test(msg)) throw e;
  }
  log('真实键盘写标题没成功，改用原生 setter 注入', 'warn');
  await client.evaluate(`(function(){
    var i = document.querySelector('#inputTitle');
    if (!i) return 0;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(title)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(700);
  if (String(await readBack()) !== title) throw new Error('标题两种写法都没写进去');
  return 'injected';
}

// 等一个 JS 表达式为真（用于等 TinyMCE 这类异步初始化的东西）
async function waitForFn(client, expr, { timeoutMs = 20000, pollMs = 500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await client.evaluate(expr)) return true; } catch {}
    await sleep(pollMs);
  }
  return false;
}

// ── 只读③：预览将发哪些章（不碰线上）──────────────────────────────
// 与番茄版 previewPublish 同一个思路：把「线上到哪了 / 本地到哪了 / 这次要发哪些」摆清楚，
// 让人先看明白再决定发不发。
export async function previewQidianPublish({ profilePath, cbid, chapters, onLog } = {}) {
  const r = await getQidianMaxChapter({ profilePath, cbid, onLog });
  if (!r.ok) return { ok: false, error: r.error };
  const all = (chapters || []).slice().sort((a, b) => a.num - b.num);
  const pending = all.filter(c => c.num > r.maxChapter);
  return {
    ok: true,
    onlineMax: r.maxChapter,
    localMax: all.length ? all[all.length - 1].num : 0,
    pending: pending.map(c => ({ num: c.num, title: c.title, chars: (String(c.content || '').match(/[一-鿿]/g) || []).length })),
  };
}
