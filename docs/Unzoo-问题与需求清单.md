# 给 Unzoo 的问题与需求清单

> 环境：Unzoo Browser **2.5.28**（Windows x64，standalone / ipc 模式）
> 复验日期：2026-08-25。以下每条都标了「已复现 / 待复验」，已复现的都附了可直接粘贴的命令。
> 使用方：Novel Studio（Node 侧直连 daemon REST，`http://127.0.0.1:9399`）

---

## 🔴 1【Bug·最高优先】同一个工具，换个调用通道就 `Unknown command`

`browser_set_input_files` 与 `browser_upload_trusted` 在**官方 MCP 端点能正常工作**，但走**统一分发端点 `/api/v1/tools/call`** 和 **`unzoo call` CLI** 都报 `Unknown command`。

### 复现

```bash
# ✅ 成功：官方 MCP 端点
curl -s -X POST http://127.0.0.1:9399/api/v1/mcp/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name":"browser_set_input_files","arguments":{"selector":"input[type=file]","file_paths":["C:/x.png"]}}'
# → {"content":[{"text":"{\"armed\": true,\"timeout_ms\": 15000}","type":"text"}]}

# ❌ 失败：统一分发端点
curl -s -X POST http://127.0.0.1:9399/api/v1/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"tool":"browser_set_input_files","arguments":{"selector":"input[type=file]","file_paths":["C:/x.png"]}}'
# → {"error":"Unknown command: browser.set_input_files","success":false}

# ❌ 失败：CLI
unzoo call browser_set_input_files '{"selector":"input[type=file]","file_paths":["C:/x.png"]}'
# → 错误: [500] browser_set_input_files: Unknown command: browser.set_input_files
```

`browser_upload_trusted` 表现完全相同（`Unknown command: browser.upload_trusted`）。

### 为什么这条最要紧

**能力清单在撒谎。** `/api/v1/capability/manifest` 对这两个工具明确声明：

```
browser_set_input_files | transport: ['mcp', 'cli', 'rest'] | profiles: ['standard','full']
browser_upload_trusted  | transport: ['mcp', 'cli', 'rest'] | profiles: ['standard','full']
```

`/api/v1/mcp/tools/list` 也照常把它们列出来、带完整 description。**声明可用、清单可见、实际调不通**——集成方没有任何办法在调用之前发现这件事，只能线上炸一次才知道。

### 机制推测

`/api/v1/tools/call` 和 CLI 共用一套「点号命名空间」的旧路由（`browser_get_title` → `browser.get_title`），而 `/api/v1/mcp/tools/call` 用的是真正的 MCP 注册表。旁证：给统一分发端点传一个不存在的工具名 `__nope__`，报错是 `Unknown command: ._nope__`——第一个下划线被替换成了点。所以问题不是名字解析，而是**旧路由的命令表覆盖不全**：`browser_get_title` / `browser_a11y_snapshot` / `browser_press_key` / `browser_wait_for_selector` 这些多下划线工具都能正常路由，唯独这两个上传类工具没注册。

### 这条曾经害我们绕了多久

我们为了给番茄小说换封面，试遍了 `browser_upload`、`DataTransfer`、拖拽、CDP `DOM.setFileInputFiles`，全部失败，写了整整一篇《受阻分析》，结论是「Unzoo 没有产出可信文件事件的能力」。**这个结论是错的**——能力一直在，只是我们用的那条通道到不了它。最后是靠人工提示才试到独立端点 `POST /api/v1/set_input_files`（这个能通）。

### 期望

1. 修掉覆盖差：`/api/v1/tools/call` 与 CLI `call` 应能路由到 MCP 注册表里的**每一个**工具。
2. 在修好之前，**能力清单不应该声明 `transport: ['mcp','cli','rest']`**——声明和实现必须一致，否则清单毫无价值。
3. 报错文案改成可自救的：`Unknown command: browser.set_input_files（该工具当前仅 mcp 通道可用，请改用 POST /api/v1/mcp/tools/call）`。

### 附带请求：请你们自查全表

我们没敢遍历 313 个工具去挨个试——里面有 `profile_delete`、`system_uninstall` 这类不可逆操作，在用户的真实浏览器上扫一遍风险太大。这个自查你们在测试环境做最合适：**把 manifest 里声明 `rest`/`cli` transport 的工具全部过一遍统一分发端点，列出所有返回 `Unknown command` 的**。我怀疑不止这两个。

---

## 🟠 2【一致性】三条调用通道，三种行为

目前同一个能力最多有三个入口，语义和覆盖面都不一样：

| 通道 | 入参形状 | 覆盖 |
|---|---|---|
| `POST /api/v1/mcp/tools/call` | `{name, arguments}` | 全（MCP 注册表） |
| `POST /api/v1/tools/call` | `{tool, arguments}` | **不全**（见 #1） |
| `POST /api/v1/<动作>`（如 `/api/v1/set_input_files`、`/api/v1/click`、`/api/v1/type`） | 各自扁平 body | 各自独立，与前两者不成映射 |

