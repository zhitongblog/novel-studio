// 番茄小说发布器 —— 从 Tauri 前端 (fanqie-novel-publisher/dist/index.html) 忠实移植到 Node ESM。
//
// 逻辑原样不动，只换外部调用层：
//   - 浏览器自动化【只走官方 MCP 端点】(POST /api/v1/mcp/tools/call)，统一经 src/unzoo.mjs。
//     读用 browser_evaluate；写用坐标真实点击 page_click 与可信输入 browser_input_text、browser_press_key。
//     ⚠️兼容通道(/api/v1/tools/call 与 /api/v1/<动作> 扁平端点)已全面弃用，勿再引入——
//     理由与实测证据见 src/unzoo.mjs 顶部注释及 docs/Unzoo-问题与需求清单.md。
//   - 原 `unzooCallTool(tool,args)` 经 Tauri invoke 透传，这里改为统一走 mcpCall。
//   - 原模块级 `selectedProfilePath` / `selectedBook` → 通过参数/构造函数注入。
//   - 原 `addLog(msg,level)` → 调用方传入的 onLog({level,msg})。
//   - 章节来源由调用方传入数组，本模块不读文件、不解析 ZIP。
//   - 所有 DOM/window/document 前端 UI（按钮/表单/toggle*）已删除，
//     只保留 UnzooClient / FanqiePublisher 两个类的完整方法与纯逻辑辅助。
//
// 纯 Node、零第三方依赖、ESM。只用 node 内置 + global fetch（Node 18+）。

import {
  mcpCall, UNZOO_TIMEOUT_MS,
  clickAt, inputText, uploadTrusted, handleDialog, launchProfile,
} from './unzoo.mjs';

// 运行中的发布器（bookId → FanqiePublisher），供「停止发布」按外部请求中断。
const RUNNING_PUBLISHERS = new Map();
// 请求停止某书的发布（下一章前会检查 shouldStop 并优雅收尾）。返回是否有在跑的发布器。
export function stopPublish(bookId) {
  const p = RUNNING_PUBLISHERS.get(String(bookId));
  if (!p) return false;
  try { p.stop(); } catch {}
  return true;
}

// 尽力清掉某标签页上阻塞的 JS 弹窗（alert/confirm）——它会让 browser_evaluate 永久挂起。
// best-effort：无弹窗/失败都静默。走 MCP browser_handle_dialog。
async function dismissDialog(tabId) {
  return handleDialog(tabId, 'accept');
}

// 判断两个番茄 URL 是否同一目标页（按 pathname 比较，忽略 query）。
// 用于 navigate 跳过"已在目标页"的重复导航，避免反复刷/切页。
function sameFanqiePage(href, target) {
  try {
    const a = new URL(href), b = new URL(target, href);
    return a.host.includes('fanqienovel.com') && b.host.includes('fanqienovel.com') && a.pathname === b.pathname;
  } catch { return false; }
}

// ===== Unzoo 调用层 =====
// 实现在 src/unzoo.mjs（只走官方 MCP 端点）。这里保留同名薄封装，让下方几百处调用点不用改。
const unzooCallTool = (tool, args = {}, timeoutMs = UNZOO_TIMEOUT_MS) => mcpCall(tool, args, timeoutMs);

// ===== UnzooClient 辅助类（从 unzoo-client.ts 搬过来）=====
// 适配：构造函数注入 profilePath（替换原模块级 selectedProfilePath）与 onLog（替换原全局 addLog）。
// 已在文件底部 export（covergen_web.mjs 复用它驱动 ChatGPT 站点标签页）。
class UnzooClient {
  // siteHost：锁定标签页用的站点域（默认番茄）。网页版写作会传入 qianwen.com/chatgpt.com 等，
  // 让同一套 getActiveTab 逻辑改为锁定该聊天站点的标签页。siteLabel 仅用于日志文案。
  constructor(profilePath = null, onLog = null, siteHost = '', siteLabel = '') {
    this.tabId = null;
    this.selectedProfilePath = profilePath || null;
    this.onLog = onLog || (() => {});
    this.siteHost = siteHost || 'fanqienovel.com';
    this.siteLabel = siteLabel || '番茄';
  }

  // 原前端的全局 addLog(msg, level) → 实例 log（转发到 onLog）
  addLog(msg, level = 'info') {
    try { this.onLog({ level, msg }); } catch {}
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 添加随机延迟，模拟人类操作
  async humanDelay(min = 100, max = 300) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.sleep(delay);
  }

  // 自动启动绑定的 Unzoo profile（窗口被关时用）。MCP profile_launch {profile_path}。
  // 关键：profile_path 必须是【完整反斜杠路径】，反斜杠被吞会"failed to load profile"。
  async launchProfile() {
    if (!this.selectedProfilePath) return false;
    try {
      this.addLog('该账号浏览器窗口未开 → 正在自动启动绑定的 Unzoo profile…', 'info');
      // MCP 层失败即抛异常；能返回就算启动成功（部分版本回 null 载荷）。
      const r = await launchProfile(this.selectedProfilePath);
      const ok = r !== false && r?.launched !== false;
      this.addLog(ok ? '✅ 已启动该账号浏览器窗口' : ('⚠️ 启动 profile 返回异常：' + JSON.stringify(r).slice(0, 120)), ok ? 'info' : 'error');
      return ok;
    } catch (e) { this.addLog('启动 profile 失败：' + (e.message || e), 'error'); return false; }
  }

  async getActiveTab() {
    let data = await unzooCallTool('tab_list', {});
    let tabs = data?.tabs || [];

    const selectedProfilePath = this.selectedProfilePath;

    // 严格锁定选中账号——绝不用其他账号顶替（防发错号）
    if (selectedProfilePath) {
      // 【按 profile 名匹配】：Unzoo 升级会改 profile 根目录(如 Chromium\User Data → Unzoo\User Data)，
      // 老配置里存的全路径会对不上。故除全路径相等外，再按【profile 文件夹名】(如 Profile_lixd220)兜底匹配，
      // 根目录变了也照样锁到同名账号——profile 名唯一，不会发错号。
      const wantBase = String(selectedProfilePath).split(/[\\/]/).filter(Boolean).pop();
      const sameProfile = (t) => t.profile_path === selectedProfilePath
        || (t.profile_path && String(t.profile_path).split(/[\\/]/).filter(Boolean).pop() === wantBase);
      const collect = () => {
        const m = new Map();
        for (const t of (tabs || []).filter(sameProfile)) m.set(String(t.tab_id), t);
        return m;
      };
      // 重试 tab_list（偶发只返回部分窗口/漏读，多读几次取并集）
      let union = collect();
      for (let attempt = 0; attempt < 6 && union.size === 0; attempt++) {
        await this.sleep(900);
        data = await unzooCallTool('tab_list', {}); tabs = data?.tabs || [];
        for (const [k, v] of collect()) union.set(k, v);
      }

      // 仍没有该账号任何标签页 → 窗口没开 → 【自动启动绑定的 profile】(绑定 profile 的意义)
      if (union.size === 0) {
        if (await this.launchProfile()) {
          for (let attempt = 0; attempt < 12 && union.size === 0; attempt++) {
            await this.sleep(1500);
            data = await unzooCallTool('tab_list', {}); tabs = data?.tabs || [];
            for (const [k, v] of collect()) union.set(k, v);
          }
        }
      }
      let inProfile = [...union.values()];
      if (inProfile.length === 0) {
        this.addLog(`⚠️ 启动后仍未读到该账号标签页（Unzoo 异常），请手动打开该账号浏览器并登录${this.siteLabel}后重试`, 'error');
        return null;
      }

      const siteInProfile = inProfile.filter(t => t.url && t.url.includes(this.siteHost));
      if (siteInProfile.length > 0) {
        // 已锁定的标签页仍在该账号目标站点页 → 继续用它，绝不来回切
        if (this.tabId) {
          const locked = siteInProfile.find(t => String(t.tab_id) === String(this.tabId));
          if (locked) return locked;
        }
        const t = siteInProfile.find(x => x.active) || siteInProfile[0];
        this.tabId = t.tab_id;
        return t;
      }
      // 账号已开但没目标站点页 → 用该账号一个标签页（优先非活动页），由调用方 navigate 打开。
      // 同一 profile cookie 共享，已登录则能进；未登录会跳登录页，被页面有效性闸拦下（失败安全）。
      const t = inProfile.find(x => !x.active) || inProfile[0];
      this.tabId = t.tab_id;
      this.addLog(`该账号下暂无${this.siteLabel}页 → 用一个标签页打开${this.siteLabel}`, 'info');
      return t;
    }

    // 未选账号：用任意已打开的目标站点页（保留兼容）
    const fanqieTabs = tabs.filter(t => t.url && t.url.includes(this.siteHost));
    if (fanqieTabs.length > 0) {
      if (this.tabId) {
        const locked = fanqieTabs.find(t => String(t.tab_id) === String(this.tabId));
        if (locked) return locked;
      }
      const t = fanqieTabs.find(x => x.active) || fanqieTabs[0];
      this.tabId = t.tab_id;
      return t;
    }
    return null;
  }

  async ensureTabId() {
    if (!this.tabId) {
      await this.getActiveTab();
    }
    if (!this.tabId) {
      throw new Error('未找到任何已打开的番茄标签页，请先在浏览器登录并打开番茄作者后台');
    }
  }

