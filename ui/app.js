// Novel Studio GUI 前端逻辑（零依赖）。served by Node 引擎 / 或 Tauri 加载。
// Tauri v2(Win) 用 http://tauri.localhost 提供资源 → 此时引擎在另一个源(127.0.0.1:8799)；
// 浏览器直连引擎时则用同源。
const IS_TAURI = location.hostname === 'tauri.localhost' || location.protocol === 'tauri:' || (typeof window !== 'undefined' && !!window.__TAURI__);
const API = (!IS_TAURI && (location.protocol === 'http:' || location.protocol === 'https:'))
  ? location.origin : 'http://127.0.0.1:8799';

// 调 Tauri 原生命令（桌面应用内可用）。v2: window.__TAURI__.core.invoke；v1: window.__TAURI__.invoke。
const HAS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;
async function tauriInvoke(cmd, args) {
  const t = window.__TAURI__;
  if (!t) throw new Error('not-tauri');
  const inv = (t.core && t.core.invoke) || t.invoke;
  if (!inv) throw new Error('invoke 不可用');
  return inv(cmd, args);
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTok = (n) => !n ? '0' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : '' + n;

async function api(p, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(API + p, opt);
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

let STATE = { models: [], books: [], sessions: [], config: {}, env: null };
let STOP_DRAINING = false;   // 优雅停止中（按钮已变"立即停止"）
let CUR = null;       // 当前打开的书
let STREAM = null;    // 当前 SSE
const PUBLISHING = new Set();   // 正在发布的书 slug（客户端状态；关弹窗后仍可从书卡回到进度）

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- 导航 ----------
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(name) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const map = { shelf: 'view-shelf', usage: 'view-usage', settings: 'view-settings', env: 'view-env' };
  $('#' + (map[name] || 'view-shelf')).classList.remove('hidden');
  if (name === 'usage') renderUsage();
  if (name === 'settings') renderSettings();
  if (name === 'env') renderEnv();
  if (name === 'shelf') closeStream();
}

// ---------- 启动 ----------
async function boot() {
  try {
    const b = await api('/api/bootstrap');
    STATE = { ...STATE, ...b };
    try { STATE.styles = await api('/api/styles'); } catch { STATE.styles = []; }
    $('#engineDot').classList.add('ok'); $('#engineText').textContent = '引擎已连接';
    renderShelf(); fillModels(); fillStyles();
  } catch (e) {
    $('#engineDot').classList.add('bad'); $('#engineText').textContent = '引擎未连接';
    setTimeout(boot, 1500);
  }
}
async function refresh() { try { const b = await api('/api/bootstrap'); STATE = { ...STATE, ...b }; renderShelf(); } catch {} }

function fillModels() {
  const opts = STATE.models.map(m => `<option value="${m.id}" ${m.available ? '' : 'disabled'}>${esc(m.name)}${m.available ? '' : '（未装）'}</option>`).join('');
  $('#nbModel').innerHTML = opts; $('#writeModel').innerHTML = opts;
  const imp = $('#nbImpModel'); if (imp) imp.innerHTML = opts;
}
function fillStyles() {
  const sel = $('#nbStyle'); if (!sel) return;
  const presets = (STATE.styles || []).map(s => `<option value="${s.id}">${esc(s.name)}（${esc(s.short)}）</option>`).join('');
  sel.innerHTML = `<option value="auto">🤖 AI 据题材自动选（推荐）</option>` + presets;
}

// ---------- 书架 ----------
function renderShelf() {
  const shelf = $('#shelf'); shelf.innerHTML = '';
  const running = new Set(STATE.sessions.filter(s => s.running !== false).map(s => s.slug));
  for (const b of STATE.books) {
    const card = el('div', 'book-card');
    const coverImg = b.stats?.cover
      ? `<img class="card-cover" src="${API}/api/book/cover?book=${encodeURIComponent(b.slug)}&t=${b.stats.coverMtime || 0}" alt="封面">`
      : `<div class="card-cover none">无<br>封面</div>`;
    card.innerHTML = `
      ${running.has(b.slug) ? '<div class="running-tag"><span class="dot live"></span>写作中</div>' : ''}
      <button class="card-del" data-act="del" title="删除这本书">🗑</button>
      <div class="card-top">
        ${coverImg}
        <div class="card-info">
          <h3>《${esc(b.title)}》</h3>
          <div class="genre">${esc(b.genre || '—')}</div>
        </div>
      </div>
      <div class="meta">
        <span class="pill model">${esc(modelName(b.model))}</span>
        ${b.status === '已完本' ? '<span class="pill done">✅ 已完本</span>' : b.status === '收尾中' ? '<span class="pill finale">🏁 收尾中</span>' : ''}
        ${b.fanqie?.status ? `<span class="pill ${b.fanqie.status === '已完结' ? 'done' : (b.status === '已完本' && b.fanqie.status !== '已完结' ? 'warn' : '')}" title="番茄平台状态">番茄·${esc(b.fanqie.status)}</span>` : ''}
        <span class="pill">${b.stats?.chapters || 0} 章</span>
        <span class="pill">${b.stats?.kb || 0} KB</span>
        <span class="pill">tokens ${fmtTok(b.tokens || 0)}</span>
        ${PUBLISHING.has(b.slug) ? '<span class="pill publishing" data-act="pubbadge" title="正在发布到番茄，点我看进度">📤 发布中</span>' : ''}
      </div>
      <div class="card-actions">
        <button class="card-btn" data-act="write">✍️ 写作</button>
        <button class="card-btn" data-act="read">📖 阅读</button>
        <button class="card-btn" data-act="review">🔍 复检</button>
      </div>`;
    card.querySelector('[data-act="write"]').addEventListener('click', (e) => { e.stopPropagation(); openWrite(b); });
    card.querySelector('[data-act="read"]').addEventListener('click', (e) => { e.stopPropagation(); openReader(b); });
    card.querySelector('[data-act="review"]').addEventListener('click', (e) => { e.stopPropagation(); CUR = b; openReview(); });
    card.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); openDelete(b); });
    const pubBadge = card.querySelector('[data-act="pubbadge"]');
    if (pubBadge) pubBadge.addEventListener('click', (e) => { e.stopPropagation(); CUR = b; openPublish(b); });
    card.addEventListener('click', () => openWrite(b));
    shelf.appendChild(card);
  }
  const add = el('div', 'book-card new', '＋ 新建书');
  add.addEventListener('click', openModal);
  shelf.appendChild(add);
}
function modelName(id) { return (STATE.models.find(m => m.id === id) || {}).name || id; }

// ---------- 写作工作台 ----------
function openWrite(book) {
  CUR = book; showWriteView();
  $('#writeTitle').textContent = '《' + book.title + '》';
  $('#writeModel').value = book.model || STATE.config.defaultModel;
  $('#writeTask').value = `请阅读 AGENTS.md 写作规范与 novel_bible.md，续写下一批 ${book.standards?.batchSize || 3} 章，写完自检。`;
  $('#mirror').textContent = '（开始写作后，这里实时显示 AI 写作过程）';
  $('#logFeed').innerHTML = '';
  $('#wbTarget').value = book.targetChapters || 0;
  $('#writeMode').value = book.writeMode === 'review' ? 'review' : 'auto';
  $('#synText').value = book.synopsis || '';
  const running = STATE.sessions.find(s => s.slug === book.slug && s.running !== false);
  setWriting(!!running);
  $('#writeTokens').textContent = 'tokens ' + fmtTok(book.tokens || 0);
  hideReviewBar(); showReviewBar();   // 若有待确认审稿，恢复动作条
  if (running) openStream(book.slug);
}
function showWriteView() {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#view-write').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
}
function setWriting(on) {
  if (on) { STOP_DRAINING = false; $('#btnStop').textContent = '■ 停止'; }
  $('#btnStart').disabled = on; $('#btnStop').disabled = !on;
  $('#writeStatus').textContent = on ? '写作中' : '未开始';
  $('#writeStatus').classList.toggle('on', on);
  $('#mirrorDot').style.display = on ? '' : 'none';
}
$('#btnBack').addEventListener('click', () => { closeStream(); showView('shelf'); refresh(); });

// 无状态模式开关：显示/隐藏批数输入
$('#statelessMode').addEventListener('change', () => {
  $('#slBatchWrap').classList.toggle('hidden', !$('#statelessMode').checked);
});
$('#btnStart').addEventListener('click', async () => {
  if (!CUR) return;
  $('#btnStart').disabled = true; $('#writeStatus').textContent = '启动中…';
  const model = $('#writeModel').value;
  const isWeb = (STATE.models || []).find(m => m.id === model)?.kind === 'web';
  const stateless = $('#statelessMode').checked;
  try {
    if (isWeb) {
      // 网页版写作：驱动 通义千问/ChatGPT/Claude 网页版，模型只吐文字→引擎抓正文自己落盘（批数复用无状态那个输入）。
      const batches = Math.max(1, parseInt($('#statelessBatches').value, 10) || 3);
      const nm = (STATE.models || []).find(m => m.id === model)?.name || model;
      await api('/api/book/web-write', 'POST', { book: CUR.slug, adapterId: model.replace(/^web-/, ''), batches });
      $('#mirror').textContent = '🌐 网页版写作运行中（驱动网页聊天框写作、抓正文落盘，无窗口镜像）。进度见下方日志。';
      setWriting(true); openStream(CUR.slug);
      toast(`网页版写作启动：${nm}（${batches} 批）`);
    } else if (stateless) {
      const batches = Math.max(1, parseInt($('#statelessBatches').value, 10) || 3);
      const r = await api('/api/book/stateless-start', 'POST', { book: CUR.slug, model: $('#writeModel').value, batches });
      $('#mirror').textContent = '♻️ 无状态省钱模式运行中（无窗口镜像）。进度见下方日志：每批全新进程写作，写完即弃会话。';
      setWriting(true); openStream(CUR.slug);
      toast(r.untilTarget ? '无状态模式：写到目标章数（可随时停）' : `无状态模式：写 ${batches} 批`);
    } else {
      const writeMode = $('#writeMode').value === 'review' ? 'review' : 'auto';
      await api('/api/write', 'POST', { book: CUR.slug, model: $('#writeModel').value, task: $('#writeTask').value, writeMode });
      if (CUR) CUR.writeMode = writeMode;
      setWriting(true); openStream(CUR.slug);
      toast(writeMode === 'review' ? '已开窗 · 逐批审核模式（每批写完会停下等你）' : '已开窗，autopilot 全自动运行中');
    }
  } catch (e) { toast('启动失败：' + e.message); setWriting(false); }
});
// 写作模式热切换（提前选或写作中随时切）：立即生效，无需重开窗口
$('#writeMode').addEventListener('change', async () => {
  if (!CUR) return;
  const mode = $('#writeMode').value === 'review' ? 'review' : 'auto';
  try {
    await api('/api/book/review-mode', 'POST', { book: CUR.slug, mode });
    CUR.writeMode = mode; const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.writeMode = mode;
    if (mode === 'auto') hideReviewBar();
    toast(mode === 'review' ? '已切到逐批审核：下一批写完会停下等你' : '已切到全自动：连续写作不再停顿');
  } catch (e) { toast('切换失败：' + e.message); }
});
$('#btnStop').addEventListener('click', async () => {
  if (!CUR) return;
  try {
    const r = await api('/api/stop', 'POST', { book: CUR.slug, force: STOP_DRAINING });
    if (r.mode === 'draining') {
      STOP_DRAINING = true; $('#btnStop').textContent = '■ 立即停止';
      toast('已请求优雅停止：写完当前批次后自动关闭（再点一次=立即停止）');
    } else {
      STOP_DRAINING = false; $('#btnStop').textContent = '■ 停止';
      setWriting(false); closeStream(); toast('已停止并关闭窗口');
    }
  } catch (e) { toast(e.message); }
});
// 切换模型即持久化到 book.model（卡片/下次默认值/续写都跟上）。运行中的旧窗口换不了模型，提示需重开。
$('#writeModel').addEventListener('change', async () => {
  if (!CUR) return;
  const model = $('#writeModel').value;
  try {
    const r = await api('/api/book/set-model', 'POST', { book: CUR.slug, model });
    CUR.model = model;
    const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.model = model;
    if (r.needReopen) toast(`已切到 ${modelName(model)}：当前窗口在跑 ${modelName(r.liveModel)}，点“写作/续写”会停旧窗口用新模型重开`);
    else toast('默认模型已切到 ' + modelName(model));
  } catch (e) { toast('切换模型失败：' + e.message); }
});
// ---------- 复检 ----------
function openReview() {
  if (!CUR) return;
  $('#rvErr').textContent = '';
  // 取最新的书(含 stats: volumes / maxChapter / chapters)
  const b = STATE.books.find(x => x.slug === CUR.slug) || CUR;
  const st = b.stats || {};
  const vols = st.volumes || [];
  const maxCh = st.maxChapter || st.chapters || 0;
  $('#rvBookInfo').textContent = `（共 ${st.chapters || 0} 章` + (vols.length ? ` · ${vols.length} 卷` : '') + '）';
  $('#rvVol').innerHTML = vols.length ? vols.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('') : '<option value="">（无分卷目录）</option>';
  $('#rvFrom').value = 1; $('#rvTo').value = maxCh || '';
  $('#rvRangeType').value = 'all'; rvSync();
  $('#reviewModal').classList.remove('hidden');
}
function rvSync() {
  const t = $('#rvRangeType').value;
  $('#rvVolWrap').classList.toggle('hidden', t !== 'vol');
  $('#rvChapWrap').classList.toggle('hidden', t !== 'chap');
  $('#rvRecentWrap').classList.toggle('hidden', t !== 'recent');
}
function rvRange() {
  const t = $('#rvRangeType').value;
  if (t === 'all') return '全书';
  if (t === 'vol') return $('#rvVol').value || '全书';
  if (t === 'recent') return '最近' + (Number($('#rvRecent').value) || 10) + '章';
  // chap：零填充三位
  const pad = n => String(Math.max(1, Number(n) || 1)).padStart(3, '0');
  return pad($('#rvFrom').value) + '-' + pad($('#rvTo').value);
}
$('#btnReview').addEventListener('click', openReview);
$('#rvRangeType').addEventListener('change', rvSync);
$('#rvClose').addEventListener('click', () => $('#reviewModal').classList.add('hidden'));
$('#rvCancel').addEventListener('click', () => $('#reviewModal').classList.add('hidden'));
$('#reviewModal').addEventListener('click', (e) => { if (e.target === $('#reviewModal')) $('#reviewModal').classList.add('hidden'); });
$('#rvStart').addEventListener('click', async () => {
  if (!CUR) return;
  const dims = [];
  if ($('#rvLogic').checked) dims.push('logic');
  if ($('#rvStyle').checked) dims.push('style');
  if ($('#rvPlaus').checked) dims.push('plausibility');
  if ($('#rvPace')?.checked) dims.push('pace');
  if (!dims.length) { $('#rvErr').textContent = '至少选一个维度'; return; }
  const range = rvRange();
  const model = (STATE.books.find(b => b.slug === CUR.slug) || CUR).model || STATE.config.defaultModel;
  $('#rvStart').disabled = true; $('#rvErr').textContent = '启动复检…';
  try {
    const r = await api('/api/book/review', 'POST', { book: CUR.slug, range, dims, model });
    $('#reviewModal').classList.add('hidden'); $('#rvStart').disabled = false;
    setWriting(true); openStream(CUR.slug);
    toast(r.mode === 'inserted' ? '已穿插复检：' + range : '复检已开始：' + range);
  } catch (e) { $('#rvErr').textContent = '失败：' + e.message; $('#rvStart').disabled = false; }
});

