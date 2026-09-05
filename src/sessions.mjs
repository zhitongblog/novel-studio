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

// 按【还活着的 pane】清理陈旧会话记录。
//
// 为什么非要有这个：上面那道 pidAlive 判据在 Unterm 0.71 上已经【永远为真】——新窗口不再注册自己的
// 实例，一本书记下的 pid 就是作者那个 Unterm 的 GUI pid，只要 Unterm 开着就判"会话还活着"。
// 后果：pane 早关了，书却一直挂在"写作中"，sessionLive 恒真 → 下次点写作/复检只会去"穿插指令"
// 而不是开新窗，指令打进一个不存在的 pane，界面上就是【点了毫无反应】。
// livePanes 传 null（拿不到 pane 列表、连不上）时【一个都不删】——宁可留着陈旧记录，也不能误删在跑的会话。
// minAgeMs：刚登记的会话给一段宽限，避开"窗口刚起、pane 还没在列表里出现"的空窗期。
export function pruneSessionsByPanes(livePanes, { minAgeMs = 60000 } = {}) {
  if (!livePanes) return [];
  const gone = [];
  for (const s of listSessions()) {
    if (s.pane == null) continue;
    if (livePanes.has(String(s.pane))) continue;
    if (Date.now() - Date.parse(s.startedAt || 0) < minAgeMs) continue;
    removeSession(s.slug); gone.push(s.slug);
  }
  return gone;
}
