---
name: unzoo-fanqie-publish
description: 用 Unzoo 浏览器把小说章节发布到番茄小说作者后台（fanqienovel.com）。涵盖账号(profile)锁定、章节批量发布、分卷、封面上传、读取线上最大章号做去重。当用户要求"发布到番茄""上传章节""换封面""建新书""看番茄发到第几章"时使用。
---

# 用 Unzoo 发布到番茄小说

番茄作者后台没有开放 API，只能驱动浏览器。这份技能记录的是**已经在生产里跑通的那条路径**——包括几条不写下来就一定会重新踩的坑。

对照实现：`src/unzoo.mjs`（唯一调用层）、`src/fanqie.mjs`（番茄业务流程）。

## 前置

1. 本机跑着 **Unzoo**（daemon 默认 `http://127.0.0.1:9399`，可用 `UNZOO_BASE` 覆盖）。
2. 有一个**已登录番茄作者后台**的 Unzoo profile，浏览器窗口开着。
3. 拿到 `bookId`（在后台 URL 里：`fanqienovel.com/main/writer/<bookId>/...`）。

## ❗只有一个通道：`POST /api/v1/mcp/tools/call`

Unzoo 上有三套入口，**只有官方 MCP 端点可用**，另外两套是陷阱。这是最容易栽的地方，务必先看懂再动手。

```
POST http://127.0.0.1:9399/api/v1/mcp/tools/call
{ "name": "browser_evaluate", "arguments": { "tab_id": "123", "expression": "location.href" } }
```

| 通道 | 为什么不能用 |
|---|---|
| `POST /api/v1/tools/call`（"统一分发"）与 `unzoo call` CLI | 共用一套点号命名空间的旧路由，**命令表覆盖不全**。实测 2.5.28：`browser_upload_trusted` 经此通道一律报 `Unknown command: browser.set_input_files`，同一个工具走官方 MCP 端点完全正常。**而能力清单还声明它们 transport 含 cli/rest——清单在撒谎，调用前无从发现。** |
| `POST /api/v1/<动作>`（`/click`、`/type`、`/set_input_files`…） | 另一套独立实现，与工具名不成映射、入参形状各不相同，**语义也未必一致**（见下方警告） |

> **⚠️ 名字几乎一样、行为完全不同的一对**
> - `POST /api/v1/set_input_files`（扁平端点）＝ 直接给 `<input type=file>` 塞文件
> - `browser_set_input_files`（MCP 工具）＝ **预备拦截下一个文件对话框**
>
> 要"直接塞文件"的行为，MCP 侧的正确工具是 **`browser_upload_trusted`**。混用会让封面上传**静默失效**。

> **📌 历史教训**：项目里曾有一份分析判定"Unzoo 没有可信上传能力，封面只能半自动"。错的不是能力，是**通道**——能力一直都在，我们用的路由到不了。下次遇到"某能力调不通"，先换官方 MCP 端点再试一遍，别急着下结论。

响应有四种形状，调用层要统一解包：

```
① 文本   {"content":[{"type":"text","text":"<JSON 或纯文本>"}]}
② 图片   {"content":[{"type":"image","data":"<base64>","mimeType":"image/png"}, …]}
③ 工具错 {"content":[{"type":"text","text":"Error: …"}],"isError":true}
④ 网关错 {"error":"…","success":false}      ← 不走 content
```

**能力租约**：观察类工具（`browser_screenshot` 等）在 MCP 通道受 capability lease 管控。遇到 lease 错误 → 自动 `request` + `grant` 后重试一次（实测无需人工批准，租约 300s）。注意 Unzoo 报错文案写的是 `capability=DesktopObserve`（帕斯卡），但 `/lease/request` **只认 `desktop_observe`（蛇形）**，照抄报错会被拒。

## 锁定账号：绝不发错号

多账号场景下**必须**按 `profile_path` 把标签页锁死，绝不允许"没找到就用当前活动标签页"兜底——那会把 A 号的稿子发到 B 号。

```js
const tabs = await listTabs();                    // tab_list
const wantBase = profilePath.split(/[\\/]/).filter(Boolean).pop();
const mine = tabs.filter(t =>
  t.profile_path === profilePath ||
  t.profile_path?.split(/[\\/]/).filter(Boolean).pop() === wantBase);
```

按文件夹名兜底是因为：Unzoo 升级会改 profile 根目录（`Chromium\User Data` → `Unzoo\User Data`），配置里存的全路径会失效，但文件夹名唯一、不会串号。

`tab_list` 偶发只返回部分窗口 → **重试几次取并集**（实践中最多 6 次），别一次读空就报错。

窗口没开时用 `profile_launch { profile_path }` 拉起来，路径要**完整反斜杠**。

## 发一章的完整流程

目标页：`https://fanqienovel.com/main/writer/<bookId>/publish/?enter_from=newchapter`

```
导航 → 填标题 → 填正文 → 【可信输入 nudge】 → 等"下一步"变可用 → 点"下一步"
   → 处理弹窗（内容检测方式 / 错别字 / 风险检测）→ 发布
```

### ❗核心坑：合成 paste 填不"活"番茄的编辑器

