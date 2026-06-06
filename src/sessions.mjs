// 运行中写作会话注册表：把"书 → 已起的 Unterm 实例(端口/令牌/pane/pid)"持久化，
// 这样任意进程（TUI / `novel send` / `novel watch`）都能连上同一个窗口注入指令或镜像内容。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';

const SESS_DIR = path.join(CONFIG_DIR, 'sessions');

function ensure() { fs.mkdirSync(SESS_DIR, { recursive: true }); }
const fileFor = (slug) => path.join(SESS_DIR, slug + '.json');

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = 存在但无权限 → 仍算存活
}

export function saveSession(s) {
  ensure();
  fs.writeFileSync(fileFor(s.slug), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

export function removeSession(slug) {
  try { fs.unlinkSync(fileFor(slug)); } catch {}
}

export function getSession(slug) {
  try { return JSON.parse(fs.readFileSync(fileFor(slug), 'utf8')); } catch { return null; }
}

// 列出仍存活的会话；顺手清理 pid 已死的陈旧记录
export function listSessions() {
  ensure();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(SESS_DIR).filter(f => f.endsWith('.json')); } catch {}
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(SESS_DIR, n), 'utf8')); } catch { continue; }
    if (pidAlive(s.pid)) out.push(s);
    else removeSession(s.slug); // 实例已退出 → 清理
  }
  return out;
}
