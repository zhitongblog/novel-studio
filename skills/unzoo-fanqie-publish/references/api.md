# Unzoo 调用清单

对照实现：`src/unzoo.mjs`（项目里唯一的调用出口，51 个源文件都经它）。

`UNZOO_BASE` 默认 `http://127.0.0.1:9399`。单次调用超时建议 45s——页面弹阻塞 alert 或卡死时，eval/点击会永久挂起。

## 唯一端点

```
POST {UNZOO_BASE}/api/v1/mcp/tools/call
{ "name": "<工具名>", "arguments": { ... } }
```

**不要用** `POST /api/v1/tools/call`、`unzoo call` CLI、或 `POST /api/v1/<动作>` 那批扁平端点。原因见 SKILL.md「只有一个通道」。

## 响应解包

四种形状，实测 2.5.28：

```js
// ① 文本：多数工具回 JSON 字符串，少数回纯文本（如 a11y 快照）
{"content":[{"type":"text","text":"{\"tabs\":[...]}"}]}
// ② 图片
{"content":[{"type":"image","data":"<base64>","mimeType":"image/png"},{"type":"text","text":""}]}
// ③ 工具错
{"content":[{"type":"text","text":"Error: …"}],"isError":true}
// ④ 网关错（不走 content）
{"error":"no valid lease for capability=DesktopObserve holder=mcp","success":false}
```

解包顺序：先看 `success===false`/`error` → 抛；再看 `isError` → 抛 text；再看 `content` 里有没有 image → 返回 `{image_base64, mimeType}`；否则拿 text，能 `JSON.parse` 就 parse，不能就返回原串；`content` 为空 → `null`。

## 能力租约

观察类工具（`browser_screenshot` 等）在 MCP 通道受 capability lease 管控（扁平端点不受管——这是两条通道的又一处不对等）。

遇到 lease 错误 → `request` + `grant` 后重试一次，实测无需人工批准，租约 300s。

**⚠️ 名称要转换**：报错文案给的是 `capability=DesktopObserve`（帕斯卡），但 `/lease/request` **只认 `desktop_observe`（蛇形）**。照抄报错会被拒。

## 工具清单

| 工具 | arguments | 备注 |
|---|---|---|
| `tab_list` | `{}` | → `{tabs:[{tab_id,url,title,profile_path}]}`。**偶发只返回部分窗口，要重试取并集** |
| `tab_create` | `{url, profile_id}` | → `tab_id` |
| `tab_activate` | `{tab_id: String}` | 置前台 |
| `browser_navigate` | `{tab_id, url}` | 已在目标页就别再导航（会把用户正看的页刷掉） |
| `browser_evaluate` | `{tab_id, expression}` | 取 `.result`。超时多半是页面弹了阻塞 alert |
| `browser_get_html` | `{tab_id, selector, outer}` | selector 必填，整页传 `'html'` |
| `browser_click` | `{tab_id, selector}` | CDP 真实点击。番茄部分按钮不吃它 |
| `page_click` | `{tab_id: String, loc:[x,y]}` | **坐标**真实点击，`isTrusted=true`、坐标精确 |
| `browser_press_key` | `{tab_id, key, modifiers:[]}` | 如 `key:'a', modifiers:['Control']` |
| `browser_input_text` | `{tab_id, text}` | 往**当前焦点元素**灌文本，走 Chromium IME 管线。`beforeinput`/`input` 均 `isTrusted=true`，ProseMirror/Lexical 认。**不要求前台** |
| `browser_type` | `{tab_id: String, selector, text, delay_ms, clear_first}` | CDP 逐字可信输入，指定选择器 |
| `browser_upload_trusted` | `{tab_id, selector, file_paths:[]}` | **可信文件注入**：直接给 `<input type=file>` 塞文件，`change` 事件 `isTrusted=true` |
| `browser_set_input_files` | — | ⚠️**不是上面那个**：它是"预备拦截下一个文件对话框"，语义完全不同 |
| `browser_handle_dialog` | `{tab_id, action}` | 清掉阻塞的 alert/confirm；`browser_evaluate` 挂起时先调它 |
| `browser_screenshot` | `{tab_id, …}` | 观察类，受租约管控 |
| `browser_scroll` | `{tab_id, delta_y}` | 真 wheel 事件，比 `scrollTo` 更能触发懒加载 |
| `profile_list` | `{}` | → `{profiles:[{path,name}]}` |
| `profile_launch` | `{profile_path}` | 窗口没开时拉起。路径要**完整反斜杠** |

## 最小封装

```js
const BASE = process.env.UNZOO_BASE || 'http://127.0.0.1:9399';

async function mcpCall(name, args = {}, timeoutMs = 45000) {
  const r = await fetch(BASE + '/api/v1/mcp/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await r.json().catch(() => null);

  if (d && d.success === false) throw new Error(`${name}: ${d.error}`);   // ④ 网关错
  const parts = d?.content || [];
  const text = parts.find(p => p.type === 'text')?.text || '';
  if (d?.isError) throw new Error(`${name}: ${text}`);                    // ③ 工具错
  const img = parts.find(p => p.type === 'image');                        // ② 图片
  if (img) return { image_base64: img.data, mimeType: img.mimeType };
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }                 // ① 文本
}

const evaluate = async (tabId, expr) => (await mcpCall('browser_evaluate', { tab_id: tabId, expression: expr }))?.result;
const inputText = (tabId, text) => mcpCall('browser_input_text', { tab_id: tabId, text: String(text) });
const uploadTrusted = (tabId, selector, files) => mcpCall('browser_upload_trusted', { tab_id: tabId, selector, file_paths: files });
const listTabs = async () => (await mcpCall('tab_list', {}))?.tabs || [];
```

（`src/unzoo.mjs` 里还带了 lease 自动续租，跨项目移植时记得一并抄。）

## tab_id 的类型

`tab_activate`、`page_click`、`browser_type` 声明为**字符串**；其余传原值即可。传错类型多半不报错，只是静默不生效——这类问题最难查。
