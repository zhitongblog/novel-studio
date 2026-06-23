// 路径与常量集中管理
import os from 'node:os';
import path from 'node:path';
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

// 默认书库工作区：D:\PM\storybook\books （APP_DIR 的上级 / books）
export const DEFAULT_WORKSPACE = path.join(path.dirname(APP_DIR), 'books');
