// 对标"别人的书"：番茄公开阅读页有字体加密，抓文本是乱码。
// 方案：Unzoo(指定 profile)打开阅读页 → 截图 → claude 视觉【只分析文风】(不复制原文，合法转化性使用) → {name, rules}。
// 与「导入自己的书」(import_fanqie.mjs 走作者后台 API 拿干净全文)是两条不同路径。
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

// 直接走 Unzoo REST：找一个已打开的番茄标签(用户已在所选账号里打开了这本书) → 导航到目标 → 截 2 屏。
// （不套 UnzooClient 的作者后台 tab 匹配逻辑——那套是给发布/导入用的。）
export async function readFanqieShots({ profilePath, bookUrl, outDir, onLog = () => {} }) {
  if (!bookUrl) throw new Error('缺少番茄图书链接');
  // 确保该 profile 已启动（best-effort）
  if (profilePath) { try { await unzoo('/api/v1/profiles/launch', { profile_path: profilePath }); await sleep(1200); } catch {} }
  let list = tabsOf(await unzoo('/api/v1/tabs', null, 'GET'));
  // 最稳：优先用【已打开的章节(reader)页】直接截，不导航（导航常让 tab 失效/正文没加载完 → 截图失败）。
  let tab = list.find(t => /fanqienovel\.com\/reader\//.test(t.url || ''));
  let tabId = tab && (tab.id || tab.tab_id);
  if (tabId) {
    onLog({ level: 'act', msg: '用已打开的番茄章节页直接截图…' });
  } else {
    // 没有章节页 → 找详情页/新建，再从 HTML 抓第 1 章链接跳过去
    tab = list.find(t => /fanqienovel\.com/.test(t.url || ''));
    tabId = tab && (tab.id || tab.tab_id);
    if (!tabId && bookUrl) { try { const c = await unzoo('/api/v1/tabs/create', { url: bookUrl }); tabId = (c.data && (c.data.tab_id || c.data.id)) || c.tab_id; await sleep(2500); } catch {} }
    if (!tabId) throw new Error('未发现番茄标签页。请先在 Unzoo(所选账号)里打开这本番茄书的【任意一章】，再点分析。');
    if (bookUrl) { await unzoo('/api/v1/navigate', { tab_id: tabId, url: bookUrl }); await sleep(3000); }
    const html = await unzoo('/api/v1/get-html', { tab_id: tabId });
    const h = String((html && html.data && (html.data.html || (html.data.result && html.data.result.html) || html.data.text)) || '');
    const m = h.match(/href="(\/reader\/\d+[^"]*)"/) || h.match(/(https?:\/\/fanqienovel\.com\/reader\/\d+[^"']*)/);
    if (m) { const u = m[1].startsWith('http') ? m[1] : ('https://fanqienovel.com' + m[1]); onLog({ level: 'info', msg: '进入第 1 章正文…' }); await unzoo('/api/v1/navigate', { tab_id: tabId, url: u }); await sleep(3500); }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) { try { await unzoo('/api/v1/scroll', { tab_id: tabId, y: 900 }); } catch {} await sleep(900); }
    const s = await unzoo('/api/v1/screenshot', { tab_id: tabId });
    const b64 = s && s.data && s.data.image_base64;
    if (!b64) break;
    const p = path.join(outDir, 'shot' + (i + 1) + '.png');
    fs.writeFileSync(p, Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    shots.push(p);
  }
  if (!shots.length) throw new Error('截图失败（Unzoo 可能未连上或页面未加载正文）');
  onLog({ level: 'info', msg: `已截 ${shots.length} 屏，交给 claude 视觉分析文风…` });
  return shots;
}

// 让视觉模型(claude 优先，其次 gemini)从截图【只分析文风】→ {name, rules}。不复制原文。
export function analyzeStyleFromShots({ shotPaths, model }, cfg) {
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
  const prompt =
    `这是对标网文的阅读页截图（就在当前目录：${rels}）。请读图，【只分析它的写作文风】，产出一份能让另一个 AI「照着这个腔写」的【文风指南】。\n` +
    `写清：段落形态（长短/一句一段/换行密度）、语言基调（平白还是文学、口语程度、口头禅）、节奏与信息密度、叙述口吻、对话风格、爽点与钩子节奏、以及【明确的禁忌】。\n` +
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

// 一步到位：番茄链接 → 截图 → 视觉分析 → {name, rules}。截图落临时目录，用完清理。
export async function styleFromFanqieUrl({ profilePath, bookUrl, model, onLog = () => {} }, cfg) {
  const outDir = path.join(os.tmpdir(), 'ns_refstyle_' + Date.now());
  try {
    const shots = await readFanqieShots({ profilePath, bookUrl, outDir, onLog });
    return analyzeStyleFromShots({ shotPaths: shots, model }, cfg);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}
