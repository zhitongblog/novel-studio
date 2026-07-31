// 对标"别人的书"：番茄公开阅读页有字体加密，抓文本是乱码。
// 方案：Unzoo(指定 profile)打开阅读页 → 截图 → claude 视觉【只分析文风】(不复制原文，合法转化性使用) → {name, rules}。
// 与「导入自己的书」(import_fanqie.mjs 走作者后台 API 拿干净全文)是两条不同路径。
// 支持【多本对标】：传 bookUrls[] 逐本导航截图，或 multi:true 直接截当前所有已打开的番茄章节页，融合成一份文风。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';

const UNZOO_BASE = process.env.UNZOO_BASE || 'http://127.0.0.1:9399';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function unzoo(pathname, body, method = 'POST') {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(40000) };
  if (method === 'POST') opt.body = JSON.stringify(body || {});
  const r = await fetch(UNZOO_BASE + pathname, opt);
  return r.json().catch(() => ({}));
}
function tabsOf(j) { return (j && j.data && (j.data.tabs || j.data)) || (j && j.tabs) || (Array.isArray(j) ? j : []); }
const tabId = (t) => t && (t.id || t.tab_id);

// 在给定 tab 上截 2 屏（滚一屏再截），落到 outDir。prefix 区分多本。
async function grabShots(tid, outDir, prefix, onLog = () => {}) {
  const shots = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) { try { await unzoo('/api/v1/scroll', { tab_id: tid, y: 900 }); } catch {} await sleep(900); }
    const s = await unzoo('/api/v1/screenshot', { tab_id: tid });
    const b64 = s && s.data && s.data.image_base64;
    if (!b64) break;
    const p = path.join(outDir, prefix + '_shot' + (i + 1) + '.png');
    fs.writeFileSync(p, Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    shots.push(p);
  }
  return shots;
}

// 把一个 tab 导航到某本书并进正文（若已在 reader 页则不动），然后截图。
async function shotsForUrl(tid, bookUrl, outDir, prefix, onLog) {
  const cur = tabsOf(await unzoo('/api/v1/tabs', null, 'GET')).find(t => tabId(t) === tid);
  const alreadyReader = cur && /fanqienovel\.com\/reader\//.test(cur.url || '');
  if (!alreadyReader && bookUrl) {
    await unzoo('/api/v1/navigate', { tab_id: tid, url: bookUrl }); await sleep(3000);
    const html = await unzoo('/api/v1/get-html', { tab_id: tid });
    const h = String((html && html.data && (html.data.html || (html.data.result && html.data.result.html) || html.data.text)) || '');
    const m = h.match(/href="(\/reader\/\d+[^"]*)"/) || h.match(/(https?:\/\/fanqienovel\.com\/reader\/\d+[^"']*)/);
    if (m) { const u = m[1].startsWith('http') ? m[1] : ('https://fanqienovel.com' + m[1]); onLog({ level: 'info', msg: '进入正文…' }); await unzoo('/api/v1/navigate', { tab_id: tid, url: u }); await sleep(3500); }
  }
  return grabShots(tid, outDir, prefix, onLog);
}