// ---------- 简介 ----------
$('#btnGenSyn').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#btnGenSyn'); const old = btn.textContent; btn.disabled = true; btn.textContent = '生成中…';
  try {
    const r = await api('/api/book/synopsis', 'POST', { book: CUR.slug });
    $('#synText').value = r.synopsis || '';
    CUR.synopsis = r.synopsis; const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.synopsis = r.synopsis;
    toast(`简介已生成（${r.synopsis.length}字 · ${modelName(r.model)}）`);
  } catch (e) { toast('生成失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#btnCopySyn').addEventListener('click', async () => {
  const t = $('#synText').value.trim(); if (!t) { toast('简介为空'); return; }
  try { await navigator.clipboard.writeText(t); toast('简介已复制'); }
  catch { $('#synText').select(); document.execCommand && document.execCommand('copy'); toast('简介已复制'); }
});
// 手改后失焦自动保存
$('#synText').addEventListener('blur', async () => {
  if (!CUR) return;
  const t = $('#synText').value.trim();
  if (t === (CUR.synopsis || '')) return;
  try { await api('/api/book/synopsis', 'POST', { book: CUR.slug, text: t }); CUR.synopsis = t; const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.synopsis = t; }
  catch (e) { toast('简介保存失败：' + e.message); }
});

// ---------- 打开书目录 ----------
$('#btnOpenDir').addEventListener('click', async () => {
  if (!CUR) return;
  try { const r = await api('/api/book/open-dir', 'POST', { book: CUR.slug }); toast('已打开目录：' + r.dir); }
  catch (e) { toast('打开失败：' + e.message); }
});

// ---------- 重写 ----------
$('#btnRewrite').addEventListener('click', () => {
  if (!CUR) return;
  $('#rwErr').textContent = ''; $('#rwMode').value = 'range'; $('#rwRange').value = ''; $('#rwNote').value = '';
  $('#rwRangeWrap').classList.remove('hidden');
  $('#rewriteModal').classList.remove('hidden');
});
$('#rwMode').addEventListener('change', () => { $('#rwRangeWrap').classList.toggle('hidden', $('#rwMode').value !== 'range'); });
$('#rwClose').addEventListener('click', () => $('#rewriteModal').classList.add('hidden'));
$('#rwCancel').addEventListener('click', () => $('#rewriteModal').classList.add('hidden'));
$('#rewriteModal').addEventListener('click', (e) => { if (e.target === $('#rewriteModal')) $('#rewriteModal').classList.add('hidden'); });
$('#rwGo').addEventListener('click', async () => {
  if (!CUR) return;
  const mode = $('#rwMode').value;
  const range = $('#rwRange').value.trim();
  const note = $('#rwNote').value.trim();
  if (mode === 'range' && !range) { $('#rwErr').textContent = '请填重写范围（如 001-008 或 卷01）'; return; }
  if (mode === 'reproject' && !confirm('整本重立项会让作者从头重写 bible+大纲+全部正文（旧内容已 git 存档可回退）。确定？')) return;
  $('#rwGo').disabled = true; $('#rwErr').textContent = '准备中…';
  try {
    const url = mode === 'reproject' ? '/api/book/reproject' : '/api/book/rewrite';
    const r = await api(url, 'POST', { book: CUR.slug, range, note });
    $('#rewriteModal').classList.add('hidden');
    if (r.mode === 'started') { setWriting(true); openStream(CUR.slug); }
    toast((r.mode === 'inserted' ? '已穿插重写指令' : '已开窗重写') + (r.snapshot ? '（存档 ' + r.snapshot + '）' : ''));
  } catch (e) { $('#rwErr').textContent = e.message; }
  finally { $('#rwGo').disabled = false; }
});

// ---------- 改书名 ----------
$('#btnRename').addEventListener('click', () => {
  if (!CUR) return;
  $('#rnErr').textContent = ''; $('#rnInput').value = CUR.title || '';
  $('#renameModal').classList.remove('hidden'); $('#rnInput').focus();
});
$('#rnClose').addEventListener('click', () => $('#renameModal').classList.add('hidden'));
$('#rnCancel').addEventListener('click', () => $('#renameModal').classList.add('hidden'));
$('#renameModal').addEventListener('click', (e) => { if (e.target === $('#renameModal')) $('#renameModal').classList.add('hidden'); });
$('#rnInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#rnSave').click(); });
$('#rnSave').addEventListener('click', async () => {
  if (!CUR) return;
  const t = $('#rnInput').value.trim();
  if (!t) { $('#rnErr').textContent = '请输入新书名'; return; }
  if (t === CUR.title) { $('#renameModal').classList.add('hidden'); return; }
  $('#rnSave').disabled = true; $('#rnErr').textContent = '改名中…';
  try {
    const r = await api('/api/book/rename', 'POST', { book: CUR.slug, title: t });
    CUR.title = r.title; const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.title = r.title;
    $('#writeTitle').textContent = '《' + r.title + '》';
    $('#renameModal').classList.add('hidden');
    toast(`已改名为《${r.title}》（改写 ${r.touched} 个文件，全书生效）`);
    refresh();
  } catch (e) { $('#rnErr').textContent = e.message; }
  finally { $('#rnSave').disabled = false; }
});

// ---------- 发布番茄 ----------
let PB_PROFILES = [];   // 缓存 Unzoo 账号列表(含权威 profile_path)
// 时间下拉：每半小时一档（00:00…23:30），值即番茄需要的 HH:MM
(function buildTimeOptions() {
  const sel = $('#pbTime'); if (!sel) return;
  let html = '<option value="">（平台默认）</option>';
  for (let h = 0; h < 24; h++) for (const mm of ['00', '30']) {
    const v = String(h).padStart(2, '0') + ':' + mm;
    html += `<option value="${v}">${v}</option>`;
  }
  sel.innerHTML = html;
})();
function pbTodayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// 日期下拉：立即发 + 今天起未来 30 天（带 周X），值=YYYY-MM-DD。WebView2 原生 type=date 常不弹日历，用下拉最稳。
(function buildDateOptions() {
  const sel = $('#pbDate'); if (!sel) return;
  const wk = ['日', '一', '二', '三', '四', '五', '六'];
  let html = '<option value="">立即发（不预约）</option>';
  const base = new Date();
  for (let i = 0; i < 31; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const v = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const rel = i === 0 ? '今天 ' : i === 1 ? '明天 ' : i === 2 ? '后天 ' : '';
    html += `<option value="${v}">${rel}${d.getMonth() + 1}月${d.getDate()}日 周${wk[d.getDay()]}</option>`;
  }
  sel.innerHTML = html;
})();
function pbFill(book) {
  const pc = book.publish || {};
  $('#pbBookId').value = pc.bookId || '';
  $('#pbPerDay').value = pc.chaptersPerDay || 'max';
  $('#pbInterval').value = pc.intervalSeconds || 3;
  $('#pbDate').value = pc.scheduledStartDate || '';
  $('#pbTime').value = pc.scheduledTime || '';
  $('#pbMatchVol').checked = !!pc.matchVolumes;
  $('#pbSyncRw').checked = !!pc.syncRewrites;
  $('#pbAuto').checked = !!pc.autoPublish;
}
function pbRenderProfiles(saved) {
  const sel = $('#pbProfile');
  if (!PB_PROFILES.length) { sel.innerHTML = '<option value="">（未检测到 Unzoo 账号，请先开浏览器并登录番茄）</option>'; return; }
  sel.innerHTML = PB_PROFILES.map(p => {
    const tag = p.fanqie.length ? `✓已开番茄${p.fanqie[0].bookId ? ' #' + p.fanqie[0].bookId : ''}`
      : (p.running ? '○运行中·未开番茄页' : '·未启动');
    const selAttr = p.path === saved ? ' selected' : '';
    const label = p.dir && p.dir !== p.name ? `${p.name} · ${p.dir}` : p.name;
    return `<option value="${esc(p.path)}"${selAttr}>${esc(label)}（${tag}）</option>`;
  }).join('');
}
// 打开发布弹窗（btnPublish 和书卡「发布中」徽标共用）。传入的 book 会设为 CUR。
async function openPublish(book) {
  book = book || CUR; if (!book) return;
  CUR = book;
  $('#pbErr').textContent = ''; $('#pbPreviewOut').style.display = 'none';
  $('#pbGo').disabled = true; $('#pbGo').textContent = '🔍 请先点「预览将发」';   // 发布前必须先预览
  const b = STATE.books.find(x => x.slug === book.slug) || book;
  pbFill(b);
  pbSyncStopBtn();   // 若这本正在发布，展示「停止发布」并接回进度
  $('#publishModal').classList.remove('hidden');
  $('#pbProfile').innerHTML = '<option value="">（加载账号…）</option>';
  $('#pbBook').innerHTML = '<option value="">（选账号后自动加载…）</option>';
  try {
    const r = await api('/api/unzoo/profiles', 'POST', {});
    PB_PROFILES = r.profiles || [];
    pbRenderProfiles((b.publish || {}).profilePath || '');
    // 选好账号后，自动读取该账号的番茄书籍并匹配当前书
    if ($('#pbProfile').value) pbLoadBooks($('#pbProfile').value);
  } catch (e) { $('#pbErr').textContent = '取账号失败：' + e.message; PB_PROFILES = []; pbRenderProfiles(''); }
}
$('#btnPublish').addEventListener('click', () => openPublish(CUR));
$('#pbProfile').addEventListener('change', () => pbLoadBooks($('#pbProfile').value));
$('#pbBook').addEventListener('change', () => { $('#pbBookId').value = $('#pbBook').value; });
// 🔄 强制重读番茄书籍（读取失败时用户能自助重试）
$('#pbBookReload').addEventListener('click', () => pbLoadBooks($('#pbProfile').value, true));

