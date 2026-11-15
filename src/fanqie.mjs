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

import fs from 'node:fs';
import path from 'node:path';
import {
  mcpCall, UNZOO_TIMEOUT_MS,
  clickAt, inputText, uploadTrusted, handleDialog, launchProfile, waitFor,
} from './unzoo.mjs';
import { alignScheduleStart } from './signdiag.mjs';

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
  // siteUrl：该站点的【后台首页】。账号窗口一个标签页都没有时，直接开这个地址把窗口拉起来
  // ——见 openSiteTab。不传就退回 https://{siteHost}/。
  constructor(profilePath = null, onLog = null, siteHost = '', siteLabel = '', siteUrl = '') {
    this.tabId = null;
    this.selectedProfilePath = profilePath || null;
    this.onLog = onLog || (() => {});
    this.siteHost = siteHost || 'fanqienovel.com';
    this.siteLabel = siteLabel || '番茄';
    this.siteUrl = siteUrl || (siteHost ? `https://${siteHost}/` : 'https://fanqienovel.com/main/writer/book-manage');
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

  // 账号窗口一个标签页都没有时的兜底：【直接开该站点的后台地址】。
  //
  // 由来（2026-09-23 作者提）：选书籍那一步，番茄没开着就只剩 profile_launch 一条路，
  // 而 profile_launch 偶发 "failed to load profile" —— 一失败整条链就断在
  // 「请手动打开该账号浏览器」，作者得自己去开窗口、自己敲网址。
  // tab_create 能直接在指定 profile 下开一个标签页并导航，比先拉窗口再找页可靠得多。
  //
  // ⚠️ 安全同 recoverTab：建完【必须验证它落在选中账号下】，落错了立刻关掉并失败。
  // 宁可这一步失败，也绝不拿别的账号的标签页顶上去（发错号是不可逆的）。
  async openSiteTab() {
    if (!this.selectedProfilePath) return false;
    try {
      // profile_id 用的是 profile 的【名字】而不是路径，且名字与路径不是简单规则
      //（"工作" 对应的目录是 Default），所以查表按路径末段匹配，别去猜。
      // 分隔符必须是 [\\/]：Windows 路径是反斜杠，只按 / 切就切不出末段（曾写成 [\/]，等于整串比）。
      const want = String(this.selectedProfilePath).split(/[\\/]/).filter(Boolean).pop().toLowerCase();
      const pl = await unzooCallTool('profile_list', {});
      const rows = pl?.profiles || (Array.isArray(pl) ? pl : []);
      const row = rows.find(x => String(x.path || x.profile_path || '').split(/[\\/]/).filter(Boolean).pop().toLowerCase() === want);
      const pid = row?.name || row?.id;
      if (!pid) { this.addLog(`⚠️ profile 列表里找不到该账号（${want}），无法自动开${this.siteLabel}后台`, 'error'); return false; }

      this.addLog(`${this.siteLabel}没有开着 → 直接打开后台：${this.siteUrl}`, 'act');
      const created = await unzooCallTool('tab_create', { profile_id: pid, url: this.siteUrl });
      const id = created?.tab_id ?? created?.id;
      if (!id) { this.addLog('⚠️ tab_create 没返回 tab_id', 'error'); return false; }

      // 验证落点：必须在选中账号下，否则关掉
      await this.sleep(1200);
      const norm = (x) => String(x || '').replace(/[\\/]+$/, '').toLowerCase();
      const list = await unzooCallTool('tab_list', {}).catch(() => null);
      const t = (list?.tabs || []).find(x => String(x.tab_id) === String(id));
      const same = t && (norm(t.profile_path) === norm(this.selectedProfilePath)
        || String(t.profile_path || '').split(/[\\/]/).filter(Boolean).pop().toLowerCase() === want);
      if (!same) {
        try { await unzooCallTool('tab_close', { tab_id: id }); } catch {}
        this.addLog('⚠️ 新开的标签页落到了别的账号下，已关掉并中止（绝不发错号）', 'error');
        return false;
      }
      this.tabId = String(id);
      this.addLog(`✅ 已打开${this.siteLabel}后台`, 'info');
      return true;
    } catch (e) {
      this.addLog(`直接打开${this.siteLabel}后台失败：` + (e.message || e), 'error');
      return false;
    }
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
      // profile_launch 这条路偶发 "failed to load profile"，一失败整条链就断在
      // 「请手动打开浏览器」。再兜一层：【直接开该站点后台地址】——tab_create 能指定 profile，
      // 比先拉窗口再等它自己出页可靠。
      if (union.size === 0 && await this.openSiteTab()) {
        for (let attempt = 0; attempt < 10 && union.size === 0; attempt++) {
          await this.sleep(1200);
          data = await unzooCallTool('tab_list', {}); tabs = data?.tabs || [];
          for (const [k, v] of collect()) union.set(k, v);
        }
      }
      let inProfile = [...union.values()];
      if (inProfile.length === 0) {
        this.addLog(`⚠️ 仍未读到该账号标签页（Unzoo 异常），请手动打开该账号浏览器并登录${this.siteLabel}后重试`, 'error');
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
      if (this.tabId) {
        try { await unzooCallTool('tab_activate', { tab_id: String(this.tabId) }); } catch {}
      }
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
      // Unzoo 遇到 beforeunload/alert 不会超时，而是直接报「A '…' dialog is blocking the page」。
      // 原来只认「超时」，这种报错一律原样抛出 → 后面每一步都卡死在同一个弹窗上
      // （2026-10-02 国术第 7 章：保存没被接受，离开编辑页弹出"未保存，确定离开？"，整批停住）。
      if (/dialog is blocking|beforeunload|browser_handle_dialog/i.test(e.message || '')) {
        const dismissed = await dismissDialog(this.tabId);
        if (dismissed) this.addLog('检测到阻塞弹窗（离开页面确认等）并已关闭，重试…', 'warn');
        const result = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: script });
        return result?.result;
      }
      // 超时多半是页面弹了阻塞 alert（eval 被卡住）→ 关掉弹窗后重试一次
      if (/超时/.test(e.message || '')) {
        const dismissed = await dismissDialog(this.tabId);
        if (dismissed) this.addLog('检测到阻塞弹窗并已关闭，重试…', 'warn');
        try {
          const result = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: script });
          return result?.result;
        } catch (e2) {
          if (!/超时/.test(e2.message || '')) throw e2;
          // 弹窗不是原因——是【整个标签页卡死了】。实测（2026-09-14）：277 章那批重发在第54章把 tab 卡住，
          // 之后连只读的 location.href 都 45s 超时；批次当场暂停，干等了 14 小时才被发现，
          // 第二天原样续发 4 分钟内又栽在同一个卡死的 tab 上（0/225）。
          // 一个标签页卡死不该报废整批 → 关掉重建、回到原页面、再试一次。
          this.addLog('标签页整个卡死（连只读 evaluate 都超时）→ 关掉重建后重试…', 'warn');
          await this.recoverTab(this.lastUrl);
          const result = await unzooCallTool('browser_evaluate', { tab_id: this.tabId, expression: script });
          return result?.result;
        }
      }
      throw e;
    }
  }

  // 标签页卡死后的恢复：关掉 → 优先复用本账号其它标签页 → 都没有才新建 → 回到原页面。
  // ⚠️【新建必须验证归属】选中账号时绝不能把稿子发到别的 profile 去（navigate 里那条安全规则同理）：
  // 万一新标签页落在别的账号下，立刻关掉并中止，宁可这批停下，也不能发错号。
  // _call 默认就是 unzooCallTool；留这个口子只为可测——测试注入它就能测到【真方法】，
  // 而不是在测试里抄一份逻辑（抄一份只会测出"我抄得对不对"）。
  get _call() { return this.__call || unzooCallTool; }
  set _call(fn) { this.__call = fn; }
  async recoverTab(url) {
    const old = this.tabId;
    try { await this._call('tab_close', { tab_id: old }); } catch {}
    await this.sleep(1200);
    this.tabId = null;
    try { await this.getActiveTab(); } catch {}
    if (!this.tabId) {
      const created = await this._call('tab_create', { url: url || 'https://fanqienovel.com/main/writer/book-manage' });
      const id = created?.tab_id ? String(created.tab_id) : null;
      if (!id) throw new Error('标签页卡死后重建失败（tab_create 没返回 tab_id）');
      if (this.selectedProfilePath) {
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
        const list = await this._call('tab_list', { scope: 'all' }).catch(() => null);
        const row = (list?.tabs || []).find(t => String(t.tab_id) === id);
        if (!row || norm(row.profile_path) !== norm(this.selectedProfilePath)) {
          try { await this._call('tab_close', { tab_id: id }); } catch {}
          throw new Error('标签页卡死后重建到了别的账号下，已关掉并中止（绝不发错号）');
        }
      }
      this.tabId = id;
    }
    try { await this._call('tab_activate', { tab_id: String(this.tabId) }); } catch {}
    if (url) { try { await this._call('browser_navigate', { tab_id: this.tabId, url }); } catch {} }
    await this.sleep(2500);
    this.addLog(`标签页已重建（${old} → ${this.tabId}）`, 'warn');
    return this.tabId;
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
  // 实测(2.5.28)：坐标是【视口坐标】(文档写 "screen coordinates" 是错的)，命中精确、isTrusted=true。
  // ⚠️必须先保证浏览器窗口在前台，否则【静默无操作】(返回 null 不报错)。
  async coordClick(x, y) {
    await this.ensureTabId();
    await this.ensureForeground();
    await this.humanDelay(20, 60);
    await clickAt(this.tabId, x, y);
    await this.humanDelay(40, 100);
  }

  // 按【可见文字】做可信点击。这是点番茄按钮的正路。
  // 2026-09-20：Unzoo 把 CDP shim 用 managed_mode 关掉了（`fetch failed`），于是所有走 cdpClick 的地方
  // ——改封面的「立即修改」、创建新书的「立即创建」——全都点不动了。官方 MCP 的 human_click 是真实输入事件
  // （bezier 移动 + click_human），番茄认；它还自带遮挡检测，比我们自己算坐标稳。
  // 顺序：human_click → CDP 坐标点（老环境还开着 shim 时）→ 合成指针序列（最后兜底，某些按钮认）。
  async trustedClickText(text, { index = 0, exact = true } = {}) {
    await this.ensureTabId();
    try {
      const r = await unzooCallTool('human_click', { tab_id: String(this.tabId), text, exact, index });
      const s = JSON.stringify(r || {});
      if (r && r.success !== false && r.ok !== false && !/not_found|no_match|未找到|找不到/i.test(s)) return true;
    } catch {}
    const Q = (s) => JSON.stringify(s);
    const coord = await this.evaluate(`(function(){var l=[].slice.call(document.querySelectorAll('button')).filter(function(e){return (e.textContent||'').trim()===${Q(text)}&&e.offsetParent!==null;});var b=l[${index}]||l[0];if(!b)return '';try{b.scrollIntoView({block:'center'});}catch(e){}var r=b.getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()`);
    if (coord) {
      try { const [x, y] = String(coord).split(',').map(Number); await this.cdpClick(x, y); return true; } catch {}
    }
    return !!(await this.evaluate(`(function(){var all=[].slice.call(document.querySelectorAll('button,div[role=button],span,a')).filter(function(e){return (e.textContent||'').trim()===${Q(text)}&&e.offsetParent!==null;});var btns=all.filter(function(e){return e.tagName==='BUTTON'||e.getAttribute('role')==='button';});var els=btns.length?btns:all;var el=els[${index}]||els[els.length-1];if(!el)return false;try{el.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`));
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
    // ⚠️别再写"到 Unzoo 设置里开启 CDP"——没有这个设置项（/api/v1/settings/service 返回的键里
    // 根本没有 managed_mode，UI 也没开关）。shim 未废弃，但被 managed_mode 门控
    // （unzoo#98：9222 无认证，可绕过 auth/lease/审计），唯一开关是环境变量。
    } catch (e) { throw new Error(`CDP shim 不可用(${e.message})。它被 Unzoo 的 managed_mode 门控，需以 UNZOO_MANAGED_MODE=0 启动 Unzoo 才会监听 ws://127.0.0.1:${port}（注意：这会绕过 auth/lease/审计）。本项目正在迁离 CDP shim，优先改用官方 MCP 工具。`); }
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
  static UNTHROTTLE_JS = `
    if (!window.__rafPatched) {
      window.__rafPatched = true;
      var origST = window.setTimeout.bind(window), origCT = window.clearTimeout.bind(window);
      var q = window.__fqTimers = [], seq = 1;
      var ch = new MessageChannel();
      var flush = window.__flushTimers = function(){
        var now = Date.now(), list = q.slice();
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item.done && now >= item.due) {
            item.done = true;
            try { origCT(item.nid); } catch (e) {}
            try { item.cb(); } catch (e) {}
          }
        }
        for (var j = q.length - 1; j >= 0; j--) { if (q[j].done) q.splice(j, 1); }
      };
      ch.port1.onmessage = flush;
      window.setTimeout = function(cb, ms) {
        if (typeof cb !== 'function') return origST(cb, ms);
        var args = Array.prototype.slice.call(arguments, 2);
        var delay = Number(ms) || 0;
        var item = { id: ++seq, due: Date.now() + delay, done: false, cb: function(){ cb.apply(window, args); }, nid: 0 };
        item.nid = origST(function(){ if (!item.done) { item.done = true; try { item.cb(); } catch (e) {} } }, delay);
        q.push(item);
        if (delay <= 50) { try { ch.port2.postMessage(0); } catch (e) {} }
        return item.nid;
      };
      window.clearTimeout = function(id) {
        for (var i = 0; i < q.length; i++) { if (q[i].nid === id || q[i].id === id) q[i].done = true; }
        return origCT(id);
      };
      window.requestAnimationFrame = function(cb) {
        return window.setTimeout(function(){ cb(performance.now()); }, 0);
      };
      window.cancelAnimationFrame = function(id) { window.clearTimeout(id); };
    }
    if (window.__flushTimers) { try { window.__flushTimers(); } catch (e) {} }
  `;

  async clickByLocator(locatorBody) {
    await this.ensureTabId();
    const expr = `(function(){
      ${UnzooClient.UNTHROTTLE_JS}
      const __find = function(){ ${locatorBody} };
      const el = __find();
      if (!el || typeof el.click !== 'function') return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      el.click();
      if (window.__flushTimers) { try { setTimeout(window.__flushTimers, 0); } catch (e) {} }
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
  async trustedType(selector, text, { delayMs = 6, clearFirst = false, force = true, timeoutMs = 180000 } = {}) {
    await this.ensureTabId();
    return await unzooCallTool('browser_type', {
      tab_id: String(this.tabId), selector, text: String(text),
      delay_ms: delayMs, clear_first: !!clearFirst, force: !!force, timeout: 8000,
    }, timeoutMs);
  }

  // 真实按键（browser_press_key，支持修饰键，isTrusted=true）。
  // ⚠️OS 级输入：浏览器窗口不在前台时【静默无操作】，故先 ensureForeground。
  async pressKey(key, modifiers) {
    await this.ensureTabId();
    await this.ensureForeground();
    await unzooCallTool('browser_press_key', { tab_id: Number(this.tabId), key, modifiers: modifiers || [] });
  }

  // 服务端等待某选择器出现（网关自己轮询，一次往返顶原来 20 次）。返回 true=出现。
  // 只适合【纯选择器/纯文本】这类简单条件；复合条件（数据行 或 空态 或 登录失效）
  // 仍要自己轮询同步表达式，见 FanqiePublisher.waitChapterRows。
  async waitForSelector(selector, { timeoutMs = 10000, state = 'attached' } = {}) {
    await this.ensureTabId();
    return waitFor(this.tabId, { selector, state, timeoutMs });
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
      // 聚焦（纯后台安全：只用 Range selectNodeContents + execCommand 全选删除，绝不触发前台按键）
      await this.evaluate(`(function(){const ed=document.querySelector(${sel});if(ed){ed.focus();const r=document.createRange();r.selectNodeContents(ed);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('selectAll',false,null);document.execCommand('delete',false,null);}return true;})()`);
      await this.humanDelay(100, 200);
    }
    return await isEmpty();
  }

  // 聚焦元素：纯后台 JS focus（绝不调 coordClick/ensureForeground 抢夺用户前台窗口）
  async focusElement(selector) {
    await this.ensureTabId();
    const sel = JSON.stringify(selector);
    await this.evaluate(`(function(){
      const el = document.querySelector(${sel});
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      if (el.focus) el.focus();
      return true;
    })()`);
    await this.humanDelay(60, 120);
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
        ${UnzooClient.UNTHROTTLE_JS}
        document.querySelectorAll('[class*="exit"], [class*="leave"]').forEach(function(el){
          try {
            el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
            el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
          } catch (e) {}
        });
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
        if (el._valueTracker) el._valueTracker.setValue('__force_diff__');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${val}, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
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

    // 2) 模拟粘贴（保留段落格式；先全选确保即使有残留也会被原子替换）
    await this.evaluate(`
      (function() {
        const ed = document.querySelector(${sel});
        if (!ed) return false;
        ed.focus();
        try {
          const r = document.createRange();
          r.selectNodeContents(ed);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        } catch (e) {}
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
      // 使用 browser_input_text (typeText) 走 Chromium IME 管线在末尾补一个空格，绝不调 human_type 的 fallback_set 破坏段落
      await this.evaluate(`(function(){const ed=document.querySelector(${sel});if(!ed)return;ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false,' ');})()`);
      await this.typeText(' ').catch(() => {});
      await this.humanDelay(150, 250);
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
    this._fgTab = String(tabId);
    this._fgAt = Date.now();
  }

  // 保持后台静默运行，不再调用 tab_activate 把浏览器窗口抢到前台
  async ensureForeground() {
    return;
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
      this.lastUrl = url;   // 记住落脚页：标签页卡死重建后要回到这里（见 recoverTab）
    } else {
      // 安全第一：选中了账号却没找到其标签页 → 绝不在"当前/其他 profile"乱建标签页(可能发错号)，直接报错。
      if (this.selectedProfilePath) {
        throw new Error('未找到该账号的番茄标签页（tab_list 暂时读不到）。请确认该 Unzoo 账号窗口已打开并登录番茄作者后台，然后重试。');
      }
      // 仅在未指定账号的兼容场景下才新建标签页
      const profileData = await unzooCallTool('profile_get_current', {});
      const profileId = profileData?.profile_id || 'default';
      const newTab = await unzooCallTool('tab_create', { profile_id: profileId, url: url });
      if (newTab?.tab_id) { this.tabId = String(newTab.tab_id); this.lastUrl = url; }
    }
    // 导航后等待页面加载（不再事后重选标签页——保持锁定，避免来回切）
    await this.sleep(1500);
    try {
      await unzooCallTool('browser_evaluate', {
        tab_id: this.tabId,
        expression: `(function(){${UnzooClient.UNTHROTTLE_JS};return 1;})()`,
      });
    } catch {}
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
// 章节表「翻页后到底算不算渲染完」的判据（纯函数，便于单测）。
//   state  : 从页面读回的 { currentPage, sig, hasRows, empty }
//   prevPage/prevSig: 翻页【之前】那一页的页码与行签名（首次加载传 null）
// ⚠️两个条件缺一不可：页码变了 + 行内容(sig)真的换了。只看页码会读到上一页的残留行——
// 实测番茄点"下一页"后页码立即变、表格数据 400~800ms 后才换，这段窗口里 hasRows 一直为真。
export function chapterRowsReady(state, { prevPage = null, prevSig = null } = {}) {
  if (!state) return false;
  const paged = prevPage == null || state.currentPage !== prevPage;
  const swapped = prevSig == null || state.sig !== prevSig;
  return !!(paged && swapped && (state.hasRows || state.empty));
}

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
      this.log(`预约发布模式，从 ${this.formatDate(this.currentScheduleDay)} 开始${config.initialDailyCount ? `（当日已排 ${config.initialDailyCount} 章）` : ''}`);
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      this.currentScheduleDay = tomorrow;
      this.log('当天立即发布模式');
    }
    this.chaptersPublishedToday = Number(config.initialDailyCount) || 0;

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

  // 章节表【行内容】的指纹：条数 + 前三个章号。翻页判据必须用它，不能只看页码——见 waitChapterRows。
  static ROW_SIG_JS = `(function(){
    var tt = document.body ? document.body.innerText : '';
    var g = /第\\s*(\\d+)\\s*章(?![0-9])/g, mm, ns = [];
    while ((mm = g.exec(tt)) !== null) ns.push(mm[1]);
    return ns.length + ':' + ns.slice(0, 3).join(',');
  })()`;

  // 等章节表【真正渲染出数据行】再读——番茄后台是 SPA，异步渲染。
  // 原来靠固定 sleep(1500)，表格没渲染完就 evaluate → 读成"没有这一章"(假 notFound) → 连续3次就停。
  // 与 getFanqieMaxChapter 的读取路径同一套硬化：轮询到【确定结果】(有真数据行 / 明确空态 / 硬失败)才停。
  // prevPage 非空时还要求页码已经翻过去；prevSig 非空时还要求【行内容真的换了】。
  // ⚠️【只看页码是不够的】——实测番茄点"下一页"后页码立刻变、表格数据 400~800ms 后才换，
  // 这段窗口里 hasRows 一直为真（旧行还在），于是判成"已翻页渲染完"→ 读的是上一页的 15 行。
  // 后果：整轮遍历错位一页，【最后一页的章永远找不到】→ 连续3次 notFound → 编辑模式停。
  // 《重生美利坚》第1章在第5页（列表按章号倒序），就是这样"找不到章节"的。
  async waitChapterRows({ prevPage = null, prevSig = null, maxMs = 15000 } = {}) {
    const probe = `
      (function(){
        ${UnzooClient.UNTHROTTLE_JS}
        var text = document.body ? document.body.innerText : '';
        var hasRows = /第\\s*\\d+\\s*章/.test(text);
        var hasArco = !!document.querySelector('[class*="arco-"]');
        var empty = hasArco && (text.indexOf('暂无') >= 0 || text.indexOf('还没有') >= 0 || text.indexOf('快去创作') >= 0);
        var active = document.querySelector('.arco-pagination-item-active');
        var currentPage = active ? (parseInt(active.textContent) || 1) : 1;
        var login = /\\/login|passport/.test(location.href) || text.indexOf('扫码登录') >= 0;
        var err = ['ERR_', 'net::', '未连接到互联网', '代理服务器', '无法访问此网站'].some(function(s){ return text.indexOf(s) >= 0; });
        var sig = ${FanqiePublisher.ROW_SIG_JS};
        return { hasRows: hasRows, empty: empty, currentPage: currentPage, sig: sig, login: login, err: err };
      })()
    `;
    const deadline = Date.now() + maxMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.client.evaluate(probe);
      if (last) {
        if (last.login || last.err) return { ...last, ready: false, fatal: true };
        if (chapterRowsReady(last, { prevPage, prevSig })) return { ...last, ready: true };
      }
      await this.client.sleep(400);
    }
    return { ...(last || {}), ready: false };
  }

  // 章节管理页：切到第 volIndex 卷的章节列表（番茄一次只显示一个卷）。返回 true=已渲染出内容。
  async gotoVolumePage(volIndex) {
    const bookId = this.config?.bookId;
    if (!bookId || !volIndex) return false;
    const vols = Array.isArray(this.config?.fanqieVolumes) ? this.config.fanqieVolumes : [];
    const wantName = vols[volIndex - 1] || '';

    const onList = await this.client.pageContains(['章节管理', '新建章节']);
    if (!onList) {
      await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&${volIndex}`);
      await this.waitChapterRows({ maxMs: 15000 });
    }

    if (wantName) {
      const VOL_DROPDOWN = `
        const sels=[...document.querySelectorAll('.chapter-select .serial-select, .serial-select, [class*="volume-select"]')];
        for(const s of sels){ const vv=s.querySelector('.byte-select-view-value')||s; if(((vv.textContent||'').indexOf('卷'))>=0) return s; }
        return sels[0]||null;
      `;
      const getCurVol = async () => {
        const r = await this.client.evaluate(`(function(){
          if (!window.__rafPatched) {
            window.__rafPatched = true;
            window.requestAnimationFrame = function(cb) { return setTimeout(function(){ cb(performance.now()); }, 16); };
            window.cancelAnimationFrame = function(id) { clearTimeout(id); };
          }
          const sel = (function(){ ${VOL_DROPDOWN} })();
          if (!sel) return '';
          const vv = sel.querySelector('.byte-select-view-value') || sel;
          return (vv.textContent || '').trim();
        })()`);
        return String(r || '').trim();
      };
      const curName = await getCurVol();
      if (curName === wantName) {
        this.currentVolPage = volIndex;
        const st = await this.waitChapterRows({ maxMs: 15000 });
        return !!st.ready;
      }
      const before = await this.waitChapterRows({ maxMs: 8000 });
      const prevSig = before?.sig || null;
      const clickOpt = async () => await this.client.clickByLocator(`
        const want = ${JSON.stringify(wantName)};
        const opts = document.querySelectorAll('.byte-select-option, .arco-select-option, [class*="select-option"]');
        for (const o of opts) { if (o.offsetParent !== null && ((o.textContent || '').trim()) === want) return o; }
        return null;
      `);
      let clicked = await clickOpt();
      if (!clicked) {
        await this.client.clickByLocator(VOL_DROPDOWN);
        await this.client.sleep(600);
        clicked = await clickOpt();
      }
      if (clicked) {
        const st = await this.waitChapterRows({ prevSig, maxMs: 15000 });
        this.currentVolPage = volIndex;
        return !!st.ready;
      }
    }

    await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&${volIndex}`);
    const st = await this.waitChapterRows({ maxMs: 15000 });
    this.currentVolPage = volIndex;
    return !!st.ready;
  }

  // 在【当前卷】的章节列表里逐页找目标章。
  // 翻页判据改用"下一页按钮是否可用"，不再靠 totalPages —— arco 分页出省略号(1 2 3 … 20)时
  // 从可见页码取 max 会把总页数算漏，导致"遍历N页后未找到"。
  // 读当前页的分页与章号概况：当前页码、可点的页码、本页首末章号、本页条数、行签名。
  async readPageInfo() {
    return this.client.evaluate(`(function(){
      var nums = [];
      document.querySelectorAll('tr').forEach(function(r){
        var m = ((r.innerText || '').trim()).match(/^第(\\d+)章/);
        if (m) nums.push(parseInt(m[1], 10));
      });
      var active = document.querySelector('.arco-pagination-item-active');
      var pages = [].slice.call(document.querySelectorAll('.arco-pagination-item'))
        .map(function(x){ return parseInt((x.textContent || '').trim(), 10); })
        .filter(function(n){ return n > 0; });
      return {
        page: active ? (parseInt(active.textContent, 10) || 1) : 1,
        pages: pages, maxPage: pages.length ? Math.max.apply(null, pages) : 1,
        first: nums.length ? nums[0] : 0, last: nums.length ? nums[nums.length - 1] : 0, count: nums.length,
        sig: ${FanqiePublisher.ROW_SIG_JS},
      };
    })()`);
  }

  // 点一个可见页码，等到行真的换了。
  async clickPageNumber(n, info) {
    const clicked = await this.client.clickByLocator(`
      const items = document.querySelectorAll('.arco-pagination-item');
      for (const item of items) { if ((item.textContent || '').trim() === ${JSON.stringify(String(n))}) return item; }
      return null;
    `);
    if (!clicked) return { ok: false };
    const after = await this.waitChapterRows({ prevPage: info?.page, prevSig: info?.sig || null, maxMs: 20000 });
    return { ok: !!after.ready, fatal: after.fatal, login: after.login };
  }

  // 算出第 N 章所在页并跳过去。返回 { found, page, tried, fatal }。
  // 只在【第 1 页】上算：此时首行就是本卷最新（新→旧）或最早（旧→新）的一章。
  async jumpToChapterPage(targetNum, checkPage) {
    let info = await this.readPageInfo();
    if (!info || !info.count) return { tried: false };
    if (info.page !== 1) {
      const back = await this.clickPageNumber(1, info);
      if (back.fatal) return { fatal: true, message: back.login ? '番茄需要登录' : '番茄页面加载失败' };
      info = await this.readPageInfo();
      if (!info || info.page !== 1 || !info.count) return { tried: false };
    }
    const per = info.count;
    if (per < 2) return { tried: false };
    const desc = info.first > info.last;
    const offset = desc ? info.first - targetNum : targetNum - info.first;
    if (offset < 0) return { tried: false };   // 目标章比本卷最新还新/比最早还早 → 不在本卷，交给逐页/跨卷逻辑
    const want = Math.floor(offset / per) + 1;
    if (want > info.maxPage) return { tried: true, page: want };

    const goTo = async (p) => {
      for (let hop = 0; hop < 15; hop++) {
        const cur = await this.readPageInfo();
        if (!cur) return false;
        if (cur.page === p) return true;
        const vis = cur.pages.filter(n => n !== cur.page);
        if (!vis.length) return false;
        // 目标可见就点它；不可见就点离它最近的那个可见页码（番茄分页只露出当前页附近几页 + 首尾）
        const pick = vis.includes(p) ? p : vis.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a));
        const r = await this.clickPageNumber(pick, cur);
        if (r.fatal) return null;
        if (!r.ok) return false;
      }
      return false;
    };

    for (const p of [want, want + 1, want - 1]) {
      if (p < 1 || p > info.maxPage) continue;
      const ok = await goTo(p);
      if (ok === null) return { fatal: true, message: '番茄页面加载失败' };
      if (!ok) break;
      const r = await this.client.evaluate(checkPage);
      if (r?.found) return { found: true, page: p, tried: true };
    }
    return { tried: true, page: want };
  }

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
        var sig = ${FanqiePublisher.ROW_SIG_JS};
        return { found: false, currentPage: currentPage, hasNext: hasNext, sig: sig };
      })()
    `;

    // 先等表格渲染完再判断（否则把"还没渲染"当成"没有这一章"）
    const st0 = await this.waitChapterRows({ maxMs: 15000 });
    if (st0.fatal) {
      return { success: false, fatal: true, message: st0.login ? '番茄需要登录' : '番茄页面加载失败(网络/代理错误页)' };
    }

    let r = await this.client.evaluate(checkPage);
    if (r?.found) { this.log(`✅ ${targetPattern} 在当前页`); return { success: true }; }

    // ⚡ 快路：直接算出目标页跳过去，不再从第 1 页一页页点"下一页"。
    // 由来（2026-10-02 国术重发 34 章）：每章都从第 1 页逐页翻，找第 1 章要翻到第 31 页，每章十七八秒。
    // 番茄章节列表每页条数固定、章号连续，按第 1 页首行章号 + 每页条数就能算出页码（新→旧或旧→新都行）。
    // 算错（中间缺号/改过号）也不怕：落点和前后各一页都看一眼，还没有才退回下面的逐页翻。
    try {
      const fast = await this.jumpToChapterPage(targetChapterNum, checkPage);
      if (fast?.found) { this.log(`✅ 直接跳到第 ${fast.page} 页找到 ${targetPattern}`); return { success: true }; }
      if (fast?.fatal) return { success: false, fatal: true, message: fast.message };
      if (fast?.tried) this.log(`快速定位没找到 ${targetPattern}（算的是第 ${fast.page} 页）→ 改为逐页查找`);
    } catch (e) { this.log(`快速定位异常（${e.message || e}）→ 改为逐页查找`); }
    r = await this.client.evaluate(checkPage);

    // 回到第 1 页再逐页找
    if ((r?.currentPage || 1) !== 1) {
      const prev = r.currentPage;
      this.log('先回到第1页...');
      const jumped = await this.client.clickByLocator(`
        const items = document.querySelectorAll('.arco-pagination-item');
        for (const item of items) { if ((item.textContent || '').trim() === '1') return item; }
        return null;
      `);
      // 20s 不是保守：实测番茄换页数据慢起来要十几秒，等不够就会误判"没这一章"。
      if (jumped) await this.waitChapterRows({ prevPage: prev, prevSig: r?.sig || null, maxMs: 20000 });
    }

    const HARD_MAX_PAGES = 300;   // 防御性上限，正常靠"下一页不可用"退出
    for (let page = 1; page <= HARD_MAX_PAGES; page++) {
      r = await this.client.evaluate(checkPage);
      if (r?.found) { this.log(`✅ 在第 ${r.currentPage || page} 页找到 ${targetPattern}`); return { success: true }; }
      if (!r?.hasNext) { this.log(`本卷共 ${r?.currentPage || page} 页，没有 ${targetPattern}`); break; }

      const prev = r.currentPage, prevSig = r.sig || null;
      const navClicked = await this.client.clickByLocator(`
        const next = document.querySelector('.arco-pagination-item-next');
        if (!next) return null;
        const cls = next.className || '';
        if (cls.indexOf('disabled') >= 0 || next.getAttribute('aria-disabled') === 'true') return null;
        return next;
      `);
      if (!navClicked) { this.log('⚠️ 无法翻到下一页'); break; }

      const after = await this.waitChapterRows({ prevPage: prev, prevSig, maxMs: 20000 });
      if (after.fatal) return { success: false, fatal: true, message: after.login ? '番茄需要登录' : '番茄页面加载失败' };
      // 等不到"行真的换了"就【停下报错】，绝不拿上一页的内容当这一页读——那正是漏掉末页章的老病根。
      if (!after.ready) { this.log('⚠️ 翻页后列表未换新（等 20s 仍是上一页的行），停止本卷查找'); break; }
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
    if (wantIdx) {
      await this.gotoVolumePage(wantIdx);
    }

    this.log(`查找 第${targetChapterNum}章…`);
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
          this._consecutiveSkips = 0;   // 成功一章就清零：零散缺号不该攒够 5 次误停
          this._chapterTries = 0;
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
          // 【一个章号缺失不该毁掉整批】本地有、番茄没有的章号是常态：
          // 《天皇》本地把 129《金流暗涌》改号成 089，而番茄上那一章还挂在第129章 → 番茄根本没有"第89章"。
          // 原来这里同一章刷新重试 3 次就 pause 整批，230 章的活在第 36 章上停住（2026-09-14 实录）。
          // 改成：同一章重试 2 次仍找不到 → 记下来、跳过、继续下一章。
          // 但"系统性找不到"必须照旧拦住——连着 5 个【不同的】章都找不到，多半是卷选错/页面不对，
          // 那时继续跑只会一路空转，直接停下让人来看。
          this._chapterTries = (this._chapterTries || 0) + 1;
          if (this._chapterTries < 2) {
            this.log(`⚠️ 未找到第 ${websiteChapterNum} 章，刷新页面重试…`);
            await this.client.evaluate(`location.reload()`);
            await this.client.sleep(3000);
          } else {
            this._chapterTries = 0;
            this.skipped = this.skipped || [];
            this.skipped.push(websiteChapterNum);
            this._consecutiveSkips = (this._consecutiveSkips || 0) + 1;
            this.log(`⏭ 番茄上没有第 ${websiteChapterNum} 章（本地有、线上无）→ 跳过，继续下一章`);
            if (this._consecutiveSkips >= 15) {
              this.log(`⚠️ 连着 15 个章都找不到，多半是卷选错或页面不对，停下来等人看`);
              this.pause('unknown_error', `连续 15 章在番茄上都找不到（最后一个是第 ${websiteChapterNum} 章），疑似卷/页面不对`);
              return;
            }
            this.currentIndex++;
          }
        } else if (result.saveRejected) {
          // 番茄明确没收这次保存（如标题与别的章重名）——同一章原样重试只会再被拒一次，
          // 还白白多弹几次"未保存，确定离开？"。记下来、跳过、最后汇总，让人去处理根因。
          this.rejected = this.rejected || [];
          this.rejected.push({ num: websiteChapterNum, reason: result.message || '' });
          this.log(`⏭ 第 ${websiteChapterNum} 章保存被番茄拒绝（${result.message || '原因未知'}）→ 跳过，继续下一章`);
          this.currentIndex++;
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
      const sk = (this.skipped || []);
      const rj = (this.rejected || []);
      this.log(`🎉 编辑完成！共编辑 ${this.chapters.length - sk.length - rj.length}/${this.chapters.length} 章`
        + (sk.length ? `；${sk.length} 章番茄上没有、已跳过：${sk.join('、')}` : '')
        + (rj.length ? `；${rj.length} 章保存被番茄拒绝、需人工处理：${rj.map(x => `第${x.num}章（${x.reason}）`).join('、')}` : ''));
    }

    this.emitProgress();
  }

  async editChapter(chapter, websiteChapterNum) {
    let directEditUrl = (chapter.itemId && this.config?.bookId)
      ? `https://fanqienovel.com/main/writer/${this.config.bookId}/publish/${chapter.itemId}/?enter_from=modifychapter`
      : '';

    if (directEditUrl) {
      this.log(`直达打开第 ${websiteChapterNum} 章编辑页 (item_id=${chapter.itemId})...`);
      try {
        await this.client.navigate(directEditUrl);
      } catch (e) {
        await dismissDialog(this.client.tabId);
      }
      await dismissDialog(this.client.tabId);
      await this.client.sleep(2000);
    } else {
      // Step 1: 确保在章节管理页面（若上一章超时留在了编辑页，自动导航回章节管理页）
      let onChapterList = await this.client.pageContains(['章节管理', '新建章节']);
      if (!onChapterList && this.config?.bookId) {
        this.log('不在章节管理页面，尝试导航回章节管理页...');
        const volumeIdx = this.currentVolPage || this.config.volumeIndex || 1;
        try {
          await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${this.config.bookId}&${volumeIdx}`);
        } catch (e) {
          await dismissDialog(this.client.tabId);
        }
        await dismissDialog(this.client.tabId);
        await this.waitChapterRows({ maxMs: 15000 }).catch(() => {});
        onChapterList = await this.client.pageContains(['章节管理', '新建章节']);
      }
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

      // Step 3: 定位对应章节的编辑按钮后坐标真实点击（同时提取直达编辑 URL 兜底）
      this.log(`在当前页面查找第 ${websiteChapterNum} 章的编辑按钮...`);
      const rowMeta = await this.client.evaluate(`(function(){
        const targetNum = ${websiteChapterNum};
        const exactPattern = new RegExp('第' + targetNum + '章(?![0-9])');
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (exactPattern.test(link.textContent || '')) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/preview\\/(\\d+)&(\\d+)/);
            const row = link.closest('tr');
            const ed = row ? row.querySelector('.icon-edit, .auto-editor-chapter-edit, .tomato-edit, [class*="chapter-edit"]') : null;
            const disabled = ed ? (ed.className || '').includes('disabled') : false;
            return { found: true, bookId: m ? m[1] : '', chapterId: m ? m[2] : '', disabled };
          }
        }
        return { found: false };
      })()`);

      if (rowMeta && rowMeta.bookId && rowMeta.chapterId) {
        directEditUrl = `https://fanqienovel.com/main/writer/${rowMeta.bookId}/publish/${rowMeta.chapterId}/?enter_from=modifychapter`;
      }

      if (rowMeta && rowMeta.disabled && directEditUrl) {
        this.log(`第 ${websiteChapterNum} 章行内编辑图标为 disabled，直接导航进入章节编辑页...`);
        await this.client.navigate(directEditUrl);
        await this.client.sleep(2000);
      } else {
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

        if (!findClicked && !directEditUrl) {
          return { success: false, notFound: true, message: `未找到第 ${websiteChapterNum} 章` };
        }
        await this.client.sleep(2000);
      }
    }

    // Step 3: 处理"有刚刚更新的章节，是否继续编辑？"弹窗——必须点「放弃」！
    // ⚠️ 绝不能点「继续编辑」：点「继续编辑」会把编辑器跳转到之前未保存的【另一章】草稿，导致覆盖错章或报标题重名！
    await this.dismissDraftPrompt();

    // Step 4: 等待编辑页面加载
    // 服务端等待（browser_wait_for 实测是真的等、如实返回 matched），一次往返顶原来 20 次轮询。
    let editorReady = await this.client.waitForSelector('.ProseMirror', { timeoutMs: 8000 });
    if (!editorReady && directEditUrl) {
      this.log(`点击未进入编辑器，使用直达 URL 打开第 ${websiteChapterNum} 章编辑页...`);
      await this.client.navigate(directEditUrl);
      await this.client.sleep(2000);
      editorReady = await this.client.waitForSelector('.ProseMirror', { timeoutMs: 10000 });
    }

    if (!editorReady) {
      return { success: false, message: '编辑页面加载超时' };
    }

    // 编辑器加载后，等待原章节内容加载完成或「是否继续编辑？」草稿弹窗出现并点「放弃」
    for (let w = 0; w < 24; w++) {
      await this.client.sleep(250);
      if (await this.dismissDraftPrompt()) {
        await this.client.sleep(800);
        continue;
      }
      const ready = await this.client.evaluate(`(function(){
        if (window.__flushTimers) { try { window.__flushTimers(); } catch (e) {} }
        const ms = document.querySelectorAll('.byte-modal, .legacy-global-confirm-modal');
        for (const m of ms) {
          const w = m.closest('.byte-modal-wrapper');
          if (m.offsetParent !== null && (!w || !/hide|exit/i.test(w.className || ''))) return false;
        }
        const nextBtn = document.querySelector('.auto-editor-next');
        return !!(nextBtn && !nextBtn.disabled);
      })()`);
      if (ready) break;
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
      // 没有保存按钮则点"下一步"（先调 clickNextStep 确保 nudge 解锁按钮）
      await this.clickNextStep();
      saved = true;
      isNext = true;
    }

    if (!saved) {
      return { success: false, message: '未找到保存按钮' };
    }

    await this.client.sleep(1000);

    // 如果点击的是下一步，需要处理发布弹窗
    let confirmedPublish = !isNext;
    if (isNext) {
      // 等待并处理弹窗（含内容检测方式、错别字提示、风险检测；预检可能耗时 45-50 秒，给足 110*500ms）
      for (let retry = 0; retry < 110; retry++) {
        await this.client.sleep(500);

        if (await this.handleDetectionModeDialog()) {
          this.log('已选择内容检测方式');
          await this.client.sleep(500);
          continue;
        }

        // 检查是否有错别字弹窗
        if (await this.handleTypoDialog()) {
          this.log('已忽略错别字提示');
          await this.client.sleep(500);
          continue;
        }

        const riskResult = await this.handleRiskDetection();
        if (riskResult.triggered) {
          await this.client.sleep(600);
          continue;
        }

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
          // 默认勾「是」：只有书的发布设置里明确 useAI=false 才勾「否」（2026-10-02 作者定：所有书默认如实申报用了 AI）
          const targetText = (this.config?.useAI !== false) ? '是' : '否';
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
          // 改期：编辑已排期的章时可顺带改发布日期（chapter.scheduleDate = 'YYYY-MM-DD'）。
          // 由来（2026-10-03 国术）：一次排期把 470–472 挤进 10-08、473 起跳到 10-13，中间断更 4 天，
          // 只能逐章编辑把日期改回来。改完必须读回输入框核对，对不上就取消、不点确认——宁可这章不改，也不能排错日子。
          if (chapter.scheduleDate) {
            const want = String(chapter.scheduleDate).slice(0, 10);
            const [yy, mm, dd] = want.split('-').map(Number);
            this.currentScheduleDay = new Date(yy, mm - 1, dd);
            await this.enableScheduleSwitch();   // 只在开关是关着的时候才会点
            await this.client.sleep(300);
            await this.selectScheduleDate();
            await this.client.sleep(400);
            const shown = await this.client.evaluate(`(function(){
              var i = document.querySelector('.arco-modal input.arco-picker-start-time, .arco-modal .arco-picker input');
              return i ? (i.value || '') : '';
            })()`);
            if (String(shown || '').slice(0, 10) !== want) {
              this.log(`⚠️ 改期没生效（输入框显示「${shown || '空'}」，要的是 ${want}）→ 取消本章，不提交`);
              await this.client.clickButtonByText('取消');
              await this.client.sleep(800);
              return { success: false, saveRejected: true, message: `改期未生效（显示 ${shown || '空'}，目标 ${want}）` };
            }
            this.log(`📅 已改发布日期为 ${want}`);
          }
          // 点击确认发布
          await this.client.clickButtonByText('确认发布');
          confirmedPublish = true;
          await this.client.sleep(1000);
          const postErr = await this.checkBlockingErrors();
          if (postErr.hasError) {
            return {
              success: false,
              needsIntervention: true,
              reason: postErr.reason,
              message: postErr.message,
            };
          }
          if (await this.handleDetectionModeDialog()) { await this.client.sleep(500); }
          await this.handleRiskDetection();
          const postRiskErr = await this.checkBlockingErrors();
          if (postRiskErr.hasError) {
            return {
              success: false,
              needsIntervention: true,
              reason: postRiskErr.reason,
              message: postRiskErr.message,
            };
          }
          const checkingKeywords = ['正在为你检测风险内容', '为你检测', '检测风险内容', '正在检测', '安全检测中', '检测中'];
          if (await this.client.pageContains(checkingKeywords)) {
            this.log('内容风险检测中，等待完成...');
            const t0 = Date.now();
            while (Date.now() - t0 < 60000) {
              await this.client.sleep(1000);
              if (!(await this.client.pageContains(checkingKeywords))) break;
            }
            await this.client.sleep(800);
          }
          const afterCheckErr = await this.checkBlockingErrors();
          if (afterCheckErr.hasError) {
            return {
              success: false,
              needsIntervention: true,
              reason: afterCheckErr.reason,
              message: afterCheckErr.message,
            };
          }
          // 风险检测/发布提交在后台可能耗时 40-50s（未必出现 checkingKeywords 文本），轮询至多 60s 并在弹窗仍打开时补点"确认发布"
          const submitStart = Date.now();
          let reclicked = 0;
          while (Date.now() - submitStart < 60000) {
            if (!(await this.client.pageContains(['发布设置', '确认发布']))) break;
            if (await this.client.pageContains(['章节管理', '新建章节'])) break;
            if (await this.handleDetectionModeDialog()) { await this.client.sleep(500); continue; }
            await this.handleRiskDetection();
            const blk = await this.checkBlockingErrors();
            if (blk.hasError) {
              return {
                success: false,
                needsIntervention: true,
                reason: blk.reason,
                message: blk.message,
              };
            }
            reclicked++;
            if (reclicked === 1 || reclicked % 6 === 0) {
              if (!(await this.isConfirmBtnLoading())) {
                this.log(`等待发布弹窗关闭(${Math.round((Date.now() - submitStart) / 1000)}s)，点击确认发布...`);
                await this.client.clickButtonByText('确认发布');
              }
            }
            await this.client.sleep(1000);
          }
          break;
        }

        if (retry === 5 || retry === 12) {
          const anyModal = await this.client.evaluate(`(function(){
            const ms = document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]');
            for (const m of ms) { if (m.offsetParent !== null && getComputedStyle(m).display !== 'none') return true; }
            return false;
          })()`);
          if (!anyModal) {
            this.log('未见弹窗，补触发识别并重一点「下一步」...');
            await this.nudgeEditor();
            await this.clickNextStep();
          }
        }
      }
    }

    // Step 6: 检查是否保存成功，返回章节列表
    await this.client.sleep(1500);

    // 等待返回章节列表（最多等待15秒）
    let returnedToList = false;
    if (confirmedPublish) {
      for (let i = 0; i < 30; i++) {
        const onList = await this.client.pageContains(['章节管理', '新建章节']);
        if (onList) {
          returnedToList = true;
          break;
        }
        await this.client.sleep(500);
      }
    }

    if (!returnedToList) {
      // 还停在编辑页 / 发布设置弹窗上 = 番茄没接受这次保存（实测原因：标题与别的章重名、敏感词、字数不够）。
      // 原来这里直接导航回列表并返回 success:true —— 把一次失败报成了成功，
      // 还因为离开未保存的编辑页触发 beforeunload，把后面每一步都卡死（2026-10-02 国术第 7 章）。
      const urlNow = await this.client.evaluate('location.href').catch(() => '');
      const onPublishUrl = this.isEditPage(String(urlNow || ''));
      const stuck = !confirmedPublish || onPublishUrl || await this.client.pageContains(['请输入标题', '请输入正文', 'ProseMirror', '发布设置', '确认发布']);
      if (stuck) {
        const reason = await this.client.evaluate(`(function(){
          var sel=['.arco-message','.arco-notification','.arco-form-item-message','[class*="error"]','[class*="toast"]','.arco-modal-content'];
          var seen={}, out=[];
          sel.forEach(function(s){ document.querySelectorAll(s).forEach(function(n){
            var t=(n.innerText||'').replace(/\\s+/g,' ').trim();
            if(t && t.length<120 && !seen[t]){ seen[t]=1; out.push(t); } }); });
          return out.slice(0,3).join('；');
        })()`).catch(() => '');
        this.log(`❌ 番茄没有接受这次保存，仍停在编辑页${reason ? '：' + reason : ''}（常见原因：标题与其他章重名）`);
        // 留在原页离开时会弹"未保存"确认——导航前先把它关掉，免得卡住下一章
        if (this.config?.bookId) {
          const volumeIdx = this.currentVolPage || this.config.volumeIndex || 1;
          try { await this.client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${this.config.bookId}&${volumeIdx}`); }
          catch (e) { await dismissDialog(this.client.tabId); }
          await dismissDialog(this.client.tabId);
          await this.waitChapterRows({ maxMs: 15000 }).catch(() => {});
        }
        return { success: false, saveRejected: true, message: `保存未被番茄接受${reason ? '：' + reason : ''}` };
      }
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
          await this.clickNewChapter().catch(() => {});
          await this.waitForNewChapterPage().catch(() => {});
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
    // Step 0: 多卷模式（或未开 matchVolumes 但番茄已有多个分卷时默认发往最新卷）——发布前确保切到目标卷
    const targetVol = (this.config?.matchVolumes && chapter.volumeText)
      ? chapter.volumeText
      : ((Array.isArray(this.config?.fanqieVolumes) && this.config.fanqieVolumes.length > 1) ? this.config.fanqieVolumes[0] : '');
    if (targetVol) {
      const sw = await this.switchToVolume(targetVol);
      if (!sw.ok) {
        // notReady = 页面/模态没渲染出来，不是真缺卷 → 软失败，让上层刷新重试（3 次才暂停）
        if (sw.notReady) {
          return { success: false, message: `发布页还没就绪，读不到分卷（目标卷「${targetVol}」），刷新重试` };
        }
        return {
          success: false, needsIntervention: true, reason: 'volume_missing',
          message: sw.found === false
            ? `番茄该书没有卷「${targetVol}」。番茄建卷不可逆，请先在番茄后台手动建好该卷，再继续发布。`
            : `切换到卷「${targetVol}」未成功（当前：${sw.current || '未知'}），已暂停以免发到错卷。`,
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
    for (let retry = 0; retry < 35; retry++) {
      if (retry > 0) await this.client.sleep(500);

      const detectionModeHandled = await this.handleDetectionModeDialog();
      if (detectionModeHandled) {
        this.log('已选择内容检测方式');
        await this.client.sleep(800);
        continue;
      }

      const typoHandled = await this.handleTypoDialog();
      if (typoHandled) {
        this.log('已忽略错别字提示');
        await this.client.sleep(800);
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

      const isNonFatalPreDialogErr = (err) => err && err.hasError && /超出每日上限|已满|请稍后再试|操作频繁|请求过于频繁|频率限制/.test(err.message || '');
      const earlyBlockingError = await this.checkBlockingErrors();
      if (earlyBlockingError.hasError && !isNonFatalPreDialogErr(earlyBlockingError)) {
        if (/当前章节不可修改/.test(earlyBlockingError.message || '')) {
          this.log('✅ 检测到章节已锁定入库（夜间审核中），视为发布成功');
          return { success: true };
        }
        this.log(`⚠️ 弹窗处理阶段检测到阻断性错误: ${earlyBlockingError.message}`);
        return {
          success: false,
          needsIntervention: true,
          reason: earlyBlockingError.reason,
          message: earlyBlockingError.message,
        };
      }
      if (isNonFatalPreDialogErr(earlyBlockingError)) {
        this.forcedScheduleMode = true;
        await this.client.evaluate(`document.querySelectorAll('.arco-message, .byte-message').forEach(function(m){ try { m.remove(); } catch(e){} })`).catch(() => {});
      }

      const atPublishDialog = await this.client.pageContains(['发布设置', '确认发布']);
      if (atPublishDialog) break;

      if (retry === 12 || retry === 22) {
        const anyModal = await this.client.evaluate(`(function(){
          const ms = document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]');
          for (const m of ms) { if (m.offsetParent !== null && getComputedStyle(m).display !== 'none') return true; }
          return false;
        })()`);
        if (!anyModal) {
          this.log('未见弹窗，重一点「下一步」...');
          const st = await this.nextStepState();
          if (st === 'disabled') await this.nudgeEditor();
          await this.clickNextStep();
        }
      }

      await this.client.sleep(400);
    }

    // Step 4: 检查阻断性错误
    const blockingError = await this.checkBlockingErrors();
    const isNonFatalPreDialogErr2 = (err) => err && err.hasError && /超出每日上限|已满|请稍后再试|操作频繁|请求过于频繁|频率限制/.test(err.message || '');
    if (blockingError.hasError && !isNonFatalPreDialogErr2(blockingError)) {
      if (/当前章节不可修改/.test(blockingError.message || '')) {
        this.log('✅ 检测到章节已锁定入库（夜间审核中），视为发布成功');
        return { success: true };
      }
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
    const dialogReady = await this.waitForPublishDialog(65);
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

      // 只动【本账号】的标签页。原来不看 profile，把同时在跑的另一本书（另一个番茄账号）的后台标签页
      // 当"多余"关掉了——2026-10-02 岳雷发布时，国术的重发两次报 tab not found 停在半路。
      const norm = (x) => String(x || '').replace(/[\\/]+$/, '').toLowerCase();
      const mine = this.client?.selectedProfilePath ? norm(this.client.selectedProfilePath) : '';
      const fanqieTabs = [];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const url = tab.url || '';
        if (mine && tab.profile_path && norm(tab.profile_path) !== mine) continue;
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

  async dismissDraftPrompt() {
    const clicked = await this.client.evaluate(`(function(){
      document.querySelectorAll('[class*="exit"], [class*="leave"], .byte-modal-wrapper-hide').forEach(function(el){
        try {
          el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
          el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
        } catch (e) {}
      });
      const modals = document.querySelectorAll('.byte-modal, .legacy-global-confirm-modal, .publish-modal-confirm, .arco-modal');
      for (const m of modals) {
        if (m.offsetParent === null) continue;
        const wrap = m.closest('.byte-modal-wrapper, .arco-modal-wrapper');
        if (wrap && (/hide|exit|leave/i.test(wrap.className || '') || getComputedStyle(wrap).display === 'none')) continue;
        if (/hide|exit|leave/i.test(m.className || '')) continue;
        const t = m.innerText || '';
        if (t.includes('是否继续编辑') || t.includes('刚刚更新的章节') || t.includes('未保存')) {
          const btns = [...m.querySelectorAll('button')];
          const giveUp = btns.find(b => ['放弃', '取消', '不使用'].includes((b.innerText || '').trim()));
          if (giveUp) {
            giveUp.click();
            setTimeout(function(){
              document.querySelectorAll('[class*="exit"], [class*="leave"], .byte-modal-wrapper-hide').forEach(function(el){
                try {
                  el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
                  el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
                } catch (e) {}
              });
            }, 50);
            return true;
          }
        }
      }
      return false;
    })()`);
    if (clicked) {
      this.log('检测到「是否继续编辑」草稿弹窗，已点击「放弃」并等待关闭...');
      await this.client.sleep(400);
    }
    return !!clicked;
  }

  async injectContent(chapter) {
    this._lastInjectedChapter = chapter;
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
    // 番茄限制「第 + 章号 + 纯标题」总计不超过 30 字（3位数章号时纯标题最多 26 字）
    const maxPureLen = Math.max(15, 29 - String(chapterNumber || '999').length);
    if (pureTitle.length > maxPureLen) {
      this.log(`⚠️ 章节标题过长(${pureTitle.length}字 > ${maxPureLen}字上限)，自动精简为 ${maxPureLen} 字...`);
      pureTitle = pureTitle.slice(0, maxPureLen).replace(/[，、：；,.!！？?—\-]+$/, '');
    }

    this.log(`章节注入 - 编号: ${chapterNumber}, 纯标题: "${pureTitle}"`);

    // 等待编辑器加载（最多等待10秒）
    // 服务端等待（browser_wait_for 实测是真的等、如实返回 matched），一次往返顶原来 20 次轮询。
    const editorReady = await this.client.waitForSelector('.ProseMirror', { timeoutMs: 10000 });
    if (!editorReady) {
      this.log('⚠️ 等待编辑器超时，尝试继续...');
    }

    await this.client.sleep(500);
    await this.dismissDraftPrompt();

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

    // 确保在页面顶部，避免 ProseMirror 顶部被 sticky header 遮挡
    await this.client.evaluate('window.scrollTo(0, 0)').catch(() => {});
    await this.client.sleep(200);

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
      // 若「是否继续编辑？」弹窗延迟弹出锁住了焦点，点「放弃」后会重置编辑器内容，需重新注入本章内容
      if (await this.dismissDraftPrompt()) {
        if (this._lastInjectedChapter) {
          this.log('草稿弹窗关闭后重新注入本章内容...');
          await this.injectContent(this._lastInjectedChapter);
          return;
        }
      }
      await this.client.evaluate(`(function(){const ed=document.querySelector('.ProseMirror');if(!ed)return;ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false,' ');})()`);
      await this.client.typeText(' ').catch(() => {});
      await this.client.sleep(200);
    } catch (e) { this.log('⚠️ nudge 失败：' + (e.message || e)); }
  }

  async clickNextStep() {
    // 先确保"下一步"可用：禁用就补 nudge 触发番茄识别正文，最多等 ~12s
    let state = await this.nextStepState();
    for (let i = 0; i < 8 && state === 'disabled'; i++) {
      this.log(`"下一步"禁用，触发番茄识别正文(${i + 1})…`);
      if (i === 2 && this._lastInjectedChapter) {
        this.log('重新注入标题与正文以恢复按钮状态...');
        await this.injectContent(this._lastInjectedChapter);
      }
      await this.nudgeEditor();
      await this.client.sleep(600);
      state = await this.nextStepState();
    }
    if (state !== 'enabled') { this.log(`⚠️ "下一步"仍${state === 'absent' ? '不存在' : '禁用'}（正文可能未被番茄识别）`); }
    // ⚠️ 关键：当顶部状态栏显示「保存中」（wsSaveStatus === 'pending'）时，番茄 handleClickPublish 会忽略「下一步」点击！
    // 必须等防抖触发且「保存中」变为「已保存 / 已保存到云端」后再点「下一步」。
    await this.client.sleep(600);
    for (let w = 0; w < 30; w++) {
      const saving = await this.client.evaluate(`(function(){
        const st = document.querySelector('.publish-maintain-info-status');
        return st ? (st.innerText || '').includes('保存中') : false;
      })()`);
      if (!saving) break;
      await this.client.sleep(300);
    }
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
    // 定位错别字弹窗的确认按钮后点击（跳过2秒内刚点过、已隐藏或正在退出动画中的弹窗）
    const clicked = await this.client.clickByLocator(`
      const now = Date.now();
      const modals = document.querySelectorAll('.arco-modal, .byte-modal');
      for (const modal of modals) {
        const wrap = modal.closest('.arco-modal-wrapper, [role="dialog"]') || modal;
        if (Number(modal.dataset?.fqHandledAt || 0) > now - 2000 || Number(wrap.dataset?.fqHandledAt || 0) > now - 2000) continue;
        const cs = getComputedStyle(modal);
        if (cs.display === 'none' || cs.visibility === 'hidden' || modal.offsetParent === null) continue;
        if (/exit|leave/i.test(modal.className || '') || /exit|leave/i.test(wrap.className || '')) continue;
        const text = modal.textContent || '';
        const typoKeywords = ['错别字', '是否确定提交', '疑似错别字', '拼写错误', '仍要提交', '继续提交', '存在问题'];
        if (!typoKeywords.some(kw => text.includes(kw))) continue;
        const buttons = modal.querySelectorAll('button, [role="button"], .arco-btn, .byte-btn, [class*="btn"], span[class*="button"]');
        for (const btn of buttons) {
          const bt = (btn.textContent || '').trim();
          const isConfirm = ['提交', '确定', '确认', '忽略', '继续', '仍要'].some(k => bt.includes(k));
          const isCancel = ['取消', '返回', '修改'].some(k => bt.includes(k));
          if (isConfirm && !isCancel) {
            if (modal.dataset) modal.dataset.fqHandledAt = String(now);
            if (wrap.dataset) wrap.dataset.fqHandledAt = String(now);
            return btn;
          }
        }
      }
      return null;
    `);
    if (clicked) await this.client.sleep(400);
    return clicked;
  }

  async handleDetectionModeDialog() {
    // 定位"普通检测/仅基础检测/基础检测"选项后点击（避开"全面检测"，从最上层弹窗开始处理，清理多层堆叠弹窗）
    const clicked = await this.client.clickByLocator(`
      const now = Date.now();
      const modals = Array.from(document.querySelectorAll('.arco-modal, .byte-modal')).reverse();
      let topBtn = null;
      for (const modal of modals) {
        const wrap = modal.closest('.arco-modal-wrapper, [role="dialog"]') || modal;
        if (Number(modal.dataset?.fqHandledAt || 0) > now - 1500) continue;
        const cs = getComputedStyle(modal);
        if (cs.display === 'none' || cs.visibility === 'hidden' || modal.offsetParent === null) continue;
        if (/exit|leave/i.test(modal.className || '') || /exit|leave/i.test(wrap.className || '')) continue;
        if (!(modal.textContent || '').includes('检测方式')) continue;
        document.querySelectorAll('.arco-message, .byte-message').forEach(m => { try { m.remove(); } catch (e) {} });
        const buttons = modal.querySelectorAll('button, .arco-btn, .byte-btn, [role="button"]');
        for (const btn of buttons) {
          const bt = (btn.textContent || '').trim();
          if ((bt.includes('普通检测') || bt.includes('仅基础检测') || bt.includes('基础检测')) && !bt.includes('全面')) {
            if (modal.dataset) modal.dataset.fqHandledAt = String(now);
            if (!topBtn) {
              topBtn = btn;
            } else {
              try { btn.click(); } catch (e) {}
            }
            break;
          }
        }
        if (topBtn) continue;
        const allElements = modal.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent || '';
          if ((text.includes('普通检测') || (text.includes('基础检测') && text.includes('不限次数'))) && !text.includes('全面检测')) {
            const r = el.getBoundingClientRect();
            if (r.width > 50 && r.height > 20) {
              if (modal.dataset) modal.dataset.fqHandledAt = String(now);
              topBtn = el;
              break;
            }
          }
        }
      }
      return topBtn;
    `);
    if (clicked) {
      this.log('选择内容检测方式: 普通/基础检测');
      await this.client.sleep(800);
      await this.handleRiskDetection();
      const checkingKeywords = ['正在为你检测风险内容', '为你检测', '检测风险内容', '正在检测', '安全检测中', '检测中'];
      const t0 = Date.now();
      let sawChecking = false;
      while (Date.now() - t0 < 50000) {
        const isChk = await this.client.pageContains(checkingKeywords);
        if (isChk) {
          if (!sawChecking) { this.log('内容风险检测中，等待完成...'); sawChecking = true; }
          await this.client.sleep(800);
          continue;
        }
        if ((sawChecking || Date.now() - t0 > 2200) && await this.client.pageContains(['发布设置', '确认发布'])) break;
        const toast = await this.client.evaluate(`(function(){
          var m = document.querySelector('.arco-message, .byte-message, [class*="arco-message"]');
          return m ? (m.innerText || '').trim() : '';
        })()`).catch(() => '');
        if (toast && (toast.includes('检测暂无风险') || toast.includes('可发布') || toast.includes('风险'))) {
          this.log(`内容检测完成（${toast}）`);
          await this.client.evaluate(`document.querySelectorAll('.arco-message, .byte-message').forEach(function(m){ try { m.remove(); } catch(e){} })`).catch(() => {});
          break;
        }
        if (sawChecking || Date.now() - t0 > 5000) break;
        await this.client.sleep(600);
      }
      await this.client.sleep(500);
    }
    return clicked;
  }

  async handleRiskDetection() {
    // 定位风险检测弹窗的确认按钮后点击（跳过退出动画中的弹窗）
    const clicked = await this.client.clickByLocator(`
      const modals = document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]');
      for (const modal of modals) {
        const cs = getComputedStyle(modal);
        if (cs.display === 'none' || cs.visibility === 'hidden' || modal.offsetParent === null) continue;
        if (/exit|leave/i.test(modal.className || '')) continue;
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
          'account_limit': ['提交字数超出每日上限', '超出每日上限', '当前章节不可修改', '账号异常', '操作频繁', '请稍后再试', '访问受限', '账号受限', '频率限制', '请求过于频繁'],
          'unknown_error': ['发布失败', '提交失败', '保存失败', '网络错误', '服务器错误', '系统错误']
        };

        const excludePatterns = ['请选择内容检测方式', '全面检测', '基础检测', '本章节剩余次数', '不限次数', '深度排查', '辅助提升内容通过效率', '不覆盖范围外的检测'];

        const modalSelectors = ['.arco-modal', '.arco-modal-wrapper', '.arco-message', '.byte-message', '.arco-notification', '.byte-notification', '[role="dialog"]', '[role="alertdialog"]', '.arco-modal-content', '[class*="modal"]', '[class*="dialog"]', '.arco-popup'];
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

  async isConfirmBtnLoading() {
    return Boolean(await this.client.evaluate(`(function(){
      var btns = document.querySelectorAll('.arco-modal button, [role="dialog"] button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').indexOf('确认发布') >= 0 && (btns[i].className || '').indexOf('loading') >= 0) return true;
      }
      return false;
    })()`).catch(() => false));
  }

  async waitForPublishDialog(maxSeconds = 30) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      const hasDialog = await this.client.pageContains(['发布设置', '确认发布']);
      const isChecking = await this.client.pageContains(['安全检测中', '正在检测', '检测中']);
      if (hasDialog && !isChecking) return true;
      await this.handleTypoDialog().catch(() => {});
      await this.handleDetectionModeDialog().catch(() => {});
      await this.client.sleep(1000);
    }
    return false;
  }

  async handlePublishDialog() {
    const maxRetry = 10;
    let retryCount = 0;
    let scheduleEnabled = false;

    const isScheduledMode = Boolean(this.config?.scheduledStartDate)
                           || this.forcedScheduleMode;

    // Step 1: 选择 AI 选项（是/否）—— 定位单选项后坐标真实点击
    if (this.config) {
      const targetText = (this.config.useAI !== false) ? '是' : '否';
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

    // Step 3: 点击确认发布（先清掉页面残留的旧 toast）
    await this.client.evaluate(`document.querySelectorAll('.arco-message, .byte-message').forEach(function(m){ try { m.remove(); } catch(e){} })`).catch(() => {});
    await this.client.clickButtonByText('确认发布');

    let actuallyChangedDate = false;
    const checkingKeywords = ['正在为你检测风险内容', '为你检测', '检测风险内容', '正在检测', '安全检测中', '检测中'];

    const hasLeftPublishPage = async () => {
      const h = String(await this.client.evaluate('location.href').catch(() => ''));
      return h.includes('chapter-manage') || (h.includes('/main/writer/') && !this.isEditPage(h));
    };

    const isConfirmBtnLoading = async () => {
      return Boolean(await this.client.evaluate(`(function(){
        var btns = document.querySelectorAll('.arco-modal button, [role="dialog"] button');
        for (var i = 0; i < btns.length; i++) {
          if ((btns[i].textContent || '').indexOf('确认发布') >= 0 && (btns[i].className || '').indexOf('loading') >= 0) return true;
        }
        return false;
      })()`).catch(() => false));
    };

    const waitModalClose = async (maxMs = 5000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await this.client.sleep(500);
        if (await hasLeftPublishPage()) return true;
        if (await this.client.pageContains(checkingKeywords)) return false;
        const blk = await this.checkBlockingErrors().catch(() => null);
        if (blk && blk.hasError) return false;
        // 若确认发布按钮处于 loading 状态（后台正在跑 45s 风险检测/入库），自动延长等待至 loading 结束
        if (await isConfirmBtnLoading()) {
          const loadStart = Date.now();
          while (Date.now() - loadStart < 60000) {
            await this.client.sleep(1000);
            if (await hasLeftPublishPage()) return true;
            if (!(await isConfirmBtnLoading())) break;
          }
          await this.client.sleep(800);
          if (await hasLeftPublishPage()) return true;
        }
      }
      return await hasLeftPublishPage();
    };

    if (await waitModalClose(4000)) {
      this.log('发布弹窗已关闭且已离开编辑页，发布成功');
      return { success: true, switchedToNextDay: false };
    }

    const isDateLimitErr = (err) => err && err.hasError && /超出每日上限|已满/.test(err.message || '');
    const isAlreadyLockedErr = (err) => err && err.hasError && /当前章节不可修改/.test(err.message || '');
    const isRateLimitErr = (err) => err && err.hasError && /请稍后再试|操作频繁|请求过于频繁|频率限制/.test(err.message || '');

    let immediateBlockingError = await this.checkBlockingErrors();
    if (isAlreadyLockedErr(immediateBlockingError)) {
      this.log('✅ 检测到章节已锁定入库（夜间审核中），视为发布成功');
      return { success: true, switchedToNextDay: actuallyChangedDate };
    }
    if (immediateBlockingError.hasError && !isDateLimitErr(immediateBlockingError) && !isRateLimitErr(immediateBlockingError)) {
      return {
        success: false,
        needsIntervention: true,
        reason: immediateBlockingError.reason,
        message: immediateBlockingError.message,
      };
    }

    while (retryCount < maxRetry) {
      if (await hasLeftPublishPage()) {
        this.log('已跳转离开编辑页，发布成功');
        return { success: true, switchedToNextDay: actuallyChangedDate };
      }

      // 确认发布后可能先弹出"请选择内容检测方式"（选仅基础检测）或"开始风险检测"按钮，需先点选
      if (await this.handleTypoDialog()) { await this.client.sleep(500); }
      if (await this.handleDetectionModeDialog()) { await this.client.sleep(800); }
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
        await this.client.sleep(800);
        await this.client.evaluate(`document.querySelectorAll('.arco-message, .byte-message').forEach(function(m){ try { m.remove(); } catch(e){} })`).catch(() => {});
        if (await hasLeftPublishPage()) {
          this.log('风险检测后已离开编辑页，发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
        // 风险检测通过后（"检测暂无风险，可发布或继续修改"），需再次点击确认发布真正提交
        const postCheckBlock = await this.checkBlockingErrors();
        if (isAlreadyLockedErr(postCheckBlock)) {
          this.log('✅ 检测到章节已锁定入库（夜间审核中），视为发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
        if (postCheckBlock.hasError && !isDateLimitErr(postCheckBlock) && !isRateLimitErr(postCheckBlock)) {
          return {
            success: false,
            needsIntervention: true,
            reason: postCheckBlock.reason,
            message: postCheckBlock.message,
          };
        }
        if (await this.client.pageContains(['发布设置', '确认发布'])) {
          this.log('风险检测通过，点击确认发布提交...');
          await this.client.clickButtonByText('确认发布');
          if (await waitModalClose(6000)) {
            this.log('发布弹窗已关闭且已离开编辑页，发布成功');
            return { success: true, switchedToNextDay: actuallyChangedDate };
          }
        }
      }

      const blockingError = await this.checkBlockingErrors();
      if (isAlreadyLockedErr(blockingError)) {
        this.log('✅ 检测到章节已锁定入库（夜间审核中），视为发布成功');
        return { success: true, switchedToNextDay: actuallyChangedDate };
      }
      if (isRateLimitErr(blockingError)) {
        this.log('⏳ 触发提交频率限制，等待 4 秒后继续...');
        await this.client.evaluate(`document.querySelectorAll('.arco-message, .byte-message').forEach(function(m){ try { m.remove(); } catch(e){} })`).catch(() => {});
        await this.client.sleep(4000);
        if (await hasLeftPublishPage()) {
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
      } else if (blockingError.hasError && !isDateLimitErr(blockingError)) {
        return {
          success: false,
          needsIntervention: true,
          reason: blockingError.reason,
          message: blockingError.message,
        };
      }

      if (await hasLeftPublishPage()) {
        this.log('已跳转离开编辑页，发布成功');
        return { success: true, switchedToNextDay: actuallyChangedDate };
      }

      let dialogOpen = await this.client.pageContains(['发布设置', '确认发布']);
      if (!dialogOpen) {
        if (await hasLeftPublishPage()) {
          this.log('发布弹窗已关闭且已离开编辑页，发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
        this.log('仍在编辑页但发布设置弹窗已关闭，重新点击下一步打开...');
        await this.handleTypoDialog();
        await this.handleDetectionModeDialog();
        await this.clickNextStep();
        await this.waitForPublishDialog(15);
        dialogOpen = await this.client.pageContains(['发布设置', '确认发布']);
        if (dialogOpen) {
          if (this.config) {
            const targetText = (this.config.useAI !== false) ? '是' : '否';
            await this.client.clickByLocator(`
              const targetText = ${JSON.stringify(targetText)};
              const radioTexts = document.querySelectorAll('.arco-radio-text');
              for (const span of radioTexts) {
                if ((span.textContent || '').trim() === targetText) {
                  const label = span.closest('label.arco-radio');
                  if (label && !label.classList.contains('arco-radio-checked')) return label;
                }
              }
              return null;
            `).catch(() => {});
          }
          if (scheduleEnabled) {
            await this.enableScheduleSwitch().catch(() => {});
            await this.client.sleep(200);
            await this.selectScheduleDate();
          }
          await this.client.sleep(300);
          await this.client.clickButtonByText('确认发布');
          if (await waitModalClose(6000)) {
            this.log('重新打开弹窗提交成功');
            return { success: true, switchedToNextDay: actuallyChangedDate };
          }
          continue;
        }
      }

      const toastMsg = await this.client.evaluate(`(function(){
        var ms = document.querySelectorAll('.arco-message, .byte-message');
        if (!ms.length) return '';
        var texts = [];
        ms.forEach(function(m){
          var t = (m.innerText || '').trim();
          if (t) texts.push(t);
          try { m.remove(); } catch (e) {}
        });
        return texts.join(' | ');
      })()`).catch(() => '');
      if (toastMsg && (toastMsg.includes('检测暂无风险') || toastMsg.includes('可发布'))) {
        this.log(`收到提示「${toastMsg}」，点击确认发布提交...`);
        await this.client.clickButtonByText('确认发布');
        if (await waitModalClose(6000)) {
          this.log('发布弹窗已关闭，发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
      }
      if (toastMsg && (toastMsg.includes('正在为你检测') || toastMsg.includes('检测风险内容')) && !/上限|已满/.test(toastMsg)) {
        this.log('⏳ 番茄后台仍在检测风险内容，等待 5 秒...');
        await this.client.sleep(5000);
        await this.client.clickButtonByText('确认发布');
        if (await waitModalClose(6000)) {
          this.log('发布弹窗已关闭，发布成功');
          return { success: true, switchedToNextDay: actuallyChangedDate };
        }
        continue;
      }

      retryCount++;
      this.log(`发布重试 ${retryCount}/${maxRetry}，弹窗仍打开${toastMsg ? `（番茄提示：${toastMsg}）` : ''}`);

      // 若风险检测后发布设置弹窗刚重绘，补选 AI 单选框与定时开关
      if (this.config) {
        const targetText = (this.config.useAI !== false) ? '是' : '否';
        await this.client.clickByLocator(`
          const targetText = ${JSON.stringify(targetText)};
          const radioTexts = document.querySelectorAll('.arco-radio-text');
          for (const span of radioTexts) {
            if ((span.textContent || '').trim() === targetText) {
              const label = span.closest('label.arco-radio');
              if (label && !label.classList.contains('arco-radio-checked')) return label;
            }
          }
          return null;
        `).catch(() => {});
      }
      if (scheduleEnabled) {
        await this.enableScheduleSwitch().catch(() => {});
      }

      if (!scheduleEnabled) {
        this.log(`📅 到达发布上限，开启定时发布`);
        await this.enableScheduleSwitch();
        scheduleEnabled = true;
        this.forcedScheduleMode = true;
        await this.client.sleep(300);
        await this.selectScheduleDate();
        await this.client.sleep(200);
        await this.client.clickButtonByText('确认发布');
        await waitModalClose(5000);
        continue;
      }

      const fullMsg = [toastMsg, blockingError?.message, immediateBlockingError?.message].filter(Boolean).join(' ');
      immediateBlockingError = { hasError: false };
      const isDateFullToast = /定时.*上限|该日.*已满|当日.*上限|日期.*上限|已达上限|超出每日上限/.test(fullMsg);
      if (isDateFullToast || retryCount >= 9) {
        this.log(`📅 当前日期可能已满，切换到下一天`);
        this.switchToNextDay();
        actuallyChangedDate = true;
        this.forcedScheduleMode = true;
        this._dateSwitches = (this._dateSwitches || 0) + 1;
        if (isDateFullToast && this._dateSwitches < 30) {
          retryCount = Math.max(0, retryCount - 1);
        }
        await this.client.sleep(200);
        await this.selectScheduleDate();
        await this.client.sleep(300);
        await this.client.clickButtonByText('确认发布');
        await waitModalClose(6000);
      } else {
        if (scheduleEnabled && this.currentScheduleDay) {
          const targetDateStr = this.formatDate(this.currentScheduleDay);
          const curVal = await this.client.evaluate(`(function(){
            const inp = document.querySelector('.arco-modal .arco-picker input, .arco-picker input');
            return inp ? (inp.value || '').trim() : '';
          })()`);
          if (curVal && !curVal.startsWith(targetDateStr)) {
            await this.selectScheduleDate();
            await this.client.sleep(200);
          }
        }
        await this.client.sleep(1000);
        await this.client.clickButtonByText('确认发布');
        await waitModalClose(6000);
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

    const findVisibleDatePanelCode = `
      (function(){
        const ps = document.querySelectorAll('.arco-picker-panel, .arco-picker-dropdown, .arco-picker-container');
        for (const p of ps) {
          const r = p.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(p);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          if (p.querySelector('.arco-picker-header, .arco-picker-cell, td[class*="cell"]')) return p;
        }
        return document.querySelector('.arco-picker-panel, .arco-picker-dropdown, .arco-picker-container');
      })()
    `;

    // 坐标真实点击打开日期选择器（仅当可见的日期面板存在时才算已打开）
    const panelAlreadyOpen = await this.client.evaluate(`(function(){
      document.querySelectorAll('[class*="exit"], [class*="leave"]').forEach(function(el){
        try {
          el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
          el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
        } catch (e) {}
      });
      const p = ${findVisibleDatePanelCode};
      return !!p;
    })()`);
    if (!panelAlreadyOpen) {
      await this.client.clickByLocator(`
        const inputs = document.querySelectorAll('.arco-modal .arco-picker input, .arco-picker input, input');
        for (const input of inputs) {
          if (input.value && /^\\d{4}-\\d{2}-\\d{2}/.test(input.value)) {
            return input.closest('.arco-picker') || input.parentElement || input;
          }
        }
        return document.querySelector('.arco-modal .arco-picker, .arco-picker');
      `);
      await this.client.sleep(500);
    }

    // 导航到目标年月：点"上一月/下一月"箭头（.arco-picker-header-icon，
    // 方向由内部 svg 图标类 arco-icon-left/right 决定；double 是年份箭头，跳过）
    for (let navAttempt = 0; navAttempt < 30; navAttempt++) {
      const cur = await this.client.evaluate(`
        (function(){
          const p = ${findVisibleDatePanelCode};
          if (!p) return { error: 'no_panel' };
          const v = (p.querySelector('.arco-picker-header-value')||{}).textContent || (p.querySelector('.arco-picker-header')||{}).textContent || '';
          const ym = v.match(/(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月/) || v.match(/(\\d{4})[^\\d]+(\\d{1,2})/);
          if (ym) return { year: parseInt(ym[1]), month: parseInt(ym[2]) - 1 };
          return { error: 'cannot_parse' };
        })()
      `);
      if (cur.error) {
        if (navAttempt === 2 || navAttempt === 6) {
          await this.client.clickByLocator(`
            const inputs = document.querySelectorAll('.arco-modal .arco-picker input, .arco-picker input, input');
            for (const input of inputs) {
              if (input.value && /^\\d{4}-\\d{2}-\\d{2}/.test(input.value)) {
                return input.closest('.arco-picker') || input.parentElement || input;
              }
            }
            return document.querySelector('.arco-modal .arco-picker, .arco-picker');
          `);
        }
        await this.client.sleep(350);
        continue;
      }
      if (cur.year === targetYear && cur.month === targetMonth) break;

      const needNext = (cur.year < targetYear) || (cur.year === targetYear && cur.month < targetMonth);
      // 坐标真实点击"上一月/下一月"箭头（按内部 svg 图标类识别方向，跳过年份双箭头）
      const moved = await this.client.clickByLocator(`
        const needNext = ${needNext};
        const p = ${findVisibleDatePanelCode};
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
      const p = ${findVisibleDatePanelCode};
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
    // 确保日历下拉面板已收起，避免遮挡底部「确认发布」按钮
    await this.client.clickByLocator(`
      const p = ${findVisibleDatePanelCode};
      if (!p) return null;
      return document.querySelector('.arco-modal-header, .arco-modal-title');
    `).catch(() => {});
    await this.client.sleep(150);
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
      const href = String(await this.client.evaluate('location.href').catch(() => ''));
      if (href.includes('chapter-manage') || (href.includes('/main/writer/') && !this.isEditPage(href))) {
        return true;
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

  // 读当前发布页头部的卷名。元素还没挂载 → 返回 null（"页面没好"和"卷名是空字符串"必须分开）。
  async readCurrentVolume() {
    const r = await this.client.evaluate(`(function(){var e=document.querySelector('.publish-header-volume-name');return {has:!!e,t:e?(e.textContent||''):''};})()`);
    if (!r || !r.has) return null;
    return (r.t || '').trim();
  }

  // 等卷名元素挂载出来。clickNewChapter 里只 sleep(3000)，慢的时候根本不够。
  async waitVolumeHeader(maxMs = this.config?.volumeWaitMs ?? 15000) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const v = await this.readCurrentVolume();
      if (v !== null) return v;
      if (Date.now() >= deadline) return null;
      await this.client.sleep(400);
    }
  }

  // 切换到指定卷（仅在发布页）。返回 {ok, current, found, notReady}。
  // 找不到目标卷 → ok:false（番茄建卷不可逆，绝不乱建，交由上层暂停并提示人工建卷）。
  // ⚠️【"番茄没有这个卷"必须拿得出证据】——《重生东京》2026-09-13 栽过：
  // 发完第311章后重新导航到发布页，卷名元素还没挂载 → 点它等于没点 → 模态没开 →
  // 分卷列表读到 0 项 → 判成"番茄该书没有卷第七卷"当场暂停；
  // 而同一分钟接口明明列着「第七卷：王座无冕」31 章。和"章节表没渲染完就判没这一章"是同一个病。
  // 现在的判据：列表没渲染出来 = 页面没好(notReady，交给上层软重试)；
  // 只有列表真渲染了、里面确实没有目标卷，才算 volume_missing。
  async switchToVolume(targetVolumeText) {
    if (!targetVolumeText) return { ok: true, skipped: true };
    await this.dismissDraftPrompt();
    const current = await this.waitVolumeHeader();
    if (current === null) {
      this.log('⚠️ 发布页的卷名元素一直没出来（页面没加载好）——不当成"番茄没有这个卷"', 'warn');
      return { ok: false, notReady: true, current: null, found: null };
    }
    if (current === targetVolumeText) { this.log(`卷已正确：${current}`); return { ok: true, current, alreadyThere: true }; }
    this.log(`切换卷：${current || '(未知)'} → ${targetVolumeText}`);

    // 打开分卷模态，并等列表真的渲染出来（byte/Arco 模态异步挂载）。最多开 3 次。
    const readNames = `(function(){var xs=document.querySelectorAll('.editor-volume-list-item-normal');var o=[];for(var i=0;i<xs.length;i++){var sp=xs[i].querySelector('span');o.push((((sp&&sp.textContent)||xs[i].textContent||'')+'').trim());}return JSON.stringify(o);})()`;
    let names = [];
    for (let attempt = 0; attempt < 3 && !names.length; attempt++) {
      await this.client.clickByLocator(`return document.querySelector('.publish-header-volume-name');`);
      const deadline = Date.now() + (this.config?.volumeListWaitMs ?? 8000);
      for (;;) {
        const r = await this.client.evaluate(readNames);
        try { names = JSON.parse(typeof r === 'string' ? r : '[]'); } catch { names = []; }
        if (names.length || Date.now() >= deadline) break;
        await this.client.sleep(400);
      }
    }
    if (!names.length) {
      this.log('⚠️ 分卷列表一直没渲染出来（模态没打开）——不当成"番茄没有这个卷"', 'warn');
      return { ok: false, notReady: true, current, found: null };
    }

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
      // 关掉模态再报。另外拿接口卷列表交叉验证：接口有、界面没有 → 是界面的问题，不是真缺卷。
      try { await this.client.clickByLocator(`const b=document.querySelectorAll('.byte-modal-footer button');for(const x of b){if((x.textContent||'').includes('取消'))return x;}return null;`); } catch {}
      const apiVols = Array.isArray(this.config?.fanqieVolumes) ? this.config.fanqieVolumes : [];
      if (apiVols.includes(targetVolumeText)) {
        this.log(`⚠️ 分卷列表里没有「${targetVolumeText}」，但接口卷列表里有它 → 按界面没刷新处理，重试（界面读到：${names.join(' / ')}）`, 'warn');
        return { ok: false, notReady: true, current, found: null };
      }
      this.log(`⚠️ 番茄该书没有卷「${targetVolumeText}」——后台实际只有：${names.join(' / ')}`, 'error');
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
    itemId: c.itemId || '',
    ...(c.scheduleDate ? { scheduleDate: c.scheduleDate } : {}),   // 编辑时顺带改期（见 editChapter）
  }));

  const client = new UnzooClient(profilePath || null, onLog || null);

  // 组装内部 config（与原 start(config) 字段对齐）
  const innerConfig = {
    chaptersPerDay: config.chaptersPerDay === 'max' ? 'max'
      : (config.chaptersPerDay != null ? parseInt(config.chaptersPerDay, 10) : 'max'),
    useAI: config.useAI !== false,   // 没传 = 是；只有明确 false 才申报「未使用 AI」
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
      // 预取全书章节 item_id 映射，使 editChapter 直接导航进编辑页，免去逐章翻页搜索
      const itemCachePath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.cache-items-' + bookId + '.json');
      let cachedMap = {};
      try { cachedMap = JSON.parse(fs.readFileSync(itemCachePath, 'utf8')) || {}; } catch {}
      try {
        await client.evaluate(`(function(){
          window.__ns_edit_map = 'PENDING';
          var api = 'https://fanqienovel.com/api/author';
          var cm = 'aid=2503&app_name=muye_novel';
          fetch(api + '/volume/volume_list/v1?' + cm + '&book_id=${bookId}', {credentials:'include'})
            .then(function(r){return r.json();})
            .then(function(vj){
              var vols = (vj && vj.data && (vj.data.volume_list || vj.data.list || vj.data.volumes)) || [];
              var tasks = [];
              vols.forEach(function(v){
                var pages = Math.max(3, Math.ceil((v.item_count || 300) / 100));
                for (var p = 0; p < pages; p++) {
                  tasks.push(
                    fetch(api + '/chapter/chapter_list/v1?' + cm + '&book_id=${bookId}&volume_id=' + v.volume_id + '&page_index=' + p + '&page_count=100&status=0', {credentials:'include'})
                      .then(function(r){return r.json();})
                      .then(function(cj){return (cj && cj.data && (cj.data.item_list || cj.data.chapter_list || cj.data.list || cj.data.items)) || [];})
                      .catch(function(){return [];})
                  );
                }
              });
              return Promise.all(tasks);
            })
            .then(function(lists){
              var mp = {};
              lists.forEach(function(arr){
                arr.forEach(function(ch){
                  var m = String(ch.title || '').match(/第\\s*(\\d+)\\s*章/);
                  if (m && ch.item_id) mp[parseInt(m[1], 10)] = String(ch.item_id);
                });
              });
              window.__ns_edit_map = JSON.stringify(mp);
            })
            .catch(function(){ window.__ns_edit_map = '{}'; });
          return 1;
        })()`);
        let applied = false;
        const applyMap = (mp) => {
          let matchedCount = 0;
          for (const m of mapped) {
            if (!m.itemId && m.chapterNumber && mp[m.chapterNumber]) {
              m.itemId = mp[m.chapterNumber];
              matchedCount++;
            }
          }
          if (matchedCount > 0) log(`⚡ 已预取 ${matchedCount}/${mapped.length} 章的直达 item_id`, 'info');
          applied = true;
        };
        for (let w = 0; w < 45; w++) {
          await client.sleep(300);
          const raw = await client.evaluate(`window.__ns_edit_map`);
          if (raw && raw !== 'PENDING') {
            let fetchedMp = {};
            try { fetchedMp = JSON.parse(raw) || {}; } catch {}
            const mp = { ...cachedMap, ...fetchedMp };
            if (Object.keys(mp).length > 0) {
              try { fs.writeFileSync(itemCachePath, JSON.stringify(mp), 'utf8'); } catch {}
            }
            applyMap(mp);
            break;
          }
        }
        if (!applied && Object.keys(cachedMap).length > 0) {
          applyMap(cachedMap);
        }
      } catch (e) {}
    } else {
      // 【开发之前先对齐番茄上已排的定时】见 signdiag.alignScheduleStart 的注释：
      // 原来没指定起始日期时一律从"明天"排，完全不看已经排着的待发布章节——
      // 《穿成王莽后》因此被排成 19 → 35 → 36 → 50 → 51 → 20……读者看完 19 章直接跳到 35。
      // 必须在打开编辑页【之前】读（publishChapter 假设页面已经停在编辑页，读完再跳过去）。
      // 读不到就照原逻辑走，但要说出来——沉默会被当成"已经对齐过了"。
      try {
        log('发布前核对番茄上已排的定时…');
        await client.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&1`);
        await client.sleep(6000);
        const rows = await readPendingSchedule(client);
        const a = alignScheduleStart(rows, innerConfig.scheduledStartDate);
        if (a.changed && a.date) {
          innerConfig.scheduledStartDate = a.date;
          log('📅 ' + a.reason, 'warn');
        } else {
          log('定时核对：' + a.reason);
        }
      } catch (e) {
        log('⚠️ 没能读到番茄上已排的定时（' + e.message + '）——按原逻辑发布，请发完到番茄后台核对章节上线顺序', 'warn');
      }
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
      // 编辑模式下被番茄拒收、已跳过的章（章号 + 原因）——上层据此不记指纹基线，下次同步还会再试
      rejected: (publisher.rejected || []).slice(),
      skipped: (publisher.skipped || []).slice(),
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
export async function getFanqieMaxChapter({ profilePath, bookId, onLog, client: injectedClient, volSwitchWaitMs = 12000 } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { maxChapter: 0, error: '缺少 bookId' };

  // client 可注入：只为可测（test/publish-volume-scan.test.mjs），线上仍是真 UnzooClient。
  const client = injectedClient || new UnzooClient(profilePath || null, onLog || null);
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
        var maxRowTs = 0, maxRowDate = '', rowDatesByCh = {};
        var rows = document.querySelectorAll('tr, [class*="table-tr"], [class*="list-item"], [role="row"]');
        rows.forEach(function(r){
          var t = r.innerText || '';
          var cm = t.match(/第\\s*(\\d+)\\s*章(?![0-9])/);
          if (!cm) return;
          var dm = t.match(/(\\d{4})-(\\d{2})-(\\d{2})(?:\\s+(\\d{2}):(\\d{2}))?/);
          if (!dm) return;
          rowDatesByCh[cm[1]] = dm[1] + '-' + dm[2] + '-' + dm[3];
          var ts = Date.parse(dm[0].replace(' ', 'T'));
          if (!isNaN(ts) && ts > maxRowTs) { maxRowTs = ts; maxRowDate = dm[0]; }
        });
        var maxDay = maxRowDate ? maxRowDate.slice(0, 10) : '';
        var maxDayCount = 0;
        if (maxDay) {
          Object.keys(rowDatesByCh).forEach(function(k){ if (rowDatesByCh[k] === maxDay) maxDayCount++; });
        }
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
        const sig = ${FanqiePublisher.ROW_SIG_JS};
        return { max, maxRowDate, maxDayCount, currentPage, totalPages, sig, valid, belongsToBook, errorPage, loginPage, onDomain, hasArco, hasManageChrome, emptyState, bodyLen: text.length, head: text.slice(0, 80) };
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

    // 读"当前所选卷"的最大章号（含分页：章节表按章号排序，最大号必在第1页或末页）。返回 {max, latestDate, latestDateCount, approx}
    const readCurVolMax = async () => {
      const r0 = await client.evaluate(readPage);
      if (!r0) return { max: 0, latestDate: '', latestDateCount: 0, approx: true };
      let max = r0.max || 0, latestDate = r0.maxRowDate || '', latestDateCount = r0.maxDayCount || 0, approx = false;
      let lastSig = r0.sig || '';   // 逐次跳页要跟【上一次读到的那页】比，不能一直跟最初那页比
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
          // 等【行内容真的换了】再读：只 sleep 固定时长会读到上一页的残留行（见 waitChapterRows 注释）。
          const prevSig = lastSig, waitUntil = Date.now() + 8000;
          let r = null;
          while (Date.now() < waitUntil) {
            r = await client.evaluate(readPage);
            if (r && r.sig && r.sig !== prevSig) break;
            await client.sleep(400);
          }
          if (!r || !r.sig || r.sig === prevSig) approx = true;   // 没等到换页数据 → 标近似，不硬当准
          else lastSig = r.sig;
          if (r && r.max > max) max = r.max;
          if (r && r.maxRowDate && (!latestDate || Date.parse(r.maxRowDate.replace(' ', 'T')) > Date.parse(latestDate.replace(' ', 'T')))) {
            latestDate = r.maxRowDate;
            latestDateCount = r.maxDayCount || 0;
          }
        }
      }
      return { max, latestDate, latestDateCount, approx };
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
    // 下拉当前显示的卷名
    const curVolName = async () => {
      const r = await client.evaluate(`(function(){
        const sel = (function(){ ${VOL_DROPDOWN} })();
        if (!sel) return null;
        const vv = sel.querySelector('.byte-select-view-value') || sel;
        return (vv.textContent || '').trim();
      })()`);
      return typeof r === 'string' ? r.trim() : (r == null ? null : String(r).trim());
    };

    // 选某卷。返回 {ok, already, switched}。
    // ⚠️【点完不等于切过去了】——原来点完只 sleep(1600) 就读表，番茄换卷的数据要几百毫秒到几秒才回来，
    // 这段窗口里【上一卷的行还在 DOM】→ 读到的是上一卷的章号，却记在这一卷名下。
    // 《重生东京》的日志就是这么自相矛盾的：同一本书先后报「第七卷=310」「第六卷=311」「第六卷=280」。
    // 后果是 maxChapter 时高时低；靠高水位兜底才没重复发布。
    // 现在要求：下拉显示值换成目标卷，【且】章节行签名真的变了（或明确是空卷），才算 switched。
    const selectVolume = async (name) => {
      const cur = await curVolName();
      if (cur === name) return { ok: true, already: true, switched: true };
      const before = await client.evaluate(readPage);
      const beforeSig = (before && before.sig) || '';
      const clickOpt = async () => await client.clickByLocator(`
        const want = ${JSON.stringify(name)};
        const opts = document.querySelectorAll('.byte-select-option, .arco-select-option, [class*="select-option"]');
        for (const o of opts) { if (o.offsetParent !== null && ((o.textContent || '').trim()) === want) return o; }
        return null;
      `);
      // 若 listVolumes 刚打开过下拉且未关掉，直接点选项；否则先点下拉框展开再点选项
      let clicked = await clickOpt();
      if (!clicked) {
        await client.clickByLocator(VOL_DROPDOWN);
        await client.sleep(600);
        clicked = await clickOpt();
      }
      if (!clicked) {
        await client.clickByLocator(VOL_DROPDOWN);
        await client.sleep(600);
        clicked = await clickOpt();
      }
      if (!clicked) return { ok: false, switched: false };
      const deadline = Date.now() + volSwitchWaitMs;
      let shown = false;
      while (Date.now() < deadline) {
        await client.sleep(400);
        if (!shown) shown = (await curVolName()) === name;
        if (!shown) continue;
        const r = await client.evaluate(readPage);
        if (r && (r.emptyState || ((r.sig || '') && (r.sig || '') !== beforeSig))) return { ok: true, switched: true };
      }
      return { ok: true, switched: false };
    };

    // 番茄章节表【按卷显示、无"全部"选项】，但章号是【全局连续】的。
    let maxChapter = 0, latestDate = '', latestDateCount = 0, approx = false;
    const vols = await listVolumes();
    if (vols.length <= 1) {
      // 单卷 / 读不到卷选择器 → 直接读当前卷
      const r = await readCurVolMax();
      maxChapter = r.max; latestDate = r.latestDate; latestDateCount = r.latestDateCount || 0; approx = r.approx;
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
        if (!sel.ok) { approx = true; scanned.push(`${v.name}=没点中`); continue; }
        // 切卷没验证成功就【不读】——读到的很可能是上一卷残留的行（见 selectVolume 注释）
        if (!sel.switched) { approx = true; scanned.push(`${v.name}=未切到(跳过)`); continue; }
        const r = await readCurVolMax();
        scanned.push(`${v.name}=${r.max}`);
        // approx 只能往上叠：前面有卷没切过去/没点中，后面这一卷读成功了也不能把近似标记抹掉
        if (r.max > 0) { maxChapter = r.max; latestDate = r.latestDate; latestDateCount = r.latestDateCount || 0; approx = approx || r.approx; break; }
      }
      log(`🔎 多卷扫描（从最新卷起、命中非空即止）：${scanned.join('、') || '(全空)'}`, 'info');
      // 🛡️安全网：多卷却一章都没扫到 → 必是卷切换/读取异常（多卷书不可能全空还在发布）。
      // 绝不返回 maxChapter=0（会被当"空书"从第1章重发，灾难）→ 阻断，让上层提示重试。
      if (maxChapter === 0) {
        log('⚠️ 多卷书未扫到任何已发章号——疑似卷列表读取异常，已中止以防从头重复发布（请重试）', 'error');
        return { maxChapter: 0, approx: true, error: '多卷书未能读到已发章号（疑似卷读取异常），为防重复发布已中止，请重试', pageInvalid: true };
      }
    }

    log(`📖 番茄已存在最大章号: 第${maxChapter}章${approx ? '（近似，分页/卷未读全）' : ''}${latestDate ? `，最新排期 ${latestDate}（当日已排 ${latestDateCount} 章）` : ''}`, 'info');
    return { maxChapter, approx, latestDate, latestDateCount };
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
    // 若弹出「有刚刚更新的章节，是否继续编辑？」弹窗，先点「放弃」关闭，否则会遮挡卷名与分卷模态
    await client.evaluate(`(function(){
      const modals = document.querySelectorAll('.byte-modal, .legacy-global-confirm-modal, .publish-modal-confirm');
      for (const m of modals) {
        if (m.offsetParent === null) continue;
        if ((m.innerText || '').includes('是否继续编辑')) {
          const b = [...m.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '放弃');
          if (b) { b.click(); return true; }
        }
      }
      return false;
    })()`);
    await client.sleep(500);
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

    // 聚焦 → 清空旧副标题 → 填新副标题（优先走 browser_type 真实输入，确保触发 React 状态更新）
    const focused = await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(!inp)return false;inp.focus();return true;})()`);
    if (!focused) { try { await client.clickByLocator(cancelRow); } catch {} return { ok: false, error: '未找到卷名输入框（番茄改版？）' }; }
    try {
      await unzooCallTool('browser_type', { tab_id: String(client.tabId), selector: INP_SEL, text: newSub, clear_first: true, timeout: 15000 });
      await client.sleep(500);
    } catch {}
    let typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
    if ((typed || '').trim() !== newSub) {
      await client.clearFocused();
      await client.sleep(200);
      await client.typeText(newSub);
      await client.sleep(400);
      typed = await client.evaluate(`((document.querySelector(${JSON.stringify(INP_SEL)})||{}).value||'')`);
    }
    if ((typed || '').trim() !== newSub) {
      await client.evaluate(`(function(){const inp=document.querySelector(${JSON.stringify(INP_SEL)});if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(newSub)});if(inp._valueTracker)inp._valueTracker.setValue('__force_diff__');inp.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(newSub)},inputType:'insertText'}));inp.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
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
      // 先走可信点击（human_click）——番茄的提交类按钮只认真实输入事件；合成序列能点开弹窗、
      // 却可能提交不了（2026-09-20 在作品信息页实证：点完退出编辑态，值还是旧的）。
      if (await client.trustedClickText(txt, { index: 0 })) return true;
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

// 标签弹窗三件套（阅读标签 / 内容标签）。建书要用，改分类也要用——所以提到模块级，
// 两处共用一套，免得番茄改版后只改好一处（主分类签约后不可改，赌不起）。
function tagHelpers(client, log = () => {}) {
  const FIRE = `function __fire(el){['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}`;

  // 弹窗里有四个分栏，四栏共用同一个类名 .category-choose-item（阅读标签整窗 154 张，
  // 主分类栏只有 19 张）。所以【必须限定在分栏内找，且全名相等】：
  //   · 不限定 → 可能点到别栏的同名词上，这一栏其实没选中；
  //   · 用 indexOf 子串匹配 → 要「悬疑」会先撞上「悬疑脑洞」「悬疑恋爱」。
  // 主分类【签约后不可改】，这里不能靠"多半能撞对"。
  const TAGJS = `
    function __sectionHost(modal, name){
      var host=null, best=1e9;
      var all=modal.querySelectorAll('*');
      for(var i=0;i<all.length;i++){
        var e=all[i], t=e.textContent||'';
        if(t.indexOf(name)<0) continue;
        if(!e.querySelectorAll('.category-choose-item').length) continue;
        if(t.length<best){best=t.length;host=e;}
      }
      return host;
    }
    function __cardName(e){ var ti=e.querySelector('.category-choose-item-title'); return ((ti?ti.textContent:e.textContent)||'').trim(); }
    function __bigModal(){
      var m=[].slice.call(document.querySelectorAll('.arco-modal')).filter(function(e){return e.getBoundingClientRect().width>300;});
      return m.length?m[m.length-1]:null;
    }`;

  // 打开某个标签选择框（阅读标签 / 内容标签），验证 + 重试。
  const openTagDialog = async (which) => {
    const isOpen = async () => (await client.evaluate(`(function(){${TAGJS} var m=__bigModal(); return m?'1':'0';})()`)) === '1';
    if (await isOpen()) return { ok: true };
    for (let i = 0; i < 5; i++) {
      const r = await client.evaluate(`(function(){${FIRE}
        var wrap=[].slice.call(document.querySelectorAll('.cate-wrap')).find(function(e){return (e.textContent||'').indexOf(${JSON.stringify('WHICH')})>=0;});
        if(!wrap) return 'no-wrap';
        var sv=wrap.querySelector('.select-view')||wrap.querySelector('.select-row');
        if(!sv) return 'no-sv';
        __fire(sv);
        return 'fired';
      })()`.replace(JSON.stringify('WHICH'), JSON.stringify(which)));
      if (r === 'no-wrap' || r === 'no-sv') return { ok: false, why: `未找到「${which}」选择框（番茄改版？）` };
      await client.sleep(1800);
      if (await isOpen()) return { ok: true };
      log(`「${which}」弹窗没打开，重试第 ${i + 1} 次…`, 'warn');
    }
    return { ok: false, why: `「${which}」弹窗点了 5 次都没打开（页面没加载完 / 有东西挡着 / 番茄改版）` };
  };

  // 在已打开的弹窗里，按分栏勾选若干标签。
  // wanted = { 分栏名: [标签名…] }。返回 {ok, picked:[], missed:[]}。
  // 【点了不等于选上了】选中的卡片会加 active 类，而且是 React 异步加的——
  // 点完立刻查会查到"没选中"（实测 1.2 秒内还没加上）。所以逐个轮询确认。
  const selectTags = async (wanted) => {
    const picked = [], missed = [];
    for (const [section, names] of Object.entries(wanted)) {
      for (const name of (names || [])) {
        const r = await client.evaluate(`(function(){${FIRE}${TAGJS}
          var m=__bigModal(); if(!m) return 'no-modal';
          var host=__sectionHost(m, ${JSON.stringify(section)}); if(!host) return 'no-section';
          var items=[].slice.call(host.querySelectorAll('.category-choose-item'));
          var hit=items.filter(function(e){return __cardName(e)===${JSON.stringify(name)};})[0];
          if(!hit) return 'MISS|'+items.map(__cardName).join('、');
          if(hit.classList.contains('active')) return 'ALREADY';
          __fire(hit);
          return 'FIRED';
        })()`);
        if (r === 'no-modal') return { ok: false, why: '弹窗不见了' };
        if (r === 'no-section') { missed.push(`${section}·${name}（这个弹窗里没有「${section}」这一栏）`); continue; }
        if (String(r).startsWith('MISS|')) { missed.push(`${section}·${name}（该栏没有这一项）`); continue; }
        if (r === 'ALREADY') { picked.push(`${section}·${name}`); continue; }
        let on = false;
        for (let i = 0; i < 8 && !on; i++) {
          await client.sleep(400);
          on = (await client.evaluate(`(function(){${TAGJS}
            var m=__bigModal(); if(!m) return '0';
            var host=__sectionHost(m, ${JSON.stringify(section)}); if(!host) return '0';
            var hit=[].slice.call(host.querySelectorAll('.category-choose-item')).filter(function(e){return __cardName(e)===${JSON.stringify(name)};})[0];
            return (hit&&hit.classList.contains('active'))?'1':'0';
          })()`)) === '1';
        }
        if (on) picked.push(`${section}·${name}`);
        else missed.push(`${section}·${name}（点了但没选上，可能超了该栏上限）`);
      }
    }
    return { ok: true, picked, missed };
  };

  // 点「确认」关掉弹窗。灰着/没关 都要报出来——那意味着没存进去。
  const confirmTagDialog = async (which) => {
    const r = await client.evaluate(`(function(){${FIRE}
      var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return (e.textContent||'').trim()==='确认';}).pop();
      if(!b) return 'no-btn';
      if(b.disabled) return 'disabled';
      __fire(b);
      return 'ok';
    })()`);
    if (r === 'no-btn') return { ok: false, why: `「${which}」弹窗里没找到「确认」按钮` };
    if (r === 'disabled') return { ok: false, why: `「${which}」的「确认」按钮是灰的——必选项可能还没选` };
    await client.sleep(1400);
    const still = (await client.evaluate(`(function(){${TAGJS} return __bigModal()?'1':'0';})()`)) === '1';
    if (still) return { ok: false, why: `点了「确认」但「${which}」弹窗没关——没存进去，先别创建` };
    return { ok: true };
  };

  return { openTagDialog, selectTags, confirmTagDialog, TAGJS, FIRE };
}

// ===== 在番茄【创建一本新书】=====
// 全自动：导航 /main/writer/create → 原生 setter 填 书名/男女频/主角名/简介 →
//         CDP 可信点击 打开作品标签弹窗、选主分类卡片、确认 → 点「立即创建」→ 跳转后抓回 bookId。
// autoSubmit=false 则填好停在表单，返回 semiManual（人工核对后自己点「立即创建」）。
// 坑：Arco 受控输入要用原生 value setter；弹窗卡片/确认/立即创建 合成点击不触发，必须 CDP 可信点击。
// signMode：番茄 2026-09 新增的【必填】项，默认两个都不选，不设就过不了校验。
// 默认「连载模式」——作者确认过「我们一般都选连载模式」，也跟本工具的工作方式一致：
// 边写边发（每天 N 章、断点续发、重发修正、完结收口全是增量流程）。
// 完本模式要求整书一次性上传、完本且满 15 万/30 万字才可签约，跟这条流水线冲突。
export async function createFanqieBook({ profilePath, title, channel = '男频', signMode = '连载模式', mainCategory, readTags = null, contentTags = null, hero = '', hero2 = '', synopsis, coverPath = '', autoSubmit = true, onLog } = {}) {
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
  if (signMode !== '连载模式' && signMode !== '完本模式') signMode = '连载模式';

  const client = new UnzooClient(profilePath, onLog, 'fanqienovel.com', '番茄');
  await client.ensureTabId();

  // 原生 setter：填 Arco 受控 input/textarea（合成 input+change 触发 React 状态）
  const SETTER = `function __sv(el,val){var pr=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(pr,'value').set;s.call(el,val);if(el._valueTracker)el._valueTracker.setValue('__force_diff__');el.dispatchEvent(new InputEvent('input',{bubbles:true,data:val,inputType:'insertText'}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

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

  // 【单选组一律按"表单项标签"限定范围，并且设完要验】
  // 页面现在有两组单选：签约模式(连载/完本) 和 目标读者(男频/女频)，而且【两组默认都不选】。
  // 原来那句是全页面找 textContent==='男频' 的元素直接点——只有一组时侥幸没出事，
  // 多一组就成了定时炸弹。而且点完从不检查，设没设上全凭运气。
  const setRadio = async (groupLabel, value) => {
    const r = await client.evaluate(`(function(){
      function fire(el){['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}
      var it=[].slice.call(document.querySelectorAll('.arco-form-item')).find(function(e){var l=e.querySelector('.arco-form-label-item,label');return l&&(l.textContent||'').indexOf(${JSON.stringify(groupLabel)})>=0;});
      if(!it) return 'no-group';
      var rd=[].slice.call(it.querySelectorAll('.arco-radio')).find(function(x){return (x.textContent||'').trim()===${JSON.stringify(value)};});
      if(!rd) return 'no-option';
      fire(rd);
      return 'fired';
    })()`);
    if (r === 'no-group') return { ok: false, why: `页面上没有「${groupLabel}」这一项（番茄改版？）` };
    if (r === 'no-option') return { ok: false, why: `「${groupLabel}」里没有「${value}」这个选项` };
    for (let i = 0; i < 6; i++) {
      await client.sleep(400);
      const on = await client.evaluate(`(function(){
        var it=[].slice.call(document.querySelectorAll('.arco-form-item')).find(function(e){var l=e.querySelector('.arco-form-label-item,label');return l&&(l.textContent||'').indexOf(${JSON.stringify(groupLabel)})>=0;});
        if(!it) return '';
        var rd=[].slice.call(it.querySelectorAll('.arco-radio')).filter(function(x){return x.classList.contains('arco-radio-checked');})[0];
        return rd?(rd.textContent||'').trim():'';
      })()`);
      if (on === value) return { ok: true };
    }
    return { ok: false, why: `点了「${groupLabel}→${value}」但它没被选中` };
  };

  // 2. 签约模式（番茄新增的【必填】项，默认两个都不选）
  // 连载模式：满2万字可发起签约，满8万字后可主动发起推荐流程，按单章审核，签约后可持续更新、灵活调整方向
  // 完本模式：完本且满15万/30万字后才可发起签约，整书一次性上传、按整书审核
  // 本工具是【边写边发】的（每天N章、断点续发、重发修正、完结收口全是增量流程），
  // 所以默认连载模式；完本模式要求整书传完才签约，跟这条流水线是冲突的。
  log(`签约模式：${signMode}`);
  { const r = await setRadio('签约模式', signMode); if (!r.ok) return { ok: false, error: '签约模式没设上：' + r.why }; }

  // 3. 目标读者（男频/女频）——同样默认不选，同样要验
  { const r = await setRadio('目标读者', channel); if (!r.ok) return { ok: false, error: '目标读者（男/女频）没设上：' + r.why }; }
  // 3. 主角名
  if (hero) { await client.evaluate(`(function(){${SETTER} var el=document.querySelector('input[placeholder*=主角名1]');if(el){el.focus();__sv(el,${JSON.stringify(String(hero).slice(0, 5))});}return 1;})()`); await client.sleep(300); }
  if (hero2) { await client.evaluate(`(function(){${SETTER} var el=document.querySelector('input[placeholder*=主角名2]');if(el){el.focus();__sv(el,${JSON.stringify(String(hero2).slice(0, 5))});}return 1;})()`); await client.sleep(300); }
  // 4. 简介
  log(`填简介(${intro.length}字)…`);
  await client.evaluate(`(function(){${SETTER} var el=document.querySelector('textarea');if(el){el.focus();__sv(el,${JSON.stringify(intro)});}return 1;})()`);
  await client.sleep(500);

  // 5. 作品标签弹窗 → 主分类卡片 → 确认（CDP 可信点击）
  log(`选择主分类「${cat}」…`);
  // 【先把挡路的引导弹窗关掉】2026-09-17 实测：创建作品页会弹一个「签约模式说明」(.sign-pattern-guide-modal，
  // 640x404) 盖在表单上。它一挡，下面这一下点击就落到遮罩上 → 标签弹窗根本不开，
  // 最后报出来的却是"未找到「作品标签」选择框"或"没找到主分类"，跟真因差着十万八千里。
  await client.evaluate(`(function(){
    var n=0;
    [].slice.call(document.querySelectorAll('.arco-modal')).forEach(function(md){
      if(md.getBoundingClientRect().width<100) return;
      if(/阅读标签|内容标签/.test(md.textContent||'')) return;   // 别误关我们要用的那个
      var b=[].slice.call(md.querySelectorAll('button,.arco-btn')).find(function(x){return /我知道了|知道了|开始创作|关闭|取消/.test((x.textContent||'').trim());});
      if(b){b.click();n++;return;}
      var c=md.querySelector('.arco-modal-close-icon,[class*=close]'); if(c){c.click();n++;}
    });
    return n;
  })()`);
  await client.sleep(1200);
  // 【这一段全部改用「页面自己的合成事件」，不用 CDP 可信点击】
  // 2026-09-18 实测（作者撞上"没找到历史脑洞"后现场复现）：对「阅读标签」这个 .select-view
  // 用 cdpClick 打过去，弹窗【纹丝不动】；换成往元素上派发 pointerdown/mousedown/…/click，
  // 一次就开。分类卡也一样：合成点击后类名从 category-choose-item 变成
  // category-choose-item active，「确认」按钮当场可点。
  //
  // 之前我以为 cdpClick 有效，是因为验证方式本身错了：先用合成事件开了弹窗，
  // 再用 cdpClick 点一次，看到弹窗开着就当成 cdpClick 成功——它其实一次都没生效过。
  //
  // 【每一步都要验证，不能 fire-and-forget】这一下点击本身就不稳（同样的代码，
  // 有时第一次开、有时不开）。不验证的话，失败会一路飘到"没找到主分类"，
  // 报出来的原因跟真因差着十万八千里。
  const { openTagDialog, selectTags, confirmTagDialog, TAGJS } = tagHelpers(client, log);

  // —— 阅读标签：主分类(必选1) + 主题/角色/情节(各≤2) ——
  log(`选择阅读标签（主分类「${cat}」${Object.values(readTags || {}).flat().length ? ' + ' + Object.values(readTags).flat().join('、') : ''}）…`);
  { const r = await openTagDialog('阅读标签'); if (!r.ok) return { ok: false, error: r.why }; }
  {
    const r = await selectTags({ 主分类: [cat] });
    if (!r.ok) return { ok: false, error: r.why };
    if (!r.picked.length) {
      // 找不到主分类时【把该栏真实有的列出来】，别拿"频道不对"去猜原因——
      // 作者撞过一次：报"男频不含历史脑洞"，而历史脑洞就是男频第 10 项，真因是弹窗没打开。
      const have = await client.evaluate(`(function(){${TAGJS}
        var m=__bigModal(); if(!m) return '';
        var host=__sectionHost(m,'主分类'); if(!host) return '';
        return [].slice.call(host.querySelectorAll('.category-choose-item')).map(__cardName).join('、');
      })()`);
      return { ok: false, error: `「阅读标签」的主分类栏里没有「${cat}」。该栏当前有：${have || '(读不到)'}` };
    }
    log(`主分类「${cat}」已选中`);
    if (readTags && Object.keys(readTags).length) {
      const r2 = await selectTags(readTags);
      if (r2.picked.length) log(`阅读标签已选：${r2.picked.join('、')}`);
      if (r2.missed.length) log(`阅读标签没选上：${r2.missed.join('；')}`, 'warn');
    }
  }
  { const r = await confirmTagDialog('阅读标签'); if (!r.ok) return { ok: false, error: r.why }; }

  // —— 内容标签：情节≤4 / 情感≤2 / 人设≤4 / 世界观≤1。全可选，选不上不拦着建书 ——
  // 作者要求「内容标签也需要提前选好」。但它不是必填，所以这里失败只警告不中断：
  // 为了几个分发标签把整本书的创建卡住，得不偿失（主分类那种必选项才值得拦）。
  if (contentTags && Object.values(contentTags).flat().length) {
    log(`选择内容标签（${Object.values(contentTags).flat().join('、')}）…`);
    const op = await openTagDialog('内容标签');
    if (!op.ok) log(`内容标签没能打开：${op.why}（不影响创建，可事后在番茄补）`, 'warn');
    else {
      const r = await selectTags(contentTags);
      if (r.picked.length) log(`内容标签已选：${r.picked.join('、')}`);
      if (r.missed.length) log(`内容标签没选上：${r.missed.join('；')}`, 'warn');
      const cf = await confirmTagDialog('内容标签');
      if (!cf.ok) log(`内容标签没存上：${cf.why}（不影响创建，可事后在番茄补）`, 'warn');
    }
  }

  if (!autoSubmit) {
    return { ok: true, semiManual: true, msg: `已在番茄填好《${title}》创建表单（${channel}·${cat}·简介${intro.length}字）。请到该浏览器核对后点「立即创建」。` };
  }

  // 6. 立即创建（不可逆）
  log('点击「立即创建」…');
  const createCoord = await client.evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(e){return (e.textContent||'').trim()==='立即创建';});if(!b)return '';var r=b.getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()");
  if (!createCoord) return { ok: false, error: '未找到「立即创建」按钮' };
  if (!(await client.trustedClickText("立即创建"))) return { ok: false, error: "点不动「立即创建」按钮" };

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

// ===== 改番茄「作品信息」里的书名 / 简介 =====
// 为什么要有：签约被拒的原因之一就是「书名和简介卖的东西正文没兑现」。改完正文往往就要同步改文案，
// 而以前引擎只能改封面和卷名，书名简介得人工去网页改（2026-09-20 王莽这本第一次真用上）。
// 实地结构（book-info/<id>?type=1 → 点「修改」进编辑态）：
//   · 书名   = 可见 input，maxlength=15   ← 15 字是番茄的硬上限，超了直接填不进去
//   · 简介   = 可见 textarea，上限 500 字（页面角标 190/500）
//   · 提交   = 「立即修改」按钮；旁边还有「取消」「选择封面」
// 注意：受控组件必须用原生 setter 派发 input/change，直接赋 value 番茄读不到。
export async function updateFanqieBookInfo({ bookId, profilePath, title = '', intro = '', mainCategory = '', readTags = null, contentTags = null, autoSubmit = true, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!bookId) return { ok: false, error: '缺少番茄 bookId' };
  title = String(title || '').trim();
  intro = String(intro || '').trim();
  const wantTags = !!(mainCategory || (readTags && Object.values(readTags).flat().length) || (contentTags && Object.values(contentTags).flat().length));
  if (!title && !intro && !wantTags) return { ok: false, error: '书名、简介、标签都没给，没什么可改的' };
  if (title && [...title].length > 15) return { ok: false, error: `书名 ${[...title].length} 字，番茄上限 15 字` };
  if (intro && ([...intro].length < 50 || [...intro].length > 500)) return { ok: false, error: `简介 ${[...intro].length} 字，番茄要求 50–500 字` };

  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');
  const Q = (s) => JSON.stringify(s);
  const fire = async (txt) => client.evaluate(`(function(){var l=[].slice.call(document.querySelectorAll('button,div[role=button],span,a,li')).filter(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});var btns=l.filter(function(e){return e.tagName==='BUTTON';});var b=(${Q(txt)}==='修改'&&btns.length)?btns[0]:(btns[btns.length-1]||l[l.length-1]);if(!b)return false;try{b.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){b.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
  const SETTER = `function __sv(el,val){var pr=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(pr,'value').set;s.call(el,val);if(el._valueTracker)el._valueTracker.setValue('__force_diff__');el.dispatchEvent(new InputEvent('input',{bubbles:true,data:val,inputType:'insertText'}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;
  // 书名框认 maxlength=15；简介框是页面上唯一可见的 textarea
  const TITLE_EL = `[].slice.call(document.querySelectorAll('input')).filter(function(e){return e.offsetParent!==null&&e.maxLength===15;})[0]`;
  const INTRO_EL = `[].slice.call(document.querySelectorAll('textarea')).filter(function(e){return e.offsetParent!==null;})[0]`;

  try {
    await client.getActiveTab();
    log('打开番茄「作品信息」页…');
    await client.navigate(`https://fanqienovel.com/main/writer/book-info/${bookId}?type=1`);
    await client.sleep(6000);
    // 从别的 tab（签约管理）跳过来时地址栏虽对、内容可能还停在旧 tab → 只有确实没看到「书本名称」才去点标签
    if (!String(await client.evaluate("(document.body.innerText||'')") || '').includes('书本名称')) {
      await fire('作品信息');
      await client.sleep(3000);
    }

    const needTitleEl = !!title;
    const before = await client.evaluate(`(function(){var t=${TITLE_EL},i=${INTRO_EL};return JSON.stringify({title:t?t.value:'',intro:i?String(i.value||'').slice(0,40):'',hasForm:${needTitleEl ? '!!(t&&i)' : '!!i'}});})()`);
    let inEdit = (typeof before === 'string' ? JSON.parse(before) : before)?.hasForm;
    // 【审核中 = 改不了，别再瞎点】番茄对作品信息的每次修改都要审核，审核期间「修改」按钮是 disabled，
    // 页面上明写「作品信息审核中，请稍后再做修改」。不认这个状态的话，上层只会看到一句
    // “没能进入编辑态”，人会以为是自动化坏了（2026-09-20 我就先这么误判了一轮）。
    if (!inEdit) {
      const pageTxt = String(await client.evaluate("(document.body.innerText||'')") || '');
      const disabled = await client.evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='修改';});return !!(b&&(b.disabled||b.getAttribute('disabled')!==null));})()");
      if (/作品信息审核中|请稍后再做修改/.test(pageTxt) || disabled) {
        return { ok: false, pending: true, error: '番茄正在审核上一次的作品信息修改，期间不允许再改（页面写着「作品信息审核通过后才能再次修改」）。等审核出结果再来。' };
      }
      log('进入编辑态…');
      // 「修改」也用真实坐标点击：合成事件在这页时灵时不灵（页面文本里"更多申请完结修改"是连在一起的，
      // 说明这几个按钮同在一行，合成事件容易落到错的节点上）。
      // 进编辑态用合成指针序列：实测它有效，而 human_click 虽然回 ok:true 却不触发这颗按钮
      for (let i = 0; i < 3 && !inEdit; i++) {
        await client.trustedClickText('修改', { index: 0 });
        await client.sleep(1500);
        inEdit = !!(await client.evaluate(needTitleEl ? `!!(${TITLE_EL}) && !!(${INTRO_EL})` : `!!(${INTRO_EL})`));
        if (!inEdit) {
          await fire('修改');
          await client.sleep(2000);
          inEdit = !!(await client.evaluate(needTitleEl ? `!!(${TITLE_EL}) && !!(${INTRO_EL})` : `!!(${INTRO_EL})`));
        }
      }
    }
    if (!inEdit) return { ok: false, error: '没能进入作品信息的编辑态（未登录/页面结构变了/该书不可改）' };

    // 【必须真打字，不能灌 value】2026-09-20 实证：用原生 setter 灌进去，框里显示对了，
    // 点「立即修改」也退出了编辑态，可保存下来的还是旧书名旧简介——番茄的表单状态没收到这次变更。
    // browser_type 是真实键盘事件（中文走 IME 提交），填完再回读校验。
    // 三级输入，逐级退。【注入永远排最后】——它填得进框、却进不了表单状态，提交上去还是旧值，
    // 这个坑 2026-09-20/21 连栽三次（王莽改书名、代码逆子改简介各一次）。
    //   ① browser_type：真实键盘事件，中文走 IME 提交
    //   ② human_type：真人式逐字输入，自带读回校验（browser_type 偶发报错时顶上）
    //   ③ 原生 setter 注入：只当最后一线希望，并且【明说它多半白填】
    const typeInto = async (selector, text, what) => {
      const el = selector.startsWith('textarea') ? INTRO_EL : TITLE_EL;
      const readBack = async () => String(await client.evaluate(`(function(){var e=${el};return e?e.value:'';})()`) || '');
      // ① 优先用 browser_type 定位可见 selector
      const tries = [
        ['browser_type', { tab_id: String(client.tabId), selector, text, clear_first: true, timeout: 15000 }],
      ];
      for (const [tool, args] of tries) {
        try {
          await unzooCallTool(tool, args, 240000);
          await client.sleep(800);
          if (await readBack() === text) return true;
          log(`${what} 用 ${tool} 填完对不上，换下一种`, 'warn');
        } catch (e) {
          log(`${what} ${tool} 失败（${String(e.message || e).replace(/\s+/g, ' ').slice(0, 80)}），换 focus+typeText`, 'warn');
        }
      }
      // ② 聚焦到真实可见元素 → clearFocused → typeText（真实键盘事件，能进 React 表单状态）
      try {
        await client.evaluate(`(function(){var e=${el};if(e){e.scrollIntoView({block:'center'});e.focus();e.click();}})()`);
        await client.sleep(200);
        await client.clearFocused();
        await client.sleep(200);
        await client.typeText(text);
        await client.sleep(600);
        if (await readBack() === text) return true;
      } catch {}
      // ③ 最后兜底 setter 注入
      await client.evaluate(`(function(){${SETTER}var el=${el};if(el){el.focus();__sv(el,${Q(text)});}return 1;})()`);
      await client.sleep(800);
      return await readBack() === text;
    };
    if (title) {
      const ok = await typeInto('input[placeholder="请输入作品名称"]', title, '书名');
      log(ok ? `已填新书名：《${title}》` : '填书名失败', ok ? 'info' : 'error');
      if (!ok) return { ok: false, error: '书名没填进去（可能超长被番茄截断）' };
    }
    if (intro) {
      const ok = await typeInto('textarea', intro, '简介');
      log(ok ? `已填新简介（${[...intro].length} 字）` : '填简介失败', ok ? 'info' : 'error');
      if (!ok) return { ok: false, error: '简介没填进去（可能超长被番茄截断）' };
    }

    // —— 阅读标签 / 内容标签：编辑态用的就是建书页那套 .cate-wrap（2026-09-20 实地确认），
    //    所以直接复用 tagHelpers，番茄哪天改版也只用改一处。
    const tagNotes = [];
    if (wantTags) {
      const { openTagDialog, selectTags, confirmTagDialog } = tagHelpers(client, log);
      if (mainCategory || (readTags && Object.values(readTags).flat().length)) {
        const op = await openTagDialog('阅读标签');
        if (!op.ok) tagNotes.push('阅读标签没能打开：' + op.why);
        else {
          const want = { ...(mainCategory ? { 主分类: [mainCategory] } : {}), ...(readTags || {}) };
          const r = await selectTags(want);
          if (r.picked?.length) log('阅读标签已选：' + r.picked.join('、'));
          if (r.missed?.length) tagNotes.push('阅读标签没选上：' + r.missed.join('；'));
          const cf = await confirmTagDialog('阅读标签');
          if (!cf.ok) tagNotes.push('阅读标签没存上：' + cf.why);
        }
      }
      if (contentTags && Object.values(contentTags).flat().length) {
        const op = await openTagDialog('内容标签');
        if (!op.ok) tagNotes.push('内容标签没能打开：' + op.why);
        else {
          const r = await selectTags(contentTags);
          if (r.picked?.length) log('内容标签已选：' + r.picked.join('、'));
          if (r.missed?.length) tagNotes.push('内容标签没选上：' + r.missed.join('；'));
          const cf = await confirmTagDialog('内容标签');
          if (!cf.ok) tagNotes.push('内容标签没存上：' + cf.why);
        }
      }
      for (const n of tagNotes) log(n, 'warn');
    }

    if (!autoSubmit) {
      return { ok: true, semiManual: true, tagNotes, msg: '已在番茄填好新书名/简介/标签，请到浏览器核对后点「立即修改」' };
    }
    // 【提交必须是真实坐标点击】合成指针序列能点开弹窗、却提交不了：实测点完编辑态是退出了，
    // 值却还是旧的（番茄把它当成取消）。createFanqieBook 的「立即创建」当年也是这么踩出来的，
    // 那边用的就是 cdpClick 坐标点击。
    log('点击「立即修改」…', 'act');
    await client.trustedClickText('立即修改');
    await client.sleep(800);
    if (await client.evaluate(`[].slice.call(document.querySelectorAll('button')).some(function(e){return (e.textContent||'').trim()==='立即修改'&&e.offsetParent!==null;})`)) {
      await fire('立即修改');
      await client.sleep(800);
    }
    await client.sleep(2500);
    // 可能弹二次确认（确定/确认/继续修改）
    for (const t of ['确定', '确认', '继续修改']) {
      const has = await client.evaluate(`[].slice.call(document.querySelectorAll('button')).some(function(e){return (e.textContent||'').trim()===${Q(t)}&&e.offsetParent!==null;})`);
      if (has) { await client.trustedClickText(t); log(`确认弹窗：点了「${t}」`); await client.sleep(1500); break; }
    }
    await client.sleep(3000);
    // 回读校验：番茄可能弹校验错误（敏感词/重名），不看回读就报成功等于骗自己
    const err = await client.evaluate("(function(){var e=document.querySelector('.arco-message-error,[class*=message-error]');return e?(e.textContent||'').trim().slice(0,80):'';})()");
    if (err) return { ok: false, error: '番茄拒绝修改：' + err };
    await client.navigate(`https://fanqienovel.com/main/writer/book-info/${bookId}?type=1`);
    await client.sleep(5000);
    const page = String(await client.evaluate("(document.body.innerText||'').slice(0,4000)") || '');
    const titleOk = !title || page.includes(title);
    const introOk = !intro || page.includes(intro.slice(0, 20));
    log(`回读校验：书名 ${titleOk ? '✅' : '❌'}　简介 ${introOk ? '✅' : '❌'}`, titleOk && introOk ? 'act' : 'warn');
    return { ok: titleOk && introOk, submitted: true, titleOk, introOk, title, introLen: [...intro].length, tagNotes };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 把「书名实验」候选推到番茄「多书名实验·实验配置」（设置别名 + 逐个上传封面）=====
// items: [{title, coverPath}]（coverPath 可空=该候选不传封面）。autoSubmit=false 默认：填好停在实验配置，
// ===== 扫描番茄「多书名实验」资格与状态（单书或全账号全部签约书）=====
// 状态码：1=未达条件, 2=待实验(可开启), 3=校验中, 4=校验未通过(可修改配置), 5=实验中, 6=实验结果待确认, 7=实验已结束(最优书名生效/未生效), 8/9=已失效
export const NAME_EXP_STATUS_TEXT = {
  1: '未达开启条件',
  2: '待实验（可开启）',
  3: '校验中',
  4: '校验未通过（可修改）',
  5: '实验中',
  6: '待确认最优书名',
  7: '已结束',
  8: '已失效',
  9: '已失效',
  10: '责编提交实验',
};

export async function scanFanqieNameExperiments({ profilePath, bookId, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');
  try {
    await client.getActiveTab();
    const curUrl = await client.evaluate('location.href');
    if (!curUrl || !String(curUrl).includes('fanqienovel.com')) {
      log('打开番茄「多书名实验」页…');
      await client.navigate('https://fanqienovel.com/main/writer/name-experiment');
      await client.sleep(2200);
    }
    await client.evaluate(`(function(){
      window.__neScanResult = '';
      (async function(){
        try {
          var targetBid = ${JSON.stringify(bookId || '')};
          if (targetBid) {
            var r = await fetch('/api/author/multiple_name/infos/v0/?aid=2503&app_name=muye_novel&book_id=' + encodeURIComponent(targetBid)).then(function(x){return x.json();});
            window.__neScanResult = JSON.stringify({ ok: true, single: true, bookId: targetBid, infoList: (r && r.data && r.data.info_list) || [] });
            return;
          }
          async function fetchWithTimeout(u, ms) {
            return Promise.race([
              fetch(u).then(function(x){return x.json();}).catch(function(){return null;}),
              new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, ms || 2500); })
            ]);
          }
          var sbl = await fetchWithTimeout('/api/author/stats/book_list/v0/?aid=2503&app_name=muye_novel&page_count=-1&page_index=0&image_fmt_list=160x214', 5000);
          var list = (sbl && sbl.data && sbl.data.stats_book_list) || [];
          var out = new Array(list.length);
          var idx = 0;
          async function worker() {
            while (idx < list.length) {
              var i = idx++;
              var b = list[i];
              var inf = await fetchWithTimeout('/api/author/multiple_name/infos/v0/?aid=2503&app_name=muye_novel&book_id=' + encodeURIComponent(b.book_id), 2500);
              out[i] = {
                bookId: b.book_id,
                bookName: b.book_name,
                aliasName: b.alias_name || '',
                chapterNum: b.chapter_num || 0,
                wordNumber: b.word_number || 0,
                thumbUrl: (b.thumb_url_list && b.thumb_url_list[0] && b.thumb_url_list[0].main_url) || (b.thumb_url && b.thumb_url[0] && b.thumb_url[0].main_url) || '',
                infoList: (inf && inf.data && inf.data.info_list) || []
              };
            }
          }
          await Promise.all([worker(), worker(), worker()]);
          window.__neScanResult = JSON.stringify({ ok: true, single: false, books: out.filter(Boolean) });
        } catch (err) {
          window.__neScanResult = JSON.stringify({ ok: false, error: String(err && err.message || err) });
        }
      })();
      return 'started';
    })()`);
    for (let w = 0; w < 50; w++) {
      await client.sleep(450);
      const raw = await client.evaluate('window.__neScanResult || ""');
      if (raw && typeof raw === 'string') {
        try {
          const res = JSON.parse(raw);
          if (res && ('ok' in res)) return res;
        } catch {}
      } else if (raw && typeof raw === 'object' && ('ok' in raw)) {
        return raw;
      }
    }
    return { ok: false, error: '扫描番茄多书名实验超时，请确认浏览器已登录番茄作者后台' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 批量调用番茄「实验书名查重」接口 (/api/author/multiple_name/check_name/v0/) =====
export async function checkFanqieExperimentNames({ profilePath, titles = [], onLog } = {}) {
  const cleanTitles = (titles || []).map(t => String(t || '').trim()).filter(Boolean);
  if (!cleanTitles.length) return { ok: true, results: [] };
  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');
  try {
    await client.getActiveTab();
    const curUrl = await client.evaluate('location.href');
    if (!curUrl || !String(curUrl).includes('fanqienovel.com')) {
      await client.navigate('https://fanqienovel.com/main/writer/name-experiment');
      await client.sleep(2000);
    }
    await client.evaluate(`(function(){
      window.__neCheckNames = '';
      (async function(){
        var list = ${JSON.stringify(cleanTitles)};
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var t = list[i];
          if (t.length > 15) {
            out.push({ title: t, len: t.length, valid: false, reason: '超过15字上限' });
            continue;
          }
          if (/\\s/.test(t) || t.replace(/[a-zA-Z0-9]|[\\uff0c\\uff1a\\uff01\\uff1f\\u3010\\u3011]|[\\u4e00-\\u9fa5]/g, '').length > 0) {
            out.push({ title: t, len: t.length, valid: false, reason: '含空格或不支持的标点符号' });
            continue;
          }
          try {
            var r = await fetch('/api/author/multiple_name/check_name/v0/?aid=2503&app_name=muye_novel&book_name=' + encodeURIComponent(t)).then(function(x){return x.json();});
            var ok = !!(r && r.code === 0 && r.data && r.data.is_valid);
            out.push({ title: t, len: t.length, valid: ok, reason: ok ? '' : ((r && r.data && r.data.invalid_reason) || '书名重名或不可用') });
          } catch (e) {
            out.push({ title: t, len: t.length, valid: false, reason: '网络请求失败' });
          }
        }
        window.__neCheckNames = JSON.stringify({ ok: true, results: out });
      })();
      return 'started';
    })()`);
    for (let w = 0; w < 25; w++) {
      await client.sleep(400);
      const raw = await client.evaluate('window.__neCheckNames || ""');
      if (raw && typeof raw === 'string') {
        try {
          const res = JSON.parse(raw);
          if (res && ('ok' in res)) return res;
        } catch {}
      } else if (raw && typeof raw === 'object' && ('ok' in raw)) {
        return raw;
      }
    }
    return { ok: false, error: '书名查重超时' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 把「书名实验」候选推到番茄「多书名实验·实验配置」（设置别名 + 极速上传封面 + 可选自动提交）=====
export async function pushNameExperiment({ bookId, bookTitle, items = [], profilePath, autoSubmit = false, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  items = (items || []).filter(x => x && x.title).slice(0, 5);
  if (!items.length) return { ok: false, error: '没有候选书名可推' };
  const client = new UnzooClient(profilePath || null, onLog || null, 'fanqienovel.com', '番茄');
  const Q = (s) => JSON.stringify(s);
  const clickText = async (txt) => await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button,div[role=button],span,a,li')).find(function(e){return (e.textContent||'').trim()===${Q(txt)}&&e.offsetParent!==null;});if(!b)return false;try{b.scrollIntoView({block:'center'});}catch(e){}['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){b.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});return true;})()`);
  const SETTER = `function __sv(el,val){var pr=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(pr,'value').set;s.call(el,val);if(el._valueTracker)el._valueTracker.setValue('__force_diff__');el.dispatchEvent(new InputEvent('input',{bubbles:true,data:val,inputType:'insertText'}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

  try {
    await client.getActiveTab();
    log('打开番茄「多书名实验」页…');
    await client.navigate('https://fanqienovel.com/main/writer/name-experiment');
    await client.sleep(2600);
    try { await unzooCallTool('tab_activate', { tab_id: String(client.tabId) }); } catch {}
    await client.sleep(500);

    // 1. 确认/切换到目标书
    const NORMJS = `function __nm(s){return (s||'').replace(/[\\s，,。：:！!？?、·—\\-]/g,'');}`;
    const READ_SHOWN = `(function(){var t=document.querySelector('.name-experiment-book .book-select-info-title')||[].slice.call(document.querySelectorAll('[class*=book-title],[class*=title]')).find(function(e){var s=(e.textContent||'').trim();return e.offsetParent!==null&&s.length>=2&&s.length<40&&!/多书名|多封面|封面推荐|实验/.test(s)&&!e.closest('[class*=drawer]');});return t?(t.textContent||'').trim():'';})()`;
    const norm = (s) => String(s || '').replace(/[\s，,。：:！!？?、·—\-]/g, '');
    const matches = (shown) => { const a = norm(shown), b = norm(bookTitle); return !!(a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)); };
    let shown = await client.evaluate(READ_SHOWN);
    if (bookTitle && !matches(shown)) {
      let inList = true;
      for (let attempt = 0; attempt < 2 && !matches(shown); attempt++) {
        log(`当前是《${shown || '?'}》，切换到《${bookTitle}》…`);
        await client.evaluate(`(function(){var b=document.querySelector('.book-select-switch');if(b)b.click();return !!b;})()`);
        await client.sleep(900);
        const picked = await client.evaluate(`(function(){${NORMJS}var name=__nm(${Q(bookTitle)});var items=[].slice.call(document.querySelectorAll('.book-switch-drawer-list-item,.book-select')).filter(function(e){return e.offsetParent!==null;});var row=items.find(function(it){var t=it.querySelector('.book-select-info-title');return t&&(__nm(t.textContent).indexOf(name)>=0||name.indexOf(__nm(t.textContent))>=0);})||items.find(function(it){return __nm(it.textContent).indexOf(name)>=0;});if(!row)return false;try{row.scrollIntoView({block:'center'});}catch(e){}row.click();return true;})()`);
        if (!picked) { inList = false; break; }
        await client.sleep(500);
        await client.evaluate(`(function(){var f=document.querySelector('.book-switch-drawer-footer,.arco-drawer-footer');var btn=f&&(f.querySelector('.arco-btn-primary')||[].slice.call(f.querySelectorAll('button')).find(function(b){return /确定|确认|切换/.test(b.textContent||'');}));if(!btn)return false;btn.click();return true;})()`);
        await client.sleep(1800);
        shown = await client.evaluate(READ_SHOWN);
      }
      if (!matches(shown)) {
        const why = inList
          ? `切到《${bookTitle}》没成功（当前仍是《${shown || '?'}》）`
          : `《${bookTitle}》不在番茄「切换作品」列表里——多书名实验要求已签约作品。`;
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

    // 2. 找【配置实验】或【修改配置】按钮（切书后异步加载 infos，轮询最多 4 秒）
    let hasCfgBtn = false;
    for (let w = 0; w < 8; w++) {
      hasCfgBtn = await client.evaluate(`[].slice.call(document.querySelectorAll('button.ne-experiment-action-button,button,[class*=btn],[class*=action]')).some(function(e){var t=(e.textContent||'').trim();return (t==='配置实验'||t==='修改配置')&&e.offsetParent!==null&&!(e.disabled||/disabled/.test(e.className));})`);
      if (hasCfgBtn) break;
      await client.sleep(500);
    }
    if (!hasCfgBtn) {
      const state = await client.evaluate(`(function(){var el=document.querySelector('.ne-experiment')||document.body;var t=el.innerText||'';if(/校验中/.test(t))return '该书多书名实验已在「校验中」';if(/实验中|进行中/.test(t))return '该书实验进行中，暂不能改配置';if(/已结束|已终止/.test(t))return '该书里程碑实验已结束';if(/不符合字数|已失效|未达|暂未满足/.test(t))return '未满足开启条件（需达20万字/100万字且近3天有更新）';return '未找到可用的「配置实验」按钮';})()`);
      log('番茄未开放「配置实验」：' + state, 'warn');
      return {
        ok: true, semiManual: true, opened: true, switched: true,
        msg: `已在番茄打开《${bookLabel}》的多书名实验页：${state}。\n候选书名：\n` +
          items.map((x, i) => `${i + 1}. ${x.title}${x.coverPath ? '  ← ' + x.coverPath : ''}`).join('\n'),
      };
    }

    // 3. 先通过番茄官方封面上传接口 (/api/author/data/upload_pic_v1/v0?aid=2503) 极速上传 5 张带字封面
    log(`正在上传 ${items.length} 张实验书封到番茄服务器…`, 'act');
    const uploaded = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const title = String(it.title || '').trim().slice(0, 15);
      let picUri = '', picUrl = '';
      if (it.coverPath && fs.existsSync(it.coverPath)) {
        const b64 = fs.readFileSync(it.coverPath).toString('base64');
        const fname = path.basename(it.coverPath);
        await client.evaluate(`(function(){
          window.__neOneUpload = '';
          (async function(){
            try {
              var b64 = ${Q(b64)};
              var bin = atob(b64);
              var u8 = new Uint8Array(bin.length);
              for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
              var blob = new Blob([u8], { type: 'image/png' });
              var fd = new FormData();
              fd.append('upfile', blob, ${Q(fname)});
              var res = await fetch('/api/author/data/upload_pic_v1/v0?aid=2503', { method: 'POST', body: fd }).then(function(r){return r.json();});
              window.__neOneUpload = JSON.stringify(res);
            } catch (e) {
              window.__neOneUpload = JSON.stringify({ code: -1, message: String(e && e.message || e) });
            }
          })();
          return 'started';
        })()`);
        for (let w = 0; w < 45; w++) {
          await client.sleep(400);
          const rawUp = await client.evaluate('window.__neOneUpload || ""');
          let upRes = null;
          if (rawUp && typeof rawUp === 'string') { try { upRes = JSON.parse(rawUp); } catch {} }
          else if (rawUp && typeof rawUp === 'object') { upRes = rawUp; }
          if (upRes && typeof upRes === 'object' && ('code' in upRes)) {
            if (upRes.code === 0 && upRes.data?.pic_uri) {
              picUri = upRes.data.pic_uri;
              picUrl = upRes.data.pic_url || '';
              log(`(${i + 1}/${items.length}) 《${title}》封面已上传`);
            } else {
              log(`(${i + 1}/${items.length}) 《${title}》封面上传返回异常：${upRes.message || upRes.code}`, 'warn');
            }
            break;
          }
        }
      }
      uploaded.push({ title, pic_uri: picUri, pic_url: picUrl, coverPath: it.coverPath || '' });
    }

    // 4. 点开「配置实验」抽屉 (.ne-drawer)
    log('打开「配置实验」抽屉…');
    await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button.ne-experiment-action-button,button,[class*=btn]')).find(function(e){var t=(e.textContent||'').trim();return (t==='配置实验'||t==='修改配置')&&e.offsetParent!==null&&!(e.disabled||/disabled/.test(e.className));});if(b)b.click();return !!b;})()`);
    let drawerOpen = false;
    for (let i = 0; i < 8; i++) {
      if (await client.evaluate("!!document.querySelector('.ne-drawer')")) { drawerOpen = true; break; }
      await client.sleep(500);
    }
    if (!drawerOpen) return { ok: false, error: '点了「配置实验」但配置抽屉没打开，请重试' };

    // 5. 优先通过 .ne-drawer 的 React 状态队列一次性写入全部 5 组（书名 + 封面 URI），秒级完成且零遮罩卡顿
    const rawFiberFilled = await client.evaluate(`(function(){
      function findFiber(el) {
        if (!el) return null;
        var k = Object.keys(el).find(function(k){ return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
        return k ? el[k] : null;
      }
      var f = findFiber(document.querySelector('.ne-drawer'));
      var targetFiber = null;
      while (f) {
        if (f.type && typeof f.type === 'function' && f.type.toString().indexOf('ne-drawer-header') >= 0) {
          targetFiber = f;
          break;
        }
        f = f.return;
      }
      if (!targetFiber) return JSON.stringify({ ok: false });
      var hook = targetFiber.memoizedState;
      var zDispatch = null;
      while (hook) {
        if (Array.isArray(hook.memoizedState) && hook.memoizedState[0] && ('condigId' in hook.memoizedState[0])) {
          zDispatch = hook.queue && hook.queue.dispatch;
          break;
        }
        hook = hook.next;
      }
      if (!zDispatch) return JSON.stringify({ ok: false });
      var uploaded = ${JSON.stringify(uploaded)};
      var newZ = uploaded.map(function(u, i) {
        return {
          condigId: 'exp_auto_' + (i + 1) + '_' + Date.now(),
          bookName: u.title,
          cover: u.pic_uri ? {
            status: 'done',
            pic_url: u.pic_url,
            pic_uri: u.pic_uri,
            response: { code: 0, data: { pic_url: u.pic_url, pic_uri: u.pic_uri } }
          } : undefined,
          error: '',
          localError: '',
          auditFail: false
        };
      });
      zDispatch(newZ);
      return JSON.stringify({ ok: true, count: newZ.length });
    })()`);
    const fiberFilled = typeof rawFiberFilled === 'string' ? (() => { try { return JSON.parse(rawFiberFilled); } catch { return null; } })() : rawFiberFilled;

    let done = 0;
    if (fiberFilled && fiberFilled.ok) {
      done = fiberFilled.count || uploaded.length;
      await client.sleep(700);
      log(`已填入 ${done} 组实验书名与专属书封`, 'act');
    } else {
      // 兜底：若 React fiber 结构变化，退回 DOM 逐组填书名
      const GROUPS_JS = `[].slice.call(document.querySelectorAll('.ne-config-item')).filter(function(g){return !/adder/.test(g.className)&&g.querySelector('input');})`;
      for (let i = 0; i < uploaded.length; i++) {
        const it = uploaded[i];
        const gc = await client.evaluate(`(${GROUPS_JS}).length`);
        if (i >= gc) {
          await client.evaluate(`(function(){var a=document.querySelector('.ne-config-item-adder');if(a)a.click();})()`);
          await client.sleep(600);
        }
        const nameOk = await client.evaluate(`(function(){${SETTER} var g=(${GROUPS_JS})[${i}];if(!g)return false;var inp=g.querySelector('input');if(!inp)return false;inp.focus();__sv(inp,${Q(it.title)});return true;})()`);
        if (nameOk) done++;
      }
    }

    if (!autoSubmit) {
      return {
        ok: true, semiManual: true, submitted: false, filled: done,
        msg: `已把 ${done} 组实验书名+专属书封填入番茄《${bookLabel}》的「配置实验」抽屉（待提交）。请到浏览器核对无误后点「提交」→「确认」开启实验。`,
      };
    }

    // 6. 自动提交：点抽屉底部主按钮「提交」→ 点二次确认气泡「确认」
    log('正在提交多书名实验配置…');
    await client.evaluate(`(function(){var b=document.querySelector('.ne-drawer-footer button.arco-btn-primary')||[].slice.call(document.querySelectorAll('.ne-drawer-footer button,.arco-drawer-footer button,[class*=footer] button,.arco-btn-primary')).find(function(e){return e.offsetParent!==null&&(e.textContent||'').trim()==='提交'&&!(e.disabled||/disabled/.test(e.className));});if(b)b.click();return !!b;})()`);
    await client.sleep(800);
    await client.evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('.ne-drawer-popconfirm button,.arco-popconfirm button,.byte-popconfirm button,.arco-popover-content button,button')).filter(function(e){return e.offsetParent!==null&&/^(确认|确定)$/.test((e.textContent||'').trim());}).pop();if(b)b.click();return !!b;})()`);
    await client.sleep(2400);
    const rawAfterCheck = await client.evaluate(`(function(){
      var expText = (document.querySelector('.ne-experiment')||{}).innerText || '';
      var errs = [].slice.call(document.querySelectorAll('.ne-config-item-error')).map(function(e){return (e.innerText||'').trim();}).filter(Boolean);
      return JSON.stringify({ verifying: /校验中/.test(expText), errs: errs, expText: expText });
    })()`);
    const afterCheck = typeof rawAfterCheck === 'string' ? (() => { try { return JSON.parse(rawAfterCheck); } catch { return null; } })() : rawAfterCheck;
    if (afterCheck && afterCheck.errs && afterCheck.errs.length) {
      return { ok: false, error: '番茄校验提示：' + afterCheck.errs.join('；') };
    }
    return {
      ok: true,
      submitted: true,
      filled: done,
      msg: afterCheck?.verifying
        ? `✅ 《${bookLabel}》多书名实验已提交成功（当前状态：校验中）`
        : `✅ 已提交《${bookLabel}》多书名实验配置`,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 读番茄章节管理表里【全部】章节的 状态+上线时间（翻页读全）。只读。
// 调用前页面须已在 chapter-manage/<bookId>&1。
// ⚠️ 这个函数第一次是用 shell 里的 node -e 写进来的——反引号全被 bash 当成命令替换吃掉，
// 落盘的是 `const FIRE = ;` 这种废代码。含浏览器端脚本（evaluate 里的模板字符串）的代码
// 一律用编辑器写，别再过 shell。
async function readPendingSchedule(client) {
  const FIRE = "function __f(e){['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}";
  const SEP_COL = String.fromCharCode(1), SEP_ROW = String.fromCharCode(2);
  const all = new Map();
  for (let page = 1; page <= 20; page++) {
    const rows = await client.evaluate(`(function(){
      var C=String.fromCharCode(1), R=String.fromCharCode(2), NL=String.fromCharCode(10);
      var L=(document.body.innerText||'').split(NL).map(function(s){return s.trim();}).filter(Boolean);
      var out=[];
      for(var i=0;i<L.length;i++){ if(/^第[0-9]+章/.test(L[i])) out.push([L[i], L[i+3]||'', L[i+4]||''].join(C)); }
      return out.join(R);
    })()`);
    let fresh = 0;
    for (const r of String(rows || '').split(SEP_ROW).filter(Boolean)) {
      const [title, status, time] = r.split(SEP_COL);
      const num = parseInt((String(title).match(/第(\d+)章/) || [])[1], 10);
      if (!num || all.has(num)) continue;
      const tm = String(time || '').trim();
      all.set(num, { num, status: String(status || '').trim(), time: /\d{4}-\d{2}-\d{2}/.test(tm) ? tm : '' });
      fresh++;
    }
    if (!fresh) break;
    const next = await client.evaluate(`(function(){${FIRE}
      var n=document.querySelector('.arco-pagination-item-next:not(.arco-pagination-item-disabled)');
      if(!n) return 'none'; __f(n); return 'ok';
    })()`);
    if (next !== 'ok') break;
    await client.sleep(3000);
  }
  return [...all.values()];
}

// ── 番茄「短故事（短篇）」一键发布/存草稿 ────────────────────────
// 番茄短故事后台（/main/writer/short-manage → /main/writer/publish-short/{itemId}）与长篇小说
// （/main/writer/book-manage）完全是两套独立系统：
//  1) 全书所有章节合并进同一个 ProseMirror 文档（window.adapter.setHTML），以 <h1>第X章：标题</h1> 划分章节目录；
//  2) 需设置「试读比例」（window.adapter.command.payNode.init() + setPercentageLine(0.3)）；
//  3) 分类词库为短故事专属 5 维词库（主分类/情节/角色/情绪/背景，最多 8 个且主分类必选 1 个）；
//  4) 协议复选框必须点开《短故事发布事项》弹窗并点「我已阅读并同意」才会真正置位 agreedLicense=true。
export async function publishShortStoryOnFanqie({
  profilePath,
  itemId = '',
  title = '',
  chapters = [],
  useAI = true,
  categories = [],
  trialRatio = 0.3,
  coverPath = '',
  draftOnly = true,
  onLog = () => {},
} = {}) {
  const log = (msg, level = 'info') => { try { onLog({ level, source: 'fanqie-short', msg }); } catch {} };
  const client = new UnzooClient(profilePath, ({ level, msg }) => log(msg, level), 'fanqienovel.com', '番茄短故事', 'https://fanqienovel.com/main/writer/short-manage');
  const okTab = await client.getActiveTab();
  if (!okTab) return { ok: false, error: '未找到或无法打开绑定的番茄作者浏览器窗口' };

  const targetUrl = itemId
    ? `https://fanqienovel.com/main/writer/publish-short/${itemId}?enter_from=NEWCHAPTER_1`
    : 'https://fanqienovel.com/main/writer/publish-short/?enter_from=NEWCHAPTER_1';
  log(`正在打开番茄短故事编辑器：${targetUrl}`, 'act');
  await client.navigate(targetUrl);
  await client.sleep(3200);

  // 等待编辑器 window.adapter 就绪并读取分配的 itemId
  let resolvedItemId = itemId;
  for (let i = 0; i < 12; i++) {
    const info = await client.evaluate(`(function(){
      var m = location.pathname.match(/publish-short\\/(\\d+)/);
      return { ready: Boolean(window.adapter && document.querySelector('textarea[placeholder*="短故事名称"]')), itemId: m ? m[1] : '' };
    })()`);
    if (info?.itemId) resolvedItemId = info.itemId;
    if (info?.ready) break;
    await client.sleep(800);
  }
  if (!resolvedItemId) {
    return { ok: false, error: '番茄短故事编辑器未就绪（请确认账号已登录番茄作家后台）' };
  }

  // 1. 关闭可能遮挡的新手引导气泡（1/2 下一步 -> 2/2 完成）
  for (let step = 0; step < 3; step++) {
    const g = await client.evaluate(`(function(){
      var b = document.querySelector('.guide-card-footer-btn');
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (g?.x) {
      await clickAt(client.tabId, g.x, g.y);
      await client.sleep(500);
    } else break;
  }

  // 2. 填入短故事标题（最多 30 字）
  const cleanBookTitle = String(title || '').replace(/[《》]/g, '').trim().slice(0, 30);
  log(`填入短故事名称：《${cleanBookTitle}》…`, 'act');
  await client.evaluate(`(function(val){
    var ta = document.querySelector('textarea[placeholder*="短故事名称"]');
    if (!ta) return false;
    ta.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, val);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.blur();
    return true;
  })(${JSON.stringify(cleanBookTitle)})`);
  await client.sleep(500);

  // 3. 组装全书合并 HTML（每章以 <h1>第X章：章名</h1> 作为番茄短故事「章节标题」节点）
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlParts = [];
  for (const ch of chapters) {
    const rawTitle = String(ch.title || '').replace(/^第\s*[0-9一二三四五六七八九十百千两]+\s*章[\s:：·—\-]*/, '').trim();
    const headText = `第${numToCn(ch.num)}章${rawTitle ? '：' + rawTitle : ''}`;
    htmlParts.push(`<h1>${esc(headText)}</h1>`);
    const lines = String(ch.content || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // 若章首自带重复章名行则跳过
      if (line === headText || /^第\s*[0-9一二三四五六七八九十百千两]+\s*章/.test(line) && line.length < 30 && line.includes(rawTitle)) continue;
      htmlParts.push(`<p>${esc(line)}</p>`);
    }
  }
  const fullHtml = htmlParts.join('');
  log(`正在向短故事编辑器写入全部 ${chapters.length} 章正文…`, 'act');
  const bodyRes = await client.evaluate(`(function(html){
    if (!window.adapter || typeof window.adapter.setHTML !== 'function') return { ok: false };
    window.adapter.setHTML(html);
    var words = (window.adapter.getText() || '').replace(/\\s+/g, '').length;
    var headers = (window.adapter.getExistNodes('header') || []).length;
    return { ok: true, words: words, headers: headers };
  })(${JSON.stringify(fullHtml)})`);
  log(`✅ 正文写入完成：识别到 ${bodyRes?.headers || chapters.length} 个章节标题，净字数约 ${bodyRes?.words || 0} 字`, 'info');
  await client.sleep(1000);

  // 4. 设置试读比例（payNode 试读分割线，默认 30%）
  const ratio = Math.max(0.1, Math.min(0.8, Number(trialRatio) || 0.3));
  const payRes = await client.evaluate(`(function(r){
    try {
      if (!window.adapter || !window.adapter.command || !window.adapter.command.payNode) return { ok: false, err: 'no payNode cmd' };
      var paras = window.adapter.getExistNodes('paragraph') || [];
      if (paras.length) window.adapter.setSelection({ index: paras[paras.length - 1].pos, length: 0 });
      var existing = window.adapter.getExistNodes('payNode') || [];
      if (!existing.length) window.adapter.command.payNode.init();
      window.adapter.command.payNode.setPercentageLine(r);
      return { ok: true, valid: Boolean(window.adapter.command.payNode.validateThreshold()) };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  })(${JSON.stringify(ratio)})`);
  if (payRes?.ok) log(`✅ 已设置短故事试读比例分割线（${Math.round(ratio * 100)}%）`, 'info');

  // 5. 设置「是否使用AI」（1=是，2=否）并选择短故事 5 维分类（最多 8 个，主分类必选 1 个）
  const cfgRes = await client.evaluate(`(function(wantAi, wantCats){
    try {
      // 5a. 是否使用AI
      var aiEl = document.querySelector('.publish_short_config_use_ai');
      if (aiEl) {
        var fk = Object.keys(aiEl).find(function(k){ return k.indexOf('__reactFiber') === 0; });
        var f = fk ? aiEl[fk] : null;
        while (f && typeof f.type !== 'function') f = f.return;
        // 也可直接点击对应单选框
        var radios = aiEl.querySelectorAll('label.arco-radio');
        var targetLabel = wantAi ? '是' : '否';
        radios.forEach(function(r){
          if ((r.innerText || '').trim() === targetLabel) r.click();
        });
      }

      // 5b. 作品分类（通过分类组件 fiber 读取完整 categoryList 并调用 setCategory）
      var catWrap = document.querySelector('.publish-short-config-category');
      var picked = [];
      if (catWrap) {
        var cfk = Object.keys(catWrap).find(function(k){ return k.indexOf('__reactFiber') === 0; });
        var cf = cfk ? catWrap[cfk] : null;
        while (cf && (typeof cf.type !== 'function' || cf.type.toString().indexOf('setCategory') === -1)) cf = cf.return;
        if (cf) {
          // 从 hooks 中找出 categoryList 数组（元素含 category_id, name, label）与 actions 对象（含 setCategory, setAgreedLicense, setUseAi）
          var ms = cf.memoizedState;
          var catList = null;
          var actions = null;
          while (ms) {
            var st = ms.memoizedState;
            if (Array.isArray(st) && st.length > 10 && st[0] && st[0].category_id !== undefined) {
              catList = st;
            }
            if (Array.isArray(st) && st.length === 2) {
              if (st[0] && typeof st[0].setCategory === 'function') actions = st[0];
              else if (st[1] && typeof st[1].setCategory === 'function') actions = st[1];
            }
            ms = ms.next;
          }
          if (actions && typeof actions.setUseAi === 'function') {
            actions.setUseAi(wantAi ? 1 : 2);
          }
          if (actions && typeof actions.setAgreedLicense === 'function') {
            actions.setAgreedLicense(true);
          }
          if (catList && actions && typeof actions.setCategory === 'function') {
            var mainLabel = catList[0].label; // "主分类"
            var hasMain = false;
            for (var i = 0; i < wantCats.length && picked.length < 8; i++) {
              var name = wantCats[i];
              var hit = catList.find(function(x){ return x.name === name; });
              if (hit) {
                if (hit.label === mainLabel) {
                  if (hasMain) continue;
                  hasMain = true;
                }
                picked.push({ label: hit.label, value: hit.category_id, name: hit.name });
              }
            }
            if (!hasMain) {
              var defMain = catList.find(function(x){ return x.name === '悬疑惊悚'; }) || catList[0];
              picked.unshift({ label: defMain.label, value: defMain.category_id, name: defMain.name });
              if (picked.length > 8) picked = picked.slice(0, 8);
            }
            actions.setCategory(picked);
          }
        }
      }
      return { ok: true, picked: picked.map(function(x){ return x.label + ':' + x.name; }) };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  })(${JSON.stringify(Boolean(useAI))}, ${JSON.stringify(categories)})`);
  if (cfgRes?.picked?.length) {
    log(`✅ 已自动配置短故事分类（${cfgRes.picked.length} 项）：${cfgRes.picked.join('、')}`, 'info');
  }

  // 6. 勾选《短故事发布事项》协议（点开弹窗 -> 点「我已阅读并同意」）
  await client.evaluate(`(function(){
    var link = document.querySelector('.publish-short-config-licenselink');
    if (link) link.click();
  })()`);
  await client.sleep(600);
  const licenseOk = await client.evaluate(`(function(){
    var btn = document.querySelector('.publish-short-license-modal-button');
    if (btn) { btn.click(); return true; }
    var cb = document.querySelector('.publish-short-config-signLicense input[type="checkbox"]');
    return Boolean(cb && cb.checked);
  })()`);
  if (licenseOk) log('✅ 已勾选《短故事发布事项》协议', 'info');
  await client.sleep(600);

  // 6.5 上传封面（短故事封面【不能出现人物】，建议 600×800）。
  // 流程（2026-10-23 实测）：点封面框/替换图标 → 抽屉 .ai-story-cover「本地上传」→
  // browser_upload_trusted 注入 input[type=file]（file_paths 必须是数组）→「确认上传」→「确定」(.ai-cover-local-content-btn)。
  let coverOk = false;
  if (coverPath) {
    try {
      log('正在上传短故事封面…', 'act');
      await client.evaluate(`(function(){
        var el = document.querySelector('.publish-short-config-book-cover-content-actions .tomato-image')
              || document.querySelector('.publish-short-config-book-cover-content');
        if (el) el.click();
      })()`);
      await client.sleep(1200);
      await client.evaluate(`(function(){
        var t = [].slice.call(document.querySelectorAll('.ai-story-cover *')).find(function(e){ return e.children.length === 0 && (e.innerText || '').trim() === '本地上传'; });
        if (t) t.click();
      })()`);
      await client.sleep(600);
      const sel = (await client.evaluate(`Boolean(document.querySelector('.ai-story-cover input[type=file]'))`))
        ? '.ai-story-cover input[type=file]' : '.byte-upload input[type=file]';
      await uploadTrusted(client.tabId, sel, [coverPath]);
      await client.sleep(3000);
      const clickText = (txt) => client.evaluate(`(function(){
        var b = [].slice.call(document.querySelectorAll('.ai-story-cover button')).filter(function(e){ return e.offsetParent && (e.innerText || '').trim() === ${JSON.stringify(txt)}; });
        if (!b.length) return false; b[b.length - 1].click(); return true;
      })()`);
      await clickText('确认上传');
      await client.sleep(1500);
      await client.evaluate(`(function(){ var b = document.querySelector('.ai-cover-local-content-btn'); if (b) b.click(); })()`);
      await client.sleep(1500);
      coverOk = Boolean(await client.evaluate(`Boolean(document.querySelector('.publish-short-config-book-cover-content-notempty img'))`));
      log(coverOk ? '✅ 封面已应用到短故事' : '⚠️ 封面上传后未检测到封面图，请在浏览器中手动核对', coverOk ? 'info' : 'warn');
    } catch (e) {
      log(`⚠️ 封面上传失败：${e.message}`, 'warn');
    }
  }

  // 7. 存草稿 或 正式提交
  if (draftOnly) {
    await client.evaluate(`(function(){
      var btn = document.querySelector('.short-publish-save-draft-btn');
      if (btn) btn.click();
    })()`);
    await client.sleep(1500);
    log(`💾 已保存至番茄短故事草稿箱（itemId: ${resolvedItemId}）。您可在浏览器中核对封面与内容后点击右上角「下一步」正式提交发布！`, 'act');
    return {
      ok: true,
      mode: 'short-draft',
      itemId: resolvedItemId,
      words: bodyRes?.words || 0,
      chapters: chapters.length,
      categories: cfgRes?.picked || [],
      cover: coverOk,
      url: `https://fanqienovel.com/main/writer/publish-short/${resolvedItemId}?enter_from=NEWCHAPTER_1`,
    };
  }

  // 若显式要求直接提交发布：点「下一步」 -> 等待「提交确认」弹窗 -> 点确认
  log('正在点击「下一步」打开提交确认弹窗…', 'act');
  await client.evaluate(`(function(){
    var btn = document.querySelector('.publish-short-header-right .btn-primary-variant');
    if (btn) btn.click();
  })()`);
  await client.sleep(1500);
  const confirmed = await client.evaluate(`(function(){
    var modal = document.querySelector('.publish-confirm-container');
    if (!modal) return false;
    var okBtn = modal.querySelector('.arco-modal-footer .arco-btn-primary');
    if (okBtn) { okBtn.click(); return true; }
    return false;
  })()`);
  if (!confirmed) {
    return { ok: false, itemId: resolvedItemId, error: '未弹出「提交确认」窗口，请检查浏览器页面是否有必填项高亮提示' };
  }
  await client.sleep(2500);
  log(`🎉 短故事《${cleanBookTitle}》已正式提交番茄审核（itemId: ${resolvedItemId}）！`, 'act');
  return {
    ok: true,
    mode: 'short-published',
    itemId: resolvedItemId,
    words: bodyRes?.words || 0,
    chapters: chapters.length,
    categories: cfgRes?.picked || [],
  };
}

export { UnzooClient, FanqiePublisher, maxChapterNumInText, readPendingSchedule };
