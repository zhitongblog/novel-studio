// 路径与常量集中管理
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();

// 应用根目录（novel-studio/）
export const APP_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// 应用配置目录 ~/.novel-studio
export const CONFIG_DIR = path.join(HOME, '.novel-studio');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const BOOKS_FILE = path.join(CONFIG_DIR, 'books.json');
export const LOG_DIR = path.join(CONFIG_DIR, 'logs');

// Unterm 相关
export const UNTERM_HOME = path.join(HOME, '.unterm');
export const UNTERM_INSTANCES_DIR = path.join(UNTERM_HOME, 'instances');
export const UNTERM_PROXY_FILE = path.join(UNTERM_HOME, 'proxy.json');

// Unterm 可执行文件候选位置（按优先级，跨平台）
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// macOS/Linux 常见安装位置 + Windows Program Files
const EXE_BY_OS = IS_WIN
  ? [
      path.join('C:', 'Program Files', 'Unterm', 'unterm.exe'),
      path.join('C:', 'Program Files', 'Unterm', 'unterm-cli.exe'),
    ]
  : [
      path.join(HOME, '.local', 'bin', 'unterm'),
      IS_MAC ? '/Applications/Unterm.app/Contents/MacOS/unterm' : null,
      '/opt/homebrew/bin/unterm',
      '/usr/local/bin/unterm',
      '/usr/bin/unterm',
    ].filter(Boolean);

const CLI_BY_OS = IS_WIN
  ? [path.join('C:', 'Program Files', 'Unterm', 'unterm-cli.exe')]
  : [
      path.join(HOME, '.local', 'bin', 'unterm-cli'),
      IS_MAC ? '/Applications/Unterm.app/Contents/MacOS/unterm-cli' : null,
      '/opt/homebrew/bin/unterm-cli',
      '/usr/local/bin/unterm-cli',
      '/usr/bin/unterm-cli',
    ].filter(Boolean);

export const UNTERM_EXE_CANDIDATES = [process.env.UNTERM_EXE, ...EXE_BY_OS].filter(Boolean);
export const UNTERM_CLI_CANDIDATES = [process.env.UNTERM_CLI, ...CLI_BY_OS].filter(Boolean);

// 默认书库工作区：
// - 开发期（源码树跑）：APP_DIR 上级 / books（沿用旧行为，便于本地调试）
// - 打包后（引擎在 .app 包内 / resources\engine 里）：绝不写进包内（重装会清、且可能只读），
//   落到用户主目录 ~/NovelStudio/books。用户也可在「设置」里用文件夹选择器另选。
const PACKAGED = /\.app[\\/]Contents[\\/]/.test(APP_DIR) || /[\\/]resources[\\/]engine([\\/]|$)/i.test(APP_DIR);
export const DEFAULT_WORKSPACE = PACKAGED
  ? path.join(HOME, 'NovelStudio', 'books')
  : path.join(path.dirname(APP_DIR), 'books');


// ── GUI 启动时的 PATH 补全 ─────────────────────────────────────────────
// 病根：从 Finder 双击打开的 .app 只继承 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 而 codex / claude / gemini 这些 CLI 装在 ~/.npm-global/bin、/opt/homebrew/bin、nvm 的版本目录里，
// 一个都不在那四个目录中。于是 detectModel 里的 `which codex` 返回空 → 界面上「找不到可用模型」。
// 而终端里跑 `novel doctor` 一切正常——因为 shell 已经加载过 .zshrc/.zprofile。
// 这个差异在开发机上往往看不出来（开发机常被别的软件在 launchd 层设过 PATH），只有干净的新 Mac 才暴露。
//
// 解法：引擎启动时把「登录 shell 的真实 PATH」并进来，再补一份常见安装目录兜底。
// 改的是 process.env.PATH，所以之后所有 which/spawn（包括 spawn 出去的 agent 进程）都能看到。

// 常见的 CLI 安装目录兜底（登录 shell 探测失败、或用户 profile 卡住时用）
function commonBinDirs() {
  const dirs = [
    path.join(HOME, '.npm-global', 'bin'),
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.deno', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    path.join(HOME, '.yarn', 'bin'),
    path.join(HOME, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ];
  // nvm / fnm 的版本目录：把装了的版本都加进去（新版排前面）
  for (const base of [path.join(HOME, '.nvm', 'versions', 'node'),
                      path.join(HOME, 'Library', 'Application Support', 'fnm', 'node-versions')]) {
    try {
      const vs = fs.readdirSync(base).sort().reverse();
      for (const v of vs) {
        for (const b of [path.join(base, v, 'bin'), path.join(base, v, 'installation', 'bin')]) {
          if (fs.existsSync(b)) dirs.push(b);
        }
      }
    } catch {}
  }
  return dirs;
}

let pathAugmented = false;

// 幂等：多次调用只做一次。返回补全后的 PATH。
export function augmentUserPath() {
  if (pathAugmented || IS_WIN) return process.env.PATH || '';
  pathAugmented = true;

  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  const seen = new Set(parts);
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); parts.push(p); } };

  // 1) 登录 shell 的真实 PATH——用户在 .zshrc/.zprofile/.bash_profile 里配的都在这儿。
  //    -i 让它加载交互式 rc（nvm 之类只在 rc 里注入）；超时保护，profile 卡住不能把引擎拖死。
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) for (const p of r.stdout.trim().split(':')) add(p);
  } catch {}

  // 2) 常见安装目录兜底
  for (const d of commonBinDirs()) { try { if (fs.existsSync(d)) add(d); } catch {} }

  process.env.PATH = parts.join(':');
  return process.env.PATH;
}