  async evaluate(script) {
    await this.ensureTabId();
    try {
      const result = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: script });
      return result?.result;
    } catch (e) {
      // 超时多半是页面弹了阻塞 alert（eval 被卡住）→ 关掉弹窗后重试一次
      if (/超时/.test(e.message || '')) {
        const dismissed = await dismissDialog(this.tabId);
        if (dismissed) this.addLog('检测到阻塞弹窗并已关闭，重试…', 'warn');
        const result = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: script });
        return result?.result;
      }
      throw e;
    }
  }

  // 真实鼠标点击（CDP，isTrusted=true）—— 选择器版
  async click(selector) {
    await this.ensureTabId();
    await this.humanDelay(20, 60);
    await unzooCallTool('browser_click', {
      tab_id: this.tabId,
      selector: selector
    });
    await this.humanDelay(40, 100);
  }

  // 真实鼠标点击（isTrusted=true）—— 坐标版。走 MCP page_click {loc:[x,y]}。
  // 实测(2.5.28)：命中坐标精确、事件 isTrusted=true。
  async coordClick(x, y) {
    await this.ensureTabId();
    await this.humanDelay(20, 60);
    await clickAt(this.tabId, x, y);
    await this.humanDelay(40, 100);
  }

  // 真实可信点击（CDP Input.dispatchMouseEvent，isTrusted=true）—— 走 Unzoo CDP shim(ws://127.0.0.1:9222)。
  // 番茄新版 Arco 弹窗卡片/「确认」/「立即创建」等只认可信点击（合成 pointer、/api/v1/click 坐标点、JS .click()
  // 都可能落空不触发）。CDP page-id 即 daemon tab_id：ws://<host>:<port>/devtools/page/<tabId>。
  async cdpClick(x, y) {
    await this.ensureTabId();
    if (typeof WebSocket === 'undefined') throw new Error('运行时无 WebSocket，无法用 CDP 可信点击（需 Node 22+）');
    const port = process.env.UNZOO_CDP_PORT || '9222';
    let wsUrl = null;
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
      const pages = Array.isArray(list) ? list : [];
      const pg = pages.find(p => String(p.id) === String(this.tabId))
              || pages.find(p => (p.url || '').includes(this.siteHost));
      wsUrl = pg && pg.webSocketDebuggerUrl;
    } catch (e) { throw new Error(`CDP shim 不可用(${e.message})，请在 Unzoo 设置里开启 CDP(ws://127.0.0.1:${port})`); }
    if (!wsUrl) throw new Error(`CDP 未找到目标页(tabId=${this.tabId})`);
    const ws = new WebSocket(wsUrl);
    let mid = 0;
    const send = (method, params) => new Promise((resolve) => {
      const i = ++mid;
      const h = (e) => { try { const j = JSON.parse(e.data); if (j.id === i) { ws.removeEventListener('message', h); resolve(j); } } catch {} };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    try {
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP ws 连接失败')); setTimeout(() => reject(new Error('CDP ws 连接超时')), 8000); });
      const cx = Math.round(x), cy = Math.round(y);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
    } finally { try { ws.close(); } catch {} }
    await this.humanDelay(40, 100);
  }

  // 定位后点击：locatorBody 是返回目标 DOM 元素(或 null)的 JS 函数体。
  // 用 element.click()(JS)触发——实测本环境坐标点击(/api/v1/click)对番茄发布页顶部按钮/弹窗按钮
  // 常落空不触发(下一步、错别字"忽略"按钮均如此)，JS .click() 才稳定。返回 true=已点击。
  // 注：正文需可信输入的地方走 typeText/pressKey，不经此函数，故 JS click 不影响内容识别。
  async clickByLocator(locatorBody) {
    await this.ensureTabId();
    const expr = `(function(){
      const __find = function(){ ${locatorBody} };
      const el = __find();
      if (!el || typeof el.click !== 'function') return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      el.click();
      return true;
    })()`;
    const ok = await this.evaluate(expr);
    if (ok) await this.humanDelay(40, 100);
    return !!ok;
  }

  // 可信输入到【当前焦点元素】（MCP browser_input_text，走 Chromium IME 管线）。
  // 实测(2.5.28)：beforeinput/input 均 isTrusted=true、inputType=insertText，ProseMirror 认。
  // 调用前须先 focus 目标元素（见 focusEditor）。
  async typeText(text) {
    await this.ensureTabId();
    await inputText(this.tabId, text);
  }

  // 【CDP 可信逐字输入】browser_type：真 WebKeyboardEvent 逐字（isTrusted=true），【后台安全、无需前台】。
  // 用于千问 Lexical 这类只认可信输入、且对合成/execCommand 会反爬 blank 的富文本框。
  // selector 支持 CSS；delayMs 控制打字速度；clearFirst 先清空。
  async trustedType(selector, text, { delayMs = 6, clearFirst = false, timeoutMs = 180000 } = {}) {
    await this.ensureTabId();
    return await unzooCallTool('browser_type', {
      tab_id: String(this.tabId), selector, text: String(text),
      delay_ms: delayMs, clear_first: !!clearFirst, timeout: 8000,
    }, timeoutMs);
  }

  // 真实按键（browser_press_key，支持修饰键，isTrusted=true）
  async pressKey(key, modifiers) {
    await this.ensureTabId();
    await unzooCallTool('browser_press_key', { tab_id: Number(this.tabId), key, modifiers: modifiers || [] });
  }

  // 上传文件（可信注入）：MCP `browser_upload_trusted`——经 blink SetFilesFromPaths 直接给
  // <input type=file> 塞文件，change 事件 isTrusted=true，番茄等硬化站点才认
  //（该工具的官方描述里直接点名了「番茄小说 cover」这个用例）。
  // selector 传【已存在的 <input type=file>】。
  // ⚠️别用 browser_upload（番茄改版后失效，files:0）；
  // ⚠️更别跟 browser_set_input_files 搞混——那个是"预备拦截下一个文件对话框"，语义完全不同。
  async uploadFile(selector, filePaths) {
    await this.ensureTabId();
    return await uploadTrusted(this.tabId, selector, filePaths);
  }

  // 真实键盘清空：Ctrl+A 全选 + Delete
  async clearFocused() {
    await this.pressKey('a', ['Control']);
    await this.humanDelay(60, 120);
    await this.pressKey('Delete');
    await this.humanDelay(60, 120);
  }

  // 彻底清空编辑器并验证为空（清不掉就重试，交替用 execCommand 与真实键盘）。
  // 用于重试/编辑时确保旧内容被清除，避免反复粘贴导致内容累积。
  async clearEditor(selector) {
    const sel = JSON.stringify(selector);
    const isEmpty = async () => await this.evaluate(`
      (function(){
        const ed = document.querySelector(${sel});
        if (!ed) return true;
        const t = (ed.innerText || '').replace(/[\\s\\u00a0\\u3000]/g, '');
        return t === '' || /^请输入/.test(t); // 空或仅占位符视为已清空
      })()
    `);
    for (let i = 0; i < 5; i++) {
      if (await isEmpty()) return true;
      // 聚焦
      await this.evaluate(`(function(){const ed=document.querySelector(${sel});if(ed)ed.focus();return true;})()`);
      if (i % 2 === 0) {
        // execCommand 全选删除
        await this.evaluate(`(function(){const ed=document.querySelector(${sel});if(ed){ed.focus();document.execCommand('selectAll',false,null);document.execCommand('delete',false,null);}return true;})()`);
      } else {
        // 真实键盘 Ctrl+A + Delete
        await this.clearFocused();
      }
      await this.humanDelay(100, 200);
    }
    return await isEmpty();
  }

  // 聚焦元素：坐标真实点击（trusted）+ JS focus 兜底（focus 仅定位光标、非合成动作；
  // ProseMirror 等坐标点击聚焦不上，靠 focus 保证）。聚焦后即可用 typeText 真人级输入。
  async focusElement(selector) {
    await this.ensureTabId();
    const sel = JSON.stringify(selector);
    const rect = await this.evaluate(`(function(){
      const el = document.querySelector(${sel});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (rect) await this.coordClick(rect.x, rect.y);
    await this.evaluate(`(function(){const el=document.querySelector(${sel}); if(el&&el.focus) el.focus(); return true;})()`);
    await this.humanDelay(80, 160);
  }

  // 模拟滚动
  async scroll(direction = 'down', amount = 300) {
    await this.ensureTabId();
    await unzooCallTool('browser_scroll', {
      tab_id: this.tabId,
      direction: direction,
      amount: amount
    });
    await this.humanDelay(100, 200);
  }

  async pageContains(keywords) {
    const script = `
      (function() {
        const text = document.body?.innerText || '';
        const keywords = ${JSON.stringify(keywords)};
        return keywords.some(kw => text.includes(kw));
      })()
    `;
    return await this.evaluate(script);
  }

  // 填充输入框：坐标真实点击聚焦（trusted）+ React-aware nativeSetter 一次性写入。
  // 标题/章节号是 React 受控输入，nativeSetter 是唯一稳定方法——不再先 /type 再
  // 校验+回退（避免出现"先错后对"的画面、提速）。nativeSetter 直接覆盖旧值，
  // 因此无需 Ctrl+A+Delete 清空。
  async fillInput(selector, value) {
    await this.ensureTabId();
    const sel = JSON.stringify(selector);
    const val = JSON.stringify(String(value));
    if (!(await this.evaluate(`!!document.querySelector(${sel})`))) return false;
    await this.focusElement(selector);
    const result = await this.evaluate(`
      (function() {
        const el = document.querySelector(${sel});
        if (!el) return false;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${val});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === ${val};
      })()
    `);
    return result;
  }

  // 填充正文编辑器：真实点击聚焦 + 模拟粘贴（派发带 clipboardData 的 paste 事件）。
  // 正文含换行，逐字 /type 会打乱段落；paste 由 ProseMirror 原生处理，原子写入且
  // 完整保留段落格式（已实测 pCount 正确）。未写入则回退 execCommand insertText。
  async fillEditor(selector, content) {
    await this.ensureTabId();
    const sel = JSON.stringify(selector);
    const txt = JSON.stringify(String(content));
    const exists = await this.evaluate(`!!document.querySelector(${sel})`);
    if (!exists) return false;

    // 真实点击聚焦（更贴近人工操作；ProseMirror 焦点最终由 focus() 保证）
    await this.focusElement(selector);

    // 1) 先彻底清空并验证为空（关键：重试/编辑时清掉旧内容，避免反复粘贴累积）
    const cleared = await this.clearEditor(selector);
    if (!cleared) this.log('⚠️ 编辑器清空可能不彻底');

    // 2) 模拟粘贴（保留段落格式）
    await this.evaluate(`
      (function() {
        const ed = document.querySelector(${sel});
        if (!ed) return false;
        ed.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', ${txt});
        ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    await this.humanDelay(150, 350);

    // 2.5) 关键：番茄 ProseMirror 只认【可信输入】才会把"下一步"按钮从禁用变可用；
    //      合成 paste 只填了 DOM、不触发番茄的内容识别/字数统计。故用可信输入
    //      (browser_input_text，走 Chromium IME 管线，实测 beforeinput/input 均 isTrusted=true)
    //      在正文末尾补一个空格再真实退格删掉 → 触发番茄识别全文、启用"下一步"，且正文零残留。
    try {
      // 保留激活标签页：browser_press_key 仍是键盘事件，前台更稳；且不激活也无副作用。
      if (this.tabId) await this.activateTab(this.tabId);
      await this.humanDelay(150, 300);
      await this.evaluate(`(function(){const ed=document.querySelector(${sel});if(!ed)return;ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
      await this.typeText(' ');
      await this.humanDelay(150, 280);
      await this.pressKey('Backspace');
      await this.humanDelay(120, 220);
    } catch (e) { this.log('⚠️ 可信输入触发失败：' + (e.message || e)); }

    // 3) 校验：内容长度应与目标接近（去空白比较），过长=累积、过短/为空=失败 → 重清+execCommand 兜底
    const expectedLen = String(content).replace(/[\s 　]/g, '').length;
    const actualLen = await this.evaluate(`((document.querySelector(${sel})||{}).innerText||'').replace(/[\\s\\u00a0\\u3000]/g,'').length`);
    // 轻量校验：内容明显偏短才警告日志，不再"先错后对"二次填充
    if (expectedLen > 100 && actualLen < expectedLen * 0.5) {
      this.log(`⚠️ 正文偏短(期望≈${expectedLen}, 实际${actualLen})，请人工核对`);
    }
    return true;
  }

  // UnzooClient.fillEditor 中调用了 this.log（原前端如此，承袭以保持字面一致）。
  log(message) {
    this.addLog(message);
  }

  // 点击含指定文本的按钮：定位可见按钮元素后坐标真实点击（isTrusted=true）
  async clickButtonByText(text) {
    return await this.clickByLocator(`
      const t = ${JSON.stringify(text)};
      const btns = document.querySelectorAll('button, [role="button"], .arco-btn, .byte-btn, [class*="btn"]');
      for (const b of btns) {
        if (b.offsetParent === null) continue;
        if ((b.textContent || '').trim().includes(t)) return b;
      }
      return null;
    `);
  }

  async getTabs() {
    const data = await unzooCallTool('tab_list', {});
    return data?.tabs || [];
  }

  async closeTab(tabId) {
    await unzooCallTool('tab_close', { tab_id: String(tabId) });
  }

  async activateTab(tabId) {
    await unzooCallTool('tab_activate', { tab_id: String(tabId) });
  }

  async navigate(url) {
    if (!this.tabId) {
      await this.getActiveTab();
    }
    if (this.tabId) {
      // 已在目标页就别再导航（避免把你正看的章节页又刷一遍 / 反复切页）
      try {
        const cur = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: 'location.href' });
        const href = cur?.result || '';
        if (href && sameFanqiePage(href, url)) return;   // 已在同一目标页 → 跳过
      } catch {}
      await unzooCallTool('browser_navigate', { tab_id: this.tabId, url });
    } else {
      // 安全第一：选中了账号却没找到其标签页 → 绝不在"当前/其他 profile"乱建标签页(可能发错号)，直接报错。
      if (this.selectedProfilePath) {
        throw new Error('未找到该账号的番茄标签页（tab_list 暂时读不到）。请确认该 Unzoo 账号窗口已打开并登录番茄作者后台，然后重试。');
      }
      // 仅在未指定账号的兼容场景下才新建标签页
      const profileData = await unzooCallTool('profile_get_current', {});
      const profileId = profileData?.profile_id || 'default';
      const newTab = await unzooCallTool('tab_create', { profile_id: profileId, url: url });
      if (newTab?.tab_id) this.tabId = String(newTab.tab_id);
    }
    // 导航后等待页面加载（不再事后重选标签页——保持锁定，避免来回切）
    await this.sleep(1500);
  }

  // 刷新当前标签页（重载当前会话 URL）。用于 ChatGPT 生图卡在"预览"占位时——刷新后完整图才渲染出来。
  async reload() {
    await this.ensureTabId();
    try { await unzooCallTool('browser_reload', { tab_id: String(this.tabId) }); }
    catch { await unzooCallTool('browser_navigate', { tab_id: this.tabId, url: await this.evaluate('location.href') }); }
    await this.sleep(2500);
  }
}

// ===== FanqiePublisher 发布器类（从 publisher.ts 搬过来）=====
// 适配：构造函数注入 client（已带 profilePath/onLog）；log() 转发到 onLog。
class FanqiePublisher {
  constructor(client) {
    this.client = client || new UnzooClient();
    this.chapters = [];
    this.config = null;
    this.status = 'idle';
    this.currentIndex = 0;
    this.currentScheduleDay = null;
    this.chaptersPublishedToday = 0;
    this.shouldStop = false;
    this.interruptReason = null;
    this.lastError = null;
    this.forcedScheduleMode = false;
    this.expectedChapterStart = 0;
    this.onLog = () => {};
    this.onProgress = () => {};
  }

  setChapters(chapters) {
    this.chapters = chapters;
    this.log(`已加载 ${chapters.length} 章`);
  }

  setExpectedChapterStart(chapterNumber) {
    this.expectedChapterStart = chapterNumber;
    this.log(`设置预期起始章节号: 第 ${chapterNumber} 章`);
  }

  getProgress() {
    return {
      currentIndex: this.currentIndex,
      totalChapters: this.chapters.length,
      currentDay: this.currentScheduleDay || new Date(),
      chaptersPublishedToday: this.chaptersPublishedToday,
      status: this.status,
      interruptReason: this.interruptReason,
      lastError: this.lastError,
      currentChapter: this.chapters[this.currentIndex]?.title,
    };
  }

  async start(config) {
    if (this.status === 'running') {
      this.log('发布器已在运行中');
      return;
    }

    this.config = config;
    this.currentIndex = config.startIndex || 0;
    this.status = 'running';
    this.shouldStop = false;
    this.interruptReason = null;
    this.lastError = null;
    this.forcedScheduleMode = false;

    // 编辑模式
    if (config.editMode) {
      this.editStartChapter = config.editStartChapter || 1;
      this.log(`编辑替换模式，从网站第 ${this.editStartChapter} 章开始`);
      this.emitProgress();
      try {
        await this.editLoop();
      } catch (error) {
        this.handleError('编辑循环异常', error);
      }
      return;
    }

    // 新建发布模式
    if (config.scheduledStartDate) {
      this.currentScheduleDay = new Date(config.scheduledStartDate);
      this.currentScheduleDay.setHours(0, 0, 0, 0);
      this.forcedScheduleMode = true;
      this.log(`预约发布模式，从 ${this.formatDate(this.currentScheduleDay)} 开始`);
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      this.currentScheduleDay = tomorrow;
      this.log('当天立即发布模式');
    }
    this.chaptersPublishedToday = 0;

    this.log(`开始发布，从第 ${this.currentIndex + 1} 章开始`);
    this.emitProgress();

    try {
      await this.publishLoop();
    } catch (error) {
      this.handleError('发布循环异常', error);
    }
  }

  // ===== 编辑替换模式 =====
  // 切卷不再点下拉框，改为直接导航到 chapter-manage/<bookId>&<卷序号>（见 gotoVolumePage）——
  // 番茄章节管理页的卷下拉选择器几经改版且要等 Arco Portal 挂载，导航稳得多。

  // 等章节表【真正渲染出数据行】再读——番茄后台是 SPA，异步渲染。
  // 原来靠固定 sleep(1500)，表格没渲染完就 evaluate → 读成"没有这一章"(假 notFound) → 连续3次就停。
  // 与 getFanqieMaxChapter 的读取路径同一套硬化：轮询到【确定结果】(有真数据行 / 明确空态 / 硬失败)才停。
  // prevPage 非空时还要求页码已经翻过去，避免读到上一页的残留行。
  async waitChapterRows({ prevPage = null, maxMs = 15000 } = {}) {
    const probe = `
      (function(){
        var text = document.body ? document.body.innerText : '';
        var hasRows = /第\\s*\\d+\\s*章/.test(text);
        var hasArco = !!document.querySelector('[class*="arco-"]');
        var empty = hasArco && (text.indexOf('暂无') >= 0 || text.indexOf('还没有') >= 0 || text.indexOf('快去创作') >= 0);
        var active = document.querySelector('.arco-pagination-item-active');
        var currentPage = active ? (parseInt(active.textContent) || 1) : 1;
        var login = /\\/login|passport/.test(location.href) || text.indexOf('扫码登录') >= 0;
        var err = ['ERR_', 'net::', '未连接到互联网', '代理服务器', '无法访问此网站'].some(function(s){ return text.indexOf(s) >= 0; });
        return { hasRows: hasRows, empty: empty, currentPage: currentPage, login: login, err: err };
      })()
    `;
    const deadline = Date.now() + maxMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.client.evaluate(probe);
      if (last) {
        if (last.login || last.err) return { ...last, ready: false, fatal: true };
        const paged = prevPage == null || last.currentPage !== prevPage;
        if (paged && (last.hasRows || last.empty)) return { ...last, ready: true };
      }
      await this.client.sleep(400);
    }
    return { ...(last || {}), ready: false };
  }

  // 章节管理页：切到第 volIndex 卷的章节列表（番茄一次只显示一个卷）。返回 true=已渲染出内容。
  async gotoVolumePage(volIndex) {
    const bookId = this.config?.bookId;
    if (!bookId || !volIndex) return false;
    await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&${volIndex}`);
    const st = await this.waitChapterRows({ maxMs: 15000 });
    this.currentVolPage = volIndex;
    return !!st.ready;
  }

  // 在【当前卷】的章节列表里逐页找目标章。
  // 翻页判据改用"下一页按钮是否可用"，不再靠 totalPages —— arco 分页出省略号(1 2 3 … 20)时
  // 从可见页码取 max 会把总页数算漏，导致"遍历N页后未找到"。
  async searchChapterInCurrentVolume(targetChapterNum) {
    const targetPattern = `第${targetChapterNum}章`;
    const checkPage = `
      (function() {
        var targetNum = ${targetChapterNum};
        // 精确匹配：第X章 后面不能跟数字，避免 "第40章" 匹配到 "第402章"
        var exactPattern = new RegExp('第' + targetNum + '章(?![0-9])');
        var links = document.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          if (links[i].textContent && exactPattern.test(links[i].textContent)) return { found: true };
        }
        var active = document.querySelector('.arco-pagination-item-active');
        var currentPage = active ? (parseInt(active.textContent) || 1) : 1;
        var next = document.querySelector('.arco-pagination-item-next');
        var cls = next ? (next.className || '') : '';
        var hasNext = !!next && cls.indexOf('disabled') < 0 && next.getAttribute('aria-disabled') !== 'true';
        return { found: false, currentPage: currentPage, hasNext: hasNext };
      })()
    `;

    // 先等表格渲染完再判断（否则把"还没渲染"当成"没有这一章"）
    const st0 = await this.waitChapterRows({ maxMs: 15000 });
    if (st0.fatal) {
      return { success: false, fatal: true, message: st0.login ? '番茄需要登录' : '番茄页面加载失败(网络/代理错误页)' };
    }

    let r = await this.client.evaluate(checkPage);
    if (r?.found) { this.log(`✅ ${targetPattern} 在当前页`); return { success: true }; }

    // 回到第 1 页再逐页找
    if ((r?.currentPage || 1) !== 1) {
      const prev = r.currentPage;
      this.log('先回到第1页...');
      const jumped = await this.client.clickByLocator(`
        const items = document.querySelectorAll('.arco-pagination-item');
        for (const item of items) { if ((item.textContent || '').trim() === '1') return item; }
        return null;
      `);
      if (jumped) await this.waitChapterRows({ prevPage: prev, maxMs: 12000 });
    }

    const HARD_MAX_PAGES = 300;   // 防御性上限，正常靠"下一页不可用"退出
    for (let page = 1; page <= HARD_MAX_PAGES; page++) {
      r = await this.client.evaluate(checkPage);
      if (r?.found) { this.log(`✅ 在第 ${r.currentPage || page} 页找到 ${targetPattern}`); return { success: true }; }
      if (!r?.hasNext) { this.log(`本卷共 ${r?.currentPage || page} 页，没有 ${targetPattern}`); break; }

      const prev = r.currentPage;
      const navClicked = await this.client.clickByLocator(`
        const next = document.querySelector('.arco-pagination-item-next');
        if (!next) return null;
        const cls = next.className || '';
        if (cls.indexOf('disabled') >= 0 || next.getAttribute('aria-disabled') === 'true') return null;
        return next;
      `);
      if (!navClicked) { this.log('⚠️ 无法翻到下一页'); break; }

      const after = await this.waitChapterRows({ prevPage: prev, maxMs: 12000 });
      if (after.fatal) return { success: false, fatal: true, message: after.login ? '番茄需要登录' : '番茄页面加载失败' };
      if (!after.ready) { this.log('⚠️ 翻页后列表未渲染完，停止本卷查找'); break; }
    }

    return { success: false };
  }

  // 查找章节：先切到该章所属卷再找；找不到再扫其它卷。
  // ⚠️多卷书必需——番茄章节管理页一次只显示一个卷，原来永远只在第1卷找，
  // 第2卷及以后的章"永远找不到"→连续3次notFound→编辑模式直接停。
  async searchForChapter(targetChapterNum, volumeText = '') {
    const vols = Array.isArray(this.config?.fanqieVolumes) ? this.config.fanqieVolumes : [];

    // 目标卷序号 = 卷名在番茄卷列表里的位置（1 基）；取不到就用当前页
    let wantIdx = 0;
    if (volumeText && vols.length) {
      const i = vols.indexOf(volumeText);
      if (i >= 0) wantIdx = i + 1;
      else this.log(`⚠️ 番茄卷列表里没有「${volumeText}」，改为全卷扫描`);
    }
    if (wantIdx && this.currentVolPage !== wantIdx) {
      this.log(`切到第 ${wantIdx} 卷「${volumeText}」的章节列表…`);
      await this.gotoVolumePage(wantIdx);
    }

    this.log(`查找 第${targetChapterNum}章，逐页遍历...`);
    let r = await this.searchChapterInCurrentVolume(targetChapterNum);
    if (r.success || r.fatal) return r;

    // 兜底：目标卷没有 → 扫其它卷（单卷书 / 卷列表未知则直接放弃）
    if (vols.length <= 1) return { success: false, message: `未找到第 ${targetChapterNum} 章` };
    const searched = wantIdx || this.currentVolPage || 1;
    this.log(`目标卷没有第 ${targetChapterNum} 章 → 扫描全部 ${vols.length} 卷…`);
    for (let idx = 1; idx <= vols.length; idx++) {
      if (idx === searched) continue;
      if (this.shouldStop) break;
      this.log(`  查第 ${idx} 卷「${vols[idx - 1]}」…`);
      if (!(await this.gotoVolumePage(idx))) continue;
      r = await this.searchChapterInCurrentVolume(targetChapterNum);
      if (r.success || r.fatal) return r;
    }
    return { success: false, message: `全部 ${vols.length} 卷都没有第 ${targetChapterNum} 章` };
  }

  async editLoop() {
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;

    // publishBook 已把页面导到 chapter-manage/<bookId>&<volumeIndex>，记下当前所在卷页。
    // 之后每章由 searchForChapter 按 chapter.volumeText 自行切卷（多卷书必需）。
    this.currentVolPage = this.config?.volumeIndex || 1;
    const volList = Array.isArray(this.config?.fanqieVolumes) ? this.config.fanqieVolumes : [];
    if (volList.length > 1) this.log(`番茄共 ${volList.length} 卷，编辑时按章所属卷自动切卷`);

    while (this.currentIndex < this.chapters.length && !this.shouldStop) {
      const chapter = this.chapters[this.currentIndex];
      // 用每章的【真实全局章号】去番茄搜索编辑，绝不用顺序计数（否则去找"第1章"了）
      const websiteChapterNum = chapter.chapterNumber || (this.editStartChapter + this.currentIndex);
      this.log(`[${this.currentIndex + 1}/${this.chapters.length}] 编辑网站第 ${websiteChapterNum} 章: ${chapter.title}`);
      this.emitProgress();

      try {
        const result = await this.editChapter(chapter, websiteChapterNum);

        if (result.success) {
          this.currentIndex++;
          consecutiveFailures = 0;
          this.log(`✅ 第 ${websiteChapterNum} 章编辑成功`);

          // 间隔等待
          if (this.currentIndex < this.chapters.length && this.config) {
            const interval = this.config.intervalSeconds || 3;
            this.log(`等待 ${interval} 秒...`);
            await this.client.sleep(interval * 1000);
          }
        } else if (result.needsIntervention) {
          this.pause(result.reason, result.message);
          return;
        } else if (result.notFound) {
          consecutiveFailures++;
          if (consecutiveFailures >= maxConsecutiveFailures) {
            this.log(`⚠️ 连续 ${maxConsecutiveFailures} 次找不到章节，停止编辑`);
            this.pause('unknown_error', `网站第 ${websiteChapterNum} 章不存在`);
            return;
          }
          this.log(`⚠️ 未找到第 ${websiteChapterNum} 章，尝试刷新页面重试...`);
          // 刷新页面重试
          await this.client.evaluate(`location.reload()`);
          await this.client.sleep(3000);
        } else {
          consecutiveFailures++;
          this.log(`编辑失败: ${result.message}，重试中...`);
          if (consecutiveFailures >= maxConsecutiveFailures) {
            this.pause('unknown_error', `连续失败: ${result.message}`);
            return;
          }
          await this.client.sleep(2000);
        }
      } catch (error) {
        this.handleError(`编辑章节 ${chapter.title} 时出错`, error);
        this.pause('unknown_error', String(error));
        return;
      }
    }

    if (this.currentIndex >= this.chapters.length) {
      this.status = 'completed';
      this.log(`🎉 编辑完成！共编辑 ${this.chapters.length} 章`);
    }

    this.emitProgress();
  }

  async editChapter(chapter, websiteChapterNum) {
    // Step 1: 确保在章节管理页面
    const onChapterList = await this.client.pageContains(['章节管理', '新建章节']);
    if (!onChapterList) {
      this.log('不在章节管理页面，尝试导航...');
      return { success: false, message: '请先进入章节管理页面' };
    }

    // Step 2: 使用搜索功能查找章节（按该章所属卷切卷后再找）
    this.log(`查找第 ${websiteChapterNum} 章...`);
    const navigateToChapter = await this.searchForChapter(websiteChapterNum, chapter.volumeText || '');
    if (!navigateToChapter.success) {
      // 登录失效/网络错误页是硬失败——不要当成"这章不存在"去重试刷新，直接要人介入
      if (navigateToChapter.fatal) {
        return { success: false, needsIntervention: true, reason: 'page_invalid', message: navigateToChapter.message };
      }
      return { success: false, notFound: true, message: navigateToChapter.message };
    }

    // Step 3: 定位对应章节的编辑按钮后坐标真实点击
    this.log(`在当前页面查找第 ${websiteChapterNum} 章的编辑按钮...`);
    const findClicked = await this.client.clickByLocator(`
      const targetNum = ${websiteChapterNum};
      // 精确匹配 "第X章" - 后面不能跟数字，避免 "第402章" 匹配到 "第4023章"
      const exactPattern = new RegExp('第' + targetNum + '章(?![0-9])');
      const links = document.querySelectorAll('a');
      let targetLink = null, targetRow = null;
      for (const link of links) {
        if (exactPattern.test(link.textContent || '')) {
          targetLink = link;
          targetRow = link.closest('tr');
          if (!targetRow) {
            let parent = link.parentElement;
            while (parent && parent !== document.body) {
              if (parent.children.length > 3) { targetRow = parent; break; }
              parent = parent.parentElement;
            }
          }
          break;
        }
      }
      if (!targetLink || !targetRow) return null;
      // 只点"编辑"图标（番茄行内操作：.icon-edit / .auto-editor-chapter-edit），
      // 绝不点"删除"(.icon-delete)，避免误删已发布章节。
      const edit = targetRow.querySelector('.icon-edit, .auto-editor-chapter-edit, .tomato-edit, [class*="chapter-edit"]');
      if (edit && !((edit.className||'').includes('delete'))) return edit;
      // 兜底：文本或 title 明确为"编辑"且不含"删除"的元素
      const cands = targetRow.querySelectorAll('a, button, span, [role="button"], [class*="icon"]');
      for (const el of cands) {
        const t = (el.textContent || '').trim();
        const ti = el.getAttribute('title') || el.getAttribute('aria-label') || '';
        const cls = (typeof el.className === 'string' ? el.className : '');
        if (cls.includes('delete') || t.includes('删除') || ti.includes('删除')) continue;
        if (t === '编辑' || ti.includes('编辑') || cls.includes('edit')) return el;
      }
      // 找不到明确的"编辑"就返回 null（绝不误点删除或其它），由上层报"未找到"
      return null;
    `);
    this.log(`查找并点击编辑: ${findClicked}`);

    if (!findClicked) {
      return { success: false, notFound: true, message: `未找到第 ${websiteChapterNum} 章` };
    }

    await this.client.sleep(2000);

    // Step 3: 处理"是否继续编辑"弹窗（坐标真实点击）
    const continueHandled = await this.client.clickByLocator(`
      const modals = document.querySelectorAll('.arco-modal, [role="dialog"], [class*="modal"]');
      for (const modal of modals) {
        const text = modal.textContent || '';
        if (text.includes('继续编辑') || text.includes('是否继续') || text.includes('刚刚更新')) {
          const buttons = modal.querySelectorAll('button, .arco-btn');
          for (const btn of buttons) {
            const bt = (btn.textContent || '').trim();
            if (bt.includes('继续编辑') || bt === '继续') return btn;
          }
        }
      }
      return null;
    `);
    if (continueHandled) {
      this.log('已点击"继续编辑"');
      await this.client.sleep(1000);
    }

    // Step 4: 等待编辑页面加载
    let editorReady = false;
    for (let i = 0; i < 20; i++) {
      const check = await this.client.evaluate(`!!document.querySelector('.ProseMirror')`);
      if (check) {
        editorReady = true;
        break;
      }
      await this.client.sleep(500);
    }

    if (!editorReady) {
      return { success: false, message: '编辑页面加载超时' };
    }

    // Step 4: 注入内容
    this.log('注入新内容...');
    await this.injectContent(chapter);
    await this.client.sleep(500);

    // Step 5: 点击保存按钮（编辑模式是保存，不是下一步）—— 坐标真实点击
    this.log('保存修改...');
    let isNext = false;
    let saved = await this.client.clickByLocator(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) { const t=(btn.textContent||'').trim(); if (t==='保存'||t.includes('保存')) return btn; }
      return null;
    `);
    if (!saved) {
      // 没有保存按钮则点"下一步"（编辑后进入发布流程）
      saved = await this.client.clickByLocator(`
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) { const t=(btn.textContent||'').trim(); if (t.includes('下一步')) return btn; }
        return null;
      `);
      if (saved) isNext = true;
    }

    if (!saved) {
      return { success: false, message: '未找到保存按钮' };
    }

    await this.client.sleep(1000);

    // 如果点击的是下一步，需要处理发布弹窗
    if (isNext) {
      // 等待并处理弹窗
      for (let retry = 0; retry < 5; retry++) {
        await this.client.sleep(500);

        // 检查是否有错别字弹窗
        await this.handleTypoDialog();

        // 检查是否有阻断性错误
        const blockingError = await this.checkBlockingErrors();
        if (blockingError.hasError) {
          return {
            success: false,
            needsIntervention: true,
            reason: blockingError.reason,
            message: blockingError.message,
          };
        }

        // 检查是否出现发布设置
        const hasPublishDialog = await this.client.pageContains(['发布设置', '确认发布']);
        if (hasPublishDialog) {
          // 先选择 AI 选项（坐标真实点击）
          const targetText = (this.config?.useAI || false) ? '是' : '否';
          await this.client.clickByLocator(`
            const radioTexts = document.querySelectorAll('.arco-radio-text');
            for (const span of radioTexts) {
              if ((span.textContent || '').trim() === ${JSON.stringify(targetText)}) {
                const label = span.closest('label.arco-radio');
                if (label) return label;
              }
            }
            return null;
          `);
          await this.client.sleep(200);
          // 点击确认发布
          await this.client.clickButtonByText('确认发布');
          await this.client.sleep(1000);
          break;
        }
      }
    }

    // Step 6: 检查是否保存成功，返回章节列表
    await this.client.sleep(1500);

    // 等待返回章节列表（最多等待15秒）
    let returnedToList = false;
    for (let i = 0; i < 30; i++) {
      const onList = await this.client.pageContains(['章节管理', '新建章节']);
      if (onList) {
        returnedToList = true;
        break;
      }

      // 如果还在编辑页面，尝试返回
      const stillOnEdit = await this.client.pageContains(['请输入标题', '请输入正文', 'ProseMirror']);
      if (stillOnEdit && i > 5) {
        this.log('仍在编辑页面，尝试返回章节列表...');
        // 方法1~3：定位返回按钮/面包屑/返回图标后坐标真实点击
        const backClicked = await this.client.clickByLocator(`
          const buttons = document.querySelectorAll('button, a, [role="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '返回' || text === '取消' || text.includes('返回列表')) return btn;
          }
          const breadcrumbs = document.querySelectorAll('.arco-breadcrumb-item a, [class*="breadcrumb"] a');
          for (const link of breadcrumbs) { if ((link.textContent || '').includes('章节管理')) return link; }
          const backIcons = document.querySelectorAll('[class*="back"], [class*="return"], .arco-icon-left, svg[class*="back"]');
          for (const icon of backIcons) { return icon.closest('button') || icon.closest('a') || icon; }
          return null;
        `);
        // 方法4：都没有则浏览器后退（导航操作，非控件点击）
        if (!backClicked) {
          await this.client.evaluate(`(function(){ history.back(); return true; })()`);
        }
        await this.client.sleep(2000);
      }

      await this.client.sleep(500);
    }

    if (!returnedToList) {
      this.log('⚠️ 无法确认是否返回章节列表，直接导航...');
      // 直接导航回【刚才所在的那一卷】的章节管理页（不是写死第1卷，否则下一章又要重新切卷）
      if (this.config?.bookId) {
        const volumeIdx = this.currentVolPage || this.config.volumeIndex || 1;
        await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${this.config.bookId}&${volumeIdx}`);
        await this.waitChapterRows({ maxMs: 15000 });
      }
    }

    return { success: true };
  }

  stop() {
    this.shouldStop = true;
    this.status = 'stopped';
    this.interruptReason = 'manual_stop';
    this.log('已停止');
    this.emitProgress();
  }

  async publishLoop() {
    while (this.currentIndex < this.chapters.length && !this.shouldStop) {
      const chapter = this.chapters[this.currentIndex];
      this.log(`[${this.currentIndex + 1}/${this.chapters.length}] 处理: ${chapter.title}`);
      this.emitProgress();

      await this.closeExtraTabs();

      try {
        const result = await this.publishChapter(chapter);

        if (result.success) {
          this._softFails = 0;
          this.chaptersPublishedToday++;
          this.currentIndex++;
          this.log(`✅ 第 ${this.currentIndex} 章发布成功 (今日已发: ${this.chaptersPublishedToday})`);

          if (result.switchedToNextDay) {
            this.forcedScheduleMode = true;
            this.chaptersPublishedToday = 1;
            this.log(`📅 系统限制触发，已切换到新日期: ${this.formatDate(this.currentScheduleDay)}`);
          }

          if (this.config && this.config.chaptersPerDay !== 'max') {
            const limit = parseInt(this.config.chaptersPerDay);
            if (this.chaptersPublishedToday >= limit) {
              this.log(`📅 已达到每天 ${limit} 章的限制，切换到下一天`);
              this.switchToNextDay();
              this.forcedScheduleMode = true;
            }
          }

          if (this.currentIndex < this.chapters.length && this.config) {
            const interval = this.config.intervalSeconds || 3;
            this.log(`等待 ${interval} 秒...`);
            await this.client.sleep(interval * 1000);
          }
        } else if (result.needsIntervention) {
          this.pause(result.reason, result.message);
          return;
        } else {
          // 软失败重试有上限——同一章连续失败 N 次就暂停，绝不无限点（曾因此一直点"下一步"）
          this._softFails = (this._softFails || 0) + 1;
          this.log(`发布失败(${this._softFails}/3)，等待重试: ${result.message}`);
          if (this._softFails >= 3) {
            this.pause('repeated_failure', `第 ${this.currentIndex + 1} 章连续失败 3 次：${result.message}。已暂停，请人工核对番茄页面状态后重试。`);
            return;
          }
          await this.client.sleep(3000);
        }
      } catch (error) {
        this.handleError(`处理章节 ${chapter.title} 时出错`, error);
        this.pause('unknown_error', String(error));
        return;
      }
    }

    if (this.currentIndex >= this.chapters.length) {
      this.status = 'completed';
      this.log(`🎉 全部完成！共发布 ${this.chapters.length} 章`);
    }

    this.emitProgress();
  }

  async publishChapter(chapter) {
    // Step 0: 多卷模式——发布前确保切到本章所属卷；切不过去就暂停（绝不发到错卷）
    if (this.config?.matchVolumes && chapter.volumeText) {
      const sw = await this.switchToVolume(chapter.volumeText);
      if (!sw.ok) {
        return {
          success: false, needsIntervention: true, reason: 'volume_missing',
          message: sw.found === false
            ? `番茄该书没有卷「${chapter.volumeText}」。番茄建卷不可逆，请先在番茄后台手动建好该卷，再继续发布。`
            : `切换到卷「${chapter.volumeText}」未成功（当前：${sw.current || '未知'}），已暂停以免发到错卷。`,
        };
      }
    }
    // Step 1: 注入内容
    this.log('注入章节内容...');
    await this.injectContent(chapter);
    await this.client.sleep(500);

    // Step 2: 点击下一步
    this.log('点击下一步...');
    await this.clickNextStep();
    await this.client.sleep(1000);

    // Step 3: 循环处理弹窗
    for (let retry = 0; retry < 10; retry++) {
      if (retry > 0) await this.client.sleep(300);

      const detectionModeHandled = await this.handleDetectionModeDialog();
      if (detectionModeHandled) {
        this.log('已选择内容检测方式');
        await this.client.sleep(500);
        continue;
      }

      const typoHandled = await this.handleTypoDialog();
      if (typoHandled) {
        this.log('已忽略错别字提示');
        await this.client.sleep(500);
        continue;
      }

      const riskResult = await this.handleRiskDetection();
      if (riskResult.triggered) {
        await this.client.sleep(600);
        continue;
      }

      const conflictHandled = await this.handleConflict();
      if (conflictHandled) {
        this.log('已处理内容冲突');
        await this.client.sleep(500);
        continue;
      }

      const earlyBlockingError = await this.checkBlockingErrors();
      if (earlyBlockingError.hasError) {
        this.log(`⚠️ 弹窗处理阶段检测到阻断性错误: ${earlyBlockingError.message}`);
        return {
          success: false,
          needsIntervention: true,
          reason: earlyBlockingError.reason,
          message: earlyBlockingError.message,
        };
      }

      const atPublishDialog = await this.client.pageContains(['发布设置', '确认发布']);
      if (atPublishDialog) break;

      if (retry < 3) await this.client.sleep(500);
    }

    // Step 4: 检查阻断性错误
    const blockingError = await this.checkBlockingErrors();
    if (blockingError.hasError) {
      this.log(`⚠️ 检测到阻断性错误: ${blockingError.message}`);
      return {
        success: false,
        needsIntervention: true,
        reason: blockingError.reason,
        message: blockingError.message,
      };
    }

    // Step 5: 等待发布设置弹窗
    this.log('等待发布设置弹窗...');
    const dialogReady = await this.waitForPublishDialog(30);
    if (!dialogReady) {
      this.log('发布设置弹窗未出现');
      return { success: false, message: '发布设置弹窗未出现' };
    }

    // Step 6: 处理发布设置弹窗
    this.log('处理发布设置...');
    const publishResult = await this.handlePublishDialog();

    if (!publishResult.success) {
      if (publishResult.needsIntervention) {
        return {
          success: false,
          needsIntervention: true,
          reason: publishResult.reason,
          message: publishResult.message,
        };
      }
      return { success: false, message: publishResult.message };
    }

    // Step 7: 等待发布完成
    this.log('等待发布完成...');
    const complete = await this.waitForPublishComplete();
    if (!complete) {
      return { success: false, message: '发布超时' };
    }

    await this.client.sleep(800);

    // Step 8: 点击新建章节
    this.log('点击新建章节...');
    await this.clickNewChapter();
    await this.client.sleep(1200);

    // Step 9: 等待新编辑页加载
    this.log('等待新编辑页...');
    await this.waitForNewChapterPage();

    return {
      success: true,
      switchedToNextDay: publishResult.switchedToNextDay,
    };
  }

  async closeExtraTabs() {
    try {
      const tabs = await this.client.getTabs();
      if (tabs.length <= 2) return;

      const fanqieTabs = [];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const url = tab.url || '';
        if (url.includes('fanqienovel.com') || url.includes('author.fqnovel')) {
          fanqieTabs.push({ tabId: tab.tab_id, url, active: tab.active });
        }
      }

      if (fanqieTabs.length <= 1) return;

      let activeTab = fanqieTabs.find(t => t.active);
      if (!activeTab) activeTab = fanqieTabs.find(t => this.isEditPage(t.url));

      const isEditPageActive = activeTab && this.isEditPage(activeTab.url);
      if (!isEditPageActive) return;

      const tabsToClose = [];
      for (const tab of fanqieTabs) {
        if (tab.tabId !== activeTab.tabId && !this.isEditPage(tab.url)) {
          tabsToClose.push(tab.tabId);
        }
      }

      if (tabsToClose.length === 0) return;

      const editTabId = activeTab.tabId;

      for (const tabId of tabsToClose) {
        try {
          await this.client.closeTab(tabId);
          await this.client.sleep(150);
        } catch (e) { }
      }

      await this.client.sleep(300);
      try {
        await this.client.activateTab(editTabId);
        await this.client.sleep(500);
      } catch (e) { }

      this.log(`✂️ 已关闭 ${tabsToClose.length} 个多余标签页`);
    } catch (error) {
      this.log(`[Tab清理] 异常: ${error}`);
    }
  }

  isEditPage(url) {
    return url.includes('/publish/') ||
           url.includes('/chapter/edit') ||
           url.includes('/chapter-edit') ||
           url.includes('/editor') ||
           (url.includes('chapter') && url.includes('edit'));
  }

  async injectContent(chapter) {
    let chapterNumber = '';
    if (chapter.chapterNumber !== null && chapter.chapterNumber !== undefined) {
      chapterNumber = String(chapter.chapterNumber);
    } else {
      const numMatch = chapter.title.match(/第(\d+)章|^(\d+)[\.\-\_\s]/);
      if (numMatch) chapterNumber = numMatch[1] || numMatch[2] || '';
    }

    let pureTitle = chapter.title;
    pureTitle = pureTitle.replace(/^第\d+章[\s\.\-\_:：]*/, '');
    pureTitle = pureTitle.replace(/^\d+[\.\-\_\s:：]+/, '');
    pureTitle = pureTitle.replace(/^\d+(?=[第一二三四五六七八九十一-龥])/, '');
    pureTitle = pureTitle.replace(/^Chapter\s*\d+[\s\.\-\_:：]*/i, '');
    pureTitle = pureTitle.trim();

    this.log(`章节注入 - 编号: ${chapterNumber}, 纯标题: "${pureTitle}"`);

    // 等待编辑器加载（最多等待10秒）
    let editorReady = false;
    for (let i = 0; i < 20; i++) {
      const check = await this.client.evaluate(`!!document.querySelector('.ProseMirror')`);
      if (check) {
        editorReady = true;
        break;
      }
      await this.client.sleep(500);
    }
    if (!editorReady) {
      this.log('⚠️ 等待编辑器超时，尝试继续...');
    }

    await this.client.sleep(300);

    // 填充章节号（带重试）
    if (chapterNumber) {
      for (let retry = 0; retry < 3; retry++) {
        const result = await this.client.fillInput('.left-input input.serial-input', chapterNumber);
        if (result) break;
        await this.client.sleep(300);
      }
      await this.client.sleep(200);
    }

    // 填充标题（带重试）
    const titleSelectors = [
      'input.serial-editor-input-hint-area',
      'input[placeholder="请输入标题"]',
      '.serial-editor-input input'
    ];
    let titleFilled = false;
    for (let retry = 0; retry < 3 && !titleFilled; retry++) {
      for (const selector of titleSelectors) {
        const result = await this.client.fillInput(selector, pureTitle || chapter.title);
        if (result) {
          this.log(`标题已填充`);
          titleFilled = true;
          break;
        }
      }
      if (!titleFilled) await this.client.sleep(300);
    }
    await this.client.sleep(200);

    // 模拟滚动到编辑器区域
    await this.client.scroll('down', 200);
    await this.client.sleep(300);

    // 填充内容（带重试）
    const editorSelectors = [
      '.syl-editor-container .ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '.ProseMirror'
    ];
    let contentFilled = false;
    for (let retry = 0; retry < 3 && !contentFilled; retry++) {
      for (const selector of editorSelectors) {
        const result = await this.client.fillEditor(selector, chapter.content);
        if (result) {
          this.log(`内容已填充`);
          contentFilled = true;
          break;
        }
      }
      if (!contentFilled) await this.client.sleep(500);
    }
    await this.client.sleep(200);

    // 滚动回顶部准备点击下一步
    await this.client.scroll('up', 300);
    await this.client.sleep(200);
  }

  // 读"下一步"按钮状态：'enabled' | 'disabled' | 'absent'
  async nextStepState() {
    return await this.client.evaluate(`(function(){
      const els=document.querySelectorAll('button, div[role="button"], span[role="button"], .arco-btn, [class*="btn"]');
      for (const b of els){ if(b.offsetParent===null) continue; if((b.textContent||'').trim().includes('下一步')){ return (b.disabled||b.getAttribute('aria-disabled')==='true'||/disabled/.test(b.className))?'disabled':'enabled'; } }
      return 'absent';
    })()`);
  }

  // 用可信键盘"敲一下"触发番茄识别正文(合成 paste 不触发) → 启用"下一步"。空格+退格，正文零残留。
  async nudgeEditor() {
    try {
      if (this.tabId) await this.client.activateTab(this.tabId);
      await this.client.evaluate(`(function(){const ed=document.querySelector('.ProseMirror');if(!ed)return;ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
      await this.client.typeText(' ');
      await this.client.sleep(200);
      await this.client.pressKey('Backspace');
      await this.client.sleep(200);
    } catch (e) { this.log('⚠️ nudge 失败：' + (e.message || e)); }
  }

  async clickNextStep() {
    // 先确保"下一步"可用：禁用就补 nudge 触发番茄识别正文，最多等 ~12s
    let state = await this.nextStepState();
    for (let i = 0; i < 8 && state === 'disabled'; i++) {
      this.log(`"下一步"禁用，触发番茄识别正文(${i + 1})…`);
      await this.nudgeEditor();
      await this.client.sleep(600);
      state = await this.nextStepState();
    }
    if (state !== 'enabled') { this.log(`⚠️ "下一步"仍${state === 'absent' ? '不存在' : '禁用'}（正文可能未被番茄识别）`); }
    // 用 JS .click() 点"下一步"——该按钮在页面顶部(y≈16)，坐标真实点击常落空/不触发；
    // 实测 element.click() 才能稳定推进到"发布设置"弹窗（已对岳雷/赵云验证）。
    const clicked = await this.client.evaluate(`(function(){
      const els=document.querySelectorAll('button, div[role="button"], span[role="button"], .arco-btn, [class*="btn"]');
      for (const b of els){ if(b.offsetParent===null) continue; if((b.textContent||'').trim()==='下一步'){ b.click(); return true; } }
      for (const b of els){ if(b.offsetParent===null) continue; if((b.textContent||'').trim().includes('下一步')){ b.click(); return true; } }
      return false;
    })()`);
    return clicked;
  }

  async handleTypoDialog() {
    // 定位错别字弹窗的确认按钮后坐标真实点击
    return await this.client.clickByLocator(`
      const modals = document.querySelectorAll('.arco-modal, [role="dialog"], .arco-modal-wrapper, .arco-modal-content, [class*="modal"], [class*="dialog"]');
      for (const modal of modals) {
        if (modal.offsetParent === null && !modal.classList.contains('arco-modal-wrapper')) continue;
        const text = modal.textContent || '';
        const typoKeywords = ['错别字', '是否确定提交', '疑似错别字', '拼写错误', '仍要提交', '继续提交', '存在问题'];
        if (!typoKeywords.some(kw => text.includes(kw))) continue;
        const buttons = modal.querySelectorAll('button, [role="button"], .arco-btn, [class*="btn"], span[class*="button"]');
        for (const btn of buttons) {
          const bt = (btn.textContent || '').trim();
          const isConfirm = ['提交', '确定', '确认', '忽略', '继续', '仍要'].some(k => bt.includes(k));
          const isCancel = ['取消', '返回', '修改'].some(k => bt.includes(k));
          if (isConfirm && !isCancel) return btn;
        }
      }
      return null;
    `);
  }

  async handleDetectionModeDialog() {
    // 定位"普通检测/仅基础检测/基础检测"选项后坐标真实点击（避开"全面检测"）
    const clicked = await this.client.clickByLocator(`
      const pageText = document.body.innerText || '';
      if (!pageText.includes('请选择内容检测方式') && !pageText.includes('内容检测方式')) return null;
      const modals = document.querySelectorAll('.arco-modal, .arco-modal-wrapper, [role="dialog"], .arco-modal-content, .byte-modal');
      const scope = [...modals].filter(m => (m.textContent||'').includes('检测方式'));
      const containers = scope.length ? scope : [document.body];
      for (const modal of containers) {
        const buttons = modal.querySelectorAll('button, .arco-btn, .byte-btn, [role="button"]');
        for (const btn of buttons) {
          const bt = (btn.textContent || '').trim();
          if ((bt.includes('普通检测') || bt.includes('仅基础检测') || bt.includes('基础检测')) && !bt.includes('全面')) return btn;
        }
        const allElements = modal.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent || '';
          if ((text.includes('普通检测') || (text.includes('基础检测') && text.includes('不限次数'))) && !text.includes('全面检测')) {
            const r = el.getBoundingClientRect();
            if (r.width > 50 && r.height > 20) return el;
          }
        }
      }
      return null;
    `);
    if (clicked) this.log('选择内容检测方式: 普通/基础检测');
    return clicked;
  }

  async handleRiskDetection() {
    // 定位风险检测弹窗的确认按钮后坐标真实点击
    const clicked = await this.client.clickByLocator(`
      const modals = document.querySelectorAll('.arco-modal, [role="dialog"], .arco-modal-wrapper');
      for (const modal of modals) {
        if (modal.offsetParent === null && !modal.classList.contains('arco-modal-wrapper')) continue;
        const text = modal.textContent || '';
        if (text.includes('风险检测') || text.includes('是否进行内容风险检测') || text.includes('安全检测')) {
          const buttons = modal.querySelectorAll('button, [role="button"], .arco-btn');
          for (const btn of buttons) {
            const bt = (btn.textContent || '').trim();
            if (bt === '确定' || bt.includes('确定') || bt.includes('开始检测')) return btn;
          }
        }
      }
      return null;
    `);
    if (!clicked) return { triggered: false, completed: false };

    this.log('风险检测中...');
    await this.client.sleep(500);

    const maxWait = 60;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait * 1000) {
      const stillChecking = await this.client.pageContains(['检测中', '正在检测', '安全检测中', '风险检测中']);
      if (!stillChecking) {
        this.log('风险检测完成');
        break;
      }
      await this.client.sleep(300);
    }

    await this.client.sleep(300);
    return { triggered: true, completed: true };
  }

  async checkBlockingErrors() {
    const script = `
      (function() {
        const blockingErrors = {
          'duplicate_title': ['标题重复', '章节名重复', '已存在相同', '标题已存在', '重复的标题', '章节标题重复', '重复章节', '章节已存在'],
          'sensitive_content': ['敏感内容', '涉嫌违规', '包含敏感词', '禁止发布', '内容违规', '审核不通过', '内容不合规'],
          'account_limit': ['账号异常', '操作频繁', '请稍后再试', '访问受限', '账号受限', '频率限制', '请求过于频繁'],
          'unknown_error': ['发布失败', '提交失败', '保存失败', '网络错误', '服务器错误', '系统错误']
        };

        const excludePatterns = ['请选择内容检测方式', '全面检测', '基础检测', '本章节剩余次数', '不限次数', '深度排查', '辅助提升内容通过效率', '不覆盖范围外的检测'];

        const modalSelectors = ['.arco-modal', '.arco-modal-wrapper', '.arco-message', '.arco-notification', '[role="dialog"]', '[role="alertdialog"]', '.arco-modal-content', '[class*="modal"]', '[class*="dialog"]', '.arco-popup'];
        const modals = document.querySelectorAll(modalSelectors.join(', '));

        for (const modal of modals) {
          const text = modal.textContent || '';
          const shouldExclude = excludePatterns.some(pattern => text.includes(pattern));
          if (shouldExclude) continue;

          for (const [reason, keywords] of Object.entries(blockingErrors)) {
            for (const kw of keywords) {
              if (text.includes(kw)) {
                return { hasError: true, reason, message: kw + ' - ' + text.substring(0, 100) };
              }
            }
          }
        }

        const errorSelectors = ['.arco-alert-error', '.arco-message-error', '.arco-alert-warning', '[class*="error"]', '[class*="danger"]'];
        const errorElements = document.querySelectorAll(errorSelectors.join(', '));
        for (const el of errorElements) {
          const text = el.textContent || '';
          for (const [reason, keywords] of Object.entries(blockingErrors)) {
            for (const kw of keywords) {
              if (text.includes(kw)) {
                return { hasError: true, reason, message: kw };
              }
            }
          }
        }

        return { hasError: false };
      })()
    `;
    return await this.client.evaluate(script) || { hasError: false };
  }

  async waitForPublishDialog(maxSeconds = 30) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      const hasDialog = await this.client.pageContains(['发布设置', '确认发布']);
      const isChecking = await this.client.pageContains(['安全检测中', '正在检测', '检测中']);
      if (hasDialog && !isChecking) return true;
      await this.client.sleep(1000);
    }
    return false;
  }

  async handlePublishDialog() {
    const maxRetry = 10;
    let retryCount = 0;
    let scheduleEnabled = false;

    const isScheduledMode = (this.config?.scheduledStartDate !== null && this.config?.scheduledStartDate !== undefined)
                           || this.forcedScheduleMode;

    // Step 1: 选择 AI 选项（是/否）—— 定位单选项后坐标真实点击
    if (this.config) {
      const targetText = this.config.useAI ? '是' : '否';
      const aiOk = await this.client.clickByLocator(`
        const targetText = ${JSON.stringify(targetText)};
        // 方法1: Arco radio 文本精确匹配
        const radioTexts = document.querySelectorAll('.arco-radio-text');
        for (const span of radioTexts) {
          if ((span.textContent || '').trim() === targetText) {
            const label = span.closest('label.arco-radio');
            if (label) return label;
          }
        }
        // 方法2: 普通 radio 按钮的 label
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const label = radio.closest('label');
          if (((label && label.textContent) || '').trim() === targetText) return label || radio;
        }
        // 方法3: div 模拟的 radio
        const options = document.querySelectorAll('[role="radio"], [class*="radio-item"]');
        for (const opt of options) {
          if ((opt.textContent || '').trim() === targetText) return opt;
        }
        return null;
      `);
      this.log(aiOk ? `AI选项: ${targetText}` : 'AI选项未找到');
    }

    await this.client.sleep(200);

    // Step 2: 如果是预约发布模式，开启定时发布
    if (isScheduledMode) {
      this.log(`预约发布模式，设置日期为 ${this.formatDate(this.currentScheduleDay)}`);
      await this.enableScheduleSwitch();
      scheduleEnabled = true;
      await this.client.sleep(300);
      await this.selectScheduleDate();
      await this.client.sleep(200);
    }

    // Step 3: 点击确认发布
    await this.client.clickButtonByText('确认发布');
    await this.client.sleep(1000);

    const immediateBlockingError = await this.checkBlockingErrors();
    if (immediateBlockingError.hasError) {
      return {
        success: false,
        needsIntervention: true,
        reason: immediateBlockingError.reason,
        message: immediateBlockingError.message,
      };
    }

    let actuallyChangedDate = false;
    const checkingKeywords = ['正在为你检测风险内容', '为你检测', '检测风险内容', '正在检测', '安全检测中', '检测中'];

    while (retryCount < maxRetry) {
      // 确认发布后可能先弹出"请选择内容检测方式"（选普通检测）或"开始风险检测"按钮，需先点选
      if (await this.handleDetectionModeDialog()) { await this.client.sleep(500); }
      await this.handleRiskDetection();

      // 点击确认发布后番茄会自动跑内容风险检测（"正在为你检测风险内容，请稍后"），
      // 期间弹窗仍开着——必须耐心等检测完成，而不是当成失败去重试。
      if (await this.client.pageContains(checkingKeywords)) {
        this.log('内容风险检测中，等待完成...');
        const t0 = Date.now();
        while (Date.now() - t0 < 90000) {
          await this.client.sleep(1000);
          if (!(await this.client.pageContains(checkingKeywords))) break;
        }
        this.log('风险检测结束');
        await this.client.sleep(1000);
        // 检测后重新判断弹窗是否已关闭（关闭=发布成功）
        if (!(await this.client.pageContains(['发布设置', '确认发布']))) {
          this.log('发布弹窗已关闭，发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
      }

      const blockingError = await this.checkBlockingErrors();
      if (blockingError.hasError) {
        return {
          success: false,
          needsIntervention: true,
          reason: blockingError.reason,
          message: blockingError.message,
        };
      }

      const dialogOpen = await this.client.pageContains(['发布设置', '确认发布']);
      if (!dialogOpen) {
        this.log('发布弹窗已关闭，发布成功');
        return { success: true, switchedToNextDay: actuallyChangedDate };
      }

      retryCount++;
      this.log(`发布重试 ${retryCount}/${maxRetry}，弹窗仍打开`);

      if (!scheduleEnabled) {
        this.log(`📅 到达发布上限，开启定时发布`);
        await this.enableScheduleSwitch();
        scheduleEnabled = true;
        this.forcedScheduleMode = true;
        await this.client.sleep(300);
        await this.selectScheduleDate();
        await this.client.sleep(200);
        await this.client.clickButtonByText('确认发布');
        await this.client.sleep(800);
        continue;
      }

      if (retryCount >= 2) {
        this.log(`📅 当前日期可能已满，切换到下一天`);
        this.switchToNextDay();
        actuallyChangedDate = true;
        this.forcedScheduleMode = true;
        await this.client.sleep(200);
        await this.selectScheduleDate();
        await this.client.sleep(300);
        await this.client.clickButtonByText('确认发布');
        await this.client.sleep(800);
      } else {
        await this.client.sleep(500);
        await this.client.clickButtonByText('确认发布');
        await this.client.sleep(1000);
      }
    }

    return { success: false, message: '达到最大重试次数' };
  }

  async enableScheduleSwitch() {
    // 定位未开启的定时发布开关后坐标真实点击
    return await this.client.clickByLocator(`
      const switches = document.querySelectorAll('.arco-switch, [role="switch"]');
      for (const sw of switches) {
        const isChecked = sw.classList.contains('arco-switch-checked') || sw.getAttribute('aria-checked') === 'true';
        if (!isChecked) return sw;
      }
      return null;
    `);
  }

  // 设置预约发布时间（最佳努力：Arco 时间列定位后真实点击；若平台无时间选择器则跳过）
  // 注：番茄是否支持"时分"级预约未在真实发布流程验证，建议实测确认。
  async selectScheduleTime() {
    const t = this.config?.scheduledTime;
    if (!t) return;
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return;
    const hh = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    this.log(`设置发布时间: ${hh}:${mm}（最佳努力，建议实测确认）`);
    const clickCol = async (colIndex, value) => {
      return await this.client.clickByLocator(`
        const cols = document.querySelectorAll('.arco-timepicker-column ul, .arco-timepicker-list, .arco-picker-time-column ul, [class*="timepicker"] ul');
        const col = cols[${colIndex}];
        if (!col) return null;
        const items = col.querySelectorAll('li, [class*="cell"]');
        for (const it of items) {
          if ((it.textContent || '').trim() === ${JSON.stringify(value)}) return it;
        }
        return null;
      `);
    };
    const okH = await clickCol(0, hh);
    await this.client.sleep(300);
    const okM = await clickCol(1, mm);
    await this.client.sleep(300);
    if (!okH && !okM) this.log('未找到时间选择器，使用平台默认时间');
  }

  async selectScheduleDate() {
    if (!this.currentScheduleDay) return;

    const targetDateStr = this.formatDate(this.currentScheduleDay);
    const targetYear = this.currentScheduleDay.getFullYear();
    const targetMonth = this.currentScheduleDay.getMonth();
    const targetDay = this.currentScheduleDay.getDate();
    this.log(`选择发布日期: ${targetDateStr}`);

    // 坐标真实点击打开日期选择器（trusted）
    await this.client.clickByLocator(`
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        if (input.value && /^\\d{4}-\\d{2}-\\d{2}/.test(input.value)) {
          return input.closest('.arco-picker') || input.parentElement || input;
        }
      }
      return document.querySelector('.arco-picker');
    `);
    await this.client.sleep(500);

    // 导航到目标年月：点"上一月/下一月"箭头（.arco-picker-header-icon，
    // 方向由内部 svg 图标类 arco-icon-left/right 决定；double 是年份箭头，跳过）
    for (let navAttempt = 0; navAttempt < 30; navAttempt++) {
      const cur = await this.client.evaluate(`
        (function(){
          const p = document.querySelector('.arco-picker-panel, .arco-picker-dropdown, .arco-picker-container');
          if (!p) return { error: 'no_panel' };
          const v = (p.querySelector('.arco-picker-header-value')||{}).textContent || (p.querySelector('.arco-picker-header')||{}).textContent || '';
          const ym = v.match(/(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月/) || v.match(/(\\d{4})[^\\d]+(\\d{1,2})/);
          if (ym) return { year: parseInt(ym[1]), month: parseInt(ym[2]) - 1 };
          return { error: 'cannot_parse' };
        })()
      `);
      if (cur.error === 'no_panel') { await this.client.sleep(400); continue; }
      if (cur.error) { await this.client.sleep(300); continue; }
      if (cur.year === targetYear && cur.month === targetMonth) break;

      const needNext = (cur.year < targetYear) || (cur.year === targetYear && cur.month < targetMonth);
      // 坐标真实点击"上一月/下一月"箭头（按内部 svg 图标类识别方向，跳过年份双箭头）
      const moved = await this.client.clickByLocator(`
        const needNext = ${needNext};
        const p = document.querySelector('.arco-picker-panel, .arco-picker-dropdown, .arco-picker-container');
        if (!p) return null;
        const icons = p.querySelectorAll('.arco-picker-header-icon');
        for (const ic of icons) {
          const svg = ic.querySelector('svg');
          const cls = svg ? (svg.getAttribute('class') || '') : '';
          if (cls.includes('double')) continue;
          if (needNext && cls.includes('right')) return ic;
          if (!needNext && cls.includes('left')) return ic;
        }
        return null;
      `);
      if (!moved) { this.log('⚠️ 未找到月份切换箭头'); break; }
      await this.client.sleep(350);
    }

    // 坐标真实点击 in-view 的目标日单元格内层
    await this.client.sleep(150);
    const daySelected = await this.client.clickByLocator(`
      const targetDay = ${targetDay};
      const p = document.querySelector('.arco-picker-panel, .arco-picker-dropdown, .arco-picker-container');
      if (!p) return null;
      const cells = p.querySelectorAll('.arco-picker-cell, td[class*="cell"]');
      for (const cell of cells) {
        const cn = cell.className || '';
        if (parseInt((cell.textContent||'').trim()) === targetDay && cn.includes('in-view') && !cn.includes('disabled')) {
          return cell.querySelector('[class*="cell-inner"]') || cell;
        }
      }
      for (const cell of cells) {
        const cn = cell.className || '';
        if ((cell.textContent||'').trim() === String(targetDay) && !cn.includes('disabled') && !cn.includes('prev') && !cn.includes('next')) {
          return cell.querySelector('[class*="cell-inner"]') || cell;
        }
      }
      return null;
    `);
    this.log(`选择日期 ${targetDateStr}: ${daySelected ? '成功' : '未找到日单元格'}`);
    await this.client.sleep(200);

    // 设置发布时间（如配置了）
    await this.selectScheduleTime();
  }

  async handleConflict() {
    const hasConflict = await this.client.pageContains(['使用本地', '使用云端', '内容冲突', '版本冲突']);
    if (!hasConflict) return false;

    this.log('检测到内容冲突，选择本地版本');

    return await this.client.clickByLocator(`
      const keywords = ['使用本地', '本地版本', '覆盖云端', '本地'];
      const buttons = document.querySelectorAll('button, [role="button"], .arco-btn');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (keywords.some(kw => text.includes(kw))) return btn;
      }
      return null;
    `);
  }

  async waitForPublishComplete(maxSeconds = 30) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      const dialogGone = !(await this.client.pageContains(['发布设置', '确认发布']));
      if (dialogGone) {
        await this.client.sleep(2000);
        const onChapterList = await this.client.pageContains(['章节管理', '新建章节']);
        if (onChapterList) return true;
      }
      await this.client.sleep(1000);
    }
    return false;
  }

  async clickNewChapter() {
    this.log('准备新建章节...');
    // 直接导航到新建章节页面（卷切换不在这里做——改在每章发布前 ensureChapterVolume 统一处理）
    const newChapterUrl = `https://fanqienovel.com/main/writer/${this.config.bookId}/publish/?enter_from=newchapter`;
    this.log('导航到新建章节页面...');
    await this.client.navigate(newChapterUrl);
    await this.client.sleep(3000);
    this.log('已导航到新建章节页面');
    return true;
  }

  // 读当前发布页头部的卷名
  async readCurrentVolume() {
    const r = await this.client.evaluate(`(function(){return {t:(document.querySelector('.publish-header-volume-name')||{}).textContent||''};})()`);
    return (r?.t || '').trim();
  }

  // 切换到指定卷（仅在发布页）。返回 {ok, current, found}。
  // 找不到目标卷 → ok:false（番茄建卷不可逆，绝不乱建，交由上层暂停并提示人工建卷）。
  async switchToVolume(targetVolumeText) {
    if (!targetVolumeText) return { ok: true, skipped: true };
    const current = await this.readCurrentVolume();
    if (current === targetVolumeText) { this.log(`卷已正确：${current}`); return { ok: true, current, alreadyThere: true }; }
    this.log(`切换卷：${current || '(未知)'} → ${targetVolumeText}`);
    // 打开分卷模态
    await this.client.clickByLocator(`return document.querySelector('.publish-header-volume-name');`);
    await this.client.sleep(500);
    // 选目标卷（精确匹配卷名 span）
    const found = await this.client.clickByLocator(`
      const targetText = ${JSON.stringify(targetVolumeText)};
      const items = document.querySelectorAll('.editor-volume-list-item-normal');
      for (const item of items) {
        const span = item.querySelector('span');
        if (((span && span.textContent) || '').trim() === targetText) return span;
      }
      return null;
    `);
    if (!found) {
      // 关掉模态，报"未找到该卷"
      try { await this.client.clickByLocator(`const b=document.querySelectorAll('.byte-modal-footer button');for(const x of b){if((x.textContent||'').includes('取消'))return x;}return null;`); } catch {}
      this.log(`⚠️ 番茄该书没有卷「${targetVolumeText}」`, 'error');
      return { ok: false, current, found: false };
    }
    await this.client.sleep(400);
    // 确定
    await this.client.clickByLocator(`
      const btns = document.querySelectorAll('.byte-modal-footer button');
      for (const btn of btns) { if ((btn.textContent || '').includes('确定')) return btn; }
      return null;
    `);
    await this.client.sleep(1800);
    const after = await this.readCurrentVolume();
    this.log(`切换后卷：${after}`);
    return { ok: after === targetVolumeText, current: after, found: true };
  }

  async waitForNewChapterPage(maxSeconds = 15) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      const script = `
        (function() {
          const editor = document.querySelector('.ProseMirror');
          const titleInput = document.querySelector('input.serial-editor-input-hint-area') ||
                            document.querySelector('input[placeholder="请输入标题"]');
          if (!editor || !titleInput) return false;
          const editorText = editor.innerText?.trim() || '';
          const isEmpty = editorText === '' || editorText.includes('请输入正文') || editorText.includes('空格');
          const titleEmpty = !titleInput.value || titleInput.value.trim() === '';
          return isEmpty && titleEmpty;
        })()
      `;
      const ready = await this.client.evaluate(script);
      if (ready) return true;
      await this.client.sleep(1000);
    }
    return false;
  }

  switchToNextDay() {
    if (this.currentScheduleDay) {
      const oldDate = this.formatDate(this.currentScheduleDay);
      this.currentScheduleDay.setDate(this.currentScheduleDay.getDate() + 1);
      this.chaptersPublishedToday = 0;
      this.log(`📅 日期切换: ${oldDate} → ${this.formatDate(this.currentScheduleDay)}`);
    }
  }

  formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  pause(reason, message) {
    this.status = 'paused';
    this.interruptReason = reason;
    this.lastError = message;
    this.log(`⚠️ 已暂停: ${reason} - ${message}`);
    this.emitProgress();
  }

  handleError(context, error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.lastError = `${context}: ${errorMessage}`;
    this.log(`❌ ${this.lastError}`);
  }

  log(message) {
    const timestamp = new Date().toLocaleTimeString();
    // 原前端 console.log，保留以便调试；同时转发到 onLog 回调
    console.log(`[${timestamp}] ${message}`);
    this.onLog(message);
  }

  emitProgress() {
    this.onProgress(this.getProgress());
  }
}

