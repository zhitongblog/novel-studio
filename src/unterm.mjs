// Unterm 编排封装：定位可执行文件、profile 管理、spawn 新实例、定位新实例、读代理配置
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  UNTERM_EXE_CANDIDATES, UNTERM_CLI_CANDIDATES,
  UNTERM_INSTANCES_DIR, UNTERM_PROXY_FILE,
} from './paths.mjs';

const IS_WIN = process.platform === 'win32';

// 在 PATH 里解析一个命令的绝对路径（mac/linux 用 which，win 用 where）
function whichBin(name) {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || '').trim().split(/\r?\n/)[0] || null;
  } catch {}
  return null;
}

// 读某个 unterm 二进制的版本（格式 "unterm 20260620-092052-hash"），取可比较的时间戳串。
export function untermVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) {
      const s = (r.stdout || '').trim();
      const m = s.match(/(\d{8}-\d{6}-[0-9a-f]+)/);   // 日期时间串，可按字典序比较新旧
      return m ? m[1] : s;
    }
  } catch {}
  return '';
}

// 关键修复：本机可能并存多份 unterm（如 ~/.local/bin 的旧版 + /Applications 的新版）。
// 旧版行为不同（pane 复用 / lua 报错）。故从所有存在的候选里挑【版本最新】的，避免误连旧版。
// 可用 UNTERM_EXE 强制指定（如指向自编译的 dev build）。结果缓存，避免每次都跑 --version。
let _exeCache;
export function findUntermExe() {
  if (_exeCache !== undefined) return _exeCache;
  if (process.env.UNTERM_EXE && fs.existsSync(process.env.UNTERM_EXE)) return (_exeCache = process.env.UNTERM_EXE);
  const cands = UNTERM_EXE_CANDIDATES.filter(c => c && fs.existsSync(c));
  const viaPath = whichBin(IS_WIN ? 'unterm.exe' : 'unterm');
  if (viaPath && !cands.includes(viaPath)) cands.push(viaPath);
  let best = null, bestV = null;
  for (const c of cands) {
    const v = untermVersion(c);
    if (best === null || v > bestV) { best = c; bestV = v; }
  }
  return (_exeCache = best);
}

// CLI 取与所选 GUI【同一份安装】里的 unterm-cli（保证版本一致，别一个新一个旧）。
let _cliCache;
export function findUntermCli() {
  if (_cliCache !== undefined) return _cliCache;
  if (process.env.UNTERM_CLI && fs.existsSync(process.env.UNTERM_CLI)) return (_cliCache = process.env.UNTERM_CLI);
  const exe = findUntermExe();
  if (exe) {
    const sib = path.join(path.dirname(exe), IS_WIN ? 'unterm-cli.exe' : 'unterm-cli');
    if (fs.existsSync(sib)) return (_cliCache = sib);
  }
  for (const c of UNTERM_CLI_CANDIDATES) if (c && fs.existsSync(c)) return (_cliCache = c);
  return (_cliCache = whichBin(IS_WIN ? 'unterm-cli.exe' : 'unterm-cli') || exe);
}

// 跨平台结束一个进程（Windows 用 taskkill 杀进程树；POSIX 用信号，先 TERM 后 KILL）。
export function killProcess(pid) {
  if (pid == null) return false;
  if (IS_WIN) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); return true; }
    catch { return false; }
  }
  // POSIX：spawnInstance 用 detached 起的是新进程组，优先杀进程组（负 pid），失败再杀单进程。
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 1500).unref?.();
  return true;
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

// 选 Windows 上跑 launch.ps1 的 PowerShell：优先 PowerShell 7(pwsh)，未安装则回退系统自带的
// Windows PowerShell(powershell.exe)。之前硬编码 pwsh，没装 PS7 的机器上 `-e pwsh` 直接退码1，
// 导致模型窗口永远起不来（立项/开写/重建大纲全失败）。launch.ps1 语法两者兼容。
export function winShell() {
  const cands = [
    process.env.NOVEL_PWSH,
    'C:/Program Files/PowerShell/7/pwsh.exe',
    'C:/Program Files/PowerShell/7-preview/pwsh.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/PowerShell/7/pwsh.exe'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'powershell';   // 系统自带、必在 PATH（System32），最稳的回退
}

// spawn 一个绑定 profile 的新 Unterm 实例，运行启动脚本。detached，不阻塞。
// 返回 child pid。随后用 waitForNewInstance() 定位它的 mcp_port/token。
// Windows：pwsh/powershell -NoExit -File launch.ps1；macOS/Linux：登录 shell source launch.sh 后保持交互
//（mirror -NoExit，让 agent 退出后窗口停在 shell 提示符，autopilot 据此判定停止）。
export function spawnInstance({ profile, cwd, launchScript }) {
  const exe = findUntermExe();
  if (!exe) throw new Error('未找到 unterm 可执行文件（设 UNTERM_EXE 或装到 ~/.local/bin / Program Files）');
  const args = [];
  if (profile) args.push('--profile', profile);
  args.push('start', '--always-new-process', '--cwd', cwd, '-e');
  if (IS_WIN) {
    args.push('pwsh', '-NoLogo', '-NoExit', '-File', launchScript);
  } else {
    const shell = process.env.SHELL || '/bin/zsh';
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    // source 脚本(运行 agent，前台)，agent 退出后落到交互 shell 保持窗口存活
    args.push(shell, '-l', '-c', `source ${q(launchScript)}; exec ${q(shell)} -i`);
  }
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
