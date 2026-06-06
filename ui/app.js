// Novel Studio GUI 前端逻辑（零依赖）。served by Node 引擎 / 或 Tauri 加载。
// Tauri v2(Win) 用 http://tauri.localhost 提供资源 → 此时引擎在另一个源(127.0.0.1:8787)；
// 浏览器直连引擎时则用同源。
const IS_TAURI = location.hostname === 'tauri.localhost' || location.protocol === 'tauri:' || (typeof window !== 'undefined' && !!window.__TAURI__);
const API = (!IS_TAURI && (location.protocol === 'http:' || location.protocol === 'https:'))
  ? location.origin : 'http://127.0.0.1:8787';

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
let CUR = null;       // 当前打开的书
let STREAM = null;    // 当前 SSE

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
        <span class="pill">${b.stats?.chapters || 0} 章</span>
        <span class="pill">${b.stats?.kb || 0} KB</span>
        <span class="pill">tokens ${fmtTok(b.tokens || 0)}</span>
      </div>
      <div class="card-actions">
        <button class="card-btn" data-act="write">✍️ 写作</button>
        <button class="card-btn" data-act="review">🔍 复检</button>
      </div>`;
    card.querySelector('[data-act="write"]').addEventListener('click', (e) => { e.stopPropagation(); openWrite(b); });
    card.querySelector('[data-act="review"]').addEventListener('click', (e) => { e.stopPropagation(); CUR = b; openReview(); });
    card.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); openDelete(b); });
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
  $('#synText').value = book.synopsis || '';
  const running = STATE.sessions.find(s => s.slug === book.slug && s.running !== false);
  setWriting(!!running);
  $('#writeTokens').textContent = 'tokens ' + fmtTok(book.tokens || 0);
  if (running) openStream(book.slug);
}
function showWriteView() {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#view-write').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
}
function setWriting(on) {
  $('#btnStart').disabled = on; $('#btnStop').disabled = !on;
  $('#writeStatus').textContent = on ? '写作中' : '未开始';
  $('#writeStatus').classList.toggle('on', on);
  $('#mirrorDot').style.display = on ? '' : 'none';
}
$('#btnBack').addEventListener('click', () => { closeStream(); showView('shelf'); refresh(); });

$('#btnStart').addEventListener('click', async () => {
  if (!CUR) return;
  $('#btnStart').disabled = true; $('#writeStatus').textContent = '启动中…';
  try {
    await api('/api/write', 'POST', { book: CUR.slug, model: $('#writeModel').value, task: $('#writeTask').value });
    setWriting(true); openStream(CUR.slug); toast('已开窗，autopilot 运行中');
  } catch (e) { toast('启动失败：' + e.message); setWriting(false); }
});
$('#btnStop').addEventListener('click', async () => {
  if (!CUR) return;
  try { await api('/api/stop', 'POST', { book: CUR.slug }); setWriting(false); closeStream(); toast('已停止并关闭窗口'); }
  catch (e) { toast(e.message); }
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
$('#cvDownload').addEventListener('click', () => { try { const a = document.createElement('a'); a.download = ($('#cvTitle').value || 'cover') + '_封面.png'; a.href = $('#cvCanvas').toDataURL('image/png'); a.click(); } catch (e) { $('#cvErr').textContent = e.message; } });
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
  STREAM.onerror = () => {};
}
function closeStream() { if (STREAM) { STREAM.close(); STREAM = null; } }
function appendLog(e) {
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
    // 导入后直接开始"恢复并续写"（不传 task → 引擎用恢复指令）
    await api('/api/write', 'POST', { book: r.book.slug, model: $('#nbImpModel').value });
    $('#modal').classList.add('hidden');
    await refresh();
    const book = STATE.books.find(b => b.slug === r.book.slug) || r.book;
    openWrite(book); setWriting(true); openStream(book.slug);
    toast('已导入《' + book.title + '》(' + (r.book.stats?.chapters || 0) + '章)，AI 正在恢复上下文并续写');
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
    <label class="field"><span>书库目录</span><input id="setWs" value="${esc(c.workspace || '')}"></label>
    <label class="field"><span>默认模型</span><select id="setModel">${STATE.models.map(m => `<option value="${m.id}" ${m.id === c.defaultModel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span>代理</span><select id="setProxy">
      <option value="on" ${c.enableProxy ? 'selected' : ''}>开（用 unterm 当前代理）</option>
      <option value="off" ${!c.enableProxy ? 'selected' : ''}>关</option></select></label>
    <label class="field"><span>Autopilot 自动监控应答</span><select id="setAuto">
      <option value="on" ${c.autopilot?.enabled ? 'selected' : ''}>开</option>
      <option value="off" ${!c.autopilot?.enabled ? 'selected' : ''}>关</option></select></label>
    <label class="field"><span>自动续写上限（每会话）</span><input id="setMax" type="number" value="${c.autopilot?.maxAutoContinue ?? 40}"></label>
    <label class="field"><span>每几批做一次全文逻辑自检（0=关闭）</span><input id="setFullCheck" type="number" value="${c.autopilot?.fullCheckEvery ?? 5}"></label>
    <div class="btn-row"><button class="btn primary" id="setSave" style="flex:0;padding:10px 22px">保存</button></div>`;
  $('#setSave').addEventListener('click', async () => {
    const patch = {
      workspace: $('#setWs').value.trim(), defaultModel: $('#setModel').value,
      enableProxy: $('#setProxy').value === 'on',
      autopilot: {
        enabled: $('#setAuto').value === 'on',
        maxAutoContinue: Number($('#setMax').value) || 40,
        fullCheckEvery: Math.max(0, Number($('#setFullCheck').value) || 0),
      },
    };
    try { STATE.config = await api('/api/config', 'POST', { patch }); fillModels(); toast('设置已保存'); }
    catch (e) { toast(e.message); }
  });
}

// ---------- 环境 ----------
async function renderEnv() {
  const box = $('#env'); box.innerHTML = '';
  const rows = [];
  for (const m of STATE.models) rows.push([m.name, (m.available ? '✔ ' : '✖ ') + (m.path || '未安装')]);
  rows.push(['运行中实例', STATE.instances.map(i => `${i.id}(v${i.version})`).join(', ') || '无']);
  rows.push(['书库', STATE.config.workspace || '—']);
  for (const [k, v] of rows) {
    const r = el('div', 'env-row'); r.innerHTML = `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`; box.appendChild(r);
  }
}

boot();
setInterval(() => { if (!$('#view-shelf').classList.contains('hidden')) refresh(); }, 5000);
