// 连接一个运行中的写作会话，做：穿插指令(send) / 实时镜像(watch) / 停止(stop)。
// 每次都按会话描述符新建一条 MCP 连接（任意进程皆可），与启动它的进程互不依赖。
import { connectInstance } from './mcpclient.mjs';
import { killProcess } from './unterm.mjs';
import { getSession, removeSession, listSessions } from './sessions.mjs';
import { Autopilot } from './autopilot.mjs';
import { recordUsage, parseTokens, currentContextSize } from './usage.mjs';
import { getBook, bookStats } from './books.mjs';
import { stripCtrl } from './imagegen.mjs';
import { maybeAutoPublish } from './autopublish.mjs';
import { setPending, hasPending, getReviewEvery, setReviewEvery, setReviewDefault, takeResume } from './pending.mjs';
import { buildGateHandlers } from './editorgates.mjs';

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
// 判断某会话的窗口里【AI 是否真的在跑】（区别于 AI 已退出、只剩命令行提示符）。
// 用途：穿插类指令（重写/复检/完本…）前先确认——若窗口停在 shell 提示符，绝不能把指令打进命令行，
// 应改为【开新窗口重启 AI】。读一次屏幕做判定；连接失败/读不到→保守判为"不在跑"。
export async function sessionAgentAlive(slug, cfg) {
  const sess = getSession(slug);
  if (!sess) return false;
  let mcp;
  try {
    mcp = await connect(sess, cfg);
    const pane = await resolvePane(mcp, sess);
    if (pane == null) return false;
    const txt = stripCtrl(await mcp.screenText(pane) || '');
    return looksLikeAgentRunning(txt);
  } catch { return false; }
  finally { try { mcp && mcp.close(); } catch {} }
}

// 从屏幕文本判断"AI 是否在跑"。【要正面证据】：只有出现 AI TUI 的明确特征才算在跑；
// 否则（裸命令行 / 空屏 / 认不出）一律判为【不在跑】——宁可多开一个新窗，也绝不把指令打进 shell。
// codex/claude/gemini/qwen 运行时屏幕上必有这些特征之一（状态行/边框/输入框/进行中提示），故足够可靠。
function looksLikeAgentRunning(t) {
  if (!t || !t.trim()) return false;
  const agentMarkers = /(esc to interrupt|to interrupt|tokens used|context left|auto-?compact|\/model\b|\/skills\b|\/help\b|type a message|╭─|╰─|─╮|─╯|▌|▏|❯ |正在(生成|思考|运行|写)|esc 中断|按 enter|ctrl\+c to|human:|assistant:|■ |◼|⏵|working…|working\.\.\.|thinking…|esc to)/i;
  return agentMarkers.test(t);
}

export async function sendToBook(slug, text, cfg) {
  const sess = getSession(slug);
  if (!sess) throw new Error('没有该书的运行中会话：' + slug);
  const mcp = await connect(sess, cfg);
  try {
    const pane = await resolvePane(mcp, sess);
    if (pane == null) throw new Error('窗口里没有活动 pane（可能已关闭）');
    // 【全局安全网】穿插前确认 AI 真的在跑：若窗口停在命令行提示符（AI 已退出），绝不能把指令打进 shell
    //（那会变成往命令行发一长串命令）。此时报清楚的错，让上层改为开新窗口。
    try {
      const screen = stripCtrl(await mcp.screenText(pane) || '');
      if (!looksLikeAgentRunning(screen)) {
        throw new Error('AGENT_NOT_RUNNING：该书窗口里的 AI 已退出、只剩命令行，不能把指令打进命令行。请重新“开始写作/重写”让它开一个新的 AI 窗口。');
      }
    } catch (e) { if (/AGENT_NOT_RUNNING/.test(e.message)) throw e; /* 读屏失败则不硬拦，按原逻辑继续 */ }
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
export async function attachAutopilot(slug, cfg, onLog = () => {}, onFreshRestart = null) {
  const sess = getSession(slug);
  if (!sess) throw new Error('没有该书的运行中会话：' + slug);
  const mcp = await connect(sess, cfg);
  const pane = await resolvePane(mcp, sess);
  if (pane == null) { mcp.close(); throw new Error('窗口里没有活动 pane'); }
  const tokenKey = sess.instanceId + '@' + (sess.startedAt || '');
  // 重启后恢复持久化的写作模式（review→逐批审核；auto→全自动）
  { const b = getBook(slug); setReviewEvery(slug, b?.writeMode === 'review' ? (b.reviewEvery || 1) : 0); }
  // 共享门处理器：大纲审稿门/修订门/收尾/完本门/逐批审核——重挂会话也必须带上，否则跨卷卡在审稿门不动。
  const gates = buildGateHandlers({ slug, book: getBook(slug), model: sess.model, cfg, onLog });
  const ap = new Autopilot(mcp, pane, {
    ...cfg.autopilot,
    assumeStarted: true,   // 重挂的会话：agent 已在运行，空闲时可直接驱动续写
    onLog: (e) => onLog({ ...e, source: 'autopilot' }),
    onTokens: (n) => recordUsage(slug, tokenKey, n),
    onOutlineReady: gates.onOutlineReady,
    onRevisionDone: gates.onRevisionDone,
    finaleCheck: gates.finaleCheck,
    onFinaleReady: gates.onFinaleReady,
    reviewEvery: () => getReviewEvery(slug),
    onBatchReview: gates.onBatchReview,
    // 写完一批：给"写够章却没卷名"的卷自动起名写回 bible（后台、best-effort）
    onBatchDone: async () => { try { const { ensureVolumeNames } = await import('./volname.mjs'); await ensureVolumeNames(getBook(slug), { cfg, onLog: (e) => onLog({ ...e, source: 'volname' }) }); } catch {} },
    takeReviewResume: () => takeResume(slug),
    contextSize: () => { const b = getBook(slug); return b ? currentContextSize(b.dir, sess.model) : 0; },
    freshContextLimit: cfg.autopilot?.freshContextLimit || 0,
    freshFallbackBatches: cfg.autopilot?.freshFallbackBatches || 0,
    onFreshRestart: typeof onFreshRestart === 'function' ? onFreshRestart : undefined,
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