// ===== 纯逻辑辅助（与 UI 无关，供新增导出复用）=====

// 从一段文本里抽取所有「第N章」的最大 N（精确匹配，第N章后不接数字）。
function maxChapterNumInText(text) {
  let max = 0;
  const re = /第\s*(\d+)\s*章(?![0-9])/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// ===== 导出主函数 =====

// publishBook：发布/编辑一本书的多个章节。
//   profilePath  Unzoo profile 路径（锁定账号标签页）
//   bookId       番茄书籍 ID
//   bookName     书名（仅用于日志）
//   chapters     [{ num, title, content, mode }]，已按章号升序。
//                mode='new'（追加新发，走 publishLoop）或 'edit'（去番茄找到对应章覆盖，走 editLoop）。
//                映射到内部 FanqiePublisher 期望的章节结构：{ chapterNumber, title, content }。
//   config       沿用原 start(config) 字段：
//                chaptersPerDay('max'|number) / scheduledStartDate / scheduledTime /
//                intervalSeconds / editMode / editStartChapter / volumeIndex / volumeText / bookId
//                额外：matchVolumes(bool) —— true=按卷发（见 ensureVolume），false=不管卷只追加。
//   onLog        ({level,msg}) 日志回调
// 返回 {ok, published, lastChapter, status, error}
export async function publishBook({ profilePath, bookId, bookName, chapters, config = {}, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };

  if (!bookId) return { ok: false, published: 0, lastChapter: null, status: 'error', error: '缺少 bookId' };
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return { ok: false, published: 0, lastChapter: null, status: 'error', error: '没有可发布的章节' };
  }

  // mode 判定：以传入章节的 mode 为准（调用方已标好）。
  // ⚠️ 一次调用只能跑一条路径（editLoop 或 publishLoop），【绝不允许混批】——
  // 原来混批时"以第一个章节的 mode 为准"，于是 edit 打头的批会把后面的新章也拿去 editLoop
  // 里"找番茄上已存在的章"，而新章在番茄根本不存在 → 连续 notFound → 整批卡死、新章一章没发。
  // 调用方必须拆成两次调用（先 edit 再 new），见 publish.mjs。
  const modes = new Set(chapters.map(c => c.mode || 'new'));
  if (modes.size > 1) {
    const msg = '同一批里混了 edit 与 new 两种模式——请拆成两次 publishBook 调用（先同步重写章，再追加新章）';
    log('⛔ ' + msg, 'error');
    return { ok: false, published: 0, lastChapter: null, status: 'error', error: msg };
  }
  const isEditMode = (chapters[0].mode || 'new') === 'edit';

  // 映射到 FanqiePublisher 期望的章节结构（保留原字段语义：chapterNumber/title/content）
  // volumeText：该章在番茄要发到的【卷名】。仅 matchVolumes 时由调用方(publish.mjs)逐章填好；否则空=不切卷只追加。
  const mapped = chapters.map(c => ({
    chapterNumber: (typeof c.num === 'number') ? c.num
      : (c.num != null && c.num !== '' ? parseInt(c.num, 10) : null),
    title: c.title,
    content: c.content,
    volumeText: c.volumeText || '',
  }));

  const client = new UnzooClient(profilePath || null, onLog || null);

  // 组装内部 config（与原 start(config) 字段对齐）
  const innerConfig = {
    chaptersPerDay: config.chaptersPerDay === 'max' ? 'max'
      : (config.chaptersPerDay != null ? parseInt(config.chaptersPerDay, 10) : 'max'),
    useAI: !!config.useAI,
    startIndex: config.startIndex || 0,
    intervalSeconds: config.intervalSeconds != null ? config.intervalSeconds : 3,
    scheduledStartDate: config.scheduledStartDate || null,
    scheduledTime: config.scheduledTime || '08:00',
    editMode: isEditMode || !!config.editMode,
    editStartChapter: config.editStartChapter || (isEditMode ? 1 : 0),
    bookId: bookId,
    volumeIndex: config.volumeIndex,
    volumeText: config.volumeText || '',
    matchVolumes: !!config.matchVolumes,
    // 番茄卷列表（按番茄展示顺序）。编辑模式靠它把「章所属卷名」换算成卷页序号去切卷；
    // 空数组=当单卷处理（维持旧行为）。由 publish.mjs 从 buildVolumeMap/getFanqieVolumes 传入。
    fanqieVolumes: Array.isArray(config.fanqieVolumes) ? config.fanqieVolumes : [],
  };

  log(`📚 ${innerConfig.editMode ? '编辑替换' : '新建发布'}《${bookName || bookId}》，共 ${mapped.length} 章`, 'info');

  try {
    if (innerConfig.editMode) {
      // 编辑模式：导航到章节管理页面。首章所属卷已知就直接开到那一卷，省一次切卷；
      // 未知(单卷书/没传卷列表)沿用旧的 &1。之后每章由 searchForChapter 自行切卷。
      let volumeIdx = innerConfig.volumeIndex || 1;
      const firstVolText = mapped[0]?.volumeText || '';
      if (firstVolText && innerConfig.fanqieVolumes.length) {
        const i = innerConfig.fanqieVolumes.indexOf(firstVolText);
        if (i >= 0) volumeIdx = i + 1;
      }
      innerConfig.volumeIndex = volumeIdx;
      log(`正在打开章节管理页面（第 ${volumeIdx} 卷）...`);
      await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&${volumeIdx}`);
      await client.sleep(2000);
    } else {
      // 新建发布模式：导航到新建章节页面。卷切换由 publishChapter 逐章处理(matchVolumes 时)，这里不再整批切单卷。
      log('正在打开新建章节页面...');
      await client.navigate(`https://fanqienovel.com/main/writer/${bookId}/publish/?enter_from=newchapter`);
      await client.sleep(3000);
    }

    const publisher = new FanqiePublisher(client);
    publisher.onLog = (message) => log(String(message));
    publisher.onProgress = () => {};
    publisher.setChapters(mapped);
    RUNNING_PUBLISHERS.set(String(bookId), publisher);   // 注册，供「停止发布」中断

    try {
      await publisher.start(innerConfig);
    } finally {
      RUNNING_PUBLISHERS.delete(String(bookId));
    }

    const published = publisher.currentIndex; // 已成功处理的章节数（成功后才 ++）
    const lastChapterObj = published > 0 ? mapped[published - 1] : null;
    const ok = publisher.status === 'completed';
    const stopped = publisher.status === 'stopped' || publisher.interruptReason === 'manual_stop';
    return {
      ok,
      published,
      stopped,
      lastChapter: lastChapterObj
        ? { num: lastChapterObj.chapterNumber, title: lastChapterObj.title }
        : null,
      status: publisher.status,
      error: ok ? null : (publisher.lastError || (stopped ? '已手动停止' : publisher.status === 'paused' ? '已暂停' : null)),
    };
  } catch (err) {
    log(`❌ 发布失败: ${err.message || err}`, 'error');
    return { ok: false, published: 0, lastChapter: null, status: 'error', error: String(err.message || err) };
  }
}

