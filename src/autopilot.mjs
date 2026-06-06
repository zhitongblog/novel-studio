// Autopilot：监控 Unterm 窗口里 agent 的进度，一旦它停下来发问/等待，就自动应答。
// 策略：
//   - 选择/审批型提问 → 按回车接受高亮的"推荐项"（多数 CLI 默认高亮安全/推荐项）
//   - y/n 型提问 → 送 y
//   - 写完一批后空闲 → 送"继续"指令，驱动下一批
//   - 命中完成短语 → 停止
// 通过"屏幕文本稳定 + busy 标志"判定空闲，避免在 agent 输出中途误触发。
import { parseTokens } from './usage.mjs';

const CR = '\r';
// 模型用量/速率上限 / 配额耗尽的信号 —— 命中就停，别再无谓重试
const LIMIT_RE = /(usage limit|rate[\s_-]?limit|too many requests|429|quota|insufficient[_\s]quota|out of (credits|tokens)|reached your (usage )?limit|you'?ve hit your (usage )?limit|plan limit|monthly limit|resets? (at|in)|try again later|请求过于频繁|额度.{0,6}(用完|耗尽|不足)|用量.{0,4}上限|配额.{0,4}(用完|耗尽|不足)|速率限制|稍后(再|重)试)/i;

export class Autopilot {
  constructor(mcp, paneId, opts = {}) {
    this.mcp = mcp;
    this.paneId = paneId;
    this.opt = opts;                       // = config.autopilot
    this.onLog = opts.onLog || (() => {});
    this.onTokens = opts.onTokens || null; // (n) => 记录 token 用量
    this.lastTokens = 0;
    this.running = false;
    this.continueCount = 0;
    this.sawBusy = false;
    this.prevScreen = null;
    this.stableCount = 0;
    this.lastRespondedHash = null;
    this.sawAgentRunning = false;   // agent 是否曾在前台运行
    // 重挂到一个已在运行的会话：直接认定 agent 已在工作，允许在它空闲时驱动续写
    if (opts.assumeStarted) { this.sawBusy = true; this.sawAgentRunning = true; }
    this.noAgentPolls = 0;          // 启动后仍是 shell 的连续次数
    this.shellAfterAgent = 0;       // agent 运行后又回到 shell 的连续次数
    this.stats = { approvals: 0, continues: 0, answers: 0 };
  }

  log(msg, level = 'info') { this.onLog({ level, msg, stats: { ...this.stats } }); }

  async start() {
    this.running = true;
    this.log('autopilot 已启动，开始监控窗口进度…');
    while (this.running) {
      try {
        await this._tick();
      } catch (e) {
        this.log('监控异常：' + e.message, 'warn');
      }
      await sleep(this.opt.pollMs || 3000);
    }
  }

  stop(reason) {
    if (!this.running) return;
    this.running = false;
    this.log('autopilot 已停止' + (reason ? '：' + reason : ''), 'info');
  }

  async _tick() {
    // pane 还在吗
    const sessions = await this.mcp.sessionList().catch(() => []);
    const pane = sessions.find(s => String(s.id) === String(this.paneId));
    if (!pane) { this.stop('窗口/pane 已关闭'); return; }
    if (pane.is_dead) { this.stop('agent 进程已退出'); return; }

    const screen = (await this.mcp.screenText(this.paneId).catch(() => '')) || '';
    // 用"非空行"的尾部：codex/claude 的 TUI 常把提问渲染在顶部、下面大片空行，
    // 若取最后 N 个原始行会全是空行 → 漏判提问。故过滤空行后再取尾部。
    const tail = screen.split(/\r?\n/).filter(l => l.trim()).slice(-40).join('\n');

    // 模型用量/速率上限 → 立即停止，不再重试（要去抖一次，避免误判）
    if (this.opt.stopOnLimit !== false && LIMIT_RE.test(tail)) {
      this._limitStreak = (this._limitStreak || 0) + 1;
      if (this._limitStreak >= 2) { this.stop('检测到模型用量/速率上限，已停止（不再重试，等额度恢复后手动继续）'); return; }
    } else { this._limitStreak = 0; }

    // 解析并上报 token 用量（agent TUI footer 的累计值）
    const tk = parseTokens(screen);
    if (tk != null && tk !== this.lastTokens) {
      this.lastTokens = tk; this.stats.tokens = tk;
      try { this.onTokens && this.onTokens(tk); } catch {}
    }

    // agent 在场检测（基于屏幕内容，比前台进程名可靠）：
    // bypass 模式下 codex 会 spawn 子 shell 执行命令，进程名会变成 pwsh —— 但屏幕仍是 agent 的 TUI。
    // 只有屏幕回到"裸 shell 提示符且无 agent TUI 标记"才算 agent 退出 → 绝不向裸 shell 注入指令。
    const agentTui = /(esc to interrupt|tokens used|gpt-[0-9]|claude|gemini|❯|›|•\s*(running|working|ran|queued)|▌|\? for shortcuts|to interrupt|to view transcript|press enter)/i.test(tail);
    const bareShell = !agentTui && /(^|\n)\s*(PS\s+)?[A-Za-z]:[\\/][^\n]*>\s*$/.test(tail.replace(/\s+$/, '') + '\n');
    if (agentTui) {
      this.sawAgentRunning = true; this.noAgentPolls = 0; this.shellAfterAgent = 0;
    } else if (bareShell) {
      if (this.sawAgentRunning) {
        this.shellAfterAgent++;
        if (this.shellAfterAgent >= 3) { this.stop('agent 已退出（窗口回到 shell 提示符）'); return; }
        return;
      }
      this.noAgentPolls++;
      if (this.noAgentPolls >= (this.opt.startGracePolls || 12)) {
        this.stop('agent 未能启动（窗口仍停在 shell 提示符，请检查模型 CLI 是否可运行）');
      }
      return;
    }
    // 既非裸 shell、也未必有明确 TUI 标记（agent 正在输出）→ 继续走下面的稳定性判断

    // —— 提问类优先（信任目录/审批/选择菜单/y-n/开放式）——
    // 关键：这些必须在屏幕“churn”时也能应答。codex 启动期会在后台拉 MCP（codex_apps）持续刷屏，
    // 若按“整屏稳定才应答”，信任提示永远等不到稳定 → 卡死。故对提问只做去抖+冷却，不要求整屏稳定。
    const pa = this.classify(tail);
    if (pa.kind === 'stop') { this.stop('检测到完成信号'); return; }
    if (pa.kind === 'yn' || pa.kind === 'menu' || pa.kind === 'answer') {
      this.sawAgentRunning = true;
      this._promptStreak = (this._lastPromptKind === pa.kind) ? (this._promptStreak || 0) + 1 : 1;
      this._lastPromptKind = pa.kind;
      const now = Date.now();
      const cooled = !this._lastPromptSendAt || (now - this._lastPromptSendAt) > 5000;
      if (this._promptStreak >= (this.opt.idleConfirms || 2) && cooled) {
        try {
          // 菜单/信任 = 纯回车采纳高亮项；y-n / 开放式 = 先打字再回车（分两次提交）
          if (pa.kind === 'menu') await this.mcp.enter(this.paneId);
          else if (pa.kind === 'yn') await this.mcp.submitText(this.paneId, this.opt.affirmativeText || 'y');
          else await this.mcp.submitText(this.paneId, pa.send);
          this._lastPromptSendAt = now; this.stats.approvals++;
          const what = pa.kind === 'menu' ? '选择/信任提示 → 回车采纳推荐项'
            : pa.kind === 'yn' ? 'y/n 提问 → 应答 ' + (this.opt.affirmativeText || 'y')
            : '开放式提问 → 自动应答';
          this.log('检测到' + what + ' ｜ ' + pa.reason, 'act');
        } catch (e) { this.log('应答注入失败（将重试）：' + e.message, 'warn'); }
      }
      this.prevScreen = screen;
      return;
    }
    this._lastPromptKind = null; this._promptStreak = 0;

    // 读 busy 标志（字段名做兼容）
    let busy = false;
    try {
      const st = await this.mcp.status(this.paneId);
      busy = st?.busy ?? st?.is_busy ?? (st?.state === 'busy') ?? false;
    } catch {}

    // 活动检测：屏幕相比上一拍变化即视为 agent 在工作（实例可能不提供 busy 字段，
    // 因此用屏幕变化作为主信号，busy 仅作辅助）。
    const changed = screen !== this.prevScreen;
    if (changed && this.prevScreen !== null) { this.sawBusy = true; this.lastRespondedHash = null; }

    if (busy) { this.sawBusy = true; this.stableCount = 0; this.prevScreen = screen; return; }

    // 屏幕稳定性判定（即使没有 busy 字段也能工作）
    if (changed) { this.stableCount = 1; this.prevScreen = screen; }
    else this.stableCount++;

    const idleConfirms = this.opt.idleConfirms || 2;
    if (this.stableCount < idleConfirms) return;   // 还在变化或刚停，再等一拍

    // —— 大纲审稿门：作者输出「【大纲待审：xxx】」并停下 → 调主编无头审稿，把修订指令注回（每个 scope 只触发一次）——
    const sm = tail.match(/【大纲待审[:：]\s*([^】\n]+)】/);
    if (sm && typeof this.opt.onOutlineReady === 'function') {
      const scope = sm[1].trim();
      this.handledReviews = this.handledReviews || new Set();
      if (!this.handledReviews.has(scope)) {
        this.handledReviews.add(scope);
        this.sawAgentRunning = true;
        this.log(`检测到【大纲待审：${scope}】→ 主编无头审稿中…`, 'act');
        try {
          const instr = await this.opt.onOutlineReady(scope);
          if (instr) { await this.mcp.submitText(this.paneId, instr); this.log('审稿意见已注入，等待作者据此修订大纲后开写', 'act'); }
        } catch (e) { this.log('大纲审稿失败（跳过，照常续写）：' + e.message, 'warn'); }
        this.lastRespondedHash = hash(tail); this.prevScreen = screen;
        return;
      }
    }

    // —— 修订验证门：作者输出「【大纲已修订：xxx】」→ 核对文件是否真改（用 hash 去重，重催后可再触发）——
    const rm = tail.match(/【大纲已修订[:：]\s*([^】\n]+)】/);
    if (rm && typeof this.opt.onRevisionDone === 'function') {
      const scope = rm[1].trim();
      const hh = hash(tail);
      if (hh !== this.lastRespondedHash) {
        this.sawAgentRunning = true;
        this.log(`检测到【大纲已修订：${scope}】→ 核对大纲是否真的改了…`, 'act');
        try {
          const instr = await this.opt.onRevisionDone(scope);
          if (instr) await this.mcp.submitText(this.paneId, instr);
        } catch (e) { this.log('修订核对失败（放行）：' + e.message, 'warn'); }
        this.lastRespondedHash = hh; this.prevScreen = screen;
        return;
      }
    }

    const h = hash(tail);
    if (h === this.lastRespondedHash) return;       // 这一屏已经应答过，等待 agent 反应

    const action = this.classify(tail);
    if (action.kind === 'none') return;
    if (action.kind === 'stop') { this.stop('检测到完成信号'); return; }

    // continue 的前置校验（不消耗 hash，便于稍后重试）
    if (action.kind === 'continue') {
      if (!this.sawBusy) return;                    // agent 还没真正开始写，不要催
      if (this.continueCount >= (this.opt.maxAutoContinue || 40)) {
        this.stop('达到自动续写上限 ' + this.opt.maxAutoContinue); return;
      }
    }

    // 这里只剩"续写"动作（提问类已在上面的提问块处理并 return）
    if (action.kind !== 'continue') return;
    // 到达"目标章节数"上限就停（按磁盘实际章节数判断，重启后仍有效）
    if (this.opt.shouldStopContinue) {
      try { if (this.opt.shouldStopContinue()) { this.stop('已达目标章节数上限，停止续写'); return; } } catch {}
    }
    const n = this.continueCount + 1;
    // 四选一（优先级递减，错峰）：全文逻辑自检 → 节奏/格局体检 → 阅读性润色扫描 → 普通续写。
    const everyFull = this.opt.fullCheckEvery || 0;
    const everyPace = this.opt.paceCheckEvery || 0;
    const everyStyle = this.opt.styleCheckEvery || 0;
    const fullCheck = everyFull > 0 && n % everyFull === 0;
    const paceCheck = !fullCheck && everyPace > 0 && n % everyPace === 0;
    const styleCheck = !fullCheck && !paceCheck && everyStyle > 0 && n % everyStyle === 0;
    const text = (fullCheck ? this.opt.fullCheckText
      : paceCheck ? this.opt.paceCheckText
      : styleCheck ? this.opt.styleCheckText
      : this.opt.continueText) || '继续';

    // 先把指令打进输入框、停顿、再单独回车提交（一次性带回车会被当作粘贴内容、只填不发）。
    try {
      await this.mcp.submitText(this.paneId, text);
    } catch (e) {
      this.log('续写注入失败（将重试）：' + e.message, 'warn');
      return;
    }
    this.lastRespondedHash = h;
    this.continueCount++; this.stats.continues++;
    if (fullCheck) { this.stats.fullChecks = (this.stats.fullChecks || 0) + 1; this.log(`检测到空闲 → 触发【全文逻辑自检】（第 ${this.continueCount} 次续写）`, 'act'); }
    else if (paceCheck) { this.stats.paceChecks = (this.stats.paceChecks || 0) + 1; this.log(`检测到空闲 → 触发【节奏/格局体检】（第 ${this.continueCount} 次续写）`, 'act'); }
    else if (styleCheck) { this.stats.styleChecks = (this.stats.styleChecks || 0) + 1; this.log(`检测到空闲 → 触发【阅读性/反AI味润色扫描】（第 ${this.continueCount} 次续写）`, 'act'); }
    else this.log(`检测到空闲 → 自动发送"继续"（第 ${this.continueCount} 次）`, 'act');
  }

  // 把屏幕尾部分类成应答动作
  classify(tail) {
    const t = tail || '';
    const low = t.toLowerCase();

    // 完成信号
    for (const p of (this.opt.stopOnPhrases || [])) {
      if (p && low.includes(String(p).toLowerCase())) return { kind: 'stop', reason: '命中完成短语：' + p };
    }

    const ynRe = /\((y\/n|yes\/no|y\/N|是\/否)\)|\[y\/n\]|\[y\/N\]|\(y\/N\)|是否继续|是否执行|确认执行[?？]?\s*$/i;
    const approveKw = /(approve|allow this|allow command|do you want to proceed|proceed\?|confirm|apply this change|run this command|授权|允许执行|是否允许|要继续吗)/i;
    // 信任目录类提示（codex/claude 首次进入新目录）
    const trusty = /(do you trust|trust the contents of this directory|信任(该|这个)?目录)/i.test(t);

    // 选择型菜单识别
    const lines = t.split(/\r?\n/);
    const numbered = lines.filter(l => /^\s*[>❯➤*●○›]?\s*\d+\s*[.)]\s+\S/.test(l));
    const radio = lines.filter(l => /^\s*[❯➤›]\s+\S/.test(l) || /^\s*[●○]\s+\S/.test(l));
    const hasMenu = numbered.length >= 2 || radio.length >= 2;
    // 真·选择菜单的关键：高亮光标(›/❯)正停在某个【编号选项】上，如 "› 1. Yes"
    const cursorOnOption = lines.some(l => /^\s*[›❯➤]\s{0,3}\d+\s*[.)]\s+\S/.test(l));
    // agent 空闲态特征：底部有 "gpt-x.x medium · 路径" 模型页脚，或 codex 的输入占位提示。
    // 这类屏幕里的 "1. … 2. …" 是 agent 的【输出总结】，不是待选菜单——绝不能当菜单去回车。
    const agentIdleFooter = /\b(gpt|claude|gemini|o\d)[-\s][\w.]*\s+(medium|default|high|low|minimal|xhigh|fast)\b[\s\S]{0,40}·/i.test(t)
      || /(Use \/skills|Implement \{feature\}|Find and fix a bug|Run \/review|\/model to change|to list available skills)/i.test(t);

    const endsQuestion = /[?？]\s*$/.test(t.trimEnd()) || /[:：]\s*$/.test(t.trimEnd());
    const selectionHint = /(press enter|enter to (continue|select|confirm|apply)|use arrows|↑|↓|请选择)/i.test(t);

    if (ynRe.test(t)) return { kind: 'yn', reason: 'y/n 模式' };
    if ((approveKw.test(t) || trusty) && hasMenu) return { kind: 'menu', reason: trusty ? '信任目录提示' : '审批选择菜单' };
    if (approveKw.test(t) || trusty) return { kind: 'yn', reason: trusty ? '信任目录(y)' : '审批关键词' };
    // 仅当光标停在编号选项上（真菜单）才按菜单处理
    if (cursorOnOption) return { kind: 'menu', reason: `选择菜单(${Math.max(numbered.length, radio.length)}项)` };
    // 带明确"请选择/按回车"提示且非 agent 空闲态的菜单
    if (!agentIdleFooter && hasMenu && (endsQuestion || selectionHint)) return { kind: 'menu', reason: '提示型菜单' };

    // 空闲且像在等待（无明确提问）→ 续写
    if (this.looksIdleWaiting(t)) return { kind: 'continue', reason: '空闲等待，驱动下一批' };

    return { kind: 'none' };
  }

  // 判断是否"写完一批、回到输入态、在等下一步"
  looksIdleWaiting(t) {
    const trimmed = t.trimEnd();
    if (!trimmed) return false;
    // 常见 agent 输入提示符尾部特征
    const idleHints = /(›|❯|\$|＞|>|tokens used|esc to interrupt|type a message|输入|input)/i;
    // 没有明显问题、但出现输入态特征
    return idleHints.test(lastNonEmpty(trimmed, 4));
  }
}

function lastLines(s, n) {
  const arr = String(s).split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - n)).join('\n');
}
function lastNonEmpty(s, n) {
  const arr = String(s).split(/\r?\n/).filter(l => l.trim());
  return arr.slice(Math.max(0, arr.length - n)).join('\n');
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
