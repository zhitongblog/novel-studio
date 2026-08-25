// Unzoo 浏览器自动化的【唯一】调用层：只走官方 MCP 端点 POST /api/v1/mcp/tools/call。
//
// 为什么不用兼容通道（本项目已全面弃用，勿再引入）：
//   ① POST /api/v1/tools/call（"统一分发"，body {tool,arguments}）与 `unzoo call` CLI 共用一套
//      点号命名空间的旧路由，命令表【覆盖不全】。实测 2.5.28：browser_set_input_files /
//      browser_upload_trusted 经此通道一律 `Unknown command: browser.set_input_files`，
//      而同一个工具走官方 MCP 端点完全正常。能力清单还声明它们 transport 含 cli/rest——
//      清单在撒谎，调用前无从发现。我们当年为此误判"Unzoo 没有可信上传能力"，绕了很久。
//   ② POST /api/v1/<动作> 那批扁平端点（/click、/type、/set_input_files…）是另一套独立实现，
//      与工具名不成映射、入参形状各不相同，且与 MCP 版语义未必一致
//      （例：/api/v1/set_input_files 是"直接给 input 塞文件"，而 MCP 的 browser_set_input_files
//        是"预备拦截下一个文件对话框"——名字几乎一样，行为完全不同。要直接塞文件得用
//        browser_upload_trusted）。
//
// 响应形状（官方 MCP，实测 2.5.28 有三种，本层统一解包）：
//   ① 文本   {"content":[{"type":"text","text":"<JSON 或纯文本>"}]}
//   ② 图片   {"content":[{"type":"image","data":"<base64>","mimeType":"image/png"},{"type":"text","text":""}]}
//   ③ 工具错 {"content":[{"type":"text","text":"Error: …"}],"isError":true}
//   ④ 网关错 {"error":"…","success":false}   ← 不走 content，例如 capability lease 被拒
//
// ⚠️能力租约：观察类工具（browser_screenshot 等）在 MCP 通道上受 capability lease 管控，
// 而扁平端点 /api/v1/screenshot 不受管——这是两条通道的又一处不对等。本层遇到 lease 错误会
// 自动 request+grant 后重试一次（实测无需人工批准，租约 300s）。
// 另注：Unzoo 的报错文案写的是 capability=DesktopObserve（帕斯卡），但 /lease/request 只认
// desktop_observe（蛇形），照抄报错会被拒——本层负责转换。

const UNZOO_BASE = process.env.UNZOO_BASE || 'http://127.0.0.1:9399';
const MCP_PATH = '/api/v1/mcp/tools/call';
// 单次浏览器调用超时（ms）：页面偶发弹阻塞 alert 或卡死时，eval/点击会永久挂起 →
// 加超时让每次调用最多等这么久，超时即抛错（上层可重试），绝不无限挂起。
export const UNZOO_TIMEOUT_MS = Number(process.env.UNZOO_TIMEOUT_MS) || 45000;

export function unzooBase() { return UNZOO_BASE; }

// 调用一个 Unzoo MCP 工具。返回解包后的载荷：
//   文本/JSON → 已 parse 的值（或原字符串）；图片 → {image_base64, mimeType}；空 → null。
// 失败抛 Error（含工具名，便于日志定位）。遇 capability lease 拒绝会自动取租约重试一次。
export async function mcpCall(name, args = {}, timeoutMs = UNZOO_TIMEOUT_MS) {
  let data = await postMcp(name, args, timeoutMs);

  // ④ 网关错：capability lease 被拒 → 自动申请+授予后重试一次
  const gwErr = (!data?.content && data?.success === false) ? String(data.error || '') : '';
  if (gwErr) {
    const cap = parseLeaseCapability(gwErr);
    if (cap && await acquireLease(cap)) {
      data = await postMcp(name, args, timeoutMs);
    } else {
      throw new Error(`调用 ${name} 失败: ${gwErr}`);
    }
    if (!data?.content && data?.success === false) throw new Error(`调用 ${name} 失败: ${data.error}`);
  }

  const items = data?.content;
  if (!Array.isArray(items)) throw new Error(`调用 ${name} 失败: 响应无 content（${JSON.stringify(data).slice(0, 160)}）`);

  const textItem = items.find(i => i?.type === 'text');
  if (data.isError) {
    throw new Error(`调用 ${name} 失败: ${String(textItem?.text || '').replace(/^Error:\s*/, '') || '未知错误'}`);
  }
  // ② 图片：截图类工具
  const img = items.find(i => i?.type === 'image');
  if (img) return { image_base64: img.data, mimeType: img.mimeType || 'image/png' };
  // ① 文本/JSON
  return parsePayload(textItem?.text);
}

