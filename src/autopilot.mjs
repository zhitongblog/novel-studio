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
    this._lastOutBytes = null;      // session.idle 的输出字节计数（单调），判"还在动"用
    this._degradedLogged = false;   // 残缺读屏只提示一次
    this.stats = { approvals: 0, continues: 0, answers: 0 };
  }

  log(msg, level = 'info') { this.onLog({ level, msg, stats: { ...this.stats } }); }

  // 调一个【可能不存在】的 MCP 便捷方法：老版本 Unterm 没有的方法、以及测试用的精简假 MCP，
  // 都统一返回 null，让上面的逻辑走屏幕启发式回退，而不是抛 TypeError 把整个监控循环打瘸。
  async _call(name, ...args) {
    const f = this.mcp?.[name];
    if (typeof f !== 'function') return null;
    try { return await f.apply(this.mcp, args); } catch { return null; }
  }

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

  // 优雅停止：不再驱动新批次/收尾/体检，等当前批次写完(回到待续点)后调 cb(关闭窗口)。
  drain(cb) {
    if (this.draining) return;
    this.draining = true;
    this.drainCb = cb;
    this.log('已请求优雅停止：写完当前批次后自动关闭', 'act');
  }

  async _tick() {
    // pane 还在吗
    const sessions = await this.mcp.sessionList().catch(() => []);
    const pane = sessions.find(s => String(s.id) === String(this.paneId));
    if (!pane) { this.stop('窗口/pane 已关闭'); return; }
    if (pane.is_dead) { this.stop('agent 进程已退出'); return; }

    // —— Unterm 0.65 的权威信号（老版本/老客户端拿不到 → 一律 null，自动回退到下面的屏幕启发式）——
    // agentState: working=真在干活(长思考也算) / waiting=真在等人 / idle|done=干完了；由 agent 侧 hook 上报。
    // outBytes: pane 的累计输出字节，单调递增——判"还在动"比 diff 整屏更准（不受光标闪烁、idle 占位符干扰）。
    const ag = await this._call('agentStatus', this.paneId);
    const idleInfo = await this._call('sessionIdle', this.paneId);
    const agentState = ag?.state || null;
    const outBytes = idleInfo?.outBytes ?? null;
    const bytesGrew = outBytes != null && this._lastOutBytes != null && outBytes > this._lastOutBytes;
    if (outBytes != null) this._lastOutBytes = outBytes;
    // detectedAgent 是"这个 pane 前台跑的是不是 AI CLI"的进程级判据，比屏幕正则可靠：
    // true=在跑；false=明确没在跑；null=这版 Unterm 不提供，别下结论。
    const agentPresent = idleInfo ? !!idleInfo.detectedAgent : null;

    const scr = await this._call('screenInfo', this.paneId);
    // ⚠️ 0.65 首连时观测到过瞬时的【1×1 空屏】残缺读数（数秒后自愈）。把它当"屏幕没变化"会一路累加
    //    空闲计数 → confirmOnly 下提前收窗。这类读数整拍跳过：不更新 prevScreen、不计入任何稳定性判定。
    if (scr && scr.rows != null && scr.rows <= 1 && scr.nonEmpty === 0) {
      if (!this._degradedLogged) { this.log('读到 1×1 空屏（Unterm 瞬时状态）→ 跳过该拍，不计入空闲', 'warn'); this._degradedLogged = true; }
      return;
    }
    let screen = scr ? scr.text : ((await this._call('screenText', this.paneId)) || '');
    // ⚠️ 窗口被【卷上去】时(底部出现 "Jump to bottom / ctrl+End ↓" 提示)，真正的提问(审批 Yes/No、菜单)在视口
    //    【下方】读不到 → 永远应答不了(圣女 csld 卡在 Yes/No 的直接原因之一)。故先跳到底部再读，且只在真卷屏时才跳、
    //    不打扰正常写作。用 Ctrl+End(xterm \x1b[1;5F)。
    if (/jump to bottom|ctrl\+end|按住.*到底部|↓\s*$/i.test(screen)) {
      try { await this.mcp.input(this.paneId, '\x1b[1;5F'); await sleep(300); screen = (await this.mcp.screenText(this.paneId).catch(() => '')) || screen; } catch {}
    }
    const screenChanged = this.prevScreen !== null && screen !== this.prevScreen;
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

    // 全局确认门：有"待用户确认"时挂起——不应答、不续写、不处理哨兵，只继续监控窗口存活，
    // 直到用户在界面点"应用修订/跳过"（由服务端注入指令并清除待确认）后自动恢复。
    if (this.opt.isPending && this.opt.isPending()) {
      if (!this._heldLogged) { this.log('已暂停，等待你确认审稿意见（应用修订 / 跳过）', 'info'); this._heldLogged = true; }
      this.prevScreen = screen;
      return;
    }
    this._heldLogged = false;

    // —— 逐批审核 · 恢复：用户已裁决(pending 已清) → 注入"下一批"指令、推进计数，恢复自动监控 ——
    // 暂停时未增 continueCount，故这里增一次让批次号单调推进（否则会卡在同一审核点反复触发）。
    if (this._awaitingReview && !(typeof this.opt.isPending === 'function' && this.opt.isPending())) {
      const resumeText = (typeof this.opt.takeReviewResume === 'function' && this.opt.takeReviewResume())
        || this.opt.continueText || '继续';
      try { await this.mcp.submitText(this.paneId, resumeText); }
      catch (e) { this.log('恢复续写注入失败（将重试）：' + e.message, 'warn'); this.prevScreen = screen; return; }
      this._awaitingReview = false;
      this.continueCount++; this.stats.continues++;
      this.lastRespondedHash = hash(tail);
      this.prevScreen = screen;
      this.log(`已采纳你的裁决 → 继续写下一批（第 ${this.continueCount} 次续写）`, 'act');
      return;
    }

    // 【权威信号优先】agent.status 说它正在干活、且输出/屏幕确实还在动 → 这一拍什么都不做。
    // 此刻屏幕上那些"像提问"的片段多半是流式输出的中间态，抢答就是在打断它（"要不要接着写"被回 y、
    // 一夜滚出几十章那类事故的根）。只在【两个信号互相印证】时压制；万一 hook 状态滞后而屏幕已经静止，
    // 照常走下面的屏幕启发式，绝不会因此卡死。
    if (agentState === 'working' && (bytesGrew || screenChanged)) {
      this.sawAgentRunning = true; this.sawBusy = true;
      this.stableCount = 0; this._doneIdle = 0;
      this.prevScreen = screen;
      return;
    }

    // agent 在场检测：屏幕特征 + 进程级判据（detectedAgent）+ hook 状态，三者任一为正就算在场。
    // bypass 模式下 codex 会 spawn 子 shell 执行命令，前台进程名会变成 pwsh —— 但屏幕仍是 agent 的 TUI。
    // 只有"裸 shell 提示符 + 无 TUI 标记 + 进程级也看不到 agent"才算它退出 → 绝不向裸 shell 注入指令。
    const agentTui = /(esc to interrupt|tokens used|gpt-[0-9]|claude|gemini|❯|›|•\s*(running|working|ran|queued)|▌|\? for shortcuts|to interrupt|to view transcript|press enter)/i.test(tail);
    const bareShell = !agentTui && agentPresent !== true && /(^|\n)\s*(PS\s+)?[A-Za-z]:[\\/][^\n]*>\s*$/.test(tail.replace(/\s+$/, '') + '\n');
    // agentPresent（进程级）/ working·waiting（hook 级）都是"它还在"的正面证据，比屏幕正则可靠。
    // ⚠️ 但 idle/done 不算：agent 退出后 hook 状态可能残留成 done，若据此认定"在场"，就会绕过下面
    //    "回到裸 shell 就停手"的保护 → 把续写指令直接打进命令行。
    const agentActive = agentState === 'working' || agentState === 'waiting';
    if (agentTui || agentPresent === true || agentActive) {
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
      // agent.status 明说 waiting = 它真的停下来在等人 → 一拍即可应答（不必等两拍去抖）；
      // 没有权威状态时仍按老规矩去抖，避免把流式输出中间态误当提问。
      const needStreak = agentState === 'waiting' ? 1 : (this.opt.idleConfirms || 2);
      if (this._promptStreak >= needStreak && cooled) {
        try {
          // 菜单/信任 = 纯回车采纳高亮项；y-n / 开放式 = 先打字再回车（分两次提交）
          // 【作者主导】模式下，"要不要接着写"一律回【不】——否则"只确认不续写"就成了空话（见 classify 里的血泪注释）。
          const denyContinue = this.opt.confirmOnly && pa.continueAsk;
          const denyText = this.opt.declineContinueText || '不用继续。就写到这里停下，等作者给下一段要求；在此之前不要再写任何新章。';
          // pick=某个编号 → 高亮项是"No/退出"这类否定项，必须按编号选肯定项，不能闭眼回车。
          if (pa.kind === 'menu') {
            if (pa.pick) await this.mcp.submitText(this.paneId, String(pa.pick));
            else await this.mcp.enter(this.paneId);
          }
          else if (pa.kind === 'yn') await this.mcp.submitText(this.paneId, denyContinue ? denyText : (this.opt.affirmativeText || 'y'));
          else await this.mcp.submitText(this.paneId, denyContinue ? denyText : pa.send);
          this._lastPromptSendAt = now; this.stats.approvals++;
          const what = denyContinue ? '它在问"要不要接着写" → 作者主导模式，已回绝并让它停下'
            : pa.kind === 'menu' ? (pa.pick ? `选择/信任提示 → 高亮项是否定项，改选第 ${pa.pick} 项（肯定项）` : '选择/信任提示 → 回车采纳推荐项')
            : pa.kind === 'yn' ? 'y/n 提问 → 应答 ' + (this.opt.affirmativeText || 'y')
            : '开放式提问 → 自动应答';
          this.log('检测到' + what + ' ｜ ' + pa.reason, 'act');
        } catch (e) { this.log('应答注入失败（将重试）：' + e.message, 'warn'); }
      }
      this.prevScreen = screen;
      return;
    }
    this._lastPromptKind = null; this._promptStreak = 0;

    // 【仅确认模式】confirmOnly：只自动应答提问（y/n、菜单、信任目录），【绝不自动续写下一批/下一章】。
    // 用于共创窗口模式——作者主导每一章，AI 写完这一章就停在那，等作者读完再给下一章要求。
    // （上面的提问应答已处理；这里没有提问=空闲，直接返回，不走下面的续写/完本/审稿逻辑。）
    if (this.opt.confirmOnly) {
      // 任务干完（连续空闲、不忙）就【自动完成】：回调收窗 + 转"写作完成"。要不要继续是作者的事，不挂着"写作中"。
      // ⚠️血泪教训：只看 status.busy 会误杀【长思考任务】——立项写整本 bible 要 ~8 分钟，思考期 status 常报 not-busy，
      // 15s(旧默认5拍×3s)就被当"干完"收窗，bible 一个字没写就没了(用户："圣经生成失败")。
      // 而 Unterm 0.65 的 session.status【已经彻底没有 busy 字段了】，那套读法恒为 false，等于纯靠屏幕硬扛。
      // 现在的判据（按可靠性）：① agent.status —— working/waiting 都算没干完，idle/done 才算干完；
      // ② session.idle 的输出字节还在涨 → 还在动；③ 屏幕还在变 → 还在动。三者任一成立就清零。
      this.prevScreen = screen;
      let cbusy = agentState === 'working' || agentState === 'waiting';
      if (agentState == null) {
        try { const st = await this.mcp.status(this.paneId); cbusy = st?.busy ?? st?.is_busy ?? (st?.state === 'busy') ?? false; } catch {}
      }
      if (cbusy || screenChanged || bytesGrew) { this._doneIdle = 0; return; }
      this._doneIdle = (this._doneIdle || 0) + 1;
      // 有权威状态(agent.status 明说 idle/done)时 12 拍×3s≈36s 即可收窗；拿不到权威状态就退回保守的
      // 40 拍×3s=120s【既不忙、输出不涨、屏幕也不动】，给慢环境的长思考留足余量，绝不打断在写的窗口。
      const authoritative = agentState === 'idle' || agentState === 'done';
      const need = authoritative ? (this.opt.confirmDoneIdleSignal || 12) : (this.opt.confirmDoneIdle || 40);
      if (this.sawAgentRunning && this._doneIdle >= need) {
        this.running = false;
        this.log(`✅ 本次任务完成，自动收起窗口（依据：${authoritative ? 'agent 状态 ' + agentState + ' + 输出静止' : '屏幕与输出连续静止 ' + Math.round(need * (this.opt.pollMs || 3000) / 1000) + 's'}）`, 'act');
        try { this.opt.onDone && this.opt.onDone('任务完成'); } catch {}
      }
      return;
    }

    // 忙判定：优先 agent.status（0.65 起 session.status 已无 busy 字段，那套读法恒为 false，只作老版本兜底）
    let busy = agentState === 'working';
    if (agentState == null) {
      try {
        const st = await this.mcp.status(this.paneId);
        busy = st?.busy ?? st?.is_busy ?? (st?.state === 'busy') ?? false;
      } catch {}
    }

    // 活动检测：屏幕变化 或 pane 输出字节在涨，都算 agent 在工作。
    // 加 bytesGrew 是为了治"屏幕看着没变、其实一直在出字"和反过来"光标/占位符微动导致屏幕永不稳定"两种误判。
    const changed = screen !== this.prevScreen || bytesGrew;
    if (changed && this.prevScreen !== null) { this.sawBusy = true; this.lastRespondedHash = null; }

    if (busy) { this.sawBusy = true; this.stableCount = 0; this.prevScreen = screen; return; }

    // 稳定性判定（没有权威状态时这就是主信号）
    if (changed) { this.stableCount = 1; this.prevScreen = screen; }
    else this.stableCount++;

    const idleConfirms = this.opt.idleConfirms || 2;
    // 显式「门信号」(【大纲待审】【大纲已修订】【完本待审】或大白话"缺卷N大纲审稿/不能动笔")是作者主动停下发出的信号，
    // 见到即处理、不必等屏幕稳定 N 拍——治"idle 占位符/光标微动导致屏幕永不'稳定'、审稿门永远触发不了"（霍元甲卡死那类）。
    const hasGateSentinel = /【大纲待审[:：]|【大纲已修订[:：]|【完本待审】/.test(tail)
      || (/大纲审稿[-－]?\s*卷/.test(tail) && /(需要等|缺|没有|尚未|还没|不能[动开]笔|无法继续|才能(继续|写))/.test(tail));
    if (this.stableCount < idleConfirms && !hasGateSentinel) return;   // 还在变化或刚停，再等一拍（但显式门信号不等）

    // —— 大纲审稿门：作者输出「【大纲待审：xxx】」并停下 → 调主编无头审稿，把修订指令注回（每个 scope 只触发一次）——
    // sentinel 优先；作者没喊 sentinel、改用大白话说"要等某卷大纲审稿门 / 缺 reviews/大纲审稿-卷N.md"停下时也兜底识别，自动触发审稿。
    let reviewScope = null;
    const sm = tail.match(/【大纲待审[:：]\s*([^】\n]+)】/);
    if (sm) reviewScope = sm[1].trim();
    else {
      const pm = tail.match(/大纲审稿[-－]?\s*(卷\s*[0-9零一二三四五六七八九十百]+)/);
      if (pm && /(需要等|缺|没有|尚未|还没|等待|审稿门|不能[动开]笔|无法继续|不准|才能(继续|写)|待.{0,4}审)/.test(tail)) reviewScope = pm[1].replace(/\s+/g, '');
    }
    if (reviewScope && typeof this.opt.onOutlineReady === 'function') {
      const scope = reviewScope;
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

    // —— 完本闸：作者输出「【完本待审】」→ 完本审稿(核对完本清单)。过则标已完本并停，不过退回补写。——
    const fm = tail.match(/【完本待审】/);
    if (fm && typeof this.opt.onFinaleReady === 'function') {
      const hh = hash(tail);
      if (hh !== this.lastRespondedHash) {
        this.sawAgentRunning = true;
        this.log('检测到【完本待审】→ 完本审稿（核对主线/伏笔/人物收束）…', 'act');
        let r = null;
        try { r = await this.opt.onFinaleReady(); } catch (e) { this.log('完本审稿失败：' + e.message, 'warn'); }
        if (r && r.text) { try { await this.mcp.submitText(this.paneId, r.text); } catch {} }
        this.lastRespondedHash = hh; this.prevScreen = screen;
        if (r && r.stop) this.stop('已完本');
        return;
      }
    }

    const h = hash(tail);
    if (h === this.lastRespondedHash) return;       // 这一屏已经应答过，等待 agent 反应

    const action = this.classify(tail);
    if (action.kind === 'none') return;
    if (action.kind === 'stop') { this.stop('检测到完成信号'); return; }

    // 这里只剩"续写"动作（提问类已在上面的提问块处理并 return）
    if (action.kind !== 'continue') return;
    if (!this.sawBusy) return;                        // agent 还没真正开始写，不要催

    // —— 优雅停止：用户请求停止后，写完【当前批次】、回到待续点 → 关闭窗口，不再驱动新批/收尾/体检 ——
    if (this.draining) {
      this.log('当前批次已写完 → 优雅停止，关闭窗口', 'act');
      this.running = false;
      if (this.drainCb) { try { await this.drainCb(); } catch {} }
      return;
    }

    // —— 收尾优先：处于收尾/完本冲刺阶段先发"收束令"，凌驾于任何停机判定（maxAutoContinue/目标章数）——
    if (typeof this.opt.finaleCheck === 'function') {
      let fin = null;
      try { fin = await this.opt.finaleCheck(this.continueCount); } catch {}
      if (fin) {
        try { await this.mcp.submitText(this.paneId, fin); }
        catch (e) { this.log('收束令注入失败（将重试）：' + e.message, 'warn'); return; }
        this.lastRespondedHash = h; this.continueCount++; this.stats.continues++;
        this.stats.finaleBatches = (this.stats.finaleBatches || 0) + 1;
        this.log(`收尾中 → 已发送收束令（第 ${this.continueCount} 次续写）`, 'act');
        return;
      }
    }

    // 普通续写的停机判定（收尾阶段不会走到这里）
    if (this.continueCount >= (this.opt.maxAutoContinue || 40)) {
      this.stop('达到自动续写上限 ' + this.opt.maxAutoContinue); return;
    }
    if (this.opt.shouldStopContinue) {
      try {
        if (this.opt.shouldStopContinue()) {
          // 写满目标章数：先触发"到达目标"回调(自动发布在此挂)，再停机。回调 fire-and-forget，不阻塞停机。
          try { this.opt.onReachedTarget && this.opt.onReachedTarget(); } catch {}
          this.stop('已达目标章节数上限，停止续写'); return;
        }
      } catch {}
    }
    // —— 省 token：上下文太大就重开新会话（停旧窗口→靠 continuity_ledger 重建最小上下文续写）——
    // 在“写完一批、回到待续点”的干净时机判定（此时上一批正文+台账都已落盘，重开无损）。
    if (typeof this.opt.onFreshRestart === 'function') {
      const limit = this.opt.freshContextLimit || 0;
      const ctx = typeof this.opt.contextSize === 'function' ? (this.opt.contextSize() || 0) : 0;
      const fallbackN = this.opt.freshFallbackBatches || 0;
      let reason = null;
      if (limit > 0 && ctx >= limit) reason = `上下文已达 ${Math.round(ctx / 1000)}K（≥${Math.round(limit / 1000)}K）`;
      else if (fallbackN > 0 && ctx === 0 && this.continueCount > 0 && this.continueCount % fallbackN === 0) reason = `已写 ${this.continueCount} 批`;
      if (reason) {
        this.log(`${reason} → 重开新会话省 token（靠 continuity_ledger 重建上下文）`, 'act');
        this.running = false;
        const cb = this.opt.onFreshRestart;
        setTimeout(() => { Promise.resolve(cb(reason)).catch(() => {}); }, 0);
        return;
      }
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

    // —— 逐批审核门（半自动）：审核模式下，到达审核点就【暂停】等用户裁决，不自动续写。
    // reviewEvery 每拍实时读取(可热切换全自动/审核模式)；本应自动发送的 text 作为"批准并继续"的默认指令交给上层暂存。
    const reviewEvery = (typeof this.opt.reviewEvery === 'function' ? this.opt.reviewEvery() : (this.opt.reviewEvery || 0)) || 0;
    if (reviewEvery > 0 && typeof this.opt.onBatchReview === 'function' && (n % reviewEvery === 0)) {
      this.sawAgentRunning = true;
      let instr = null;
      try { instr = await this.opt.onBatchReview({ n, defaultText: text }); }
      catch (e) { this.log('审核门处理失败（照常续写）：' + e.message, 'warn'); }
      if (instr) {
        try { await this.mcp.submitText(this.paneId, instr); }
        catch (e) { this.log('暂停指令注入失败（将重试）：' + e.message, 'warn'); return; }
        this._awaitingReview = true;
        this.lastRespondedHash = h;
        this.log('本批写完 → 已暂停，等你审核（批准继续 / 按要求继续 / 停止）', 'act');
        return;
      }
    }

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
    // 写完一批的干净时机：给"写够章却没卷名"的卷自动起名(写回 bible)。后台跑、不 await、不阻塞写作循环。
    if (typeof this.opt.onBatchDone === 'function') {
      Promise.resolve().then(() => this.opt.onBatchDone(this.continueCount)).catch(() => {});
    }
  }

  // 把屏幕尾部分类成应答动作
  classify(tail) {
    const t = tail || '';
    const low = t.toLowerCase();

    // 完成信号
    for (const p of (this.opt.stopOnPhrases || [])) {
      if (p && low.includes(String(p).toLowerCase())) return { kind: 'stop', reason: '命中完成短语：' + p };
    }

    // y/n 型提问：既认英文 (y/n) 记号，也认中文「是否…/要不要…/需要我…吗/继续吗/写下一批(章)吗…？」，
    // 中文一律【锚定在屏幕末尾】(问句结尾)判定，避免误伤正文里出现的“是否”。
    // 必须以「吗？」或「？」结尾（真提问），避免误伤正文里出现的“是否/继续”等（正文多以。！结尾）。
    const ynTailRe = /(是否|要不要|需不需要|需要我|可否|可以|行不行|好不好|继续|接着写|写下一[批章]|再写|确认|对)[^\n。！!]{0,10}(吗[?？]?|[?？])\s*$/;
    const ynRe = /\((y\/n|yes\/no|y\/N|是\/否)\)|\[y\/n\]|\[y\/N\]|\(y\/N\)|是否继续|是否执行|确认执行[?？]?\s*$/i;
    const isYn = (s) => ynRe.test(s) || ynTailRe.test(String(s).trimEnd());
    // 【剥边框】——审批弹窗都画在方框里，每行真正的开头是 │ 而不是 ❯，下面所有菜单正则(^\s*[❯›]…)会全部落空。
    // 血泪（复检卡死）：弹窗既认不出菜单、也认不出提问 → 只会被当"空闲"；在 confirmOnly（复检/立项/AI改名）下
    // 更会被 doneIdle 计数当成【任务完成】把窗口收掉，界面显示"✅ 本次任务完成"，实际一个字都没改。
    const bare = stripBox(t);
    // Claude Code 的审批问句【不止一句】"Do you want to proceed?"：
    //   改文件 → "Do you want to make this edit to 第012章.md?"   新建 → "Do you want to create 复检-全书.md?"
    //   跑命令 → "Do you want to proceed?"                       取网页 → "Do you want to make this request?"
    // 只认死 proceed 那一句，它换个问法就再也接不上——这正是"claude 的同意变了、复检没法自动执行"的直接原因。
    // 故改按 "do you want to" 这个稳定前缀认，并把选项文案（Yes, allow all edits / don't ask again /
    // No, and tell Claude what to do differently）也算作证据：将来问句再改，凭选项也还认得出这是审批弹窗。
    const approveKw = /(approve|allow this|allow command|allow all edits|do you want to|proceed\?|confirm|apply this change|run this command|don'?t ask again|tell claude what to do differently|授权|允许执行|是否允许|要继续吗)/i;
    // 信任目录类提示（codex/claude 首次进入新目录）。claude 现在的措辞是 "Do you trust the files in this folder?"
    const trusty = /(do you trust|trust the (contents|files) (of|in) this (directory|folder)|信任(该|这个)?目录)/i.test(bare);

    // 选择型菜单识别（一律在【剥掉边框】的文本上做，否则弹窗里的选项一行都认不出来）
    const lines = bare.split(/\r?\n/);
    const numbered = lines.filter(l => /^\s*[>❯➤*●○›]?\s*\d+\s*[.)]\s+\S/.test(l));
    const radio = lines.filter(l => /^\s*[❯➤›]\s+\S/.test(l) || /^\s*[●○]\s+\S/.test(l));
    const hasMenu = numbered.length >= 2 || radio.length >= 2;
    // 真·选择菜单的关键：高亮光标(›/❯)正停在某个【编号选项】上，如 "› 1. Yes"
    const cursorOnOption = lines.some(l => /^\s*[›❯➤]\s{0,3}\d+\s*[.)]\s+\S/.test(l));
    // agent 空闲态特征：底部有 "gpt-x.x medium · 路径" 模型页脚，或 codex 的输入占位提示。
    // 这类屏幕里的 "1. … 2. …" 是 agent 的【输出总结】，不是待选菜单——绝不能当菜单去回车。
    const agentIdleFooter = /\b(gpt|claude|gemini|o\d)[-\s][\w.]*\s+(medium|default|high|low|minimal|xhigh|fast)\b[\s\S]{0,40}·/i.test(bare)
      || /(Use \/skills|Implement \{feature\}|Find and fix a bug|Run \/review|\/model to change|to list available skills)/i.test(bare);

    const endsQuestion = /[?？]\s*$/.test(bare.trimEnd()) || /[:：]\s*$/.test(bare.trimEnd());
    const selectionHint = /(press enter|enter to (continue|select|confirm|apply)|use arrows|↑|↓|请选择)/i.test(bare);

    // 「要不要继续写下去」这一类提问必须和"信任目录/审批/一般确认"区分开：
    // 在【作者主导】模式(confirmOnly)下，它的正确答案永远是【不】——继续与否是作者的事。
    // 血泪：不区分时，共创批次写完 agent 问一句"要我接着写下一段吗？"，autopilot 回 y，
    // 它就接着写、再问、再 y……一夜滚出 44 章(用户："我让他写三五章，直接写了好几十章")。
    const continueAsk = /(继续|接着写|接下来|下一[批章段]|再写|写下去|往下写)[^\n。！!]{0,12}(吗[?？]?|[?？])\s*$/.test(String(t).trimEnd());
    // 菜单的默认高亮项【不一定是"同意"】：claude 的 bypass 警告框默认停在 "1. No, exit"，
    // 闭眼回车就是把窗口关掉。故凡是走菜单，都先看清高亮项是不是否定项；是的话改按肯定项的编号。
    const pickAffirmative = () => affirmativeOption(lines);
    if (isYn(t)) return { kind: 'yn', reason: continueAsk ? '续写征询' : 'y/n 模式', continueAsk };
    if ((approveKw.test(bare) || trusty) && hasMenu) return { kind: 'menu', reason: trusty ? '信任目录提示' : '审批选择菜单', pick: pickAffirmative() };
    if (approveKw.test(bare) || trusty) return { kind: 'yn', reason: trusty ? '信任目录(y)' : '审批关键词' };
    // 仅当光标停在编号选项上（真菜单）才按菜单处理
    if (cursorOnOption) return { kind: 'menu', reason: `选择菜单(${Math.max(numbered.length, radio.length)}项)`, pick: pickAffirmative() };
    // 带明确"请选择/按回车"提示且非 agent 空闲态的菜单
    if (!agentIdleFooter && hasMenu && (endsQuestion || selectionHint)) return { kind: 'menu', reason: '提示型菜单', pick: pickAffirmative() };

    // 空闲且像在等待（无明确提问）→ 续写
    if (this.looksIdleWaiting(t)) return { kind: 'continue', reason: '空闲等待，驱动下一批' };

    return { kind: 'none' };
  }

  // 判断是否"写完一批、回到输入态、在等下一步"
  looksIdleWaiting(t) {
    const trimmed = t.trimEnd();
    if (!trimmed) return false;
    // 兜底闸：屏幕上摆着 "❯ 1. Yes / 2. No" 这种待选项 = 它在等人点头，绝不是空闲。
    // 上面的关键词认漏了(CLI 又改文案)时，至少不会把审批弹窗当"写完了"——那会在 confirmOnly 下把窗口收掉。
    if (/^\s*[›❯➤]?\s*\d+\s*[.)]\s*(yes|no|y|n|是|否|同意|拒绝|允许|取消|退出)\b/im.test(stripBox(t))) return false;
    // 常见 agent 输入提示符尾部特征
    const idleHints = /(›|❯|\$|＞|>|tokens used|esc to interrupt|type a message|输入|input)/i;
    // 没有明显问题、但出现输入态特征
    return idleHints.test(lastNonEmpty(trimmed, 4));
  }
}