正文编辑器是 ProseMirror。用 `ClipboardEvent('paste')` 合成粘贴，**DOM 里字出来了，但「下一步」按钮一直是禁用的**——番茄的内容识别/字数统计只认可信输入。

解法：粘完之后用 `browser_input_text` 在正文末尾灌一个空格，再真实退格删掉。`browser_input_text` 走 Chromium IME 管线，实测 `beforeinput`/`input` 均 `isTrusted=true`。

```js
// 1) 合成 paste（保留段落格式，快）
await evaluate(tabId, `(function(){
  const ed=document.querySelector('.ProseMirror'); if(!ed) return false;
  ed.focus();
  const dt=new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  return true;})()`);

// 2) nudge：光标移到正文末尾 → 灌一个空格 → 退格
await mcpCall('tab_activate', { tab_id: String(tabId) });   // 见下
await evaluate(tabId, `(function(){const ed=document.querySelector('.ProseMirror');if(!ed)return;
  ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);
  const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
await inputText(tabId, ' ');                                       // browser_input_text
await mcpCall('browser_press_key', { tab_id: tabId, key: 'Backspace' });
```

`browser_input_text` **不要求标签页在前台**。但 `browser_press_key` 仍是键盘事件，前台更稳，而且激活没有副作用 → 保留 `tab_activate`。

填之前**先彻底清空编辑器并验证为空**，否则重试会反复累积粘贴。

### 选择器（按顺序试，番茄改版时逐个降级）

```js
标题: 'input.serial-editor-input-hint-area'
    → 'input[placeholder="请输入标题"]'
    → '.serial-editor-input input'

正文: '.syl-editor-container .ProseMirror'
    → '.ProseMirror[contenteditable="true"]'
    → '.ProseMirror'
```

### 点击：没有一种点法通吃

- **「下一步」**：在页面顶部 y≈16，坐标真实点击常落空 → 用 **JS `.click()`**。错别字弹窗的「忽略」同理。
- **封面相关按钮**（修改 / 选择封面 / 本地上传 / 确认上传 / 确定 / 立即修改）：合成 `.click()`、坐标点、`browser_click` **都不稳** → 在**元素本身**派发完整指针序列 `pointerdown → mousedown → pointerup → mouseup → click`（位置无关）。优先找真 `<button>`：同样的文字常有 `span` 子节点，点 span 不触发。
- 先读状态再点，别盲点：

```js
// 'enabled' | 'disabled' | 'absent'
await evaluate(tabId, `(function(){
  const els=document.querySelectorAll('button,div[role="button"],span[role="button"],.arco-btn,[class*="btn"]');
  for(const b of els){ if(b.offsetParent===null) continue;
    if((b.textContent||'').trim().includes('下一步'))
      return (b.disabled||b.getAttribute('aria-disabled')==='true'||/disabled/.test(b.className))?'disabled':'enabled'; }
  return 'absent';})()`);
```

禁用就再 nudge 一次，最多等 ~12 秒。

### 点完「下一步」会弹的三种框

依次探测并处理（都可能不出现）：

1. **内容检测方式**：选「普通检测 / 仅基础检测 / 基础检测」，**避开「全面检测」**（有次数限制）。
2. **错别字**：文本含「错别字 / 疑似错别字 / 是否确定提交 / 仍要提交」→ 点「提交 / 确定 / 忽略 / 继续」，**排除「取消 / 返回 / 修改」**。
3. **风险检测**：文本含「风险检测 / 安全检测」→ 点「确定 / 开始检测」。

### 失败必须有上限

同一章连续软失败 N 次就**停下报错**，绝不无限重试——曾经因为没有上限而一直空点「下一步」。

## 去重：发之前先读线上进度

别靠本地记录，本地和线上会漂。从 `https://fanqienovel.com/main/writer/chapter-manage/<bookId>?type=1` 的章节表读最大章号——**已发布 + 待发布的定时章都在表里，两者都要算**，否则会把定时章重发一遍。

## 其他能力

| 要做的事 | 入口 |
|---|---|
| 列账号 | `profile_list` + `tab_list` 叠加（哪些在跑、开了哪些番茄页） |
| 列书 | 导航 `book-manage` 后解析 |
| 建新书 | `writer/create` |
| 分卷 / 卷改名 | `chapter-manage/<bookId>&<卷序号>` |
| 换封面 | 见 `references/cover.md`——**坑最多的一块，动手前必读** |
| 多书名实验 | `writer/name-experiment` |

## 安全约定

- **绝不点「删除」**（`.icon-delete`）——误删的是已发布章节，不可逆。
- 「立即修改」「立即发布」这类**保存上线**的按钮，默认停在待提交状态、交给人点；只有调用方显式传 `autoSubmit: true` 才自动点。上线即进番茄审核，不可逆。
- 确认类按钮**只精确匹配**预期文案，**绝不兜底取「最后一个按钮」或「主按钮」**——同一页的主按钮往往是「立即修改」，误点会提前保存并退出编辑态。

## 参考

- `references/api.md` —— MCP 工具清单、最小封装、响应解包与租约
- `references/cover.md` —— 封面上传：可信注入 + 全屏遮罩两步确认
- `references/pitfalls.md` —— 全部踩过的坑，按现象索引
