// CLI 模型交互式登录引导：借内置 unterm-core 终端拉起 agy / claude / codex / gemini / qwen 登录流程，
// 供桌面端弹窗实时回显屏幕、提取 OAuth 授权链接并发送按键，登录完成后自动收窗。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectModel, detectModelAuth, getModel } from './models.mjs';
import { connectInstance } from './mcpclient.mjs';
import { ensureUntermReady, listInstances, processAlive, proxyUrl, winShell } from './unterm.mjs';

const IS_WIN = process.platform === 'win32';
const sessions = new Map();

function stripAnsi(s) {
  return String(s || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
}

function extractAuthUrl(text) {
  const clean = stripAnsi(text);
  const matches = clean.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  // 优先挑 OAuth / 授权 / 登录相关域名或路径
  const prio = matches.find((u) => /accounts\.google|claude\.ai|anthropic\.com|auth\.openai|login|oauth|authorize/i.test(u));
  return prio || matches[matches.length - 1] || '';
}

function buildLoginLaunchScript(det, authInfo, proxy) {
  const bin = det.path || det.bin;
  const args = Array.isArray(authInfo.loginArgs) ? authInfo.loginArgs : [];
  if (IS_WIN) {
    const lines = [
      '$ErrorActionPreference = "Continue"',
      ...(proxy ? [
        `$env:HTTP_PROXY = '${proxy.replace(/'/g, "''")}'`,
        `$env:HTTPS_PROXY = '${proxy.replace(/'/g, "''")}'`,
        `$env:ALL_PROXY = '${proxy.replace(/'/g, "''")}'`,
        `Write-Host "[StoryAlter] 已注入代理: ${proxy.replace(/'/g, "''")}" -ForegroundColor Cyan`,
      ] : []),
      `Write-Host "[StoryAlter] 正在启动 ${det.name} 登录流程..." -ForegroundColor Green`,
      `& '${String(bin).replace(/'/g, "''")}'${args.length ? ' ' + args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ') : ''}`,
    ];
    const fp = path.join(os.tmpdir(), `storyalter-auth-${det.id}-${Date.now()}.ps1`);
    fs.writeFileSync(fp, '\uFEFF' + lines.join('\r\n'), 'utf8');
    return { scriptPath: fp, argv: [winShell(), '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', fp] };
  }
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const envPrefix = proxy ? `export HTTP_PROXY=${q(proxy)} HTTPS_PROXY=${q(proxy)} ALL_PROXY=${q(proxy)}; ` : '';
  const cmd = `${envPrefix}${q(bin)}${args.length ? ' ' + args.map(q).join(' ') : ''}; exec ${q(process.env.SHELL || '/bin/sh')} -i`;
  return { scriptPath: null, argv: [process.env.SHELL || '/bin/zsh', '-i', '-c', cmd] };
}

/**
 * 启动一个内置终端登录会话。
 */
export async function startCliLoginSession(modelId, cfg) {
  const m = getModel(modelId);
  if (!m || m.kind === 'web' || m.kind === 'api') {
    throw new Error(`模型 ${modelId} 不需要 CLI 登录`);
  }
  const det = detectModel(modelId);
  const authInfo = detectModelAuth(modelId, det);
  if (!det.available) {
    throw new Error(`未检测到 ${det.name} CLI，请先安装：${authInfo.installCmd || det.bin}`);
  }

  await ensureUntermReady();
  const inst = listInstances().find((i) => i.mcp_port && (i.pid == null || processAlive(i.pid)));
  if (!inst) throw new Error('未能连接到内置终端引擎 (unterm-core)');

  const mcp = await connectInstance(inst, { identifyAs: cfg?.untermAgentName || 'claude-code' });
  const proxy = proxyUrl(cfg);
  const { scriptPath, argv } = buildLoginLaunchScript(det, authInfo, proxy);

  try {
    const r = await mcp.call('session.create', { cwd: os.homedir(), argv }, 30000);
    const paneId = r?.id ?? r?.pane_id ?? r?.session_id;
    if (paneId == null) throw new Error('创建登录终端失败（未返回 pane id）');

    const id = `auth_${modelId}_${Date.now().toString(36)}`;
    sessions.set(id, { id, modelId, inst, mcp, paneId, scriptPath, startedAt: Date.now() });
    return { ok: true, sessionId: id, modelId, paneId, proxyUsed: !!proxy, proxyUrl: proxy || '' };
  } catch (e) {
    try { mcp.close(); } catch {}
    if (scriptPath) try { fs.unlinkSync(scriptPath); } catch {}
    throw e;
  }
}

/**
 * 轮询登录终端屏幕并复检登录状态。
 */
export async function pollCliLoginSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('登录会话不存在或已关闭');
  let screen = '';
  try {
    const raw = await s.mcp.screenText(s.paneId);
    screen = stripAnsi(raw);
  } catch {}
  const authUrl = extractAuthUrl(screen);
  const auth = detectModelAuth(s.modelId, null, { checkCli: true });
  return {
    ok: true,
    sessionId: s.id,
    modelId: s.modelId,
    screen,
    authUrl,
    loggedIn: !!auth.loggedIn,
    auth,
  };
}

/**
 * 向登录终端发送按键或文本输入。
 */
export async function sendCliLoginInput(sessionId, text) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('登录会话不存在或已关闭');
  await s.mcp.input(s.paneId, String(text ?? ''));
  return { ok: true };
}

/**
 * 关闭并清理登录终端会话。
 */
export async function closeCliLoginSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { ok: true };
  sessions.delete(sessionId);
  try { await s.mcp.destroyPane(s.paneId); } catch {}
  try { s.mcp.close(); } catch {}
  if (s.scriptPath) try { fs.unlinkSync(s.scriptPath); } catch {}
  return { ok: true };
}