// 剥掉 TUI 方框边框：claude/gemini 把审批弹窗画成 ╭─╮ │ … │ ╰─╯，每行开头是 │ 而不是选项本身，
// 不剥就没有一条菜单正则能命中（"│ ❯ 1. Yes" 的 ^ 后面是 │）。逐行去掉首尾的框线字符即可，
// 嵌套框（diff 预览是框中框）也一并去掉，行内的 ❯ › 光标字符不在框线区段里，不会被误删。
const BOX_EDGE = /^[\s─-╿|｜]+|[\s─-╿|｜]+$/g;
export function stripBox(s) {
  return String(s).split(/\r?\n/).map(l => l.replace(BOX_EDGE, '')).join('\n');
}

// 在一组（已剥边框的）菜单行里挑出"肯定项"的编号——仅在高亮项是【否定项】时才需要它。
// 由来：claude 加了 --dangerously-skip-permissions 后的 bypass 警告框，默认高亮的是 "1. No, exit"，
// 闭眼回车 = 直接退出 agent。返回 null 表示"高亮的就是肯定项/看不明白"，照旧回车采纳高亮项。
const NEG_OPT = /^(no\b|n\b|don'?t|cancel|exit|quit|reject|deny|否|不|拒绝|取消|退出)/i;
const POS_OPT = /^(yes\b|y\b|proceed|accept|allow|approve|continue|ok\b|是|好|同意|允许|确认|接受|继续)/i;
export function affirmativeOption(lines) {
  const opts = [];
  let cursorIdx = -1;
  for (const l of lines) {
    const m = /^\s*([›❯➤]?)\s*(\d+)\s*[.)]\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    if (m[1]) cursorIdx = opts.length;
    opts.push({ num: m[2], text: m[3] });
  }
  if (cursorIdx < 0 || opts.length < 2) return null;          // 没看出高亮项 → 照旧回车
  if (!NEG_OPT.test(opts[cursorIdx].text)) return null;       // 高亮的本来就是肯定项 → 照旧回车
  const pos = opts.find(o => POS_OPT.test(o.text));
  return pos ? pos.num : null;
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