// 从所选番茄账号读取其全部书籍，填充下拉，并按 当前书名/已存bookId 自动选中
let PB_BOOKS = [];
const PB_BOOKS_CACHE = {};   // profilePath -> books[]（避免重开弹窗/切下拉时反复读番茄）
async function pbLoadBooks(profilePath, force) {
  const sel = $('#pbBook');
  const reload = $('#pbBookReload');
  if (!profilePath) { sel.innerHTML = '<option value="">（请先选账号）</option>'; $('#pbBookId').value = ''; if (reload) reload.disabled = false; return; }
  if (!force && PB_BOOKS_CACHE[profilePath]) { PB_BOOKS = PB_BOOKS_CACHE[profilePath]; pbRenderBooks(); return; }
  sel.innerHTML = '<option value="">（读取番茄书籍中…）</option>';
  if (reload) { reload.disabled = true; reload.textContent = '⏳'; }
  try {
    // 客户端超时兜底：番茄读取偶尔卡住，60s 后主动失败，别让下拉停在"读取中…"
    const r = await pbRace(api('/api/fanqie/books', 'POST', { profilePath, book: CUR.slug }), 60000, '读取番茄书籍超时');
    PB_BOOKS = r.books || [];
    if (r.ok && PB_BOOKS.length) PB_BOOKS_CACHE[profilePath] = PB_BOOKS;
    if (!r.ok || !PB_BOOKS.length) {
      sel.innerHTML = `<option value="">（${r.error || '该账号下没读到书籍'}，点右侧🔄重试）</option>`;
      $('#pbBookId').value = '';
      if (r.error) $('#pbErr').textContent = '读取番茄书籍：' + r.error;
      return;
    }
    pbRenderBooks();
  } catch (e) {
    sel.innerHTML = '<option value="">（读取失败，点右侧🔄重试）</option>';
    $('#pbErr').textContent = '读取番茄书籍失败：' + e.message;
  } finally {
    // 无论成败，重读按钮永远可点，让用户能自助重试
    if (reload) { reload.disabled = false; reload.textContent = '🔄'; }
  }
}
// 客户端超时兜底：给可能卡住的网络调用套 60s 上限，避免按钮/下拉永久停在"读取中…"
function pbRace(promise, ms, msg) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg || '请求超时')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
// 渲染番茄书籍下拉并自动选中（优先已存 bookId，其次书名精确/包含匹配）
function pbRenderBooks() {
  const sel = $('#pbBook');
  const saved = (CUR.publish || {}).bookId || '';
  const norm = s => String(s || '').replace(/[\s：:，,。.、！!？?]/g, '');
  const myTitle = norm(CUR.title);
  const pick = PB_BOOKS.find(b => b.id === saved)
    || PB_BOOKS.find(b => norm(b.title) === myTitle)
    || PB_BOOKS.find(b => myTitle && (norm(b.title).includes(myTitle) || myTitle.includes(norm(b.title))));
  sel.innerHTML = PB_BOOKS.map(b => `<option value="${esc(b.id)}"${pick && b.id === pick.id ? ' selected' : ''}>${esc(b.title || '(无名)')} · #${esc(b.id)}</option>`).join('');
  $('#pbBookId').value = pick ? pick.id : '';
  if (pick) $('#pbErr').textContent = '';
}
function pbCfg() {
  return {
    profilePath: $('#pbProfile').value,
    bookId: $('#pbBookId').value.trim(),
    bookName: CUR.title,
    chaptersPerDay: $('#pbPerDay').value.trim() || 'max',
    intervalSeconds: Number($('#pbInterval').value) || 3,
    scheduledStartDate: $('#pbDate').value.trim(),
    scheduledTime: $('#pbTime').value.trim(),
    matchVolumes: $('#pbMatchVol').checked,
    syncRewrites: $('#pbSyncRw').checked,
    autoPublish: $('#pbAuto').checked,
  };
}
async function pbSave() {
  const cfg = pbCfg();
  if (!cfg.profilePath) { $('#pbErr').textContent = '请选择 Unzoo 账号'; return false; }
  if (!cfg.bookId) { $('#pbErr').textContent = '请从「番茄书籍」下拉选择对应的书（没有则确认账号选对/番茄能打开）'; return false; }
  await api('/api/book/publish-config', 'POST', { book: CUR.slug, publish: cfg });
  const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.publish = { ...(b.publish || {}), ...cfg };
  CUR.publish = { ...(CUR.publish || {}), ...cfg };
  return true;
}
$('#pbSaveCfg').addEventListener('click', async () => {
  $('#pbErr').textContent = '';
  try { if (await pbSave()) toast('番茄发布配置已保存'); } catch (e) { $('#pbErr').textContent = e.message; }
});
// —— 番茄卷管理：读取现有卷 + 逐卷改名（番茄序号"第N卷："自动加，只改副标题）——
function pbRenderVols(r) {
  const box = $('#pbVolList');
  if (!r || !r.ok) { box.innerHTML = `<div class="modal-err">读取番茄卷失败：${esc((r && r.error) || '未知')}</div>`; return; }
  const vols = r.volumes || [];
  if (!vols.length) { box.innerHTML = '<p class="modal-hint">该书番茄上暂无分卷（或为单卷书）。</p>'; return; }
  box.innerHTML = vols.map(name => {
    const sub = name.includes('：') ? name.split('：').slice(1).join('：') : '';
    return `<div class="pb-vol-row" data-old="${esc(name)}">
      <span class="pb-vol-cur" title="${esc(name)}">${esc(name)}</span>
      <input class="pb-vol-input" maxlength="16" value="${esc(sub)}" placeholder="新副标题(≤16)">
      <button class="btn pb-vol-rename">改名</button>
    </div>`;
  }).join('');
}
$('#pbVolLoad').addEventListener('click', async () => {
  const btn = $('#pbVolLoad'); const old = btn.textContent; btn.disabled = true; btn.textContent = '读取中…';
  $('#pbErr').textContent = ''; $('#pbVolList').innerHTML = '';
  try {
    if (!await pbSave()) return;
    const r = await api('/api/fanqie/volumes', 'POST', { book: CUR.slug });
    pbRenderVols(r);
  } catch (e) { $('#pbErr').textContent = '读取番茄卷失败：' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#pbVolList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.pb-vol-rename'); if (!btn) return;
  const row = btn.closest('.pb-vol-row'); const oldName = row.getAttribute('data-old');
  const sub = row.querySelector('.pb-vol-input').value.trim();
  if (!sub) { $('#pbErr').textContent = '新副标题不能为空'; return; }
  const prefix = oldName.includes('：') ? oldName.split('：')[0] : oldName;
  if (!confirm(`把「${oldName}」改名为「${prefix}：${sub}」？\n改动番茄真实账号（可再次改名，但卷不可删）。`)) return;
  btn.disabled = true; const old = btn.textContent; btn.textContent = '改名中…'; $('#pbErr').textContent = '';
  try {
    const r = await api('/api/fanqie/rename-volume', 'POST', { book: CUR.slug, oldName, newName: sub });
    if (r.ok) {
      toast('已改卷名 → ' + prefix + '：' + sub);
      const nn = prefix + '：' + sub;
      row.querySelector('.pb-vol-cur').textContent = nn; row.querySelector('.pb-vol-cur').title = nn;
      row.setAttribute('data-old', nn);
    } else { $('#pbErr').textContent = '改名失败：' + (r.error || '未知'); }
  } catch (e) { $('#pbErr').textContent = '改名失败：' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#pbPreview').addEventListener('click', async () => {
  $('#pbErr').textContent = ''; $('#pbGo').disabled = true; $('#pbGo').textContent = '🔍 请先点「预览将发」';
  const btn = $('#pbPreview'); const old = btn.textContent; btn.disabled = true; btn.textContent = '读取番茄中…';
  try {
    if (!await pbSave()) return;
    const r = await pbRace(api('/api/book/publish-preview', 'POST', { book: CUR.slug }), 60000, '预览番茄超时');
    const out = $('#pbPreviewOut'); out.style.display = '';
    if (r.blocked) {
      out.textContent = `⛔ 无法确认番茄当前章号，已阻止发布：\n${r.reason}\n\n请确认该 Unzoo 账号的浏览器能正常打开番茄章节管理页（检查代理/网络/登录），再重新预览。`;
      $('#pbGo').disabled = true; $('#pbGo').textContent = '📤 发布全部新章 ▶';
      return;
    }
    let rw = '';
    if (r.rewrittenCount > 0) {
      rw = `\n⟳ 检测到 ${r.rewrittenCount} 个重写章（第 ${(r.rewrittenNums || []).join('、')}${r.rewrittenCount > 8 ? '…' : ''} 章）` +
        (r.syncRewrites ? '，发布时将 edit 覆盖同步。' : '，未开「同步重写章」，本次不动它们。');
    }
    // 多卷映射预览
    let vol = '';
    if (r.matchVolumes && r.volumes) {
      const V = r.volumes;
      if (V.error) vol = `\n⚠️ 按卷发布：读取番茄卷失败（${V.error}）`;
      else if (V.single) vol = `\n📚 按卷发布：番茄是单卷书，将忽略分卷直接追加`;
      else {
        vol = `\n📚 按卷发布：${Object.entries(V.map || {}).map(([k, v]) => `${k}→${v}`).join('，') || '(本批无已存在卷映射)'}`;
        if (V.willCreate && V.willCreate.length) vol += `\n🆕 番茄缺卷，将自动新建：${V.willCreate.join('、')}（卷名可后续在番茄改；卷建后删不掉，只建恰好缺的）`;
      }
    }
    // 排期起始日（自动接续番茄已排期）
    let sched = '';
    if (r.scheduled) sched = `\n📅 排期起始日：${r.scheduleStart}（${r.scheduleReason}）`;
    else if (r.fanqieLatestDate) sched = `\n📅 立即发布（番茄最新章 ${r.fanqieLatestDate}，无未来排期）`;
    // 按卷发布仅在【读取卷失败】时禁止发布；缺卷会自动新建，不再禁用
    const volBlocked = r.matchVolumes && r.volumes && r.volumes.error;
    if (r.newCount > 0) {
      out.textContent = `番茄已发到第 ${r.fanqieMax} 章${r.approx ? '(近似)' : ''}，本地已写到第 ${r.localMax} 章。\n将发布 ${r.newCount} 个新章：第 ${r.from}–${r.to} 章\n` + (r.titles || []).map(t => '  · ' + t).join('\n') + (r.newCount > 5 ? '\n  …' : '') + rw + vol + sched;
      $('#pbGo').disabled = !!volBlocked; $('#pbGo').textContent = volBlocked ? '⛔ 番茄卷读取失败，重试预览' : `📤 发布全部 ${r.newCount} 个新章 ▶`;
    } else {
      out.textContent = `番茄已发到第 ${r.fanqieMax} 章${r.approx ? '(近似)' : ''}，本地第 ${r.localMax} 章 —— 无新章可发。` + rw + vol + sched;
      // 仅有重写章且已开同步：也允许发布
      const canEditOnly = r.rewrittenCount > 0 && r.syncRewrites;
      $('#pbGo').disabled = !canEditOnly;
      $('#pbGo').textContent = canEditOnly ? `📤 同步 ${r.rewrittenCount} 个重写章 ▶` : '📤 发布全部新章 ▶';
    }
  } catch (e) { $('#pbErr').textContent = '预览失败：' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
let PB_STREAM = null;      // 发布进度的 SSE（弹窗内实时滚日志）
let PB_STREAM_SLUG = null; // 当前 SSE 属于哪本书（用于弹窗重开时判断是否已挂着）
function pbCloseStream() { if (PB_STREAM) { try { PB_STREAM.close(); } catch {} PB_STREAM = null; PB_STREAM_SLUG = null; } }
// 发布进入/结束时切换「停止发布」「发布中」等按钮态；发布中禁用发布类按钮，露出停止按钮。
function pbSetPublishingUI(on) {
  const stop = $('#pbStop');
  if (stop) { stop.style.display = on ? '' : 'none'; stop.disabled = !on; stop.textContent = '⏹ 停止发布'; }
  $('#pbTest').disabled = !!on; $('#pbPreview').disabled = !!on;
  // 发布中禁用发布并显示"发布中…"；结束后仍保持禁用（需重新预览确认最新章号，避免重发）。
  $('#pbGo').disabled = true;
  $('#pbGo').textContent = on ? '📤 发布中…' : '🔍 请先点「预览将发」';
}
// 弹窗打开时按该书的发布状态同步 UI，并在正在发布时接回 SSE 进度。
function pbSyncStopBtn() {
  if (!CUR) return;
  if (PUBLISHING.has(CUR.slug)) {
    pbSetPublishingUI(true);
    // 若 SSE 没挂在这本书上（如关弹窗后重开），重新接回进度
    if (PB_STREAM_SLUG !== CUR.slug) pbAttachStream(CUR.slug, '⏳ 发布进行中，接回进度：\n');
  } else {
    pbSetPublishingUI(false);
  }
}
// 标记发布结束/停止：清客户端状态、复位 UI、刷新书架去掉徽标。
function pbMarkDone(slug) {
  PUBLISHING.delete(slug);
  pbCloseStream();
  if (CUR && CUR.slug === slug) pbSetPublishingUI(false);
  renderShelf();
}
// 挂 SSE：把番茄发布日志滚进 pbPreviewOut，命中结束词时收尾。
function pbAttachStream(slug, header) {
  const out = $('#pbPreviewOut'); out.style.display = '';
  if (header) out.textContent = header;
  pbCloseStream();
  PB_STREAM_SLUG = slug;
  PB_STREAM = new EventSource(`${API}/api/stream?book=${encodeURIComponent(slug)}`);
  PB_STREAM.addEventListener('log', ev => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.source !== 'fanqie') return;
    const tag = e.level === 'error' ? '✖' : e.level === 'act' ? '▶' : '·';
    out.textContent += `${tag} ${e.msg}\n`;
    out.scrollTop = out.scrollHeight;
    // 发布收尾/停止/异常 → 清状态、复位按钮
    if (/发布结束|重发结束|全部完成|已暂停|已中止|已停止|无新章|发布异常/.test(e.msg)) {
      out.textContent += '\n——（已结束，可关闭。番茄那边稍后刷新可见）——\n';
      out.scrollTop = out.scrollHeight;
      pbMarkDone(slug);
    }
  });
  PB_STREAM.onerror = () => {};
}
async function pbPublish(limit) {
  $('#pbErr').textContent = '';
  const warn = limit ? `【联调】只发第一个新章到番茄真实账号《${CUR.title}》，确认？` : `把全部新章发布到番茄真实账号《${CUR.title}》。建卷不可逆、发错改不了，确认配置无误？`;
  if (!confirm(warn)) return;
  const slug = CUR.slug;
  try {
    if (!await pbSave()) return;
    await api('/api/book/publish', 'POST', { book: slug, limit: limit || 0 });
    // 标记这本书正在发布（书卡徽标 + 停止按钮 + 关弹窗后可回来）
    PUBLISHING.add(slug); renderShelf();
    pbSetPublishingUI(true);
    // 不关弹窗——发布进度实时滚在弹窗里
    pbAttachStream(slug, '⏳ 已开始发布，进度：\n');
    toast(limit ? '已开始试发 1 章，进度见下方' : '已开始发布，进度见下方');
  } catch (e) {
    // 启动失败：清状态、恢复所有按钮，绝不卡死
    PUBLISHING.delete(slug); renderShelf();
    pbSetPublishingUI(false);
    $('#pbErr').textContent = '发布失败：' + e.message;
  }
}
// ⏹ 停止发布：请求后台停发（发完当前章即停），保留状态直到 SSE 报结束。
$('#pbStop').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#pbStop'); btn.disabled = true; const old = btn.textContent; btn.textContent = '⏹ 停止中…';
  try {
    await pbRace(api('/api/book/publish-stop', 'POST', { book: CUR.slug }), 60000, '停止请求超时');
    toast('已请求停止（发完当前章即停）');
  } catch (e) {
    $('#pbErr').textContent = '停止失败：' + e.message;
    btn.disabled = false; btn.textContent = old;   // 停止请求本身失败时恢复按钮，让用户能重试
  }
});
$('#pbGo').addEventListener('click', () => pbPublish(0));
$('#pbTest').addEventListener('click', () => pbPublish(1));
// 关弹窗：若该书仍在发布，保留 SSE 让书卡徽标能在后台发布结束时自动消失；否则收流。
function pbCloseModal() {
  if (!(PB_STREAM_SLUG && PUBLISHING.has(PB_STREAM_SLUG))) pbCloseStream();
  $('#publishModal').classList.add('hidden');
}
$('#pbClose').addEventListener('click', pbCloseModal);
$('#pbCancel').addEventListener('click', pbCloseModal);
$('#publishModal').addEventListener('click', (e) => { if (e.target === $('#publishModal')) pbCloseModal(); });

// ---------- 从番茄导入图书到本地 ----------
let IF_PROFILES = [], IF_BOOKS = [], IF_STREAM = null;
const IF_BOOKS_CACHE = {};
function ifCloseStream() { if (IF_STREAM) { try { IF_STREAM.close(); } catch {} IF_STREAM = null; } }
function ifRenderProfiles() {
  const sel = $('#ifProfile');
  if (!IF_PROFILES.length) { sel.innerHTML = '<option value="">（未检测到 Unzoo 账号，请先开浏览器并登录番茄）</option>'; return; }
  sel.innerHTML = IF_PROFILES.map(p => {
    const tag = p.fanqie && p.fanqie.length ? '✓已开番茄' : (p.running ? '○运行中' : '·未启动');
    const label = p.dir && p.dir !== p.name ? `${p.name} · ${p.dir}` : p.name;
    return `<option value="${esc(p.path)}">${esc(label)}（${tag}）</option>`;
  }).join('');
}
async function ifLoadBooks(profilePath, force) {
  const sel = $('#ifBook');
  if (!profilePath) { sel.innerHTML = '<option value="">（请先选账号）</option>'; $('#ifBookId').value = ''; return; }
  if (!force && IF_BOOKS_CACHE[profilePath]) { IF_BOOKS = IF_BOOKS_CACHE[profilePath]; ifRenderBooks(); return; }
  sel.innerHTML = '<option value="">（读取番茄书籍中…）</option>';
  try {
    const r = await api('/api/fanqie/books', 'POST', { profilePath });
    IF_BOOKS = r.books || [];
    if (r.ok && IF_BOOKS.length) IF_BOOKS_CACHE[profilePath] = IF_BOOKS;
    if (!r.ok || !IF_BOOKS.length) { sel.innerHTML = `<option value="">（${r.error || '没读到书籍'}）</option>`; $('#ifBookId').value = ''; if (r.error) $('#ifErr').textContent = '读取番茄书籍：' + r.error; return; }
    ifRenderBooks();
  } catch (e) { sel.innerHTML = '<option value="">（读取失败）</option>'; $('#ifErr').textContent = '读取番茄书籍失败：' + e.message; }
}
function ifRenderBooks() {
  const sel = $('#ifBook');
  sel.innerHTML = IF_BOOKS.map(b => `<option value="${esc(b.id)}">${esc(b.title || '(无名)')} · #${esc(b.id)}</option>`).join('');
  $('#ifBookId').value = IF_BOOKS[0] ? IF_BOOKS[0].id : '';
}
$('#btnImportFanqie').addEventListener('click', async () => {
  $('#ifErr').textContent = ''; $('#ifOut').style.display = 'none'; $('#ifOut').textContent = '';
  $('#ifGo').disabled = true; $('#ifTitle').value = '';
  $('#importFanqieModal').classList.remove('hidden');
  $('#ifProfile').innerHTML = '<option value="">（加载账号…）</option>';
  $('#ifBook').innerHTML = '<option value="">（选账号后自动加载…）</option>';
  try {
    const r = await api('/api/unzoo/profiles', 'POST', {});
    IF_PROFILES = r.profiles || []; ifRenderProfiles();
    if ($('#ifProfile').value) ifLoadBooks($('#ifProfile').value);
  } catch (e) { $('#ifErr').textContent = '取账号失败：' + e.message; IF_PROFILES = []; ifRenderProfiles(); }
});
$('#ifProfile').addEventListener('change', () => ifLoadBooks($('#ifProfile').value));
$('#ifBook').addEventListener('change', () => { $('#ifBookId').value = $('#ifBook').value; $('#ifGo').disabled = true; });
$('#ifPreview').addEventListener('click', async () => {
  const profilePath = $('#ifProfile').value, bookId = $('#ifBookId').value;
  if (!profilePath || !bookId) { $('#ifErr').textContent = '请选账号和番茄书籍'; return; }
  $('#ifErr').textContent = ''; const btn = $('#ifPreview'); const old = btn.textContent; btn.disabled = true; btn.textContent = '读取番茄中…';
  const out = $('#ifOut'); out.style.display = ''; out.textContent = '⏳ 读取卷与章节目录…';
  try {
    const r = await api('/api/fanqie/import-preview', 'POST', { profilePath, bookId });
    if (!r.ok) { out.textContent = '⛔ ' + (r.error || '预览失败'); $('#ifGo').disabled = true; return; }
    out.textContent = `将导入 ${r.volumes} 卷 / ${r.chapters} 章：\n` + (r.volNames || []).map(n => '  · ' + n).join('\n');
    $('#ifGo').disabled = false;
  } catch (e) { out.textContent = '预览失败：' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
async function ifImport(limit) {
  const profilePath = $('#ifProfile').value, bookId = $('#ifBookId').value, title = $('#ifTitle').value.trim();
  if (!profilePath || !bookId) { $('#ifErr').textContent = '请选账号和番茄书籍'; return; }
  if (!limit && !confirm('把这本番茄书整本拉到本地（含全部章节正文）？章数多时需要几分钟。')) return;
  $('#ifErr').textContent = '';
  const out = $('#ifOut'); out.style.display = ''; out.textContent = '⏳ 已开始导入，进度：\n';
  $('#ifGo').disabled = true; $('#ifTest').disabled = true; $('#ifPreview').disabled = true;
  try {
    await api('/api/fanqie/import', 'POST', { profilePath, bookId, title, limit: limit || 0 });
    ifCloseStream();
    IF_STREAM = new EventSource(`${API}/api/stream?book=${encodeURIComponent('__import_' + bookId)}`);
    IF_STREAM.addEventListener('log', ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (e.source !== 'import') return;
      const tag = e.level === 'error' ? '✖' : e.level === 'warn' ? '⚠' : e.level === 'act' ? '▶' : '·';
      out.textContent += `${tag} ${e.msg}\n`; out.scrollTop = out.scrollHeight;
      if (/从番茄导入结束|从番茄导入异常/.test(e.msg)) {
        ifCloseStream(); $('#ifTest').disabled = false; $('#ifPreview').disabled = false; $('#ifGo').disabled = false;
        out.textContent += '\n——（结束）——\n'; out.scrollTop = out.scrollHeight;
        refresh();
        if (/导入结束/.test(e.msg)) toast('导入完成，已加入书架');
      }
    });
    IF_STREAM.onerror = () => {};
    toast(limit ? '已开始试导 3 章' : '已开始导入，进度见下方');
  } catch (e) { $('#ifErr').textContent = '导入失败：' + e.message; $('#ifGo').disabled = false; $('#ifTest').disabled = false; $('#ifPreview').disabled = false; }
}
$('#ifGo').addEventListener('click', () => ifImport(0));
$('#ifTest').addEventListener('click', () => ifImport(3));
function ifCloseModal() { ifCloseStream(); $('#importFanqieModal').classList.add('hidden'); }
$('#ifClose').addEventListener('click', ifCloseModal);
$('#ifCancel').addEventListener('click', ifCloseModal);
$('#importFanqieModal').addEventListener('click', (e) => { if (e.target === $('#importFanqieModal')) ifCloseModal(); });

// ---------- 完本 ----------
function flSync() {
  const b = (STATE.books.find(x => x.slug === CUR?.slug) || CUR || {});
  const st = b.status || '连载中';
  const fq = b.fanqie?.status ? `　|　番茄：${b.fanqie.status}${(st === '已完本' && b.fanqie.status !== '已完结') ? ' ⚠ 内部已完本但平台未完结' : ''}` : '';
  $('#flStatus').textContent = '内部状态：' + st + fq;
  $('#flEnter').disabled = (st === '收尾中' || st === '已完本');
}
function openFinale() {
  if (!CUR) return;
  $('#flErr').textContent = ''; $('#flResult').classList.add('hidden'); $('#flCritique').textContent = '';
  const co = $('#flClosureOut'); if (co) { co.style.display = 'none'; co.textContent = ''; }
  flSync();
  $('#finaleModal').classList.remove('hidden');
}
function setStatusLocal(s) { if (CUR) CUR.status = s; const b = STATE.books.find(x => x.slug === CUR?.slug); if (b) b.status = s; flSync(); }
$('#btnFinale').addEventListener('click', openFinale);
function flCloseModal() { flCloseStream && flCloseStream(); $('#finaleModal').classList.add('hidden'); }
$('#flClose').addEventListener('click', flCloseModal);
$('#finaleModal').addEventListener('click', (e) => { if (e.target === $('#finaleModal')) flCloseModal(); });
$('#flEnter').addEventListener('click', async () => {
  if (!CUR) return;
  $('#flErr').textContent = ''; $('#flEnter').disabled = true;
  try {
    const r = await api('/api/book/finale', 'POST', { book: CUR.slug, on: true });
    setStatusLocal(r.status);
    toast(r.live ? '已进入收尾 → 已穿插收束令' : '已进入收尾，下次写作即开始收束冲刺');
  } catch (e) { $('#flErr').textContent = e.message; $('#flEnter').disabled = false; }
});
$('#flApply').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#flApply'); btn.disabled = true;
  try {
    const r = await api('/api/book/apply-review', 'POST', { book: CUR.slug, kind: 'ending' });
    $('#finaleModal').classList.add('hidden');
    if (r.mode === 'started') { setWriting(true); openStream(CUR.slug); }
    toast(r.mode === 'inserted' ? '已让作者按完本审稿补写结局' : '已开窗：作者按完本审稿补写结局');
  } catch (e) { $('#flErr').textContent = e.message; }
  finally { btn.disabled = false; }
});
$('#flAfterword').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#flAfterword'); const old = btn.textContent; btn.disabled = true; btn.textContent = '发指令中…';
  $('#flErr').textContent = '';
  try {
    const r = await api('/api/book/afterword', 'POST', { book: CUR.slug });
    if (r.mode === 'opened') { setWriting(true); openStream(CUR.slug); }
    toast(r.mode === 'inserted' ? '已穿插指令：作者补写《完本感言/尾声》' : '已开窗：作者补写《完本感言/尾声》');
  } catch (e) { $('#flErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#flReview').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#flReview'); const old = btn.textContent; btn.disabled = true; btn.textContent = '完本审稿中…（约1-2分钟）';
  $('#flErr').textContent = ''; $('#flResult').classList.add('hidden');
  try {
    const r = await api('/api/book/review-ending', 'POST', { book: CUR.slug });
    $('#flMeta').textContent = `${r.pass ? '✅ 判定：可完本' : '⚠️ 判定：未完本（还有未收束项）'} ｜ 主编：${modelName(r.editorModel)} ｜ reviews/${r.file}`;
    $('#flCritique').textContent = r.critique || '（无内容）';
    $('#flResult').classList.remove('hidden');
  } catch (e) { $('#flErr').textContent = '失败：' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#flUndo').addEventListener('click', async () => {
  if (!CUR) return;
  try { const r = await api('/api/book/status', 'POST', { book: CUR.slug, status: '连载中' }); setStatusLocal(r.status); toast('已撤销收尾，恢复连载中'); }
  catch (e) { $('#flErr').textContent = e.message; }
});
$('#flMark').addEventListener('click', async () => {
  if (!CUR) return;
  try { const r = await api('/api/book/status', 'POST', { book: CUR.slug, status: '已完本' }); setStatusLocal(r.status); toast('已标记为「已完本」'); }
  catch (e) { $('#flErr').textContent = e.message; }
});

// ---------- 完结收口（内部完本 → 番茄平台完结）----------
let FL_STREAM = null;
function flCloseStream() { if (FL_STREAM) { try { FL_STREAM.close(); } catch {} FL_STREAM = null; } }
// 把番茄 SSE 日志滚进 flClosureOut，命中 endRe 时复位按钮。
function flStreamFanqie(endRe, onEnd) {
  const out = $('#flClosureOut'); out.style.display = ''; out.scrollTop = out.scrollHeight;
  flCloseStream();
  FL_STREAM = new EventSource(`${API}/api/stream?book=${encodeURIComponent(CUR.slug)}`);
  FL_STREAM.addEventListener('log', ev => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.source !== 'fanqie') return;
    const tag = e.level === 'error' ? '✖' : e.level === 'warn' ? '⚠' : e.level === 'act' ? '▶' : '·';
    out.textContent += `${tag} ${e.msg}\n`; out.scrollTop = out.scrollHeight;
    if (endRe.test(e.msg)) { flCloseStream(); out.textContent += '\n——（结束）——\n'; out.scrollTop = out.scrollHeight; if (onEnd) onEnd(); }
  });
  FL_STREAM.onerror = () => {};
}
function flRenderReport(r) {
  const out = $('#flClosureOut'); out.style.display = '';
  const sym = c => c.level === 'info' ? (c.ok ? '✅' : 'ℹ️') : c.level === 'hard' ? (c.ok ? '✅' : '❌') : (c.ok ? '✅' : '⚠️');
  const lines = [];
  lines.push(r.ready ? '【完结就绪】内容已落地、内部已完本，可去番茄申请完结。' : '【尚未就绪】见下方未过项（❌为硬指标，必须满足）。');
  lines.push('');
  for (const c of (r.checks || [])) lines.push(`${sym(c)} ${c.label} — ${c.detail}`);
  if (r.fanqie && r.fanqie.ok) lines.push('', `番茄：${r.fanqie.status}${r.fanqie.signed ? '·已签约' : ''}｜${r.fanqie.totalWordsText || '?'}｜最新 第${r.fanqie.lastChapterNum}章 ${r.fanqie.lastChapterTitle || ''}`);
  else if (r.fanqie && r.fanqie.error) lines.push('', `⚠ 番茄状态读取失败：${r.fanqie.error}`);
  if (r.mismatch && r.mismatch.length) lines.push('', '⚠ 对账提示：' + r.mismatch.join('；'));
  if (r.note) lines.push('', '— 可发给编辑的完结说明 —', r.note);
  out.textContent = lines.join('\n'); out.scrollTop = 0;
}
$('#flReport').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#flReport'); const old = btn.textContent; btn.disabled = true; btn.textContent = '对账中…（读番茄约10秒）';
  $('#flErr').textContent = ''; $('#flClosureOut').style.display = ''; $('#flClosureOut').textContent = '⏳ 读取本地 + 番茄状态，生成完结就绪报告…\n';
  try {
    const r = await api('/api/book/completion-report', 'POST', { book: CUR.slug });
    flRenderReport(r);
    // 番茄状态回写到卡片（双状态可视化）
    if (r.fanqie?.ok) { const b = STATE.books.find(x => x.slug === CUR.slug); if (b) b.fanqie = { status: r.fanqie.status }; if (CUR) CUR.fanqie = { status: r.fanqie.status }; }
  } catch (e) { $('#flErr').textContent = '报告失败：' + e.message; $('#flClosureOut').textContent = ''; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#flClosure').addEventListener('click', async () => {
  if (!CUR) return;
  if (!confirm(`完结收口：把番茄还没有的收尾新章（含尾声/完本感言）发齐到《${CUR.title}》，并对账平台状态。\n（只发新章、按章号去重，不提交"完结申请"。）确认？`)) return;
  $('#flErr').textContent = '';
  const out = $('#flClosureOut'); out.style.display = ''; out.textContent = '⏳ 已开始完结收口，进度：\n';
  const btn = $('#flClosure'); btn.disabled = true; const old = btn.textContent; btn.textContent = '收口中…';
  try {
    await api('/api/book/finale-closure', 'POST', { book: CUR.slug });
    flStreamFanqie(/完结收口结束|完结收口异常|完结收口：/, () => { btn.disabled = false; btn.textContent = old; });
  } catch (e) { $('#flErr').textContent = '收口失败：' + e.message; btn.disabled = false; btn.textContent = old; }
});
$('#flLocate').addEventListener('click', async () => {
  if (!CUR) return;
  $('#flErr').textContent = '';
  const out = $('#flClosureOut'); out.style.display = ''; out.textContent = '⏳ 只读探测番茄"申请完结"入口（不会提交任何不可逆动作）…\n';
  const btn = $('#flLocate'); btn.disabled = true; const old = btn.textContent; btn.textContent = '探测中…';
  try {
    await api('/api/book/locate-completion', 'POST', { book: CUR.slug });
    flStreamFanqie(/完结入口探测结束|探测完结入口异常/, () => { btn.disabled = false; btn.textContent = old; });
  } catch (e) { $('#flErr').textContent = '探测失败：' + e.message; btn.disabled = false; btn.textContent = old; }
});