// ===== 新增导出：读番茄某书"已存在的最大章号"（只读，不写）=====
//
// 用于去重对齐：读已发布 + 待发布定时章里「第N章」的最大值。
// 导航到章节管理页，逐页（尽力）遍历读取所有「第N章」，抽最大 N。
// 读不到返回 {maxChapter:0}。分页拿不准时标 approx:true。
export async function getFanqieMaxChapter({ profilePath, bookId, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { maxChapter: 0, error: '缺少 bookId' };

  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    // type=1 章节管理页（已发布 + 待发布定时章均在章节表中）
    await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}?type=1`);
    await client.sleep(2500);

    // 读取当前页/总页信息 + 当前页最大章号 + 页面有效性信号（防"假0→重复发"）
    const readPage = `
      (function(){
        const re = /第\\s*(\\d+)\\s*章(?![0-9])/g;
        let max = 0, m;
        const text = document.body ? document.body.innerText : '';
        while ((m = re.exec(text)) !== null) {
          const n = parseInt(m[1], 10);
          if (!isNaN(n) && n > max) max = n;
        }
        // 章节行里的【发布/排期时间】最大值——限定在含"第N章"的行内取，避免误抓页面其它日期。
        var maxRowTs = 0, maxRowDate = '';
        var rows = document.querySelectorAll('tr, [class*="table-tr"], [class*="list-item"], [role="row"]');
        rows.forEach(function(r){
          var t = r.innerText || '';
          if (!/第\\s*\\d+\\s*章/.test(t)) return;
          var dm = t.match(/(\\d{4})-(\\d{2})-(\\d{2})(?:\\s+(\\d{2}):(\\d{2}))?/);
          if (!dm) return;
          var ts = Date.parse(dm[0].replace(' ', 'T'));
          if (!isNaN(ts) && ts > maxRowTs) { maxRowTs = ts; maxRowDate = dm[0]; }
        });
        const activeItem = document.querySelector('.arco-pagination-item-active');
        const currentPage = activeItem ? (parseInt(activeItem.textContent) || 1) : 1;
        const pageItems = document.querySelectorAll('.arco-pagination-item:not(.arco-pagination-item-prev):not(.arco-pagination-item-next)');
        let totalPages = 1;
        for (const item of pageItems) {
          const num = parseInt(item.textContent);
          if (!isNaN(num) && num > totalPages) totalPages = num;
        }
        // 有效性：错误页/登录页/网络异常 → 非法；番茄后台 UI 标记(Arco/章节管理) → 合法
        const url = location.href || '';
        const errMarkers = ['ERR_','未连接到互联网','代理服务器','net::','无法访问此网站','该网页无法正常运作','502 Bad','504 Gateway'];
        const errorPage = errMarkers.some(s => text.indexOf(s) >= 0);
        const loginPage = /\\/login|passport|\\/auth/.test(url) || (text.indexOf('扫码登录') >= 0) || (text.indexOf('登录后查看') >= 0);
        const onDomain = url.indexOf('fanqienovel.com') >= 0;
        const hasArco = !!document.querySelector('[class*="arco-"]');
        const hasManageChrome = (text.indexOf('章节管理') >= 0) || (text.indexOf('作品管理') >= 0) || (text.indexOf('新建章节') >= 0) || (text.indexOf('卷') >= 0 && hasArco);
        // 空书的合法空状态（番茄空表）：在后台 UI 下出现"暂无"且无章节
        const emptyState = hasArco && (text.indexOf('暂无') >= 0 || text.indexOf('还没有') >= 0 || text.indexOf('快去创作') >= 0);
        // ⚠️修复"读到别的书的章号"：校验页面确属【目标 bookId】。番茄后台是 SPA，切书时上一本书的
        // 章节行会残留在 DOM（曾读到别本的 601 章）——只判"是不是章节管理页"会把残留当本书→读错章号→
        // 发布误判(算出0新章=发布失败 / 或极端下从第1章重发)。要求 url 与页面内容都出现目标 bookId
        // （空书允许 emptyState 放行），否则视为"还没真正切到本书"，继续轮询等待。
        const wantId = ${JSON.stringify(String(bookId || ''))};
        const htmlAll = document.documentElement ? document.documentElement.innerHTML : '';
        const belongsToBook = !wantId ? true : (url.indexOf(wantId) >= 0 && (htmlAll.indexOf(wantId) >= 0 || emptyState));
        const valid = onDomain && !errorPage && !loginPage && belongsToBook && (max > 0 || hasManageChrome || emptyState);
        return { max, maxRowDate, currentPage, totalPages, valid, belongsToBook, errorPage, loginPage, onDomain, hasArco, hasManageChrome, emptyState, bodyLen: text.length, head: text.slice(0, 80) };
      })()
    `;

    // 先校验页面有效性（防"假0→重复发"）。番茄页异步渲染——轮询至多 ~17s。
    // ⚠️关键：必须等到【确定结果】才停——读到章号(max>0) 或 真空状态(emptyState) 或 硬失败(登录/错误)。
    // 只出现"章节管理"框架但【章节行还没渲染】(max=0 且非空态)不算确定结果，继续等；否则会把
    // "还没加载完"误当"空书"→返回 0→上层从第1章把已发章重复发布（本次修复的根因）。
    let firstRead = null;
    for (let i = 0; i < 14; i++) {
      firstRead = await client.evaluate(readPage);
      if (firstRead) {
        if (firstRead.loginPage || firstRead.errorPage) break;      // 硬失败立即停，不空等
        if (firstRead.belongsToBook && (firstRead.max > 0 || firstRead.emptyState)) break; // 确认已切到本书且拿到确定结果才停
      }
      await client.sleep(1200);
    }
    if (!firstRead) return { maxChapter: 0, approx: true, error: '页面读取为空，无法确认番茄章节状态' };
    if (!firstRead.valid) {
      let why = firstRead.errorPage ? '番茄页面加载失败(网络/代理错误页)'
        : firstRead.loginPage ? '番茄需要登录(登录/扫码页)'
        : !firstRead.onDomain ? '当前不在番茄域名'
        : !firstRead.belongsToBook ? '页面不属于本书(番茄残留了上一本书的章节，读到的会是别的书的章号)——已中止防止读错，请重试'
        : '无法确认是番茄章节管理页(可能未加载完/改版)';
      log(`⛔ ${why}：拒绝读取最大章号以防误判空书重复发布。页面首段「${(firstRead.head || '').replace(/\\n/g, ' ')}」`, 'error');
      return { maxChapter: 0, error: why, pageInvalid: true };
    }

    // 读"当前所选卷"的最大章号（含分页：章节表按章号排序，最大号必在第1页或末页）。返回 {max, latestDate, approx}
    const readCurVolMax = async () => {
      const r0 = await client.evaluate(readPage);
      if (!r0) return { max: 0, latestDate: '', approx: true };
      let max = r0.max || 0, latestDate = r0.maxRowDate || '', approx = false;
      const totalPages = r0.totalPages || 1;
      if (totalPages > 1) {
        const targets = [1, totalPages].filter((v, i, a) => a.indexOf(v) === i && v !== (r0.currentPage || 1));
        for (const target of targets) {
          const jumped = await client.clickByLocator(`
            const want = ${target};
            const items = document.querySelectorAll('.arco-pagination-item');
            for (const item of items) { if (parseInt(item.textContent) === want) return item; }
            return null;
          `);
          if (!jumped) { approx = true; continue; }
          await client.sleep(1000);
          const r = await client.evaluate(readPage);
          if (r && r.max > max) max = r.max;
          if (r && r.maxRowDate && (!latestDate || Date.parse(r.maxRowDate.replace(' ', 'T')) > Date.parse(latestDate.replace(' ', 'T')))) latestDate = r.maxRowDate;
        }
      }
      return { max, latestDate, approx };
    };

    // 卷下拉定位：页面有【卷】和【审核状态】两个 .serial-select，挑【当前显示值含"卷"】的那个。
    const VOL_DROPDOWN = `
      const sels=[...document.querySelectorAll('.chapter-select .serial-select, .serial-select, [class*="volume-select"]')];
      for(const s of sels){ const vv=s.querySelector('.byte-select-view-value')||s; if(((vv.textContent||'').indexOf('卷'))>=0) return s; }
      return sels[0]||null;
    `;
    // 列出全部卷 [{name, num}]（卷下拉随章节数据异步渲染，轮询至多 ~12 次；读不到→[]=按单卷处理）
    const listVolumes = async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const opened = await client.clickByLocator(VOL_DROPDOWN);
        if (opened) {
          await client.sleep(700);
          const opts = await client.evaluate(`(function(){
            const cn={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
            function num(t){const m=String(t).match(/第\\s*([0-9一二三四五六七八九十两]+)\\s*卷/);if(!m)return -1;let s=m[1];if(/^[0-9]+$/.test(s))return parseInt(s,10);if(s.indexOf('十')>=0){const[a,b]=s.split('十');const te=a===''?1:cn[a];const u=b===''?0:cn[b];return (te==null||u==null)?-1:te*10+u;}return s.length===1&&cn[s]!=null?cn[s]:-1;}
            const seen=new Set(), out=[];
            for(const o of document.querySelectorAll('.byte-select-option, .arco-select-option, [class*="select-option"]')){
              const t=(o.textContent||'').trim(); if(!t||seen.has(t))continue; seen.add(t); out.push({name:t, num:num(t)});
            }
            return out;
          })()`);
          try { await client.pressKey('Escape'); } catch {}
          await client.sleep(200);
          if (Array.isArray(opts) && opts.length) return opts;
        }
        await client.sleep(1000);
      }
      return [];
    };
    // 选某卷（精确匹配卷名）。返回是否点中。
    const selectVolume = async (name) => {
      await client.clickByLocator(VOL_DROPDOWN);
      await client.sleep(600);
      const ok = await client.clickByLocator(`
        const want = ${JSON.stringify(name)};
        const opts = document.querySelectorAll('.byte-select-option, .arco-select-option, [class*="select-option"]');
        for (const o of opts) { if (((o.textContent || '').trim()) === want) return o; }
        return null;
      `);
      await client.sleep(1600);
      return ok;
    };

    // 番茄章节表【按卷显示、无"全部"选项】，但章号是【全局连续】的。
    let maxChapter = 0, latestDate = '', approx = false;
    const vols = await listVolumes();
    if (vols.length <= 1) {
      // 单卷 / 读不到卷选择器 → 直接读当前卷
      const r = await readCurVolMax();
      maxChapter = r.max; latestDate = r.latestDate; approx = r.approx;
      // 🛡️安全网（本次修复）：单卷读到 0 章，但页面【并非真空状态】→ 章节表没渲染出来/读取异常，
      // 绝不返回 0（会被当空书从第1章把已发章重复发布）→ 阻断并提示重试。真空书(emptyState)才放行 0。
      if (maxChapter === 0) {
        const chk = await client.evaluate(readPage);
        if (!chk || !chk.emptyState) {
          log('⛔ 单卷读到 0 章但页面非"暂无章节"空状态——疑似章节表未加载完/读取异常，已中止以防从第1章重复发布，请重试', 'error');
          return { maxChapter: 0, error: '番茄读到 0 章但页面非空状态(疑似未加载完)，已中止以防重复发布，请重试', pageInvalid: true };
        }
      }
    } else {
      // ⚠️关键修复：卷号最高的卷【可能是空的】（如刚建的新卷），全局最大章号在【最新的非空卷】里。
      // 章号全局连续、按序追加 → 从卷号高到低逐卷读，命中第一个非空卷即全局最大章号（不会把已发的当新章重发）。
      const sorted = vols.slice().sort((a, b) => (b.num || 0) - (a.num || 0));
      const scanned = [];
      for (const v of sorted) {
        const sel = await selectVolume(v.name);
        if (!sel) { approx = true; continue; }
        const r = await readCurVolMax();
        scanned.push(`${v.name}=${r.max}`);
        if (r.max > 0) { maxChapter = r.max; latestDate = r.latestDate; approx = r.approx; break; }
      }
      log(`🔎 多卷扫描（从最新卷起、命中非空即止）：${scanned.join('、') || '(全空)'}`, 'info');
      // 🛡️安全网：多卷却一章都没扫到 → 必是卷切换/读取异常（多卷书不可能全空还在发布）。
      // 绝不返回 maxChapter=0（会被当"空书"从第1章重发，灾难）→ 阻断，让上层提示重试。
      if (maxChapter === 0) {
        log('⚠️ 多卷书未扫到任何已发章号——疑似卷列表读取异常，已中止以防从头重复发布（请重试）', 'error');
        return { maxChapter: 0, approx: true, error: '多卷书未能读到已发章号（疑似卷读取异常），为防重复发布已中止，请重试', pageInvalid: true };
      }
    }

    log(`📖 番茄已存在最大章号: 第${maxChapter}章${approx ? '（近似，分页/卷未读全）' : ''}${latestDate ? '，最新排期 ' + latestDate : ''}`, 'info');
    return { maxChapter, approx, latestDate };
  } catch (err) {
    log(`读取番茄最大章号失败: ${err.message || err}`, 'error');
    return { maxChapter: 0, approx: true, error: String(err.message || err) };
  }
}

// ===== 新增导出(A)：只读番茄某书在【作品管理】卡片上的状态信息 =====
// 用于"内部完本 ↔ 番茄平台完结"对账：读 状态(连载中/已完结/完结审核中)、总字数、最新章号+标题、章数。
// 返回 { ok, status, statusRaw, signed, totalWords, totalWordsText, lastChapterNum, lastChapterTitle, chapterCount, error }
export async function getFanqieBookStatus({ profilePath, bookId, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, error: '缺少 bookId' };
  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    await client.navigate('https://fanqienovel.com/main/writer/book-manage');
    await client.sleep(4000);
    const r = await client.evaluate(`(function(){
      var text = document.body ? document.body.innerText : '';
      var errMarkers=['ERR_','未连接到互联网','代理服务器','net::','无法访问此网站'];
      if(errMarkers.some(function(s){return text.indexOf(s)>=0;})) return {invalid:'errorPage'};
      if(location.href.indexOf('fanqienovel.com')<0) return {invalid:'offDomain'};
      if(/\\/login|passport/.test(location.href) || text.indexOf('扫码登录')>=0) return {invalid:'loginPage'};
      // 用 bookId 锚定该书卡片
      var as=[].slice.call(document.querySelectorAll('a[href*="${bookId}"]'));
      var card=null;
      if(as.length){ var node=as[0]; for(var i=0;i<8&&node;i++){ node=node.parentElement; if(node){ var t=node.innerText||''; if(t.indexOf('字')>=0 && t.indexOf('章')>=0){ card=node; if(t.length>40) break; } } } }
      if(!card){
        // 退化：按书名文字找
        var all=[].slice.call(document.querySelectorAll('a,div,span,p'));
        for(var k=0;k<all.length;k++){ var e=all[k]; var et=(e.textContent||''); if(et.indexOf('字')>=0 && et.indexOf('章')>=0 && et.indexOf('最近更新')>=0 && et.length<400){ card=e; break; } }
      }
      if(!card) return {invalid:'noCard'};
      var ct=(card.innerText||'').replace(/\\s+/g,' ');
      var lastM=ct.match(/最近更新[：:]\\s*第(\\d+)章\\s*([^|·\\n]*)/);
      var cntM=ct.match(/(\\d+)\\s*章/);
      var wWan=ct.match(/([\\d.]+)\\s*万字/);
      var wPlain=ct.match(/([\\d,]+)\\s*字/);
      var words=0, wtext='';
      if(wWan){ words=Math.round(parseFloat(wWan[1])*10000); wtext=wWan[1]+'万字'; }
      else if(wPlain){ words=parseInt(wPlain[1].replace(/,/g,''),10)||0; wtext=words+'字'; }
      var status='未知';
      if(/已完结|已完本/.test(ct)) status='已完结';
      else if(/完结审核|审核中.*完结|完结.*审核|申请完结中/.test(ct)) status='完结审核中';
      else if(/连载中|连载/.test(ct)) status='连载中';
      return {
        raw: ct.slice(0,400),
        status: status,
        signed: /已签约/.test(ct),
        totalWords: words,
        totalWordsText: wtext,
        lastChapterNum: lastM?parseInt(lastM[1],10):0,
        lastChapterTitle: lastM?(lastM[2]||'').trim():'',
        chapterCount: cntM?parseInt(cntM[1],10):0
      };
    })()`);
    if (!r) return { ok: false, error: '读取作品卡片为空' };
    if (r.invalid) {
      const why = r.invalid === 'errorPage' ? '番茄页面加载失败(网络/代理)' : r.invalid === 'loginPage' ? '番茄需要登录' : r.invalid === 'noCard' ? '作品管理页未找到该书卡片(bookId 不匹配/未加载)' : '不在番茄域名';
      log(`⛔ 读取番茄完结状态失败：${why}`, 'error');
      return { ok: false, error: why };
    }
    log(`📊 番茄状态：${r.status}${r.signed ? '·已签约' : ''}｜${r.totalWordsText || '?字'}｜最新 第${r.lastChapterNum}章 ${r.lastChapterTitle}`, 'info');
    return { ok: true, statusRaw: r.raw, ...r };
  } catch (e) {
    log(`读取番茄完结状态异常：${e.message || e}`, 'error');
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 新增导出(D)：只读探测番茄"申请完结/设为完结"入口在哪 =====
// 不点任何提交按钮——只导航(只读)并扫描候选控件，回报"是否能自助完结/入口在哪"。
// 签约/征文书完结通常需编辑审批，可能根本无自助入口；本函数如实回报，由人去走流程。
// 返回 { ok, found, candidates:[{text}], url, note, error }
export async function locateFanqieCompletionEntry({ profilePath, bookId, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, error: '缺少 bookId' };
  const client = new UnzooClient(profilePath || null, onLog || null);
  const KW = '申请完结|设为完结|完结申请|完结作品|结文|提交完结|完本申请|申请完本';
  try {
    await client.navigate('https://fanqienovel.com/main/writer/book-manage');
    await client.sleep(3500);
    // 1) 在作品卡片里找"作品相关/作品信息/更多"链接，拿其 href
    const href = await client.evaluate(`(function(){
      var as=[].slice.call(document.querySelectorAll('a[href*="${bookId}"]'));
      var card=null; if(as.length){ var node=as[0]; for(var i=0;i<8&&node;i++){ node=node.parentElement; if(node && /字/.test(node.innerText||'') && /章/.test(node.innerText||'')){ card=node; break; } } }
      if(!card) return '';
      var links=[].slice.call(card.querySelectorAll('a[href]'));
      var rel=links.find(function(a){return /作品相关|作品信息|作品设置|更多|管理/.test(a.textContent||'');});
      return rel?rel.href:(links[0]?links[0].href:'');
    })()`);
    if (href) { try { await client.navigate(href); await client.sleep(3500); } catch {} }
    // 2) 在当前页扫描完结相关可点控件(只读，不点)
    const scan = await client.evaluate(`(function(){
      var re=/${KW}/;
      var els=[].slice.call(document.querySelectorAll('a,button,div,span,li'));
      var out=[];
      for(var i=0;i<els.length;i++){ var t=(els[i].textContent||'').trim(); if(t && t.length<=14 && re.test(t)){ if(out.indexOf(t)<0) out.push(t); } }
      var bodyHasKw=re.test(document.body?document.body.innerText:'');
      return {candidates: out.slice(0,8), bodyHasKw: bodyHasKw, url: location.href.slice(0,120)};
    })()`);
    const candidates = (scan?.candidates || []);
    const found = candidates.length > 0;
    const note = found
      ? `发现 ${candidates.length} 个完结相关入口：${candidates.join('、')}。番茄签约/征文书完结通常需编辑审批，请人工点击提交（软件不自动提交不可逆动作）。`
      : (scan?.bodyHasKw ? '页面提到"完结"字样但未找到可点入口——可能在"作品相关/更多设置"二级页，或需联系编辑。' : '未发现自助"申请完结"入口。签约/征文作品的完结一般由编辑在后台操作，请直接联系责编申请完结。');
    log(found ? `🔎 完结入口候选：${candidates.join('、')}` : '🔎 未发现自助完结入口（多为签约书需编辑审批）', found ? 'info' : 'warn');
    return { ok: true, found, candidates, url: scan?.url || href || '', note };
  } catch (e) {
    log(`探测完结入口异常：${e.message || e}`, 'error');
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 新增导出：只读番茄某书的【卷列表】（按番茄展示顺序）=====
// 供 matchVolumes 预检：把图书卷按顺序映射到番茄卷，并确认番茄已有对应卷（缺则中止，绝不自动建）。
// 返回 { ok, volumes:[名称…], current(当前卷名), error? }。
export async function getFanqieVolumes({ profilePath, bookId, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, volumes: [], error: '缺少 bookId' };
  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    // 从【发布页的卷模态】读卷列表——与实际切卷(switchToVolume)用同一选择器，既稳又一致
    await client.navigate(`https://fanqienovel.com/main/writer/${bookId}/publish/?enter_from=newchapter`);
    await client.sleep(2500);
    // 登录只按 URL 判（未登录会跳 /login）；'扫码登录' 文本在发布页可能是隐藏组件→不可作判据(会误判)
    const valid = await client.evaluate(`(function(){var t=document.body?document.body.innerText:'';var err=['ERR_','未连接到互联网','代理服务器','net::'].some(function(s){return t.indexOf(s)>=0;});var login=/\\/login|passport/.test(location.href);return {err:err,login:login,onDomain:location.href.indexOf('fanqienovel.com')>=0};})()`);
    if (!valid || valid.err || valid.login || !valid.onDomain) {
      const why = valid?.err ? '番茄页面加载失败(网络/代理)' : valid?.login ? '番茄需要登录' : '不在番茄域名';
      return { ok: false, volumes: [], error: why, pageInvalid: true };
    }
    const current = (await client.evaluate(`(function(){return (document.querySelector('.publish-header-volume-name')||{}).textContent||'';})()`) || '').trim();
    const readModal = () => client.evaluate(`
      (function(){
        const items = document.querySelectorAll('.editor-volume-list-item-normal');
        if (!items.length) return null;
        const vols = [];
        for (const it of items) { const sp = it.querySelector('span'); const t = ((sp&&sp.textContent)||it.textContent||'').trim(); if (t) vols.push(t); }
        return vols;
      })()
    `);
    // 多轮：点开卷名打开模态 → 读 → 关。Arco 模态挂载有偶发性，务必读到（读不到≠单卷）
    let volumes = [];
    for (let round = 0; round < 4 && !volumes.length; round++) {
      await client.clickByLocator(`return document.querySelector('.publish-header-volume-name');`);
      for (let i = 0; i < 12; i++) {
        await client.sleep(180);
        const v = await readModal();
        if (v && v.length) { volumes = v; break; }
        if (i === 5) await client.clickByLocator(`return document.querySelector('.publish-header-volume-name');`);
      }
      // 关模态（点取消，避免误改卷）
      try { await client.clickByLocator(`const b=document.querySelectorAll('.byte-modal-footer button');for(const x of b){if((x.textContent||'').includes('取消'))return x;}return null;`); } catch {}
      if (!volumes.length) await client.sleep(500);
    }
    if (!volumes.length) {
      return { ok: false, volumes: [], error: '未能读取番茄卷列表（卷模态未加载，请重试或确认页面已就绪）', readFailed: true };
    }
    return { ok: true, volumes, current };
  } catch (err) {
    return { ok: false, volumes: [], error: String(err.message || err) };
  }
}

