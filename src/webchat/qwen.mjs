// 通义千问网页版适配器（qianwen.com — 页面标题「千问-阿里 AI 助手」）。
//
// 选择器已对着真实登录页校准（Profile lixd220，https://www.qianwen.com/）：
//   input       = div[contenteditable="true"]（占位符「向千问提问」）
//   sendButton  = button[aria-label="发送消息"]
//   generating  = button[aria-label*="停止"]（生成中出现的「停止」按钮）
// 千问输入框是 Lexical 富文本，对机器输入很挑。已实测有效的【发送配方】：
//   1) document.execCommand('insertText') 原子写入多行长文（合成 paste / OS 级 /api/v1/type 都不行）
//   2) execCommand 落了字但 Lexical 不认「机器输入」→ 发送键仍禁用 → 补一次【可信按键】(browser_press_key，
//      CDP 可信、后台安全，如一个空格) 触发框架识别 → 发送键立即启用
//   3) 【可信回车】提交
//   另：必须用【非思考模型 Qwen3.x-Max】（见 ensureFastModel）——Thinking 版写小说会「系统超时」。
// 回答抓取不依赖脆弱的气泡 class：优先 .answer-common-card 的 markdown 正文（剥掉「深度思考已完成」头），
//   命中不足再用 grabLatestAnswerText 的哨兵兜底。

import { pollUntil, grabLatestAnswerText } from './adapter.mjs';