连字段名都不一样（`name` vs `tool`）。集成方要么三套都写、要么试错。

**期望**：明确一条推荐通道并在文档里写清楚；其余标注为兼容层。哪条能力只在哪条通道上有，在能力清单里如实标出来。

---

## 🟡 3【文档】OpenAPI 存在，但没人找得到

`http://127.0.0.1:9399/openapi.json`（255 条 path，完整）和 `/docs` 都是好的——**但 `unzoo --help`、`unzoo tools`、`unzoo reference` 里一个字都没提**。`unzoo tools` 只给了一份约 60 条的分组速查，末尾写「使用 `unzoo call <tool_name>` 可调用全部 194+ 工具」，而 manifest 实际是 313 个。

我们第一轮排查时因此认定「没有接口文档」，全靠 `--help` 和挨个 curl 探路。

**期望**：
1. `unzoo --help` / `unzoo tools` 末尾加一行指向 `/openapi.json` 与 `/docs`。
2. `unzoo tools --all` 直接输出 manifest 全表（含 transport 与 profile）。
3. 速查里的「194+」跟 manifest 的 313 对齐。

---

## 🟡 4【能力】页面就绪信号：请给一个「等到列表真的渲染完」的原语

我们驱动的番茄小说后台是 SPA + Arco 表格，导航/翻页后 DOM 要好几百毫秒才出数据行。目前只能自己写轮询（`browser_evaluate` 每 400ms 探一次，探到「有真数据行 / 明确空态 / 硬失败」为止）。用固定 sleep 必然踩竞态——我们就为这个吃过一次「把还没渲染完误判成没有该章」的线上事故。

现有的 `browser_wait_for_selector` 不够用：选择器存在 ≠ 数据渲染完（表格骨架先于数据出现）。

**期望**：一个「等到某个 JS 断言为真」的端点，比如 `browser_wait_for_function(expression, timeout_ms, poll_ms)`——manifest 里其实列了 `browser_wait_for_function`，但我们没在文档里找到用法说明（见 #3）。如果已经有，请补文档；如果只在 MCP 通道有，那就是 #1 的又一例。

---

## ⚪ 5【待复验·不确定是否仍存在】按钮点击不触发

我们代码里积了大量注释，说番茄后台的 Arco 按钮/弹窗卡片对合成点击不响应，必须在元素上派发完整指针序列 `pointerdown → mousedown → pointerup → mouseup → click`：

- `browser_click`（选择器版）、`/api/v1/click`（坐标版）、JS `.click()` 都出现过「点了没反应」
- 部分按钮要求标签页处于**前台**才触发，后台标签页里可信点击也会落空
- 同文字常有 `<span>` 子节点，点 span 不触发，必须点到真正的 `<button>`

⚠️ **这些结论都是 1.8.x 时代记的，2.5.28 上我没有复验**（需要登录态 + 真实书目才能测，不适合在用户的生产账号上跑）。**先别作为 bug 提**，建议我们自己先复验一轮：如果 2.5.28 已经修好，我们可以删掉一大堆补丁代码；如果还在，再带着新证据提。

同理，`/api/v1/click`「坐标点击对番茄顶部按钮常落空」这条也待复验。

---

## ⚪ 6【环境】CDP shim 默认不开，但我们代码依赖它

我们有一条 `cdpClick` 路径走 `ws://127.0.0.1:9222`，用于那些只认 `Input.dispatchMouseEvent` 的按钮。当前 9222 端口不通（`/json/version` 无响应），OpenAPI 里也没有任何 cdp/devtools 相关 path。

这条**更像是我们该改**（迁到官方 MCP 工具，别依赖 shim），但想确认两件事：

1. CDP shim 在 2.5.28 里是否仍受支持？还是已经废弃？
2. 如果还支持，怎么开？（我们代码里的报错提示写的是「请在 Unzoo 设置里开启 CDP」，不确定现在还准不准）

---

## 优先级建议

| # | 内容 | 优先级 | 类型 |
|---|---|---|---|
| 1 | tools/call 与 CLI 覆盖不全 + 能力清单说谎 | 🔴 高 | Bug |
| 2 | 三通道行为不一致 | 🟠 中 | 设计 |
| 3 | OpenAPI 没有指路 | 🟡 中低 | 文档 |
| 4 | 等待页面就绪的原语 | 🟡 中低 | 需求 |
| 5 | 点击不触发 | ⚪ — | **先自己复验** |
| 6 | CDP shim 现状 | ⚪ — | 咨询 |

**只有 #1–#4 建议现在提。** #5 是旧结论没复验，#6 是我们自己的技术债。