// 整数 → 中文数字（1~99，用于卷名 "第N卷"）。
function numToCn(n) {
  n = parseInt(n, 10);
  if (!(n >= 1 && n <= 99)) return String(n);
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return d[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + d[n - 10];
  const tens = Math.floor(n / 10), units = n % 10;
  return d[tens] + '十' + (units ? d[units] : '');
}

// ===== 新增导出：在番茄【实际新建分卷】（matchVolumes 自动建卷用）=====
// ⚠️ 番茄分卷【删不掉】（删除按钮 disabled），只能改名。故本函数：
//   1. 先读现有卷，已存在的(按卷号)跳过——【绝不重复建、绝不多建】。
//   2. 逐个新建缺的卷：编辑分卷 → 新建分卷 → 填卷名 → 确定 → 验证。
//   3. 全程 JS click（本环境坐标点击对番茄不可靠）。任何一步失败立即停手并报错。
// volumes 入参：[{ num, name }]，name 为完整卷名（如「第十四卷：少年游」）。按 num 升序逐个建。
export async function createFanqieVolumes({ profilePath, bookId, volumes, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, created: [], error: '缺少 bookId' };
  if (!Array.isArray(volumes) || !volumes.length) return { ok: true, created: [] };
  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}?type=1`);
    await client.sleep(2500);
    // 页面有效性
    const valid = await client.evaluate(`(function(){var t=document.body?document.body.innerText:'';var err=['ERR_','未连接到互联网','代理服务器','net::'].some(s=>t.indexOf(s)>=0);return {err,login:/\\/login|passport/.test(location.href),onDomain:location.href.indexOf('fanqienovel.com')>=0};})()`);
    if (!valid || valid.err || valid.login || !valid.onDomain) return { ok: false, created: [], error: '番茄页面无效(网络/登录)' };

    // 打开"编辑分卷"——按钮随章节数据异步渲染，单次查常太早，轮询重试至多 ~16s
    let opened = false;
    for (let i = 0; i < 16 && !opened; i++) {
      opened = await client.clickByLocator(`for(const b of document.querySelectorAll('button')){if(b.offsetParent!==null&&(b.textContent||'').trim()==='编辑分卷')return b;}return null;`);
      if (!opened) await client.sleep(1000);
    }
    if (!opened) return { ok: false, created: [], error: '未找到"编辑分卷"入口（番茄页面加载超时或改版）' };
    await client.sleep(1500);

    const created = [];
    for (const v of [...volumes].sort((a, b) => a.num - b.num)) {
      // 已存在(按卷号)就跳过——绝不重复建
      const exists = await client.evaluate(`(function(){
        const items=document.querySelectorAll('.chapter-volume-list-item-normal');
        const want=${JSON.stringify('第' + numToCn(v.num) + '卷')};
        for(const it of items){ const sp=it.querySelector('span'); const t=((sp&&sp.textContent)||'').trim(); if(t.indexOf(want)===0||t.indexOf('卷'+${v.num})>=0) return true; }
        return false;
      })()`);
      if (exists) { log(`卷已存在，跳过：${v.name}`); continue; }

      // 新建分卷
      // "新建分卷"按钮随卷列表异步渲染，多卷/慢网时单次点常太早 → 轮询重试至多 ~5s，别一次点不到就报错停手。
      let addOk = false;
      for (let ai = 0; ai < 6 && !addOk; ai++) {
        addOk = await client.clickByLocator(`return document.querySelector('.chapter-volume-footer-add-volume')||document.querySelector('i.tomato-circle-add')||(function(){for(const b of document.querySelectorAll('button,[class*="btn"]')){if(b.offsetParent!==null&&(b.textContent||'').trim()==='新建分卷')return b;}return null;})();`);
        if (!addOk) await client.sleep(850);
      }
      if (!addOk) { return { ok: false, created, error: '未找到"新建分卷"按钮（番茄页面未就绪/改版，可刷新番茄页重试）' }; }
      await client.sleep(1000);
      // 番茄新版分卷 UI（2026 改版）：点"新建分卷"生成一行待命名项——
      //   · 序号"第N卷："由番茄【自动加】，输入框只填【副标题】(maxlength 16)；
      //   · 确认/取消是行内图标 <i class="tomato-confirm green"> / <i class="tomato-cancel red">，
      //     不是底部那个"确定"按钮（底部确定恒 disabled，旧代码误检它→永远报"确定未启用"）。
      // 故：① 只把副标题填进输入框；② 点行内绿勾提交；③ 读已提交的 normal 项验证。
      const INP_SEL = 'input.serial-input.common-input-hint-area, input[placeholder="请输入分卷名字"]';
      const sub = String(v.name).replace(/^第[一-龥\d]+卷[:：]?/, '').trim(); // "第二卷"→"" ; "第十四卷：少年游"→"少年游"
      const cancelRow = `return document.querySelector('i.tomato-cancel');`; // 行内红叉撤销（未提交，安全）
      // 聚焦副标题输入框
      const focused = await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(!inp)return false;inp.focus();return true;})()`);
      if (!focused) { return { ok: false, created, error: '未找到卷名输入框（番茄改版？）' }; }
      // 【安全网】番茄要求分卷必须有名字。副标题为空（卷目录只叫"卷03"、大纲里也没取到卷名）→ 不硬提交空名
      //（硬提交会在番茄留个未命名空行、界面卡住不动），而是撤销该行 + 给清楚可操作的提示。
      if (!sub) {
        try { await client.clickByLocator(cancelRow); } catch {}
        return { ok: false, created, error: `卷「${v.name}」没有名字，番茄要求分卷必须命名。请三选一后重发：①把本地卷目录改成带名字的（如「卷${numToCn(v.num)}_静海旧火」）；②让该卷大纲文件名带上卷名（如 outlines/卷0${v.num}静海旧火分章大纲.md）；③在「📚番茄卷管理」里手动建好这一卷。` };
      }
      // 填副标题：真实键盘(typeText)优先，setter 兜底
      if (sub) await client.typeText(sub);
      await client.sleep(400);
      let typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
      if ((typed || '').trim() !== sub) {
        await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(sub)});inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
        await client.sleep(300);
        typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
      }
      // 安全闸：副标题没填对 → 撤销行内编辑、绝不提交（番茄卷删不掉）
      if ((typed || '').trim() !== sub) {
        try { await client.clickByLocator(cancelRow); } catch {}
        return { ok: false, created, error: `卷副标题未能填入(实际"${typed}"，期望"${sub}")，已取消未提交` };
      }
      // 提交：点行内【绿勾】i.tomato-confirm（此步不可逆）
      const confirmed = await client.clickByLocator(`return document.querySelector('i.tomato-confirm');`);
      if (!confirmed) {
        try { await client.clickByLocator(cancelRow); } catch {}
        return { ok: false, created, error: '未找到行内"确认(绿勾)"图标，已取消未提交（番茄改版？请人工核对）' };
      }
      // 验证新卷已提交为正常项。番茄"第N卷"前缀按【位置】异步重渲染，连续建多卷时列表刷新更慢，
      // 单次查太早会误判"确认不到"→停手。故【轮询最多 ~8s】，且同时按【副标题】匹配（副标题即时出现，
      // 不像"第N卷"前缀会延迟）——只要新行带着我们填的副标题出现，就算建成。
      const wantPfx = '第' + numToCn(v.num) + '卷';
      let nowExists = false;
      for (let vi = 0; vi < 9 && !nowExists; vi++) {
        await client.sleep(vi === 0 ? 1600 : 750);
        nowExists = await client.evaluate(`(function(){
          const items=document.querySelectorAll('.chapter-volume-list-item-normal');
          const want=${JSON.stringify(wantPfx)}; const subw=${JSON.stringify(sub)};
          for(const it of items){ const sp=it.querySelector('span'); const t=((sp&&sp.textContent)||'').trim();
            if(t.indexOf(want)===0) return true;
            if(subw && t.indexOf(subw)>=0) return true;
          }
          return false;
        })()`);
      }
      if (nowExists) { log(`✅ 已新建卷：第${numToCn(v.num)}卷${sub ? '：' + sub : ''}`, 'success'); created.push(v.name); await client.sleep(700); }
      else {
        try { await client.clickByLocator(cancelRow); } catch {}
        return { ok: false, created, error: `新建卷"${v.name}"未在列表确认到，已停手（若番茄要求非空副标题，请给该卷设个名字再试）` };
      }
    }
    return { ok: true, created };
  } catch (err) {
    return { ok: false, created: [], error: String(err.message || err) };
  }
}