// ---------- 大纲审稿 ----------
function openOutline() {
  if (!CUR) return;
  $('#olErr').textContent = ''; $('#olResult').classList.add('hidden');
  $('#olCritique').textContent = ''; $('#olMeta').textContent = '';
  const b = STATE.books.find(x => x.slug === CUR.slug) || CUR;
  const st = b.stats || {};
  const vols = st.volumes || [];
  $('#olBookInfo').textContent = `（共 ${st.chapters || 0} 章` + (vols.length ? ` · ${vols.length} 卷` : '') + '）';
  $('#olScope').innerHTML = ['<option value="立项">立项 / 全书大纲</option>']
    .concat(vols.map(v => `<option value="${esc(v)}">${esc(v)} 大纲</option>`)).join('');
  $('#olStart').disabled = false; $('#olStart').textContent = '开始审稿 ▶';
  $('#outlineModal').classList.remove('hidden');
}
$('#btnOutline').addEventListener('click', openOutline);
$('#btnRebuildOutline').addEventListener('click', async () => {
  if (!CUR) return;
  if (!confirm('据已写正文逆向重建【设定圣经 + 各卷分章大纲】（不写新正文、不动已写章节）。\n导入的番茄书/半成品书建议先用它补齐规划。确定？')) return;
  const btn = $('#btnRebuildOutline'); const old = btn.textContent; btn.disabled = true; btn.textContent = '发指令中…';
  try {
    const r = await api('/api/book/rebuild-outline', 'POST', { book: CUR.slug });
    if (r.mode === 'opened') { setWriting(true); openStream(CUR.slug); }
    toast(r.mode === 'inserted' ? '已穿插指令：重建设定+大纲（不写新正文）' : '已开窗：重建设定+大纲（不写新正文）');
  } catch (e) { toast('重建失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#olApply').addEventListener('click', async () => {
  if (!CUR) return;
  const scope = $('#olScope').value;
  const btn = $('#olApply'); btn.disabled = true;
  try {
    const r = await api('/api/book/apply-review', 'POST', { book: CUR.slug, scope, kind: 'outline' });
    $('#outlineModal').classList.add('hidden');
    if (r.mode === 'started') { setWriting(true); openStream(CUR.slug); }
    toast(r.mode === 'inserted' ? `已让作者按审稿修订【${scope}】大纲` : `已开窗：作者按审稿修订【${scope}】大纲`);
  } catch (e) { $('#olErr').textContent = e.message; }
  finally { btn.disabled = false; }
});
$('#olClose').addEventListener('click', () => $('#outlineModal').classList.add('hidden'));
$('#olCancel').addEventListener('click', () => $('#outlineModal').classList.add('hidden'));
$('#outlineModal').addEventListener('click', (e) => { if (e.target === $('#outlineModal')) $('#outlineModal').classList.add('hidden'); });
$('#olStart').addEventListener('click', async () => {
  if (!CUR) return;
  const scope = $('#olScope').value;
  const inject = $('#olInject').checked;
  $('#olStart').disabled = true; $('#olStart').textContent = '主编审稿中…（约 1–2 分钟）';
  $('#olErr').textContent = ''; $('#olResult').classList.add('hidden');
  try {
    const r = await api('/api/book/review-outline', 'POST', { book: CUR.slug, scope, inject });
    $('#olMeta').textContent = `主编模型：${r.editorModel} ｜ 已写入 reviews/${r.file}` + (inject ? ' ｜ 已穿插给作者修订' : '');
    $('#olCritique').textContent = r.critique || '（无内容）';
    $('#olResult').classList.remove('hidden');
    $('#olStart').textContent = '重新审稿 ▶';
    toast('审稿完成：' + scope);
  } catch (e) { $('#olErr').textContent = '失败：' + e.message; $('#olStart').textContent = '开始审稿 ▶'; }
  finally { $('#olStart').disabled = false; }
});

// ---------- 文风 ----------
let ST_REC = null; // AI 推荐结果(带 tweak)
function openStyle() {
  if (!CUR) return;
  ST_REC = null;
  const b = STATE.books.find(x => x.slug === CUR.slug) || CUR;
  const presets = (STATE.styles || []).map(s => `<option value="${s.id}">${esc(s.name)}（${esc(s.short)}）</option>`).join('');
  $('#stSelect').innerHTML = presets;
  if (b.style && b.style.id) $('#stSelect').value = b.style.id;
  $('#stRec').textContent = b.style ? ('当前文风：' + b.style.name + (b.style.tweak ? ' · ' + b.style.tweak : '')) : '当前未设定文风';
  $('#stErr').textContent = '';
  $('#styleModal').classList.remove('hidden');
}
$('#btnStyle').addEventListener('click', openStyle);
$('#stClose').addEventListener('click', () => $('#styleModal').classList.add('hidden'));
$('#stCancel').addEventListener('click', () => $('#styleModal').classList.add('hidden'));
$('#styleModal').addEventListener('click', (e) => { if (e.target === $('#styleModal')) $('#styleModal').classList.add('hidden'); });
$('#stAiRec').addEventListener('click', async () => {
  if (!CUR) return;
  const b = STATE.books.find(x => x.slug === CUR.slug) || CUR;
  $('#stAiRec').disabled = true; $('#stRec').textContent = 'AI 据题材分析中…'; $('#stErr').textContent = '';
  try {
    const r = await api('/api/book/recommend-style', 'POST', { theme: b.genre || b.title, model: b.model || STATE.config.defaultModel });
    ST_REC = r.style;
    $('#stSelect').value = r.style.id;
    $('#stRec').textContent = '🤖 推荐：' + r.style.name + '——' + (r.style.reason || '') + (r.style.tweak ? '｜微调：' + r.style.tweak : '');
  } catch (e) { $('#stRec').textContent = ''; $('#stErr').textContent = '推荐失败：' + e.message; }
  finally { $('#stAiRec').disabled = false; }
});
$('#stApply').addEventListener('click', async () => {
  if (!CUR) return;
  const id = $('#stSelect').value;
  // 若 AI 推荐的就是当前选中的，连带 tweak 一起存
  const style = (ST_REC && ST_REC.id === id) ? { id, tweak: ST_REC.tweak } : id;
  $('#stApply').disabled = true; $('#stErr').textContent = '应用中…';
  try {
    await api('/api/book/set-style', 'POST', { book: CUR.slug, style });
    await refresh();
    const nb = STATE.books.find(x => x.slug === CUR.slug); if (nb) CUR = nb;
    $('#styleModal').classList.add('hidden'); toast('文风已设为：' + (nb?.style?.name || id));
  } catch (e) { $('#stErr').textContent = '失败：' + e.message; }
  finally { $('#stApply').disabled = false; }
});

// ---------- 目标章节数上限 ----------
$('#wbTarget').addEventListener('change', async () => {
  if (!CUR) return;
  const n = Math.max(0, Number($('#wbTarget').value) || 0);
  try {
    await api('/api/book/set-target', 'POST', { book: CUR.slug, targetChapters: n });
    const nb = STATE.books.find(b => b.slug === CUR.slug); if (nb) nb.targetChapters = n; CUR.targetChapters = n;
    toast(n ? ('写到 ' + n + ' 章就自动停') : '已取消上限（不限）');
  } catch (e) { toast(e.message); }
});

// ---------- 封面生成 ----------
const COVER_THEMES = [
  { id: 'ink', name: '水墨', tColor: '#1a1a1a', aColor: '#555', bg(c, W, H) { c.fillStyle = '#efe9dd'; c.fillRect(0, 0, W, H); const g = c.createRadialGradient(W * .5, H * .3, 20, W * .5, H * .3, W * .65); g.addColorStop(0, 'rgba(20,20,20,.12)'); g.addColorStop(1, 'rgba(20,20,20,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H); c.fillStyle = '#9e2b25'; c.fillRect(W - 118, H - 118, 64, 64); c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 2; c.strokeRect(24, 24, W - 48, H - 48); } },
  { id: 'republic', name: '民国旧韵', tColor: '#e8d6a8', aColor: '#b09a6a', bg(c, W, H) { const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#2a2018'); g.addColorStop(1, '#15100a'); c.fillStyle = g; c.fillRect(0, 0, W, H); const r = c.createRadialGradient(W * .5, H * .28, 10, W * .5, H * .28, W * .6); r.addColorStop(0, 'rgba(224,189,134,.2)'); r.addColorStop(1, 'rgba(224,189,134,0)'); c.fillStyle = r; c.fillRect(0, 0, W, H); c.strokeStyle = 'rgba(224,189,134,.55)'; c.lineWidth = 2; c.strokeRect(28, 28, W - 56, H - 56); } },
  { id: 'night', name: '暗夜', tColor: '#eaf0ff', aColor: '#8fa6c8', bg(c, W, H) { const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0b1020'); g.addColorStop(1, '#1a2740'); c.fillStyle = g; c.fillRect(0, 0, W, H); c.fillStyle = 'rgba(255,255,255,.55)'; for (let i = 0; i < 50; i++) { c.fillRect(Math.random() * W, Math.random() * H * .6, 1.6, 1.6); } } },
  { id: 'gold', name: '烫金', tColor: '#e8c97a', aColor: '#b8995a', bg(c, W, H) { c.fillStyle = '#0c0c0c'; c.fillRect(0, 0, W, H); c.strokeStyle = '#b8995a'; c.lineWidth = 3; c.strokeRect(26, 26, W - 52, H - 52); } },
  { id: 'vermilion', name: '朱砂', tColor: '#f2e6c8', aColor: '#e7d2a4', bg(c, W, H) { c.fillStyle = '#6e1f17'; c.fillRect(0, 0, W, H); c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, H * .56, W, H * .44); c.strokeStyle = 'rgba(242,230,200,.4)'; c.lineWidth = 2; c.strokeRect(26, 26, W - 52, H - 52); } },
  { id: 'bamboo', name: '青竹', tColor: '#e6f0e2', aColor: '#9fc0a8', bg(c, W, H) { const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#14241c'); g.addColorStop(1, '#0c1812'); c.fillStyle = g; c.fillRect(0, 0, W, H); c.strokeStyle = 'rgba(159,192,168,.4)'; c.lineWidth = 2; c.strokeRect(26, 26, W - 52, H - 52); } },
  { id: 'minimal', name: '简约', tColor: '#222', aColor: '#666', bg(c, W, H) { c.fillStyle = '#f5f3ee'; c.fillRect(0, 0, W, H); c.fillStyle = '#c9a26a'; c.fillRect(0, 0, W, 150); } },
];
function wrapCN(c, text, maxW) { const lines = []; let cur = ''; for (const ch of text) { if (c.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch; } if (cur) lines.push(cur); return lines; }
let coverBgImg = null;   // 已加载的 AI 底图（HTMLImageElement）
// 把图片按 cover 方式填满 600×800（裁掉溢出），再压一层上深下浅渐变保证书名清晰
function drawAiBg(c, W, H) {
  const iw = coverBgImg.naturalWidth, ih = coverBgImg.naturalHeight;
  const s = Math.max(W / iw, H / ih), dw = iw * s, dh = ih * s;
  c.drawImage(coverBgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(.32, 'rgba(0,0,0,.15)');
  g.addColorStop(.7, 'rgba(0,0,0,.15)'); g.addColorStop(1, 'rgba(0,0,0,.6)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.strokeRect(20, 20, W - 40, H - 40);
}
function drawCover() {
  const cv = $('#cvCanvas'); if (!cv) return; const c = cv.getContext('2d'); const W = 600, H = 800;
  const themeId = $('#cvTheme').value;
  c.clearRect(0, 0, W, H);
  if (themeId === 'ai' && coverBgImg) { drawAiBg(c, W, H); return drawCoverText(c, W, H, { tColor: '#fff', aColor: '#f0e6c8' }, true); }
  const theme = COVER_THEMES.find(t => t.id === themeId) || COVER_THEMES[0];
  theme.bg(c, W, H);
  drawCoverText(c, W, H, theme);
}
function drawCoverText(c, W, H, theme, shadow) {
  const title = ($('#cvTitle').value || '未命名').trim();
  const author = ($('#cvAuthor').value || '').trim();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  if (shadow || theme === undefined) { c.shadowColor = 'rgba(0,0,0,.85)'; c.shadowBlur = 14; c.shadowOffsetY = 3; }
  c.fillStyle = theme.tColor;
  let size = title.length <= 4 ? 100 : title.length <= 6 ? 80 : title.length <= 9 ? 62 : 50;
  c.font = `700 ${size}px "Noto Serif SC","Songti SC","SimSun",serif`;
  const lines = wrapCN(c, title, W - 120);
  let y = H * 0.30 - (lines.length - 1) * size * 0.6;
  for (const ln of lines) { c.fillText(ln, W / 2, y); y += size * 1.2; }
  if (author) { c.fillStyle = theme.aColor; c.font = `400 34px "Noto Serif SC","Songti SC",serif`; c.fillText(author, W / 2, H - 96); }
  c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
}
function loadCoverBg(url) {   // 加载 AI 底图，成功后切到 AI 主题并重绘
  return new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { coverBgImg = img; resolve(img); };
    img.onerror = () => reject(new Error('底图加载失败')); img.src = url;
  });
}
async function openCover() {
  if (!CUR) return;
  coverBgImg = null;
  $('#cvTitle').value = CUR.title; $('#cvAuthor').value = CUR.author || '';
  $('#cvPrompt').value = '';
  const opts = COVER_THEMES.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  $('#cvTheme').innerHTML = `<option value="ai">🎨 AI 插画</option>` + opts;
  $('#cvTheme').value = 'ink';
  $('#cvErr').textContent = ''; $('#coverModal').classList.remove('hidden');
  // 若书里已有 AI 底图，预加载并默认用它
  if (CUR.stats?.coverBg) {
    try { await loadCoverBg(`${API}/api/book/cover-bg?book=${encodeURIComponent(CUR.slug)}&t=${CUR.stats.coverBgMtime || 0}`); $('#cvTheme').value = 'ai'; } catch {}
  }
  drawCover();
}
$('#btnCover').addEventListener('click', openCover);
['cvTitle', 'cvAuthor'].forEach(id => $('#' + id).addEventListener('input', drawCover));
$('#cvTheme').addEventListener('change', drawCover);
$('#cvGenAI').addEventListener('click', async () => {
  if (!CUR) return;
  const btn = $('#cvGenAI'); btn.disabled = true; const old = btn.textContent; btn.textContent = '🎨 生成中…（约10-20秒）'; $('#cvErr').textContent = '';
  try {
    const r = await api('/api/book/gen-cover-bg', 'POST', { book: CUR.slug, prompt: $('#cvPrompt').value.trim() || undefined });
    await loadCoverBg(API + r.url);
    $('#cvTheme').value = 'ai'; drawCover();
    if (r.prompt && !$('#cvPrompt').value.trim()) $('#cvPrompt').value = r.prompt;
    toast('AI 封面插画已生成');
  } catch (e) { $('#cvErr').textContent = '生成失败：' + e.message + '（需在设置里填 Gemini key，且代理可用）'; }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#cvClose').addEventListener('click', () => $('#coverModal').classList.add('hidden'));
$('#coverModal').addEventListener('click', (e) => { if (e.target === $('#coverModal')) $('#coverModal').classList.add('hidden'); });
$('#cvDownload').addEventListener('click', async () => {
  try {
    const dataUrl = $('#cvCanvas').toDataURL('image/png');
    if (IS_TAURI && CUR) {
      const r = await api('/api/book/export-cover', 'POST', { book: CUR.slug, dataUrl });
      toast('已导出到下载文件夹：' + r.path);
    } else {
      const a = document.createElement('a'); a.download = ($('#cvTitle').value || 'cover') + '_封面.png'; a.href = dataUrl; a.click();
    }
  } catch (e) { $('#cvErr').textContent = e.message; }
});
$('#cvSave').addEventListener('click', async () => {
  if (!CUR) return; $('#cvSave').disabled = true; $('#cvErr').textContent = '保存中…';
  try { await api('/api/book/save-cover', 'POST', { book: CUR.slug, dataUrl: $('#cvCanvas').toDataURL('image/png') }); $('#coverModal').classList.add('hidden'); toast('封面已保存到书目录 cover.png'); }
  catch (e) { $('#cvErr').textContent = '失败：' + e.message; } finally { $('#cvSave').disabled = false; }
});

$('#btnSend').addEventListener('click', sendInstr);
$('#sendInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendInstr(); });
async function sendInstr() {
  const v = $('#sendInput').value.trim(); if (!v || !CUR) return;
  const btn = $('#btnSend'); btn.disabled = true;
  try {
    const r = await api('/api/send', 'POST', { book: CUR.slug, task: v, model: $('#writeModel').value });
    $('#sendInput').value = '';
    if (r.mode === 'switched') { setWriting(true); openStream(CUR.slug); toast(`已切到 ${modelName(r.model)} → 停旧窗口并用新模型重开续写`); }
    else if (r.mode === 'resumed') { setWriting(true); openStream(CUR.slug); toast('会话已停止 → 已重新打开 Unterm 并带着这条指令继续写作'); }
    else toast('已穿插指令');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

// ---------- SSE 实时镜像 + 日志 ----------
function openStream(slug) {
  closeStream();
  STREAM = new EventSource(`${API}/api/stream?book=${encodeURIComponent(slug)}`);
  STREAM.addEventListener('screen', e => {
    const m = $('#mirror'); const atBottom = m.scrollTop + m.clientHeight >= m.scrollHeight - 30;
    m.textContent = JSON.parse(e.data).text || '';
    if (atBottom) m.scrollTop = m.scrollHeight;
  });
  STREAM.addEventListener('log', e => appendLog(JSON.parse(e.data)));
  STREAM.addEventListener('stopped', () => { STOP_DRAINING = false; $('#btnStop').textContent = '■ 停止'; setWriting(false); closeStream(); toast('当前批次已完成 → 已自动关闭窗口'); });
  STREAM.onerror = () => {};
}
function closeStream() { if (STREAM) { STREAM.close(); STREAM = null; } }
// ---------- 审稿/审核确认门动作条 ----------
function hideReviewBar() { $('#reviewBar').classList.add('hidden'); }
async function showReviewBar() {
  if (!CUR) return;
  try {
    const p = await api('/api/book/pending?book=' + encodeURIComponent(CUR.slug));
    if (!p.pending) { hideReviewBar(); return; }
    const batch = p.kind === 'batch-review';
    if (batch) {
      // 逐批审核：本批写完，等用户批准/给要求/停止
      $('#rbTitle').textContent = `本批已写完，待你审核（${p.scope || ''}）`;
      $('#rbFile').textContent = '';
      $('#rbCritique').textContent = '可在右侧实时镜像 / 阅读台查看本批内容。满意就「批准并继续」；想左右剧情就写下要求再「按我的要求继续」。';
      $('#rbReq').classList.remove('hidden');
      $('#rbActionsOutline').classList.add('hidden');
      $('#rbActionsBatch').classList.remove('hidden');
    } else {
      // 大纲审稿确认门
      $('#rbTitle').textContent = `审稿意见待确认（${p.scope || ''}）`;
      $('#rbFile').textContent = p.file ? ' · reviews/' + p.file : '';
      $('#rbCritique').textContent = p.critique || '（详见 reviews 文件）';
      $('#rbReq').classList.add('hidden');
      $('#rbActionsBatch').classList.add('hidden');
      $('#rbActionsOutline').classList.remove('hidden');
    }
    $('#reviewBar').classList.remove('hidden');
  } catch {}
}
async function reviewDecision(apply) {
  if (!CUR) return;
  $('#rbApply').disabled = $('#rbSkip').disabled = true;
  try {
    await api('/api/book/review-decision', 'POST', { book: CUR.slug, apply });
    hideReviewBar();
    toast(apply ? '已采纳 → 作者据意见修订大纲' : '已跳过 → 不改大纲，继续');
  } catch (e) { toast(e.message); }
  finally { $('#rbApply').disabled = $('#rbSkip').disabled = false; }
}
$('#rbApply').addEventListener('click', () => reviewDecision(true));
$('#rbSkip').addEventListener('click', () => reviewDecision(false));
// 逐批审核裁决：批准继续 / 按要求继续 / 停止
async function batchContinue(withReq) {
  if (!CUR) return;
  const requirements = withReq ? $('#rbReq').value.trim() : '';
  if (withReq && !requirements) { toast('请先写下你对下一批的要求'); $('#rbReq').focus(); return; }
  const btns = ['#rbContinue', '#rbContinueReq', '#rbStop'].map(s => $(s));
  btns.forEach(b => b.disabled = true);
  try {
    await api('/api/book/review-continue', 'POST', { book: CUR.slug, requirements });
    $('#rbReq').value = ''; hideReviewBar();
    toast(requirements ? '已下达本批要求 → 继续写' : '已批准 → 继续写下一批');
  } catch (e) { toast(e.message); }
  finally { btns.forEach(b => b.disabled = false); }
}
async function batchStop() {
  if (!CUR) return;
  const btns = ['#rbContinue', '#rbContinueReq', '#rbStop'].map(s => $(s));
  btns.forEach(b => b.disabled = true);
  try {
    await api('/api/book/review-continue', 'POST', { book: CUR.slug, stop: true });
    hideReviewBar(); setWriting(false); closeStream();
    toast('已停止 → 不再续写，关闭窗口');
  } catch (e) { toast(e.message); }
  finally { btns.forEach(b => b.disabled = false); }
}
$('#rbContinue').addEventListener('click', () => batchContinue(false));
$('#rbContinueReq').addEventListener('click', () => batchContinue(true));
$('#rbStop').addEventListener('click', batchStop);
function appendLog(e) {
  if (e.kind === 'pending-review' || e.kind === 'pending-batch') showReviewBar();   // 待确认/待审核 → 弹动作条
  const feed = $('#logFeed');
  const cls = 'log-line ' + (e.source === 'autopilot' ? 'autopilot ' : '') + (e.level || 'info');
  const tag = e.level === 'act' ? '●' : e.level === 'warn' ? '▲' : e.level === 'error' ? '✖' : '○';
  const line = el('div', cls, `<span class="tag">${tag}</span><span class="msg">${esc(e.msg)}</span>`);
  feed.appendChild(line);
  if (e.msg && /token/i.test(e.msg)) {}
  feed.scrollTop = feed.scrollHeight;
  while (feed.childNodes.length > 400) feed.removeChild(feed.firstChild);
  // 顺带刷新 token 徽章
  if (CUR) api('/api/usage').then(u => { const t = u.books?.[CUR.slug]?.total; if (t) $('#writeTokens').textContent = 'tokens ' + fmtTok(t); }).catch(() => {});
}

// ---------- 阅读 / 工作台 ----------
let RD_BOOK = null, RD_REL = null, RD_RAW = '';
function mdInline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); }
function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/); let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = l.split('|').slice(1, -1).map(c => c.trim()); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim())); i++; }
      html += '<table><thead><tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'; continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { html += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'; i++; continue; }
    if (/^\s*>\s?/.test(l)) { html += '<blockquote>' + mdInline(l.replace(/^\s*>\s?/, '')) + '</blockquote>'; i++; continue; }
    if (/^\s*[-*]\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + mdInline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; } html += '<ul>' + items.join('') + '</ul>'; continue; }
    if (/^\s*---+\s*$/.test(l)) { html += '<hr>'; i++; continue; }
    if (l.trim() === '') { i++; continue; }
    html += '<p>' + mdInline(l) + '</p>'; i++;
  }
  return html;
}
function chapterToHtml(txt) { return String(txt || '').split(/\n\s*\n|\n/).filter(p => p.trim()).map(p => '<p>' + esc(p) + '</p>').join('') || '<div class="rd-empty">（空）</div>'; }

async function openReader(book) {
  RD_BOOK = book; RD_REL = null; RD_RAW = '';
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('#view-read').classList.remove('hidden');
  $('#rdTitle').textContent = '《' + book.title + '》';
  $('#rdFileName').textContent = '加载中…'; $('#rdContent').innerHTML = '<div class="rd-empty">加载中…</div>'; $('#rdNav').innerHTML = '';
  exitEdit(); $('#rdEdit').classList.add('hidden');
  try {
    const t = await api('/api/book/files?book=' + encodeURIComponent(book.slug));
    renderReaderNav(t);
    const pg = t.progress || {};
    $('#rdProgress').textContent = `${pg.status || '连载中'} · 卷${pg.vol || '?'}${pg.totalVol ? '/' + pg.totalVol : ''} · ${pg.chapters || 0}${pg.target ? '/' + pg.target : ''}章${pg.pct ? ' · ' + pg.pct + '%' : ''} · ${pg.kb || 0}KB${pg.dupCount ? ' · ⚠️' + pg.dupCount + '处重名' : ''}`;
    $('#rdFileName').textContent = '选择左侧任意文件阅读';
    $('#rdContent').innerHTML = '<div class="rd-empty">📖 从左侧选 设定圣经 / 大纲 / 章节 / 审稿报告 来读</div>';
  } catch (e) { $('#rdContent').innerHTML = '<div class="rd-empty">加载失败：' + esc(e.message) + '</div>'; }
}
function rdNavItem(rel, label, kb) { return `<a class="rd-item" data-rel="${esc(rel)}" title="${esc(label)}"><span class="rd-lbl">${esc(label)}</span><span class="rd-kb">${kb || 0}K</span></a>`; }
function renderReaderNav(t) {
  let h = '';
  if (t.dups?.length) {
    h += `<div class="rd-dup"><div class="rd-dup-t">⚠️ ${t.dups.length} 个重复章名（应全书唯一）</div>` +
      t.dups.map(d => `<div class="rd-dup-row"><b>${esc(d.name)}</b>${d.files.map(f => `<a class="rd-item dup" data-rel="${esc('chapters/' + f)}">${esc(f)}</a>`).join('')}</div>`).join('') +
      '</div>';
  }
  if (t.meta?.length) h += '<div class="rd-gtitle">设定</div>' + t.meta.map(m => rdNavItem(m.rel, m.label, m.kb)).join('');
  if (t.outlines?.length) h += '<div class="rd-gtitle">大纲</div>' + t.outlines.map(o => rdNavItem(o.rel, o.name, o.kb)).join('');
  if (t.volumes?.length) {
    h += '<div class="rd-gtitle">章节</div>';
    for (const v of t.volumes) h += `<details class="rd-vol"${t.volumes.length <= 2 ? ' open' : ''}><summary>${esc(v.vol)} (${v.chapters.length})</summary>${v.chapters.map(c => rdNavItem(c.rel, (c.num ? '第' + c.num + '章 ' : '') + c.name, c.kb)).join('')}</details>`;
  }
  if (t.reviews?.length) h += '<div class="rd-gtitle">审稿 / 复检</div>' + t.reviews.map(r => rdNavItem(r.rel, r.name, r.kb)).join('');
  $('#rdNav').innerHTML = h || '<div class="rd-empty">（暂无内容）</div>';
  $('#rdNav').querySelectorAll('[data-rel]').forEach(el => el.addEventListener('click', () => loadReaderFile(el.dataset.rel)));
}
async function loadReaderFile(rel) {
  RD_REL = rel; exitEdit();
  $('#rdNav').querySelectorAll('.rd-item').forEach(el => el.classList.toggle('active', el.dataset.rel === rel));
  $('#rdFileName').textContent = rel; $('#rdContent').innerHTML = '<div class="rd-empty">加载中…</div>';
  $('#rdEdit').classList.remove('hidden');
  try {
    const r = await api('/api/book/read?book=' + encodeURIComponent(RD_BOOK.slug) + '&rel=' + encodeURIComponent(rel));
    RD_RAW = r.content || '';
    $('#rdContent').innerHTML = /\.md$/i.test(rel) ? mdToHtml(RD_RAW) : chapterToHtml(RD_RAW);
    $('#rdContent').scrollTop = 0;
  } catch (e) { $('#rdContent').innerHTML = '<div class="rd-empty">读取失败：' + esc(e.message) + '</div>'; }
}
function enterEdit() {
  if (!RD_REL) return;
  $('#rdEditor').value = RD_RAW;
  $('#rdEditor').classList.remove('hidden'); $('#rdContent').classList.add('hidden');
  $('#rdEdit').classList.add('hidden'); $('#rdSave').classList.remove('hidden'); $('#rdCancel').classList.remove('hidden');
}
function exitEdit() {
  $('#rdEditor').classList.add('hidden'); $('#rdContent').classList.remove('hidden');
  $('#rdEdit').classList.toggle('hidden', !RD_REL); $('#rdSave').classList.add('hidden'); $('#rdCancel').classList.add('hidden');
}
$('#rdEdit').addEventListener('click', enterEdit);
$('#rdCancel').addEventListener('click', exitEdit);
$('#rdSave').addEventListener('click', async () => {
  if (!RD_BOOK || !RD_REL) return;
  const content = $('#rdEditor').value; $('#rdSave').disabled = true;
  try {
    await api('/api/book/save-file', 'POST', { book: RD_BOOK.slug, rel: RD_REL, content });
    RD_RAW = content;
    $('#rdContent').innerHTML = /\.md$/i.test(RD_REL) ? mdToHtml(content) : chapterToHtml(content);
    exitEdit(); toast('已保存：' + RD_REL);
  } catch (e) { toast('保存失败：' + e.message); }
  finally { $('#rdSave').disabled = false; }
});
$('#rdBack').addEventListener('click', () => { showView('shelf'); refresh(); });
$('#rdToWrite').addEventListener('click', () => { if (RD_BOOK) openWrite(RD_BOOK); });
$('#rdRenumber').addEventListener('click', async () => {
  if (!RD_BOOK) return;
  if (!confirm('把全书章节统一为【全局连续编号 001…N】（每卷独立编号会被改成连续号），并重建索引。改前自动 git 存档可回退。写作中需先停止。确定？')) return;
  $('#rdRenumber').disabled = true;
  try {
    const r = await api('/api/book/renumber', 'POST', { book: RD_BOOK.slug });
    toast(`已全局重编号：${r.chapters} 章连续（存档 ${r.snapshot || '-'}）`);
    openReader(RD_BOOK);   // 刷新
  } catch (e) { toast('重编号失败：' + e.message); }
  finally { $('#rdRenumber').disabled = false; }
});
$('#btnReadFromWrite').addEventListener('click', () => { if (CUR) openReader(CUR); });

// ---------- 删除书 ----------
let DEL_BOOK = null;
function openDelete(b) {
  DEL_BOOK = b;
  $('#dlName').textContent = '《' + b.title + '》　' + (b.stats?.chapters || 0) + ' 章 · ' + (b.stats?.kb || 0) + 'KB';
  $('#dlFiles').checked = false; $('#dlErr').textContent = '';
  $('#delModal').classList.remove('hidden');
}
$('#dlClose').addEventListener('click', () => $('#delModal').classList.add('hidden'));
$('#dlCancel').addEventListener('click', () => $('#delModal').classList.add('hidden'));
$('#delModal').addEventListener('click', (e) => { if (e.target === $('#delModal')) $('#delModal').classList.add('hidden'); });
$('#dlConfirm').addEventListener('click', async () => {
  if (!DEL_BOOK) return;
  $('#dlConfirm').disabled = true; $('#dlErr').textContent = '删除中…';
  try {
    const r = await api('/api/book/delete', 'POST', { book: DEL_BOOK.slug, deleteFiles: $('#dlFiles').checked });
    $('#delModal').classList.add('hidden');
    if (CUR && CUR.slug === DEL_BOOK.slug) showView('shelf');
    await refresh();
    toast('已删除《' + r.title + '》' + (r.filesDeleted ? '（含磁盘文件）' : '（保留磁盘文件）'));
  } catch (e) { $('#dlErr').textContent = '失败：' + e.message; }
  finally { $('#dlConfirm').disabled = false; }
});

// ---------- 新建书 · AI 立项 ----------
let NB_TITLES = [], NB_SEL = -1;
// 目标字数：框里只填数字，单位固定"万字" → 拼成 "200万字"
function getWords() {
  const v = ($('#nbWords').value || '').replace(/[^0-9.]/g, '');
  return v ? v + '万字' : '';
}
function openModal() {
  $('#modal').classList.remove('hidden');
  $('#nbStep1').classList.remove('hidden'); $('#nbStep2').classList.add('hidden');
  $('#nbAdv').classList.add('hidden'); if ($('#nbImport')) $('#nbImport').classList.add('hidden');
  $('#nbErr').textContent = ''; $('#nbFinalTitle').value = ''; $('#nbLaunch').disabled = true;
  $('#nbTheme').focus();
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#btnNewBook').addEventListener('click', openModal);
$('#btnImport').addEventListener('click', () => { openModal(); $('#nbImport').classList.remove('hidden'); $('#nbImport').scrollIntoView({ block: 'nearest' }); setTimeout(() => $('#nbImpDir').focus(), 50); });
$('#nbCancel').addEventListener('click', closeModal);
$('#modalClose').addEventListener('click', closeModal);
// 点遮罩空白处关闭（点卡片内部不关）
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
// Esc 关闭
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').classList.contains('hidden')) closeModal();
  if (!$('#reviewModal').classList.contains('hidden')) $('#reviewModal').classList.add('hidden');
  if (!$('#styleModal').classList.contains('hidden')) $('#styleModal').classList.add('hidden');
  if (!$('#delModal').classList.contains('hidden')) $('#delModal').classList.add('hidden');
  if (!$('#coverModal').classList.contains('hidden')) $('#coverModal').classList.add('hidden');
});
$('#nbAdvToggle').addEventListener('click', () => $('#nbAdv').classList.toggle('hidden'));
$('#nbImportToggle').addEventListener('click', () => $('#nbImport').classList.toggle('hidden'));
// 原生选择文件夹（仅 Tauri 桌面端有；浏览器里提示手动粘贴）
$('#nbImpBrowse').addEventListener('click', async () => {
  const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!inv) { toast('请在桌面应用里使用"选择"，或直接粘贴完整路径'); $('#nbImpDir').focus(); return; }
  try {
    const dir = await inv('pick_folder');
    if (dir) {
      $('#nbImpDir').value = dir;
      try { const r = await api('/api/detect-title', 'POST', { dir }); if (r.title && !$('#nbImpTitle').value.trim()) $('#nbImpTitle').value = r.title; } catch {}
    }
  }
  catch (e) { toast('打开文件夹选择失败：' + e.message); }
});
$('#nbSelfNameLink').addEventListener('click', nbSelfName);

// 导入已有文件夹 → 继续写
$('#nbImpBtn').addEventListener('click', async () => {
  const dir = $('#nbImpDir').value.trim();
  if (!dir) { $('#nbImpErr').textContent = '请填文件夹路径'; return; }
  $('#nbImpBtn').disabled = true; $('#nbImpErr').textContent = '导入中…';
  try {
    const r = await api('/api/book/import', 'POST', { dir, title: $('#nbImpTitle').value.trim(), model: $('#nbImpModel').value });
    // 确认门：导入只注册 + 代码归档文件，【不自动开写】。打开写作台让你检查后再点"开始写作"。
    $('#modal').classList.add('hidden');
    await refresh();
    const book = STATE.books.find(b => b.slug === r.book.slug) || r.book;
    openWrite(book);
    toast('已导入《' + book.title + '》(' + (r.book.stats?.chapters || 0) + '章) 并归档到 chapters/，请检查后点【开始写作】续写');
  } catch (e) { $('#nbImpErr').textContent = '失败：' + e.message; $('#nbImpBtn').disabled = false; }
});

// 步骤1 → 生成候选书名 → 步骤2
$('#nbPropose').addEventListener('click', proposeTitles);
$('#nbRegen').addEventListener('click', proposeTitles);
$('#nbBack2').addEventListener('click', () => { $('#nbStep2').classList.add('hidden'); $('#nbStep1').classList.remove('hidden'); });
async function proposeTitles() {
  const theme = $('#nbTheme').value.trim();
  if (!theme) { $('#nbErr').textContent = '请先写题材/想法'; return; }
  $('#nbStep1').classList.add('hidden'); $('#nbStep2').classList.remove('hidden');
  $('#nbErr2').textContent = ''; $('#nbTitles').innerHTML = ''; $('#nbLoading').classList.remove('hidden');
  NB_SEL = -1;
  try {
    const r = await api('/api/book/propose-titles', 'POST', { theme, words: getWords(), model: $('#nbModel').value });
    NB_TITLES = r.titles || [];
    $('#nbLoading').classList.add('hidden');
    renderTitleCards();
  } catch (e) {
    $('#nbLoading').classList.add('hidden');
    $('#nbErr2').textContent = '生成失败：' + e.message + '\n（可换个模型，或直接在上面自己写书名）';
  }
}
function renderTitleCards() {
  const box = $('#nbTitles'); box.innerHTML = '';
  NB_TITLES.forEach((t, i) => {
    const c = el('div', 'nb-title-card', `<div class="t">《${esc(t.title)}》</div><div class="p">${esc(t.premise || '')}</div>`);
    c.addEventListener('click', () => { NB_SEL = i; renderTitleCards(); $('#nbFinalTitle').value = t.title; nbTitleSync(); });
    if (i === NB_SEL) c.classList.add('sel');
    box.appendChild(c);
  });
}
function nbTitleSync() { $('#nbLaunch').disabled = !$('#nbFinalTitle').value.trim(); }
// 自己起名直接立项（跳过 AI 建议）
function nbSelfName() {
  const theme = $('#nbTheme').value.trim();
  if (!theme) { $('#nbErr').textContent = '请先写题材/想法'; return; }
  $('#nbStep1').classList.add('hidden'); $('#nbStep2').classList.remove('hidden');
  $('#nbErr2').textContent = ''; $('#nbTitles').innerHTML = ''; $('#nbLoading').classList.add('hidden');
  NB_TITLES = []; NB_SEL = -1; nbTitleSync(); $('#nbFinalTitle').focus();
}

// 步骤2 → 确认并开写（建书 + 全卷立项 + 开写）
$('#nbFinalTitle').addEventListener('input', nbTitleSync);
$('#nbLaunch').addEventListener('click', async () => {
  const title = $('#nbFinalTitle').value.trim();
  if (!title) { $('#nbErr2').textContent = '请填一个书名（点候选或自己写）'; return; }
  $('#nbLaunch').disabled = true; $('#nbErr2').textContent = '正在建书并启动 AI 立项…';
  try {
    const r = await api('/api/book/launch', 'POST', {
      title, theme: $('#nbTheme').value.trim(),
      words: getWords(), model: $('#nbModel').value, style: $('#nbStyle').value,
      writeMode: $('#nbWriteMode').value === 'review' ? 'review' : 'auto',
    });
    $('#modal').classList.add('hidden');
    await refresh();
    const book = STATE.books.find(b => b.slug === r.book.slug) || r.book;
    openWrite(book); setWriting(true); openStream(book.slug);
    const st = r.book && r.book.style;
    toast('已立项《' + title + '》' + (st ? ' · 文风：' + st.name : '') + '，AI 开始搭设定与全卷大纲');
  } catch (e) { $('#nbErr2').textContent = '失败：' + e.message; $('#nbLaunch').disabled = false; }
});

// 高级：仅手动创建
$('#nbManualCreate').addEventListener('click', async () => {
  const title = $('#nbTitle').value.trim();
  if (!title) { $('#nbErr').textContent = '手动模式下书名不能为空'; return; }
  try {
    await api('/api/book/create', 'POST', {
      title, genre: $('#nbGenre').value.trim(), model: $('#nbModel').value,
      totalWords: getWords(), volumes: $('#nbVolumes').value.trim(),
      chaptersPerVolume: $('#nbCpv').value.trim(), batchSize: Number($('#nbBatch').value) || 3,
    });
    $('#modal').classList.add('hidden');
    ['nbTitle', 'nbGenre', 'nbWords', 'nbVolumes', 'nbCpv', 'nbBatch', 'nbTheme'].forEach(id => { const e = $('#' + id); if (e) e.value = ''; });
    await refresh(); toast('已创建《' + title + '》');
  } catch (e) { $('#nbErr').textContent = e.message; }
});

// ---------- 用量 ----------
async function renderUsage() {
  const u = await api('/api/usage').catch(() => ({ books: {} }));
  const list = $('#usageList'); list.innerHTML = '';
  const entries = Object.entries(u.books || {});
  if (!entries.length) { list.innerHTML = '<div class="env-row"><span class="v">暂无用量记录。开始写作后自动统计。</span></div>'; return; }
  const max = Math.max(...entries.map(([, b]) => b.total), 1);
  for (const [slug, b] of entries.sort((a, c) => c[1].total - a[1].total)) {
    const title = (STATE.books.find(x => x.slug === slug) || {}).title || slug;
    const row = el('div', 'usage-row');
    row.innerHTML = `<div class="top"><span class="title">《${esc(title)}》</span><span class="num">${fmtTok(b.total)} tokens</span></div>
      <div class="bar"><i style="width:${(b.total / max * 100).toFixed(1)}%"></i></div>
      <div style="margin-top:7px;color:var(--muted);font-size:11.5px">${b.total.toLocaleString()} · 写作会话 ${Object.keys(b.sessions || {}).length}</div>`;
    list.appendChild(row);
  }
}

// ---------- 设置 ----------
async function renderSettings() {
  const c = STATE.config;
  const box = $('#settings');
  box.innerHTML = `
    <label class="field"><span>书库目录（写好的书都放这里）</span>
      <div class="ws-row">
        <input id="setWs" value="${esc(c.workspace || '')}" placeholder="点右侧“选择文件夹”挑一个目录">
        <button class="btn" id="setWsPick" type="button">📁 选择文件夹</button>
        <button class="btn ghost" id="setWsOpen" type="button">📂 打开</button>
      </div>
    </label>
    <label class="field"><span>默认模型</span><select id="setModel">${STATE.models.map(m => `<option value="${m.id}" ${m.id === c.defaultModel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span>代理</span><select id="setProxy">
      <option value="on" ${c.enableProxy ? 'selected' : ''}>开（用 unterm 当前代理）</option>
      <option value="off" ${!c.enableProxy ? 'selected' : ''}>关</option></select></label>
    <label class="field"><span>Autopilot 自动监控应答</span><select id="setAuto">
      <option value="on" ${c.autopilot?.enabled ? 'selected' : ''}>开</option>
      <option value="off" ${!c.autopilot?.enabled ? 'selected' : ''}>关</option></select></label>
    <label class="field"><span>自动续写上限（每会话）</span><input id="setMax" type="number" value="${c.autopilot?.maxAutoContinue ?? 40}"></label>
    <label class="field"><span>每几批做一次全文逻辑自检（0=关闭）</span><input id="setFullCheck" type="number" value="${c.autopilot?.fullCheckEvery ?? 5}"></label>
    <label class="field"><span>上下文达多少 token 就重开新会话省钱（0=关闭；claude 精确，建议 12万~20万）</span><input id="setFreshCtx" type="number" value="${c.autopilot?.freshContextLimit ?? 180000}"></label>
    <div class="modal-hint" style="margin:-2px 0 4px">连续写时同一会话上下文越堆越大、每批都被重发（缓存还会过期→全价）。到阈值就停旧会话、靠 continuity_ledger 重开新窗口续写，省 token。太小会频繁重开反而更费。</div>
    <div class="btn-row"><button class="btn primary" id="setSave" style="flex:0;padding:10px 22px">保存</button></div>`;
  $('#setSave').addEventListener('click', async () => {
    const patch = {
      workspace: $('#setWs').value.trim(), defaultModel: $('#setModel').value,
      enableProxy: $('#setProxy').value === 'on',
      autopilot: {
        enabled: $('#setAuto').value === 'on',
        maxAutoContinue: Number($('#setMax').value) || 40,
        fullCheckEvery: Math.max(0, Number($('#setFullCheck').value) || 0),
        freshContextLimit: Math.max(0, Number($('#setFreshCtx').value) || 0),
      },
    };
    try { STATE.config = await api('/api/config', 'POST', { patch }); fillModels(); toast('设置已保存'); }
    catch (e) { toast(e.message); }
  });
  // 书库目录：原生文件夹选择器（桌面应用用 Tauri 对话框；浏览器回退到手填路径）
  $('#setWsPick').addEventListener('click', async () => {
    let dir = null;
    if (HAS_TAURI) {
      try { dir = await tauriInvoke('pick_folder'); }
      catch (e) { toast('打开目录选择器失败：' + e.message); return; }
      if (!dir) return;   // 用户取消
    } else {
      dir = window.prompt('输入书库目录的完整路径：', $('#setWs').value || '');
      if (dir == null) return;
      dir = dir.trim(); if (!dir) return;
    }
    $('#setWs').value = dir;
    try { STATE.config = await api('/api/config', 'POST', { patch: { workspace: dir } }); toast('书库目录已设为 ' + dir); }
    catch (e) { toast('保存失败：' + e.message); }
  });
  $('#setWsOpen').addEventListener('click', async () => {
    try { const r = await api('/api/open-path', 'POST', { path: $('#setWs').value.trim() }); toast('已在文件管理器打开：' + r.dir); }
    catch (e) { toast(e.message); }
  });
}

// ---------- 环境 ----------
async function renderEnv() {
  const box = $('#env'); box.innerHTML = '<div class="env-row"><span class="k">检测中…</span></div>';
  let e;
  try { e = await api('/api/env'); }
  catch (err) { box.innerHTML = `<div class="env-row"><span class="k">引擎未连接</span><span class="v">${esc(err.message)}</span></div>`; return; }
  box.innerHTML = '';
  // 操作条（可执行的操作）
  const bar = el('div', 'btn-row'); bar.style.marginBottom = '12px';
  bar.innerHTML = `<button class="btn" id="envReload">🔄 重新检测</button>
    <button class="btn" id="envOpenWs">📂 打开书库目录</button>
    <button class="btn ghost" id="envToSettings">⚙️ 去设置</button>`;
  box.appendChild(bar);
  const ok = (b) => b ? '✔ ' : '✖ ';
  const rows = [
    ['平台', e.platform],
    ['Unterm 程序', e.untermExe ? (e.untermExe + (e.untermVersion ? '  [' + e.untermVersion + ']' : '')) : '✖ 未找到（写作功能需要 Unterm）'],
    ['Unterm CLI', e.untermCli || '✖ 未找到'],
  ];
  for (const m of e.models) rows.push([m.name, ok(m.available) + (m.path || '未安装')]);
  rows.push(['运行中实例', e.instances.map(i => `${i.id}(v${i.version})`).join('、') || '无']);
  rows.push(['代理', e.proxy.enabled ? ('开 · ' + (e.proxy.url || '(未配置)')) : '关']);
  rows.push(['书库目录', ok(e.workspaceExists) + (e.workspace || '—')]);
  for (const [k, v] of rows) {
    const r = el('div', 'env-row'); r.innerHTML = `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`; box.appendChild(r);
  }
  $('#envReload').addEventListener('click', async () => {
    try { const b = await api('/api/bootstrap'); STATE = { ...STATE, ...b }; } catch {}
    renderEnv(); toast('已重新检测');
  });
  $('#envOpenWs').addEventListener('click', async () => {
    try { const r = await api('/api/open-path', 'POST', { path: e.workspace }); toast('已打开：' + r.dir); }
    catch (err) { toast(err.message); }
  });
  $('#envToSettings').addEventListener('click', () => showView('settings'));
}

boot();
setInterval(() => { if (!$('#view-shelf').classList.contains('hidden')) refresh(); }, 5000);