async function postMcp(name, args, timeoutMs) {
  let resp;
  try {
    resp = await fetch(`${UNZOO_BASE}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`调用 ${name} 超时(${Math.round(timeoutMs / 1000)}s，页面可能卡住/弹窗阻塞)`);
    }
    throw new Error(`Unzoo 连接失败 (${name}): ${e.message || e}`);
  }
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!data) throw new Error(`调用 ${name} 失败: HTTP ${resp.status}（响应非 JSON）`);
  return data;
}

// 从 "no valid lease for capability=DesktopObserve holder=mcp" 里抠出能力名，转成 API 认的蛇形。
function parseLeaseCapability(msg) {
  if (!/capability lease required|no valid lease/i.test(msg)) return '';
  const m = msg.match(/capability=([A-Za-z_]+)/);
  if (!m) return '';
  return m[1].includes('_') ? m[1].toLowerCase()
    : m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// 申请并授予某能力的租约（实测无需人工批准）。成功返回 true。
async function acquireLease(capability, holder = 'mcp') {
  try {
    const req = await fetch(`${UNZOO_BASE}/api/v1/lease/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, holder }), signal: AbortSignal.timeout(8000),
    }).then(r => r.json());
    const id = req?.data?.id;
    if (!id) return false;
    const gr = await fetch(`${UNZOO_BASE}/api/v1/lease/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }), signal: AbortSignal.timeout(8000),
    }).then(r => r.json());
    return gr?.data?.state === 'granted';
  } catch { return false; }
}

// MCP 的 text 载荷：多数工具回 JSON 字符串，少数回纯文本（如 a11y 快照）。
function parsePayload(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (!/^[[{"]|^-?\d|^true$|^false$|^null$/.test(s)) return s;   // 明显不是 JSON 就原样给
  try { return JSON.parse(s); } catch { return s; }
}

// ——— 语义化包装：把项目里用到的几个能力固定成一处，避免各文件各写各的 ———

// 执行 JS，返回表达式结果（工具回 {result:…}）。
export async function evaluate(tabId, expression, timeoutMs = UNZOO_TIMEOUT_MS) {
  const r = await mcpCall('browser_evaluate', { tab_id: tabId, expression }, timeoutMs);
  return r?.result;
}

// 坐标真实点击（isTrusted=true）。替代已弃用的 POST /api/v1/click。
// page_click 的 tab_id 声明为 string，loc 为 [x,y]。
export async function clickAt(tabId, x, y) {
  return mcpCall('page_click', { tab_id: String(tabId), loc: [Math.round(x), Math.round(y)] });
}

// 往【当前焦点元素】灌文本（isTrusted=true，走 Chromium IME 管线，ProseMirror/Lexical 认）。
// 替代已弃用的 POST /api/v1/type。实测 beforeinput/input 均 isTrusted=true。
export async function inputText(tabId, text) {
  return mcpCall('browser_input_text', { tab_id: tabId, text: String(text) });
}

// 可信文件注入：直接给 <input type=file> 塞文件，change 事件 isTrusted=true。
// ⚠️不是 browser_set_input_files——那个是"预备拦截下一个文件对话框"，语义完全不同。
// 替代已弃用的 POST /api/v1/set_input_files。
export async function uploadTrusted(tabId, selector, filePaths) {
  return mcpCall('browser_upload_trusted', { tab_id: tabId, selector, file_paths: filePaths });
}

// 清掉阻塞的 JS 弹窗（alert/confirm）——它会让 browser_evaluate 永久挂起。best-effort。
export async function handleDialog(tabId, action = 'accept') {
  if (tabId == null) return false;
  try { await mcpCall('browser_handle_dialog', { tab_id: tabId, action }, 8000); return true; }
  catch { return false; }
}

// 启动某个 profile 的浏览器窗口（窗口被关时用）。
export async function launchProfile(profilePath) {
  return mcpCall('profile_launch', { profile_path: profilePath });
}

// 列出所有标签页 → [{tab_id,url,title,profile_path,…}]
export async function listTabs() {
  const r = await mcpCall('tab_list', {});
  return r?.tabs || (Array.isArray(r) ? r : []);
}

// 新建标签页 → tab_id（拿不到返回 null）
export async function createTab(url, profileId = 'default') {
  const r = await mcpCall('tab_create', { url, profile_id: profileId });
  return r?.tab_id ?? r?.id ?? null;
}

export async function navigate(tabId, url) {
  return mcpCall('browser_navigate', { tab_id: tabId, url });
}

// 取 HTML。selector 必填（要整页传 'html'）。返回字符串。
export async function getHtml(tabId, selector = 'html', outer = true) {
  const r = await mcpCall('browser_get_html', { tab_id: tabId, selector, outer });
  return typeof r === 'string' ? r : (r?.result ?? '');
}

// 截图 → base64（不含 data: 前缀）。观察类能力，受租约管控，mcpCall 会自动取租约。
export async function screenshot(tabId, opts = {}) {
  const r = await mcpCall('browser_screenshot', { tab_id: tabId, ...opts }, 60000);
  return r?.image_base64 || '';
}

// 滚动。deltaY 走真 wheel 事件（isTrusted=true），比绝对 scrollTo 更能触发懒加载。
export async function scrollBy(tabId, deltaY) {
  return mcpCall('browser_scroll', { tab_id: tabId, delta_y: Math.round(deltaY) });
}

// 服务端等待：网关自己轮询到条件成立。返回 true=命中，false=超时。
// 只支持 {selector,state} / {text 出现} / {text_gone 消失}——【没有 JS 断言】，
// 复合条件（如"出现数据行 或 空态 或 登录失效"）表达不了，那种仍需自己轮询同步表达式。
//
// ⚠️只有 browser_wait_for 和 browser_delay 是真的会等。同族的
// browser_wait_for_selector / browser_wait_for_network_idle / browser_wait_for_function
// 是【空壳】：传 timeout_ms 也只跑 ~100ms 就返回 {} 假成功（schema 与实现读的参数名不一致，
// 兜底成字面量 true 恒真；且 eval_js 不 await Promise）。已提 unzoo#153，修好前别用。
// 同理 browser_evaluate 不 await Promise —— 注入的表达式必须是【同步】的。
export async function waitFor(tabId, { selector, state, text, textGone, timeoutMs = 15000, pollMs = 200 } = {}) {
  const args = { tab_id: String(tabId), timeout_ms: timeoutMs, poll_ms: pollMs };
  if (selector) args.selector = selector;
  if (state) args.state = state;
  if (text) args.text = text;
  if (textGone) args.text_gone = textGone;
  const r = await mcpCall('browser_wait_for', args, Math.max(timeoutMs + 10000, UNZOO_TIMEOUT_MS));
  return !!r?.matched;
}