// ===== 改番茄卷名（番茄改版后：卷号"第N卷："自动前缀，只能改【副标题】）=====
// 定位现有卷：num（按"第N卷"前缀）或 oldName（按全名/前缀）二选一；newName 是目标完整卷名或副标题。
// 流程：编辑分卷 → 找到目标 normal 行点其 i.tomato-edit → 清空输入填新副标题 → 点行内绿勾 → 验证。
// 安全：副标题为空 / 没填对 / 找不到入口 → 撤销行内编辑（未提交），绝不留下错改。
export async function renameFanqieVolume({ profilePath, bookId, num, oldName, newName, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, error: '缺少 bookId' };
  const newSub = String(newName || '').replace(/^第[一-龥\d]+卷[:：]?/, '').trim();
  if (!newSub) return { ok: false, error: '新卷名（副标题）不能为空（番茄"第N卷："前缀自动加，无需填）' };
  if (newSub.length > 16) return { ok: false, error: `副标题超过番茄上限 16 字（当前 ${newSub.length}）` };
  if (!num && !oldName) return { ok: false, error: '未指定目标卷（num 或 oldName 至少一个）' };
  const client = new UnzooClient(profilePath || null, onLog || null);
  const INP_SEL = 'input.serial-input.common-input-hint-area, input[placeholder="请输入分卷名字"]';
  const cancelRow = `return document.querySelector('i.tomato-cancel');`;
  try {
    await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}?type=1`);
    await client.sleep(2500);
    const valid = await client.evaluate(`(function(){var t=document.body?document.body.innerText:'';var err=['ERR_','未连接到互联网','代理服务器','net::'].some(s=>t.indexOf(s)>=0);return {err,login:/\\/login|passport/.test(location.href),onDomain:location.href.indexOf('fanqienovel.com')>=0};})()`);
    if (!valid || valid.err || valid.login || !valid.onDomain) return { ok: false, error: '番茄页面无效(网络/登录)' };

    let opened = false;
    for (let i = 0; i < 16 && !opened; i++) {
      opened = await client.clickByLocator(`for(const b of document.querySelectorAll('button')){if(b.offsetParent!==null&&(b.textContent||'').trim()==='编辑分卷')return b;}return null;`);
      if (!opened) await client.sleep(1000);
    }
    if (!opened) return { ok: false, error: '未找到"编辑分卷"入口（番茄页面加载超时或改版）' };
    await client.sleep(1500);

    // 定位目标卷的 normal 行，点其铅笔 i.tomato-edit 进入编辑态
    const want = num ? ('第' + numToCn(num) + '卷') : String(oldName || '');
    const editClicked = await client.clickByLocator(`
      const items=document.querySelectorAll('.chapter-volume-list-item-normal');
      const want=${JSON.stringify(want)}; const oldName=${JSON.stringify(String(oldName || ''))};
      for(const it of items){const sp=it.querySelector('span');const t=((sp&&sp.textContent)||'').trim();
        if(t===want||t.indexOf(want)===0||(oldName&&t===oldName)){const e=it.querySelector('i.tomato-edit');if(e)return e;}}
      return null;`);
    if (!editClicked) return { ok: false, error: `未找到目标卷的编辑入口：${want}（该卷在番茄不存在？）` };
    await client.sleep(800);

    // 聚焦 → 清空旧副标题 → 填新副标题
    const focused = await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(!inp)return false;inp.focus();return true;})()`);
    if (!focused) { try { await client.clickByLocator(cancelRow); } catch {} return { ok: false, error: '未找到卷名输入框（番茄改版？）' }; }
    await client.clearFocused();
    await client.sleep(200);
    await client.typeText(newSub);
    await client.sleep(400);
    let typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
    if ((typed || '').trim() !== newSub) {
      await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(newSub)});inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
      await client.sleep(300);
      typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
    }
    if ((typed || '').trim() !== newSub) {
      try { await client.clickByLocator(cancelRow); } catch {}
      return { ok: false, error: `新副标题未能填入(实际"${typed}")，已取消未改` };
    }
    // 点行内绿勾提交改名
    const confirmed = await client.clickByLocator(`return document.querySelector('i.tomato-confirm');`);
    if (!confirmed) {
      try { await client.clickByLocator(cancelRow); } catch {}
      return { ok: false, error: '未找到行内"确认(绿勾)"图标，已取消未改（番茄改版？）' };
    }
    await client.sleep(2000);
    // 验证：normal 项里出现"第…卷：新副标题"
    const ok = await client.evaluate(`(function(){const items=document.querySelectorAll('.chapter-volume-list-item-normal span');for(const sp of items){const t=(sp.textContent||'').trim();if(t.indexOf('：'+${JSON.stringify(newSub)})>=0||t.endsWith(${JSON.stringify(newSub)}))return true;}return false;})()`);
    if (!ok) return { ok: false, error: `改名后未在列表确认到"…：${newSub}"，请人工核对番茄分卷` };
    log(`✅ 已改卷名：${want} → …：${newSub}`, 'success');
    return { ok: true, name: newSub };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

export { numToCn };

