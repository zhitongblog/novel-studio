// 连接一个运行中的写作会话，做：穿插指令(send) / 实时镜像(watch) / 停止(stop)。
// 每次都按会话描述符新建一条 MCP 连接（任意进程皆可），与启动它的进程互不依赖。
import { connectInstance } from './mcpclient.mjs';
import { killProcess } from './unterm.mjs';
import { getSession, removeSession, listSessions } from './sessions.mjs';
import { Autopilot } from './autopilot.mjs';
import { recordUsage, parseTokens } from './usage.mjs';
import { getBook, bookStats } from './books.mjs';
import { stripCtrl } from './imagegen.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { setPending, hasPending, getReviewEvery, setReviewEvery, setReviewDefault, takeResume } from './pending.mjs';

const CR = '\r';

function instanceOf(sess) {
  return { id: sess.instanceId, mcp_port: sess.mcp_port, auth_token: sess.auth_token };
}

async function connect(sess, cfg) {
  return connectInstance(instanceOf(sess), { identifyAs: cfg?.untermAgentName || 'claude-code' });
}

async function resolvePane(mcp, sess) {
  // 优先用记录的 pane；否则取第一个活 pane
  const ss = await mcp.sessionList().catch(() => []);
  const alive = ss.filter(s => !s.is_dead);
  if (sess.pane != null && alive.some(s => String(s.id) === String(sess.pane))) return sess.pane;
  return alive.length ? alive[0].id : null;
}

// 穿插一条指令到正在写作的窗口
export async function sendToBook(slug, text, cfg) {
  const sess = getSession(slug);
  if (!sess) throw new Error('没有该书的运行中会话：' + slug);
  const mcp = await connect(sess, cfg);
  try {
    const pane = await resolvePane(mcp, sess);
    if (pane == null) throw new Error('窗口里没有活动 pane（可能已关闭）');
    await mcp.submitText(pane, text);   // 先打字、停顿、再回车，确保真正提交
    return { ok: true, instance: sess.instanceId, pane };
  } finally { mcp.close(); }
}

// 实时镜像：持续读屏，内容变化即回调 onFrame(text)。返回 { stop() }。
export async function streamBook(slug, cfg, onFrame, { intervalMs = 1000 } = {}) {
  const sess = getSession(slug);
  if (!sess) throw new Error('没有该书的运行中会话：' + slug);
  const mcp = await connect(sess, cfg);
  const pane = await resolvePane(mcp, sess);
  if (pane == null) { mcp.close(); throw new Error('窗口里没有活动 pane'); }
  let last = null, stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const txt = stripCtrl(await mcp.screenText(pane));   // 去 ANSI/控制码，避免镜像里显示乱码
      if (txt !== last) { last = txt; onFrame(txt); }
    } catch (e) {
      // 实例可能已关闭
      onFrame('[stream] 读取失败：' + e.message);
    }
  }, intervalMs);
  return {
    stop() { stopped = true; clearInterval(timer); try { mcp.close(); } catch {} },
  };
}

// 把 autopilot 挂到一个已在运行的会话上（启动它的进程退出后仍可恢复监控）。
// 返回 { autopilot, mcp, stop() }。
export async function attachAutopilot(slug, cfg, onLog = () => {}) {
  const sess = getSession(slug);
  if (!sess) throw new Error('没有该书的运行中会话：' + slug);
  const mcp = await connect(sess, cfg);
  const pane = await resolvePane(mcp, sess);
  if (pane == null) { mcp.close(); throw new Error('窗口里没有活动 pane'); }
  const tokenKey = sess.instanceId + '@' + (sess.startedAt || '');
  // 重启后恢复持久化的写作模式（review→逐批审核；auto→全自动）
  { const b = getBook(slug); setReviewEvery(slug, b?.writeMode === 'review' ? (b.reviewEvery || 1) : 0); }
  const onBatchReview = async ({ n, defaultText }) => {
    const b = getBook(slug);
    const chapters = (() => { try { return bookStats(b).chapters; } catch { return 0; } })();
    setReviewDefault(slug, defaultText);
    setPending(slug, { kind: 'batch-review', scope: `已写到第 ${chapters} 章 · 第 ${n} 批`, n, chapters });
    onLog({ level: 'act', source: 'autopilot', kind: 'pending-batch', n, chapters,
      msg: `⏸ 本批已写完（已到第 ${chapters} 章），待你审核：批准继续 / 按要求继续 / 停止` });
    return '本批已写完。请【暂停】：先不要写下一批，也不要改大纲，等用户审核当前内容并下达下一步要求后再继续。';
  };
  const ap = new Autopilot(mcp, pane, {
    ...cfg.autopilot,
    assumeStarted: true,   // 重挂的会话：agent 已在运行，空闲时可直接驱动续写
    onLog: (e) => onLog({ ...e, source: 'autopilot' }),
    onTokens: (n) => recordUsage(slug, tokenKey, n),
    reviewEvery: () => getReviewEvery(slug),
    onBatchReview,
    takeReviewResume: () => takeResume(slug),
    isPending: () => hasPending(slug),
    shouldStopContinue: () => { const b = getBook(slug); const t = b?.targetChapters || 0; return t > 0 && bookStats(b).chapters >= t; },
    onReachedTarget: () => { try { maybeAutoPublish(getBook(slug), { cfg, onLog: (e) => onLog({ ...e }) }); } catch {} },
  });
  ap.start();
  return { autopilot: ap, mcp, stop() { ap.stop('外部停止'); mcp.close(); } };
}

// 采样一次某会话的当前 token 用量并记录（用于无 autopilot 时刷新统计）
export async function sampleTokens(slug, cfg) {
  const sess = getSession(slug);
  if (!sess) return null;
  let mcp;
  try {
    mcp = await connect(sess, cfg);
    const pane = await resolvePane(mcp, sess);
    if (pane == null) return null;
    const txt = await mcp.screenText(pane);
    const n = parseTokens(txt);
    if (n) recordUsage(slug, sess.instanceId + '@' + (sess.startedAt || ''), n);
    return n;
  } catch { return null; }
  finally { try { mcp?.close(); } catch {} }
}

// 停止一个会话：关闭对应 Unterm 实例并清理注册
export function stopBook(slug) {
  const sess = getSession(slug);
  if (!sess) return { ok: false, reason: '无该会话' };
  try { killProcess(sess.pid); } catch {}
  removeSession(slug);
  return { ok: true, killed: sess.pid };
}

export { listSessions };