// 直接走 Unzoo REST。三种取图方式：
//   multi:true          → 截【当前所有已打开的番茄章节(reader)页】，用户开几本就参考几本（最稳，不导航）。
//   bookUrls:[u1,u2,…]  → 逐本导航到详情页→进第 1 章→截图（可参考多本，但导航偶发失效）。
//   bookUrl:u（旧）      → 单本，优先用已打开的 reader 页直接截，否则导航。
export async function readFanqieShots({ profilePath, bookUrl, bookUrls, multi, outDir, onLog = () => {} }) {
  const urls = (bookUrls && bookUrls.length ? bookUrls : (bookUrl ? [bookUrl] : [])).slice(0, 4);
  if (!multi && !urls.length) throw new Error('缺少番茄图书链接');
  if (profilePath) { try { await unzoo('/api/v1/profiles/launch', { profile_path: profilePath }); await sleep(1200); } catch {} }
  fs.mkdirSync(outDir, { recursive: true });
  let list = tabsOf(await unzoo('/api/v1/tabs', null, 'GET'));
  const readerTabs = list.filter(t => /fanqienovel\.com\/reader\//.test(t.url || ''));

  // 模式 A：多本 —— 截所有已打开的章节页（最稳）
  if (multi || urls.length > 1) {
    const all = [];
    if (readerTabs.length) {
      onLog({ level: 'act', msg: `发现 ${readerTabs.length} 个已打开的番茄章节页，逐一截图融合…` });
      for (let i = 0; i < Math.min(readerTabs.length, 4); i++) {
        const sh = await grabShots(tabId(readerTabs[i]), outDir, 'book' + (i + 1), onLog);
        all.push(...sh);
      }
    }
    // 章节页不够、又给了链接 → 用一个可用 tab 逐本导航补齐
    if (all.length < 2 && urls.length) {
      let tid = tabId(list.find(t => /fanqienovel\.com/.test(t.url || ''))) || tabId(list[0]);
      if (!tid && urls[0]) { const c = await unzoo('/api/v1/tabs/create', { url: urls[0] }); tid = (c.data && (c.data.tab_id || c.data.id)) || c.tab_id; await sleep(2500); }
      for (let i = 0; i < urls.length && tid; i++) { onLog({ level: 'act', msg: `导航对标书 ${i + 1}/${urls.length}…` }); const sh = await shotsForUrl(tid, urls[i], outDir, 'nav' + (i + 1), onLog); all.push(...sh); }
    }
    if (!all.length) throw new Error('未截到任何番茄章节页。请先在 Unzoo(所选账号)里打开 1~3 本对标书的【任意一章】，再点分析。');
    onLog({ level: 'info', msg: `共 ${all.length} 屏，交给 claude 视觉融合分析文风…` });
    return all;
  }

  // 模式 B：单本 —— 优先已打开的 reader 页直接截，否则导航
  const readerTid = tabId(readerTabs[0]);
  if (readerTid) {
    onLog({ level: 'act', msg: '用已打开的番茄章节页直接截图…' });
    const sh = await grabShots(readerTid, outDir, 'book1', onLog);
    if (sh.length) { onLog({ level: 'info', msg: `已截 ${sh.length} 屏，交给 claude 视觉分析文风…` }); return sh; }
  }
  let tid = tabId(list.find(t => /fanqienovel\.com/.test(t.url || '')));
  if (!tid && urls[0]) { const c = await unzoo('/api/v1/tabs/create', { url: urls[0] }); tid = (c.data && (c.data.tab_id || c.data.id)) || c.tab_id; await sleep(2500); }
  if (!tid) throw new Error('未发现番茄标签页。请先在 Unzoo(所选账号)里打开这本番茄书的【任意一章】，再点分析。');
  const sh = await shotsForUrl(tid, urls[0], outDir, 'book1', onLog);
  if (!sh.length) throw new Error('截图失败（Unzoo 可能未连上或页面未加载正文）');
  onLog({ level: 'info', msg: `已截 ${sh.length} 屏，交给 claude 视觉分析文风…` });
  return sh;
}

// 让视觉模型(claude 优先，其次 gemini)从截图【只分析文风】→ {name, rules}。不复制原文。
export function analyzeStyleFromShots({ shotPaths, model, multi }, cfg) {
  // 只有能读图的本地 CLI 能干这个：claude / gemini（codex 视觉不稳，排除）
  const prefer = (model === 'gemini') ? ['gemini', 'claude'] : ['claude', 'gemini'];
  const visId = prefer.find(id => { const m = getModel(id); return m && m.bin; });
  if (!visId) throw new Error('需要 claude 或 gemini CLI 来做视觉文风分析（当前都不可用）');
  const m = getModel(visId);
  const cwd = path.dirname(shotPaths[0]);
  const rels = shotPaths.map(p => './' + path.basename(p)).join('、');
  const env = { ...process.env };
  if (cfg?.enableProxy) { const px = proxyUrl(); if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; } }
  // -p 打印模式；claude 只放开 Read（读本地截图），不给 Bash/Write —— 截图内容属不可信输入，
  // 即便被 prompt 注入，最多污染分析文本，绝不能动系统。绝不用 --dangerously-skip-permissions。
  const args = visId === 'claude' ? ['-p', '--allowedTools', 'Read'] : ['-p'];
  const many = multi || shotPaths.length > 2;
  const head = many
    ? `这是【多本】对标网文的阅读页截图（就在当前目录：${rels}，可能来自不同的书）。请读图，提炼它们【共通的写作文风】，产出一份能让另一个 AI「照着这个腔写」的融合【文风指南】。`
    : `这是对标网文的阅读页截图（就在当前目录：${rels}）。请读图，【只分析它的写作文风】，产出一份能让另一个 AI「照着这个腔写」的【文风指南】。`;
  const prompt =
    head + `\n` +
    `写清：段落形态（长短/一句一段/换行密度）、语言基调（平白还是文学、口语程度、口头禅）、节奏与信息密度、叙述口吻、对话风格、爽点与钩子节奏、以及【明确的禁忌】。\n` +
    (many ? `若几本书风格有差异，取它们的最大公约数并注明可调档位；` : ``) +
    `可引用【不超过 10 字】的短句做例证；【不要】整段复制原文、不要摘要剧情。\n` +
    `严格按格式输出（第一行必须是"风格名="）：\n风格名=<一句话风格名>\n<从这里开始是文风指南正文>`;
  const r = spawnSync(m.bin, args, { encoding: 'utf8', timeout: 300000, input: prompt, cwd, env, maxBuffer: 8 * 1024 * 1024, shell: true, windowsHide: true });
  if (r.error) throw new Error(m.name + ' 调用失败：' + r.error.message);
  const raw = (r.stdout || '') + '\n' + (r.stderr || '');
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const mm = clean.match(/风格名\s*[=＝：:]\s*([^\n]+)\n([\s\S]+)/);
  let name, rules;
  if (mm) { name = mm[1].trim(); rules = mm[2].trim(); }
  else { name = '对标文风'; rules = clean.trim(); }
  rules = rules.replace(/\n{3,}/g, '\n\n').trim();
  if (rules.length < 40) { const e = new Error('视觉分析结果异常（太短），请重试（确认 claude 可用、页面已加载正文）'); e.raw = raw.slice(-500); throw e; }
  return { name: name.slice(0, 40), rules, visionModel: visId };
}

// 一步到位：番茄链接(可多本) → 截图 → 视觉分析 → {name, rules}。截图落临时目录，用完清理。
export async function styleFromFanqieUrl({ profilePath, bookUrl, bookUrls, multi, model, onLog = () => {} }, cfg) {
  const outDir = path.join(os.tmpdir(), 'ns_refstyle_' + process.pid + '_' + shotSeq());
  try {
    const shots = await readFanqieShots({ profilePath, bookUrl, bookUrls, multi, outDir, onLog });
    return analyzeStyleFromShots({ shotPaths: shots, model, multi: multi || (bookUrls && bookUrls.length > 1) }, cfg);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}
let _seq = 0; function shotSeq() { return (++_seq).toString(36) + Math.floor(process.hrtime()[1] / 1e5).toString(36); }