// ===== 新增导出：建卷（仅 matchVolumes=true 时用）=====
//
// 安全第一——番茄建卷不可逆、发错改不了。本函数策略：
//   1. 先读出番茄当前卷列表（点开卷下拉读，参考 selectVolume / fetchVolumes 的读法）。
//   2. 若目标卷"确实已存在"（按卷名或「第N卷」匹配）→ 直接返回 {created:false, ok:true, exists:true}。
//   3. 若读不到卷列表 / 无法确定 → 返回 {created:false, ok:false, reason} 并告警，绝不乱建。
//   4. 目标卷确实不存在时：当前实现【不实际建卷】，仅返回 TODO 标记，待联调校准"分卷/新建卷"
//      入口与命名输入框后再开启真正的建卷动作。宁可不建，也不建错。
export async function ensureVolume({ profilePath, bookId, volNum, volName, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { created: false, ok: false, reason: '缺少 bookId' };
  if (!volNum && !volName) return { created: false, ok: false, reason: '未指定目标卷（volNum/volName 至少一个）' };

  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    // 导航到章节管理页（卷下拉在此页可读）
    await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&1`);
    await client.sleep(2000);

    // 坐标真实点击展开卷下拉（trusted）
    const openVol = () => client.clickByLocator(`return document.querySelector('.serial-select, .byte-select, [class*="volume-select"]');`);
    await openVol();

    // 轮询等待 Arco 弹层挂载（Portal + transition），document 层级读取卷列表
    let volumes = [], current = '';
    for (let i = 0; i < 15; i++) {
      await client.sleep(120);
      if (i === 7) { await openVol(); }
      const r = await client.evaluate(`
        (function(){
          const opts = document.querySelectorAll('.byte-select-option, .arco-select-option, [class*="select-option"]');
          if (!opts.length) return null;
          const vols = [];
          for (const o of opts) { const t = (o.textContent||'').trim(); if (t) vols.push(t); }
          const cur = (document.querySelector('.byte-select-view-value, .arco-select-view-value')||{}).textContent || '';
          return { vols, cur: cur.trim() };
        })()
      `);
      if (r && r.vols && r.vols.length) { volumes = r.vols; current = r.cur; break; }
    }
    // 关闭下拉
    try { await client.evaluate(`document.body.click()`); } catch {}

    // 读不到卷列表 → 不确定，绝不乱建
    if (!volumes.length) {
      log('⚠️ 未能读取卷列表（下拉未挂载或页面未就绪），为安全起见不建卷', 'error');
      return { created: false, ok: false, reason: '无法读取当前卷列表', volumes: [] };
    }

    // 判断目标卷是否已存在：按卷名精确包含，或「第N卷」/「卷N」匹配
    const nameHit = volName && volumes.some(v => v.includes(volName));
    const numHit = volNum && volumes.some(v => v.includes(`第${volNum}卷`) || v.includes(`卷${volNum}`));
    if (nameHit || numHit) {
      log(`✅ 目标卷已存在（${volName || '第' + volNum + '卷'}），无需新建`, 'success');
      return { created: false, ok: true, exists: true, volumes, current };
    }

    // 目标卷不存在 —— 安全起见【不实际建卷】，仅标 TODO，待联调校准建卷入口后再开启。
    // 番茄建卷不可逆：必须先确认"分卷/新建卷"按钮选择器与卷名输入框，再写真正动作。
    log(`⚠️ 目标卷不存在（${volName || '第' + volNum + '卷'}）。出于安全，本实现不自动建卷，请人工建卷或联调校准建卷流程后再开启。`, 'error');
    return {
      created: false,
      ok: false,
      exists: false,
      reason: 'TODO: 建卷动作未实现（安全策略，避免不可逆误建）。需联调校准"分卷/新建卷"入口与命名输入框。',
      volumes,
      current,
    };
  } catch (err) {
    log(`ensureVolume 失败: ${err.message || err}`, 'error');
    return { created: false, ok: false, reason: String(err.message || err) };
  }
}

// 导出类，供需要更细粒度控制的调用方使用（可选）
// 列出 Unzoo 全部账号（profile）及其已打开的番茄页。
// 以 profile_list 为主源 → 列出【所有】账号(含未开标签页的)；再用 tab_list 叠加番茄页/bookId 检测。
// 路径取自 Unzoo 接口，权威无转义损坏，供前端下拉直接选用。
// 返回 [{ path, name(显示名), dir(目录名), running(是否已启动), fanqie:[{url,bookId}] }]。
export async function listProfiles() {
  // 1) 全部账号（即使没开浏览器/没标签页也要列出）
  let allProfiles = [];
  try {
    const pl = await unzooCallTool('profile_list', {});
    allProfiles = pl?.profiles || (Array.isArray(pl) ? pl : []);
  } catch (e) { /* profile_list 不可用时退化为只用 tab_list */ }

  const byPath = new Map();
  for (const pp of allProfiles) {
    if (!pp?.path) continue;
    byPath.set(pp.path, {
      path: pp.path,
      name: pp.name || pp.path.split(/[\\/]/).pop() || pp.path,
      dir: pp.path.split(/[\\/]/).pop() || '',
      running: false,
      fanqie: [],
    });
  }

  // 2) 叠加标签页信息（哪些账号在跑、哪些开了番茄页/对应 bookId）
  let tabs = [];
  try { const data = await unzooCallTool('tab_list', {}); tabs = data?.tabs || []; }
  catch (e) { if (!byPath.size) return { ok: false, error: e.message || String(e), profiles: [] }; }
  for (const t of tabs) {
    const p = t.profile_path;
    if (!p) continue;
    if (!byPath.has(p)) byPath.set(p, { path: p, name: p.split(/[\\/]/).pop() || p, dir: p.split(/[\\/]/).pop() || '', running: true, fanqie: [] });
    const entry = byPath.get(p);
    entry.running = true;
    if (t.url && t.url.includes('fanqienovel.com')) {
      const m = t.url.match(/\/(\d{6,})(?:[/?]|$)/);
      entry.fanqie.push({ url: t.url, bookId: m ? m[1] : '' });
    }
  }

  // 已开番茄页的排最前，其次在跑的，再次其他
  const profiles = [...byPath.values()].sort((a, b) =>
    (b.fanqie.length - a.fanqie.length) || (Number(b.running) - Number(a.running)) || a.name.localeCompare(b.name));
  return { ok: true, profiles };
}

// 读取某番茄账号(profile)下的【全部书籍】列表(title+bookId)，供前端"从番茄选书"下拉，
// 免去用户手填 bookId、也避免填错号。返回 { ok, books:[{id,title}], error? }。
async function _getFanqieBooksOnce({ profilePath, onLog } = {}) {
  const client = new UnzooClient(profilePath || null, onLog || null);
  try {
    await client.navigate('https://fanqienovel.com/main/writer/book-manage');
    await client.sleep(2500);
    const readExpr = `(function(){
      var text = document.body ? document.body.innerText : '';
      var errMarkers=['ERR_','未连接到互联网','代理服务器','net::'];
      if(errMarkers.some(function(s){return text.indexOf(s)>=0;})) return {invalid:'errorPage'};
      if(location.href.indexOf('fanqienovel.com')<0) return {invalid:'offDomain'};
      if(/\\/login|passport/.test(location.href) || text.indexOf('扫码登录')>=0) return {invalid:'loginPage'};
      var anchors=[].slice.call(document.querySelectorAll('a[href*="/writer/"]'));
      var seen={}, books=[];
      anchors.forEach(function(a){
        var m=a.href.match(/\\/(7\\d{15,})/); if(!m) return; var id=m[1];
        var node=a, card=null;
        for(var i=0;i<6 && node;i++){ node=node.parentElement; if(node && /serial-card-large|book-manage-item|content-card/.test(node.className||'')){card=node;break;} }
        if(!card){ node=a; for(var j=0;j<5 && node.parentElement;j++){node=node.parentElement;} card=node; }
        var titleEl=card.querySelector('[class*="book-name"],[class*="title"]');
        var title=titleEl?titleEl.innerText.trim():'';
        if(!title){ var lines=(card.innerText||'').split('\\n').map(function(s){return s.trim();}); title=lines.filter(function(s){return s.length>=3 && s.length<=30 && !/章|更新|置顶|别名|创建|管理|数据|征文|作品|置顶/.test(s);})[0]||''; }
        if(!seen[id]){ seen[id]=1; books.push({id:id, title:title.split('\\n')[0].slice(0,30)}); }
      });
      var emptyState = books.length===0 && /还没有作品|去创作|暂无作品|发布你的第一|创作你的第一/.test(text);
      var pagItems=[].slice.call(document.querySelectorAll('.arco-pagination-item:not(.arco-pagination-item-prev):not(.arco-pagination-item-next)'));
      var totalPages=1; pagItems.forEach(function(p){var n=parseInt(p.textContent);if(!isNaN(n)&&n>totalPages)totalPages=n;});
      var actItem=document.querySelector('.arco-pagination-item-active'); var currentPage=actItem?(parseInt(actItem.textContent)||1):1;
      return {books:books, emptyState:emptyState, totalPages:totalPages, currentPage:currentPage};
    })()`;
    // 番茄作品管理页【异步渲染】——书卡比页面框架晚出来。轮询等到读到书(books.length>0)或真"还没有作品"
    // 空状态才停，别像以前那样只读一次(4s后)就拿空/半列表→上层"书籍匹配不上"。
    let ev = null;
    for (let i = 0; i < 12; i++) {
      ev = await client.evaluate(readExpr);
      if (ev) {
        if (ev.invalid) break;                                     // 硬失败(登录/错误/离域)立即停
        if ((ev.books && ev.books.length) || ev.emptyState) break; // 读到书 / 真"还没有作品"
      }
      await client.sleep(1200);
    }
    if (!ev) return { ok: false, error: '读取书籍列表失败(页面空)', books: [] };
    if (ev.invalid) {
      const why = ev.invalid === 'errorPage' ? '番茄页面加载失败(网络/代理)' : ev.invalid === 'loginPage' ? '番茄需要登录' : '不在番茄域名';
      return { ok: false, error: why, books: [] };
    }
    // 作品管理页【分页】——每页约 10 本；书多必须翻页读全，否则下拉里"少书"。
    // ⚠️关键修复：不能假设初始读到的就是第1页！navigate 若已在 book-manage 会【跳过刷新】，
    // 页面可能停在上次翻到的第2/3页。旧代码只从第2页往后翻→漏掉整个第1页(用户的书全在第1页)。
    // 改为从第1页起【逐页显式点选并读】，覆盖所有页。
    const seenIds = new Set(), allBooks = [];
    const totalPages = Math.min(ev.totalPages || 1, 30);
    for (let pg = 1; pg <= totalPages; pg++) {
      if (totalPages > 1) {
        await client.clickByLocator(`
          const want=${pg};
          const items=document.querySelectorAll('.arco-pagination-item');
          for(const it of items){ if(parseInt(it.textContent)===want) return it; }
          return null;
        `);
      }
      // 轮询等这一页书卡渲染出来、且已切到该页
      let pr = null;
      for (let i = 0; i < 12; i++) {
        await client.sleep(800);
        pr = await client.evaluate(readExpr);
        if (pr && pr.books && pr.books.length && (totalPages <= 1 || pr.currentPage === pg)) break;
      }
      if (pr && pr.books) for (const b of pr.books) if (b.id && !seenIds.has(b.id)) { seenIds.add(b.id); allBooks.push(b); }
    }
    if (totalPages > 1) onLog && onLog({ level: 'info', msg: `📚 翻页读全番茄书：共 ${allBooks.length} 本（${totalPages} 页）` });
    return { ok: true, books: allBooks.length ? allBooks : (ev.books || []) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), books: [] };
  }
}

// 读番茄书籍列表：番茄页偶发慢/空/卡 → 自动重试至多 3 次；登录/域名类硬失败不重试。
export async function getFanqieBooks({ profilePath, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  let last = { ok: false, error: '未执行', books: [] };
  for (let i = 1; i <= 3; i++) {
    last = await _getFanqieBooksOnce({ profilePath, onLog });
    if (last.ok && last.books.length) return last;
    // 硬失败（需登录/不在番茄域名）→ 重试也没用，直接返回
    if (last.error && /登录|域名/.test(last.error)) return last;
    if (i < 3) { log(`读番茄书籍第 ${i} 次未成功（${last.error || '空'}）→ 重试…`, 'warn'); await new Promise(r => setTimeout(r, 1500)); }
  }
  return last;
}

// ===== 共用：番茄封面【可信注入 + 全屏遮罩两步确认】=====
// 换封面 / 多书名实验封面 / 新书封面 都走这两个助手，保证只有一条经过验证的上传路径。
//
// injectTrustedCover：番茄唯一认的上传法 = MCP `browser_upload_trusted`（blink SetFilesFromPaths，
//   产生 isTrusted 文件事件；browser_upload/DataTransfer/拖拽/CDP-shim 都不认）。
//   中文书名目录路径先拷成 ASCII 临时文件避编码坑。
//   返回 { ok, rmTmp }：⚠️ rmTmp 必须在“确认按钮点亮/上传完成”之后再调用——注入只是把磁盘
//   文件引用塞给 input，番茄异步读取上传，删早了上传就失败、确认按钮永不点亮（踩过的坑）。
async function injectTrustedCover(client, filePath, selectors = ['.byte-upload input[type=file]', '.cover-modal-upload input[type=file]', 'input[type=file]']) {
  let injPath = filePath, tmpFile = null;
  try {
    const [fsm, osm, pm] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
    tmpFile = pm.join(osm.tmpdir(), 'ns_fqup_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.png');
    fsm.copyFileSync(filePath, tmpFile); injPath = tmpFile;
  } catch {}
  const rmTmp = async () => { if (tmpFile) { try { (await import('node:fs')).unlinkSync(tmpFile); } catch {} tmpFile = null; } };
  let ok = false;
  for (const sel of selectors) {
    try {
      // MCP 层失败即抛异常；能返回就算注入成功（不同版本载荷字段不一，别按字段硬判）。
      const r = await uploadTrusted(client.tabId, sel, [injPath]);
      if (r === null || r?.uploaded !== false) { ok = true; break; }
    } catch {}
  }
  return { ok, rmTmp };
}

// confirmCoverOverlay：番茄封面选择器是【全屏遮罩】(非 arco-modal 小弹窗)，确认常是【两步】：先“确认上传”、
//   再出现橙色“确定”。confirmLabels 只精确匹配确认文案——绝不兜底点“最后一个/主按钮”，否则会误点同页的
//   “立即修改”(提前保存) 或“取消”。先轮询等确认按钮点亮(=图被接受)，再循环点确认按钮直到遮罩关闭。
//   返回 { accepted, closed }。accepted=false 说明图没被番茄接受（不合规/审核中）。
async function confirmCoverOverlay(client, { confirmLabels = ['确认上传', '确定', '确认'], overlayTabText = '本地上传', waitTries = 16 } = {}) {
  const CONFIRM_JS = `(function(){
    function norm(t){return (t||'').replace(/\\s+/g,'');}
    var labels=${JSON.stringify(confirmLabels)};
    var pool=[].slice.call(document.querySelectorAll('button,[role=button],.arco-btn')).filter(function(e){return e.offsetParent!==null;});
    var named=pool.filter(function(e){return labels.indexOf(norm(e.textContent))>=0;});
    return named.find(function(e){return !(e.disabled||/disabled/.test(e.className));})||null;
  })`;
  const OVERLAY_OPEN_JS = `[].slice.call(document.querySelectorAll('*')).some(function(e){return (e.textContent||'').trim()===${JSON.stringify(overlayTabText)}&&e.offsetParent!==null&&e.children.length===0;})`;
  let accepted = false;
  for (let i = 0; i < waitTries; i++) {
    accepted = await client.evaluate(`!!${CONFIRM_JS}()`);
    if (accepted) break;
    await client.sleep(900);
  }
  if (!accepted) return { accepted: false, closed: false };
  const clickConfirm = `(function(){var el=${CONFIRM_JS}();if(!el)return false;try{el.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`;
  for (let k = 0; k < 4; k++) {
    const clicked = await client.evaluate(clickConfirm);
    await client.sleep(2000);
    if (!(await client.evaluate(OVERLAY_OPEN_JS))) break;                       // 遮罩已关 → 完成
    if (!clicked && !(await client.evaluate(`!!${CONFIRM_JS}()`))) break;       // 没按钮可点了也退出，避免空转
  }
  return { accepted: true, closed: !(await client.evaluate(OVERLAY_OPEN_JS)) };
}

// ===== 更换番茄图书封面 =====
// 把本地封面图推到番茄「作品信息」页。流程（实地研究得出）：
//   book-info 页 → 点"修改"进编辑态 → "选择封面"开全屏遮罩 → "本地上传" → set_input_files 可信注入
//   → 确认上传→确定(两步) → autoSubmit ? 点"立即修改"提交 : 停在"待提交"让用户手动确认。
// 番茄封面竖版 3:4，用本地 cover.png(600×800) 正好。
export async function changeFanqieCover({ bookId, coverPath, profilePath, autoSubmit = false, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, error: '缺少番茄 bookId' };
  if (!coverPath) return { ok: false, error: '缺少封面文件路径' };   // 文件存在性由调用方(server)校验，本模块不碰 fs
  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');

  const Q = (label) => JSON.stringify(label);
  // 轮询等某文字的【可见】按钮出现
  const waitText = async (label, tries = 15, gap = 1000) => {
    for (let i = 0; i < tries; i++) {
      const ok = await client.evaluate(`[].slice.call(document.querySelectorAll('button,div,span,a')).some(function(e){return (e.textContent||'').trim()===${Q(label)} && e.offsetParent!==null;})`);
      if (ok) return true;
      await client.sleep(gap);
    }
    return false;
  };
  // 合成点击某文字按钮（不弹文件框的普通按钮用这个够了）
  const jsClick = async (label) => await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button,div,span,a')).find(function(e){return (e.textContent||'').trim()===${Q(label)} && e.offsetParent!==null;});if(!b)return false;b.click();return true;})()`);
  // 【可信点击】某文字按钮（打标记 + browser_click）——用于会弹文件框的"选择封面"
  const trustedClick = async (label) => {
    const marked = await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button,div,span,a')).find(function(e){return (e.textContent||'').trim()===${Q(label)} && e.offsetParent!==null;});if(!b)return false;b.setAttribute('data-ns-cvclick','1');return true;})()`);
    if (!marked) return false;
    try { await client.click('[data-ns-cvclick="1"]'); }
    finally { await client.evaluate(`(function(){var e=document.querySelector('[data-ns-cvclick="1"]');if(e)e.removeAttribute('data-ns-cvclick');})()`); }
    return true;
  };

  try {
    await client.getActiveTab();
    log('打开番茄作品信息页…');
    await client.navigate(`https://fanqienovel.com/main/writer/book-info/${bookId}?type=1`);
    await client.sleep(2000);
    // 强制刷新到干净态：navigate 若已在该页会跳过刷新，上一次编辑残留会让"修改"点了不进编辑态。
    try { await client.reload(); } catch {}
    await client.sleep(3000);
    // 把标签页激活置前——番茄部分按钮的 handler 要页面有焦点才触发，否则 CDP 可信点击也会落空。
    try { await unzooCallTool('tab_activate', { tab_id: String(client.tabId) }); } catch {}
    await client.sleep(600);

    // 可信点击文字按钮：先 scrollIntoView 再 CDP 真实点击。番茄按钮只认【可信点击】(合成/坐标点都不触发)，
    // 且按钮可能在视口外(如底部第二个"修改")；which='first' 取最靠上的(封面那个"修改"在基础信息区顶部)。
    // 点番茄按钮：在【元素本身】派发完整指针序列(pointerdown→…→click)。位置无关(不靠坐标)，实测对
    // 修改/选择封面/本地上传/确定/立即修改 都触发。优先点真正的 <button>(同文字常有 span 子节点，点 span 不触发)。
    const cdpClickText = async (txt, which = 'last') => {
      const pick = which === 'first' ? 'els[0]' : 'els[els.length-1]';
      return !!(await client.evaluate(`(function(){var all=[].slice.call(document.querySelectorAll('button,div[role=button],span,a')).filter(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});var btns=all.filter(function(e){return e.tagName==='BUTTON'||e.getAttribute('role')==='button';});var els=btns.length?btns:all;var el=${pick};if(!el)return false;try{el.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`));
    };

    // 1. 进编辑态：已在编辑态(有"选择封面")直接用；否则点顶部"修改"进入（可信点击；番茄编辑态刷新不重置，故容错）
    const inEdit = await client.evaluate(`[].slice.call(document.querySelectorAll('button,div,span,a')).some(function(e){return (e.textContent||'').trim()==='选择封面' && e.offsetParent!==null;})`);
    if (!inEdit) {
      if (!(await waitText('修改'))) return { ok: false, error: '未找到"修改"按钮（未登录/页面没加载完/该书不可改）' };
      for (let i = 0; i < 3 && !(await client.evaluate("[].slice.call(document.querySelectorAll('button,div,span')).some(function(e){return (e.textContent||'').trim()==='选择封面'&&e.offsetParent!==null;})")); i++) {
        await cdpClickText('修改', 'first'); await client.sleep(2000);
      }
      log('进入编辑模式…');
      if (!(await waitText('选择封面'))) return { ok: false, error: '进入编辑模式后未出现"选择封面"' };
    } else {
      log('已在编辑模式…');
    }

    // 2. 打开封面弹窗：点"选择封面"。⚠️番茄的按钮/上传触发器只认【完整指针事件序列】(pointerdown→
    //    mousedown→pointerup→mouseup→click)——合成 .click()、CDP browser_click、坐标点击都【不触发】
    //    (实测踩出来的坑)。故用 JS 派发完整序列点击番茄的按钮/tab。
    const firePointer = async (txt) => await client.evaluate(`(function(){var btn=[].slice.call(document.querySelectorAll('button')).find(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});var el=btn;if(!el){var c=[].slice.call(document.querySelectorAll('div,span,a')).filter(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});el=c[c.length-1];}if(!el)return false;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
    log('打开番茄封面弹窗…');
    let modalOpen = false;
    for (let a = 0; a < 3 && !modalOpen; a++) {
      await cdpClickText('选择封面');
      for (let i = 0; i < 6; i++) {
        if (await client.evaluate(`[].slice.call(document.querySelectorAll('*')).some(function(e){return (e.textContent||'').trim()==='本地上传'&&e.offsetParent!==null;})`)) { modalOpen = true; break; }
        await client.sleep(800);
      }
    }
    if (!modalOpen) return { ok: false, error: '没能打开番茄封面弹窗（未见"本地上传"），请重试。' };

    // 3. 切到"本地上传"tab，并把该标签页激活置前
    await cdpClickText('本地上传');
    await client.sleep(1200);
    try { await unzooCallTool('tab_activate', { tab_id: String(client.tabId) }); } catch {}

    // 4. 等文件输入框出现
    let hasInput = false;
    for (let i = 0; i < 8; i++) {
      if (await client.evaluate("document.querySelectorAll('input[type=file]').length>0")) { hasInput = true; break; }
      await client.sleep(700);
    }
    if (!hasInput) return { ok: false, error: '未找到番茄封面上传文件框（本地上传弹窗没开好），请重试' };

    // 5. 【可信注入】封面文件（共用助手：set_input_files，番茄唯一认的上传法）
    log('注入封面文件（可信上传 set_input_files）…');
    const { ok: injOk, rmTmp } = await injectTrustedCover(client, coverPath);
    if (!injOk) { await rmTmp(); return { ok: false, error: '可信文件注入未成功（browser_upload_trusted 调用失败，请确认 Unzoo 版本 ≥2.5）' }; }

    // 6-7. 两步确认（确认上传→确定）直到全屏遮罩关闭（共用助手）。
    //    ⚠️ rmTmp 放确认之后——番茄异步读文件上传，删早了确认按钮永不点亮（坑）。
    log('确认选图…');
    const { accepted, closed } = await confirmCoverOverlay(client);
    await rmTmp();
    if (!accepted) return { ok: false, error: '封面已注入但番茄确认按钮未点亮（图可能不合规/未被接受，或该书封面正在审核中），请人工核对' };
    if (!closed) return { ok: false, error: '封面确认后番茄选择遮罩未关闭（确认按钮可能变了），请人工核对' };

    if (!autoSubmit) {
      return { ok: true, semiManual: false, submitted: false, msg: '封面已上传并确认到「待提交」。去浏览器点「立即修改」保存即可（开「全自动提交」下次自动保存）。' };
    }

    // 8. 立即修改（保存到线上 · 不可逆）
    log('保存封面（立即修改）…');
    await cdpClickText('立即修改');
    await client.sleep(3800);
    const okToast = await client.evaluate("/修改成功|成功|已提交/.test((document.querySelector('.arco-message,[class*=message]')||{}).textContent||'')");
    return { ok: true, semiManual: false, submitted: true, msg: okToast ? '✅ 番茄封面已更换并提交（修改成功，等番茄审核）' : '已点「立即修改」，请到浏览器确认结果' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 在番茄【创建一本新书】=====
// 全自动：导航 /main/writer/create → 原生 setter 填 书名/男女频/主角名/简介 →
//         CDP 可信点击 打开作品标签弹窗、选主分类卡片、确认 → 点「立即创建」→ 跳转后抓回 bookId。
// autoSubmit=false 则填好停在表单，返回 semiManual（人工核对后自己点「立即创建」）。
// 坑：Arco 受控输入要用原生 value setter；弹窗卡片/确认/立即创建 合成点击不触发，必须 CDP 可信点击。
export async function createFanqieBook({ profilePath, title, channel = '男频', mainCategory, hero = '', hero2 = '', synopsis, coverPath = '', autoSubmit = true, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  title = String(title || '').trim();
  const intro = String(synopsis || '').trim();
  const cat = String(mainCategory || '').trim();
  if (!title) return { ok: false, error: '缺少书名' };
  if (title.length > 15) return { ok: false, error: `书名「${title}」超过番茄上限(15字)` };
  if (!cat) return { ok: false, error: '缺少主分类（如「历史脑洞」）' };
  if (intro.length < 50) return { ok: false, error: `简介仅 ${intro.length} 字，番茄要求 50–500 字` };
  if (intro.length > 500) return { ok: false, error: `简介 ${intro.length} 字，超过番茄上限(500字)` };
  if (channel !== '男频' && channel !== '女频') channel = '男频';

  const client = new UnzooClient(profilePath, onLog, 'fanqienovel.com', '番茄');
  await client.ensureTabId();

  // 原生 setter：填 Arco 受控 input/textarea（合成 input+change 触发 React 状态）
  const SETTER = `function __sv(el,val){var pr=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(pr,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

  log('打开番茄「创建作品」页…');
  await client.navigate('https://fanqienovel.com/main/writer/create');
  await client.sleep(5000);
  let ready = false;
  for (let k = 0; k < 12; k++) {
    if (await client.evaluate("!!document.querySelector('input[placeholder*=作品名称]')")) { ready = true; break; }
    await client.sleep(800);
  }
  if (!ready) return { ok: false, error: '创建作品表单未加载（番茄改版/未登录/网络？）' };

  // 1. 书名
  log(`填书名《${title}》…`);
  await client.evaluate(`(function(){${SETTER} var el=document.querySelector('input[placeholder*=作品名称]');if(el){el.focus();__sv(el,${JSON.stringify(title)});}return 1;})()`);
  await client.sleep(400);
  // 2. 男频/女频
  await client.evaluate(`(function(){var m=[].slice.call(document.querySelectorAll('.arco-radio,label')).find(function(e){return (e.textContent||'').trim()===${JSON.stringify(channel)};});if(m){['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){m.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}return 1;})()`);
  await client.sleep(400);
  // 3. 主角名
  if (hero) { await client.evaluate(`(function(){${SETTER} var el=document.querySelector('input[placeholder*=主角名1]');if(el){el.focus();__sv(el,${JSON.stringify(String(hero).slice(0, 5))});}return 1;})()`); await client.sleep(300); }
  if (hero2) { await client.evaluate(`(function(){${SETTER} var el=document.querySelector('input[placeholder*=主角名2]');if(el){el.focus();__sv(el,${JSON.stringify(String(hero2).slice(0, 5))});}return 1;})()`); await client.sleep(300); }
  // 4. 简介
  log(`填简介(${intro.length}字)…`);
  await client.evaluate(`(function(){${SETTER} var el=document.querySelector('textarea');if(el){el.focus();__sv(el,${JSON.stringify(intro)});}return 1;})()`);
  await client.sleep(500);

  // 5. 作品标签弹窗 → 主分类卡片 → 确认（CDP 可信点击）
  log(`选择主分类「${cat}」…`);
  const selCoord = await client.evaluate("(function(){var s=[].slice.call(document.querySelectorAll('.arco-select,[class*=select]')).find(function(e){return /请选择作品标签/.test(e.textContent);});if(!s)return '';var r=s.getBoundingClientRect();return Math.round(r.x+30)+','+Math.round(r.y+r.height/2);})()");
  if (!selCoord) return { ok: false, error: '未找到「作品标签」选择框' };
  { const [x, y] = selCoord.split(',').map(Number); await client.cdpClick(x, y); }
  await client.sleep(1600);
  // 主分类卡片：番茄弹窗里每张分类卡为 .category-choose-item（含标题+描述）。优先按此类名匹配，兜底取含分类名的最小元素。
  const cardCoord = await client.evaluate(`(function(){var name=${JSON.stringify(cat)};var els=[].slice.call(document.querySelectorAll('.category-choose-item')).filter(function(e){return (e.textContent||'').indexOf(name)>=0;});if(!els.length){els=[].slice.call(document.querySelectorAll('*')).filter(function(e){var t=e.textContent||'';return t.indexOf(name)>=0&&t.length<40;}).sort(function(a,b){return a.textContent.length-b.textContent.length;});}var c=els[0];if(!c)return '';var r=c.getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()`);
  if (!cardCoord) return { ok: false, error: `标签弹窗里没找到主分类「${cat}」（频道选对了吗？男/女频分类不同）` };
  { const [x, y] = cardCoord.split(',').map(Number); await client.cdpClick(x, y); }
  await client.sleep(900);
  const okCoord = await client.evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(e){return (e.textContent||'').trim()==='确认';});if(!b)return '';var r=b.getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()");
  if (okCoord) { const [x, y] = okCoord.split(',').map(Number); await client.cdpClick(x, y); }
  await client.sleep(1400);

  if (!autoSubmit) {
    return { ok: true, semiManual: true, msg: `已在番茄填好《${title}》创建表单（${channel}·${cat}·简介${intro.length}字）。请到该浏览器核对后点「立即创建」。` };
  }

  // 6. 立即创建（不可逆）
  log('点击「立即创建」…');
  const createCoord = await client.evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(e){return (e.textContent||'').trim()==='立即创建';});if(!b)return '';var r=b.getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()");
  if (!createCoord) return { ok: false, error: '未找到「立即创建」按钮' };
  { const [x, y] = createCoord.split(',').map(Number); await client.cdpClick(x, y); }

  // 7. 等跳转 book-info/<id> 抓 bookId；期间若弹校验错误则报错
  let bookId = null;
  for (let k = 0; k < 15; k++) {
    await client.sleep(1000);
    const href = await client.evaluate('location.href');
    const m = String(href || '').match(/book-info\/(\d+)/);
    if (m) { bookId = m[1]; break; }
    const err = await client.evaluate("(function(){var e=document.querySelector('.arco-message-error,[class*=message-error]');return e?(e.textContent||'').trim().slice(0,60):'';})()");
    if (err) return { ok: false, error: '番茄拒绝创建：' + err };
  }
  if (!bookId) return { ok: false, error: '已点「立即创建」但未跳到作品页（可能有校验未过/网络慢），请到浏览器核对' };
  log(`✅ 已在番茄创建《${title}》，bookId=${bookId}`, 'act');

  // 8. 上传本地封面（番茄建书默认自动生成封面；有本地 cover.png 就换成我们的）。best-effort：
  //    失败只告警、不影响“建书成功”——封面之后随时能用「更换番茄封面」补。复用换封面全流程(可信注入+两步确认+立即修改)。
  let cover = null;
  if (coverPath) {
    log('上传本地封面到新书…', 'act');
    try {
      await client.sleep(1500);   // 等新书 book-info 页稳定
      cover = await changeFanqieCover({ bookId, coverPath, profilePath, autoSubmit: true, onLog });
      if (cover.ok) log('✅ 新书封面已上传' + (cover.submitted ? '并提交' : '（待提交，去浏览器点保存）'), 'act');
      else log('新书封面上传未成功（可稍后用「更换番茄封面」重试）：' + (cover.error || ''), 'warn');
    } catch (e) { cover = { ok: false, error: String(e.message || e) }; log('新书封面上传异常（不影响建书）：' + cover.error, 'warn'); }
  }
  return { ok: true, bookId, title, channel, mainCategory: cat, cover };
}

// ===== 把「书名实验」候选推到番茄「多书名实验·实验配置」（设置别名 + 逐个上传封面）=====
// items: [{title, coverPath}]（coverPath 可空=该候选不传封面）。autoSubmit=false 默认：填好停在实验配置，
//   让用户核对后自己点「开启实验」(不可逆)；autoSubmit=true 才自动开启。封面上传复用换封面的可信注入+两步确认。
// ⚠️ 番茄门槛：20万字+/已签约/未完结，且该字数里程碑实验【未跑过】时才开放「实验配置」表单。不满足时本函数
//   【不瞎点】，而是切到该书、把候选清单列出来、把页面留在多书名实验页，返回 semiManual 让人工配。
//   （实验配置表单当前无处于实验期的书可实地观测→ step 3 表单填充为通用尽力实现，需在有资格的书上校准。）
export async function pushNameExperiment({ bookId, bookTitle, items = [], profilePath, autoSubmit = false, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  items = (items || []).filter(x => x && x.title);
  if (!items.length) return { ok: false, error: '没有候选书名可推' };
  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');
  const Q = (s) => JSON.stringify(s);
  // 完整指针序列点某文字元素（番茄按钮只认这个，合成 .click()/坐标点不触发）
  const clickText = async (txt) => await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button,div[role=button],span,a,li')).find(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});if(!b)return false;try{b.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){b.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
  const SETTER = `function __sv(el,val){var pr=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(pr,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

  try {
    await client.getActiveTab();
    log('打开番茄「多书名实验」页…');
    await client.navigate('https://fanqienovel.com/main/writer/name-experiment');
    await client.sleep(2500);
    try { await client.reload(); } catch {}
    await client.sleep(3500);
    try { await unzooCallTool('tab_activate', { tab_id: String(client.tabId) }); } catch {}
    await client.sleep(600);

    // 1. 确认/切换到目标书。「切换作品」打开的是【arco 抽屉 .book-switch-drawer】：每本书一行
    //    .book-switch-drawer-list-item(.book-select，标题在 .book-select-info-title)，行内 radio 选中，
    //    【必须】再点抽屉底部 .book-switch-drawer-footer 的「确定」(.arco-btn-primary) 才真正切过去
    //    ——旧代码只点了标题文字节点、没选 radio 也没点确定(“没点击选择”)，故切不过去。
    //    书名匹配要【去标点/空白归一化】：番茄显示的标题常与本地略有出入(如“国术：每日清算从不讲武德到武圣”少个逗号)。
    const NORMJS = `function __nm(s){return (s||'').replace(/[\\s，,。：:！!？?、·—\\-]/g,'');}`;
    const READ_SHOWN = `(function(){var t=[].slice.call(document.querySelectorAll('[class*=book-title],[class*=title]')).find(function(e){var s=(e.textContent||'').trim();return e.offsetParent!==null&&s.length>=3&&s.length<40&&!/多书名|多封面|封面推荐|实验/.test(s)&&!e.closest('[class*=drawer]');});return t?(t.textContent||'').trim():'';})()`;
    const norm = (s) => String(s || '').replace(/[\s，,。：:！!？?、·—\-]/g, '');
    const matches = (shown) => { const a = norm(shown), b = norm(bookTitle); return !!(a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)); };
    let shown = await client.evaluate(READ_SHOWN);
    if (bookTitle && !matches(shown)) {
      let inList = true;
      for (let attempt = 0; attempt < 2 && !matches(shown); attempt++) {
        log(`当前是《${shown || '?'}》，切换到《${bookTitle}》…`);
        await clickText('切换作品');
        await client.sleep(2000);
        // 在抽屉里【点目标书那一行】(归一化匹配标题)选中它
        const picked = await client.evaluate(`(function(){${NORMJS}var name=__nm(${Q(bookTitle)});var items=[].slice.call(document.querySelectorAll('.book-switch-drawer-list-item,.book-select')).filter(function(e){return e.offsetParent!==null;});var row=items.find(function(it){var t=it.querySelector('.book-select-info-title');return t&&__nm(t.textContent).indexOf(name)>=0;})||items.find(function(it){return __nm(it.textContent).indexOf(name)>=0;});if(!row)return false;try{row.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){row.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
        if (!picked) { inList = false; break; }        // 列表里根本没这本书 → 不在可选范围，别再试
        await client.sleep(800);
        // 点抽屉底部「确定」确认切换（这一步旧代码漏了）
        await client.evaluate(`(function(){var f=document.querySelector('.book-switch-drawer-footer,.arco-drawer-footer');var btn=f&&(f.querySelector('.arco-btn-primary')||[].slice.call(f.querySelectorAll('button')).find(function(b){return /确定|确认|切换/.test(b.textContent||'');}));if(!btn)return false;try{btn.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){btn.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
        await client.sleep(2800);
        shown = await client.evaluate(READ_SHOWN);
      }
      if (!matches(shown)) {
        const why = inList
          ? `切到《${bookTitle}》没成功（当前仍是《${shown || '?'}》）——已点选该书并确认，但页面没切过去，可能番茄抽屉改版/网络延迟，请重试或人工在「切换作品」里选它。`
          : `《${bookTitle}》不在番茄「切换作品」列表里——多书名实验要求 20万字+/已签约/未完结，该书可能不满足。`;
        log(why, 'warn');
        return {
          ok: true, semiManual: true, opened: true, switched: false,
          msg: `${why}\n候选书名（够条件后可手动配）：\n` +
            items.map((x, i) => `${i + 1}. ${x.title}${x.coverPath ? '  ← ' + x.coverPath : ''}`).join('\n'),
        };
      }
      log(`已切到《${shown}》`, 'act');
    }
    const bookLabel = shown || bookTitle || '';

    // 2. 找【配置实验】按钮（某个字数里程碑实验处于「待实验」时才有；已跑过/失效则无）。点开右侧「配置实验」抽屉。
    const hasCfgBtn = await client.evaluate(`[].slice.call(document.querySelectorAll('button,[class*=btn]')).some(function(e){return (e.textContent||'').trim()==='配置实验'&&e.offsetParent!==null&&!(e.disabled||/disabled/.test(e.className));})`);
    if (!hasCfgBtn) {
      const state = await client.evaluate(`(function(){var t=document.body.innerText;if(/最优书名生效/.test(t))return '该书里程碑实验已结束（最优书名已生效），不能再配置';if(/实验中|进行中/.test(t))return '该书实验进行中，暂不能改配置';if(/不符合字数|已失效|未达/.test(t))return '未达字数里程碑（20万字/100万字实验尚未解锁「配置实验」）';return '未找到「配置实验」按钮（番茄可能改版，或该书暂不可配）';})()`);
      log('番茄未开放「配置实验」：' + state, 'warn');
      return {
        ok: true, semiManual: true, opened: true, switched: true,
        msg: `已在番茄打开《${bookLabel}》的多书名实验页。${state}。\n候选书名（够条件后可在「配置实验」里逐个添加，封面用下方路径）：\n` +
          items.map((x, i) => `${i + 1}. ${x.title}${x.coverPath ? '  ← ' + x.coverPath : ''}`).join('\n'),
      };
    }
    log('打开「配置实验」…');
    await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button,[class*=btn]')).find(function(e){return (e.textContent||'').trim()==='配置实验'&&e.offsetParent!==null&&!(e.disabled||/disabled/.test(e.className));});if(b)['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){b.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return !!b;})()`);
    let drawerOpen = false;
    for (let i = 0; i < 8; i++) { if (await client.evaluate("!!document.querySelector('input[placeholder*=书名]')")) { drawerOpen = true; break; } await client.sleep(700); }
    if (!drawerOpen) return { ok: false, error: '点了「配置实验」但配置抽屉没打开（番茄改版/加载慢），请重试' };

    // 3. 逐个候选：确保有第 i 个【实验组】(.ne-config-item，不含 -adder) → 填书名(≤15字) → 点该组封面框传封面。
    //    实验组封面框点开的是【与换封面同一个全屏遮罩】(AI封面/本地上传 tab)，故复用 injectTrustedCover+confirmCoverOverlay。
    const GROUPS_JS = `[].slice.call(document.querySelectorAll('.ne-config-item')).filter(function(g){return !/adder/.test(g.className)&&g.querySelector('input');})`;
    log(`开始配置 ${items.length} 个实验书名（含封面）…`, 'act');
    let done = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const title = String(it.title).slice(0, 15);
      log(`(${i + 1}/${items.length}) 实验组${i + 1}：《${title}》…`);
      // 3a. 确保第 i 组存在：不够就点「添加实验组」(.ne-config-item-adder)
      const gc = await client.evaluate(`(${GROUPS_JS}).length`);
      if (i >= gc) {
        await client.evaluate(`(function(){var a=document.querySelector('.ne-config-item-adder');if(!a)return false;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){a.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
        await client.sleep(1000);
      }
      // 3b. 填第 i 组书名（原生 setter 触发 React 状态）
      const nameOk = await client.evaluate(`(function(){${SETTER} var g=(${GROUPS_JS})[${i}];if(!g)return false;var inp=g.querySelector('input');if(!inp)return false;inp.focus();__sv(inp,${Q(title)});return true;})()`);
      if (!nameOk) { log(`《${title}》没找到第${i + 1}组书名输入框`, 'warn'); continue; }
      await client.sleep(500);
      // 3c. 传第 i 组封面：点该组封面框 → 遮罩 → 本地上传 → 可信注入 → 两步确认
      if (it.coverPath) {
        const opened = await client.evaluate(`(function(){var g=(${GROUPS_JS})[${i}];if(!g)return false;var box=g.querySelector('.ne-config-item-body-cover-add')||g.querySelector('.ne-config-item-body-cover')||g.querySelector('[class*=cover]');if(!box)return false;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){box.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
        if (opened) {
          await client.sleep(1500);
          // 切到「本地上传」tab
          await client.evaluate(`(function(){var t=[].slice.call(document.querySelectorAll('*')).find(function(e){return (e.textContent||'').trim()==='本地上传'&&e.offsetParent!==null&&e.children.length===0;});if(t)['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(x){t.dispatchEvent(new MouseEvent(x,{bubbles:true,cancelable:true,view:window}));});return !!t;})()`);
          await client.sleep(1000);
          let hasInput = false;
          for (let k = 0; k < 8; k++) { if (await client.evaluate("document.querySelectorAll('input[type=file]').length>0")) { hasInput = true; break; } await client.sleep(700); }
          if (hasInput) {
            const { ok: injOk, rmTmp } = await injectTrustedCover(client, it.coverPath);
            const { accepted, closed } = await confirmCoverOverlay(client);
            await rmTmp();
            if (injOk && accepted && closed) log(`《${title}》封面已传`);
            else log(`《${title}》封面未完成(注入${injOk}/接受${accepted}/关闭${closed})`, 'warn');
          } else { log(`《${title}》没出现封面文件框`, 'warn'); }
        } else { log(`《${title}》没找到第${i + 1}组封面入口`, 'warn'); }
      }
      done++;
    }
    log(`已填入 ${done}/${items.length} 个实验书名`, 'act');

    if (!autoSubmit) {
      return { ok: true, semiManual: true, submitted: false, filled: done, msg: `已把 ${done} 个候选书名${items.some(x => x.coverPath) ? '+封面' : ''}填入番茄《${bookLabel}》的「配置实验」抽屉（待提交）。请到浏览器核对无误后点「提交」保存（开启实验·不可逆）。` };
    }
    // 4. 提交（抽屉底部主按钮「提交」·不可逆）
    log('提交实验配置…');
    await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('.arco-drawer-footer button,[class*=footer] button,.arco-btn-primary')).find(function(e){return e.offsetParent!==null&&(e.textContent||'').trim()==='提交'&&!(e.disabled||/disabled/.test(e.className));});if(!b)return false;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){b.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
    await client.sleep(2800);
    const okToast = await client.evaluate("/成功|已提交|已开启/.test((document.querySelector('.arco-message,[class*=message]')||{}).textContent||'')");
    return { ok: true, submitted: true, filled: done, msg: okToast ? '✅ 多书名实验已提交（等番茄跑 A/B）' : '已点「提交」，请到浏览器确认结果' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export { UnzooClient, FanqiePublisher, maxChapterNumInText };
