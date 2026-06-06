// Unterm 编排封装：定位可执行文件、profile 管理、spawn 新实例、定位新实例、读代理配置
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  UNTERM_EXE_CANDIDATES, UNTERM_CLI_CANDIDATES,
  UNTERM_INSTANCES_DIR, UNTERM_PROXY_FILE,
} from './paths.mjs';

export function findUntermExe() {
  for (const c of UNTERM_EXE_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}
export function findUntermCli() {
  for (const c of UNTERM_CLI_CANDIDATES) if (c && fs.existsSync(c)) return c;
  // 退而求其次：GUI exe 也接受大部分 cli 子命令
  return findUntermExe();
}

// 同步跑一条 unterm-cli 子命令，返回 {ok, stdout, stderr}
export function cli(args, opts = {}) {
  const exe = findUntermCli();
  if (!exe) return { ok: false, stdout: '', stderr: 'unterm-cli 未找到' };
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: opts.timeout || 20000, ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

// —— Profile ——
export function listProfiles() {
  const r = cli(['profile', 'list', '--json']);
  if (r.ok) { try { return JSON.parse(r.stdout); } catch {} }
  // 文本回退
  return r.stdout;
}

export function ensureProfile(name) {
  // 已存在则跳过；profile create 接受自由文本显示名
  const existing = cli(['profile', 'show', name]);
  if (existing.ok) return { created: false, name };
  const r = cli(['profile', 'create', name]);
  return { created: r.ok, name, raw: r };
}

// —— 代理 ——
export function readProxyConfig() {
  try { return JSON.parse(fs.readFileSync(UNTERM_PROXY_FILE, 'utf8')); }
  catch { return null; }
}

export function resolveProxyNode(configNode) {
  if (configNode && configNode !== 'auto') return configNode;
  const p = readProxyConfig();
  return p?.current_node || 'local';
}

export function proxyUrl() {
  const p = readProxyConfig();
  return p?.http_proxy || p?.socks_proxy || '';
}

// —— 实例 ——
export function listInstances() {
  try {
    return fs.readdirSync(UNTERM_INSTANCES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(UNTERM_INSTANCES_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

export function instanceIds() {
  return new Set(listInstances().map(i => i.id));
}

export function instancePids() {
  return new Set(listInstances().map(i => i.pid));
}

// spawn 一个绑定 profile 的新 Unterm 实例，运行 launch.ps1。detached，不阻塞。
// 返回 child pid。随后用 waitForNewInstance() 定位它的 mcp_port/token。
export function spawnInstance({ profile, cwd, launchScript }) {
  const exe = findUntermExe();
  if (!exe) throw new Error('unterm.exe 未找到');
  const args = [];
  if (profile) args.push('--profile', profile);
  args.push('start', '--always-new-process', '--cwd', cwd,
    '-e', 'pwsh', '-NoLogo', '-NoExit', '-File', launchScript);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

// 轮询 instances 目录定位刚 spawn 的实例。
// Unterm 会复用实例 id（alpha…），被 kill 的实例会留下陈旧 json 并被下次复用，
// 所以"新 id"不可靠；优先用 spawn 出的 pid 精确匹配，其次回退到"新 pid + cwd"。
export async function waitForNewInstance({ beforePids, pid, cwd, timeoutMs = 25000 }) {
  const before = beforePids || new Set();
  const deadline = performance.now() + timeoutMs;
  const norm = (p) => path.resolve(String(p || '')).toLowerCase();
  while (performance.now() < deadline) {
    const inst = listInstances();
    // 1) pid 精确匹配（最可靠）
    if (pid != null) {
      const byPid = inst.find(i => i.pid === pid);
      if (byPid) return byPid;
    }
    // 2) 新出现的 pid（+ cwd 过滤）
    let fresh = inst.filter(i => !before.has(i.pid));
    if (cwd) {
      const byCwd = fresh.filter(i => norm(i.cwd) === norm(cwd));
      if (byCwd.length) fresh = byCwd;
    }
    if (fresh.length) {
      fresh.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return fresh[0];
    }
    await sleep(400);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