export const qwenAdapter = {
  id: 'qwen',
  name: '通义千问 网页版',
  url: 'https://www.qianwen.com/',
  host: 'qianwen.com',   // 锁定标签页用（含 www.qianwen.com / qianwen.com）

  selectors: {
    input: 'div[contenteditable="true"]',
    sendButton: 'button[aria-label="发送消息"], button[aria-label*="发送"]',
    // 回答容器：每条 AI 回答是一个 .answer-common-card（内含 .qk-markdown）。取最后一个 = 最新回答。
    // （已对真实登录页 DOM 校准；grabLatestAnswerText 命中不足时再用哨兵兜底。）
    answer: '.answer-common-card, .markdown-pc-special-class, [class*="qk-markdown"]',
    generating: 'button[aria-label*="停止"], button[aria-label*="停止生成"]',
  },

  // 【关键】确保当前是【非思考模型】。实测：Qwen3-Max-Thinking（深度思考版）写小说会「系统超时」写不出，
  // 必须切到 Qwen3.x-Max（非思考、快）。每次会话开始调一次；已经是非思考则跳过。
  async ensureFastModel(client, { onLog = () => {} } = {}) {
    try {
      const cur = await client.evaluate(`
        (function(){ const el=[...document.querySelectorAll('div')].find(e=>e.offsetParent&&/hover:bg-tag/.test(e.className||'')&&/Qwen/.test(e.textContent||'')); return el?(el.textContent||'').trim():''; })()
      `);
      if (cur && !/Thinking|思考/i.test(cur)) return true;   // 已是非思考模型
      // 打开模型下拉
      await client.evaluate(`
        (function(){ const el=[...document.querySelectorAll('div')].find(e=>e.offsetParent&&/hover:bg-tag/.test(e.className||'')&&/Qwen/.test(e.textContent||'')); if(el) el.click(); return !!el; })()
      `);
      await client.humanDelay(700, 1100);
      // 选一个非思考模型：优先 Qwen3.7-Max，其次任何含 Max 但不含 Thinking 的
      const picked = await client.evaluate(`
        (function(){
          const pref = ['Qwen3.7-Max','Qwen3-Max','Qwen3.5-Flash'];
          const opts = [...document.querySelectorAll('*')].filter(e=>e.offsetParent && /truncate/.test(e.className||'') && /^Qwen[\\w.\\-]+$/.test((e.textContent||'').trim()));
          for (const name of pref) { const hit=opts.find(o=>(o.textContent||'').trim()===name); if(hit){ hit.click(); return name; } }
          const any = opts.find(o=>/Max|Flash/.test(o.textContent||'') && !/Thinking|思考/.test(o.textContent||'')); if(any){ any.click(); return (any.textContent||'').trim(); }
          return '';
        })()
      `);
      await client.humanDelay(500, 800);
      if (picked) onLog({ level: 'info', msg: `网页版[千问]：已切到非思考模型 ${picked}（Thinking 版写作会系统超时）` });
      return !!picked;
    } catch (e) { return false; }
  },

  async send(client, promptText) {
    const sel = this.selectors;
    await this.ensureFastModel(client);   // 发送前确保非思考模型
    const jsIn = JSON.stringify(sel.input);
    const jsTxt = JSON.stringify(String(promptText));
    // 【只用 CDP 可信输入】发送——execCommand/合成事件会触发千问反爬把整页 blank，clipboard.writeText 又不可靠。
    //   1) browser_type 逐字可信输入（isTrusted=true，后台安全，不 blank 页面）→ 发送键从禁用变可用
    //      注意：\n 在千问=回车=提前发送，所以把 prompt 的换行替换成空格（分隔符 <<<CHAPTER…>>> 单行仍可解析）
    //   2) 发送键就绪 → 可信回车提交（绝不空按，空按会把 Lexical 按崩）
    const oneLine = String(promptText).replace(/[\r\n]+/g, '  ');   // 换行→双空格，避免 \n 触发提前发送
    const isGenerating = async () => await client.evaluate(`
      (function(){ const g=document.querySelector(${JSON.stringify(sel.generating)}); return !!(g&&g.offsetParent!==null); })()
    `);
    const sendReady = async () => await client.evaluate(`
      (function(){ const b=document.querySelector(${JSON.stringify(sel.sendButton)}); return !!(b && !b.disabled && b.getAttribute('aria-disabled')!=='true'); })()
    `);
    const submitted = async () => await client.evaluate(`
      (function(){
        const g=document.querySelector(${JSON.stringify(sel.generating)});
        const el=document.querySelector(${jsIn});
        const len=el?(el.innerText||'').replace(/\\uFEFF/g,'').trim().length:0;
        return (g && g.offsetParent!==null) || len < 8;   // 生成中 或 编辑器已空
      })()
    `);
    const editorLen = async () => await client.evaluate(`
      (function(){ const el=document.querySelector(${jsIn}); return el?(el.innerText||'').replace(/\\uFEFF/g,'').trim().length:0; })()
    `);
    const attempt = async (onLog) => {
      if (client.tabId) { try { await client.activateTab(client.tabId); } catch {} }
      // 清空（可信全选+删除）
      try { await client.click(sel.input); await client.humanDelay(80,160); await client.pressKey('a', ['Control']); await client.pressKey('Delete'); } catch {}
      await client.humanDelay(150, 300);
      // 逐字可信输入全文（换行已替空格）。长文分块，避免单次 browser_type 超时/502。
      // 【关键】delayMs 不能太小：中文走 ImeCommitText 异步逐字提交，太快(如 4ms)会【乱序交错】把 prompt 打乱。
      //   实测需 ≥25ms 才保证中文按顺序落字。宁慢勿乱（2K 字约 1 分钟，可接受）。
      const CHUNK = 400;
      for (let p = 0; p < oneLine.length; p += CHUNK) {
        const piece = oneLine.slice(p, p + CHUNK);
        let ok = false;
        for (let r = 0; r < 3 && !ok; r++) {
          try { await client.trustedType(sel.input, piece, { delayMs: 30, timeoutMs: 120000 }); ok = true; }
          catch (e) { await client.humanDelay(500, 900); }   // 502/超时 → 重试该块
        }
        await client.humanDelay(80, 160);
      }
      await client.humanDelay(300, 500);
      // 就绪才提交
      if (await sendReady()) {
        await client.pressKey('Enter');
        await client.humanDelay(800, 1200);
        if (await submitted()) return true;
        try { await client.click(sel.sendButton); } catch {}
        await client.humanDelay(500, 900);
        return await submitted();
      }
      return false;
    };
    for (let i = 0; i < 2; i++) {
      if (await attempt()) return;
      try { await client.click(sel.input); await client.pressKey('a', ['Control']); await client.pressKey('Delete'); } catch {}
      await client.humanDelay(300, 500);
    }
  },

  async waitDone(client, { timeoutMs = 480000, onLog } = {}) {
    const sel = this.selectors;
    // 千问有【深度思考】模式：发出后会先思考再答，中间「停止」按钮可能短暂不在 → 不能一看到 not-generating 就判完成。
    // 分两段：① 先等【生成真正开始】（停止按钮出现，或最新回答实质变长）；② 再等【生成结束】（停止消失 + 文本稳定）。
    const probe = async () => await client.evaluate(`
      (function(){
        const g = document.querySelector(${JSON.stringify(sel.generating)});
        return { generating: !!(g && g.offsetParent !== null) };
      })()
    `);
    // ① 等开始：最多 ~40s。看到 generating=true 或答案文本明显增长即算已开始。
    const startDeadline = Date.now() + Math.min(45000, timeoutMs);
    let baseLen = (await this.readLatest(client) || '').length;
    let started = false;
    while (Date.now() < startDeadline) {
      const st = await probe();
      const curLen = (await this.readLatest(client) || '').length;
      if (st.generating || curLen > baseLen + 30) { started = true; break; }
      await new Promise(r => setTimeout(r, 1200));
    }
    if (!started && onLog) onLog({ level: 'warn', msg: '网页版[千问]：未检测到明确的“开始生成”信号（可能秒回或深度思考未触发停止键），继续按结束判定' });

    // ② 等结束：停止键消失 + 文本长度连续 3 轮稳定（深度思考模式下答案会分段涌现，多等一轮更稳）
    let lastLen = -1, stableHits = 0;
    const done = await pollUntil(async () => {
      const st = await probe();
      const text = await this.readLatest(client);
      const len = (text || '').length;
      if (st.generating) { stableHits = 0; lastLen = len; return false; }
      if (len > 0 && len === lastLen) { stableHits++; } else { stableHits = 0; }
      lastLen = len;
      return stableHits >= 3;
    }, { timeoutMs, intervalMs: 1600, onLog });
    return !!done;
  },

  // 抓最新一条【真正的回答正文】。千问用的是 Qwen3-Max-Thinking，回答卡结构是：
  //   [深度思考已完成 折叠头] + [真正的答案 markdown 正文]
  // 所以要读回答卡里的 markdown 正文，并【剥掉开头的“深度思考已完成/深度思考中”那一行】。
  async readLatest(client) {
    const viaCard = await client.evaluate(`
      (function(){
        function strip(t){
          return String(t||'')
            .replace(/^\\s*深度思考(已完成|中)?\\s*[>》]?\\s*\\n?/,'')   // 去掉思考折叠头那行
            .replace(/^\\uFEFF/,'')
            .trim();
        }
        const cards = Array.from(document.querySelectorAll('.answer-common-card'));
        for (let i = cards.length - 1; i >= 0; i--) {
          const el = cards[i];
          // 优先读 markdown 正文容器（排除思考区）
          const mds = el.querySelectorAll('.qk-markdown, .qk-md-text, .markdown-pc-special-class');
          let body = '';
          if (mds && mds.length) {
            // 取最长的一个 markdown 块（思考摘要通常很短，正文最长）
            for (const m of mds) { const t=(m.innerText||''); if (t.length > body.length) body = t; }
          }
          if (!body) body = el.innerText || '';
          const txt = strip(body);
          if (!txt) continue;
          if (/^深度思考(已完成|中)?$/.test(txt)) continue;   // 纯思考状态卡（还没出正文）→ 跳过
          if (txt.length < 8 && !/CHAPTER|<<</.test(txt)) continue;
          return txt;
        }
        return '';
      })()
    `);
    if (viaCard && String(viaCard).trim()) return viaCard;
    return await grabLatestAnswerText(client, this.selectors.answer);
  },
};

export default qwenAdapter;
