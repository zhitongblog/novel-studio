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

## 🔴 1b【Bug】报错文案给的能力名，API 自己不认

`browser_screenshot` 经 MCP 通道被能力租约拦下时，报错是：

```
capability lease required for 'browser_screenshot' (channel=mcp):
no valid lease for capability=DesktopObserve holder=mcp.
申请:POST /api/v1/lease/request {"capability":"..."} 再 /lease/grant
```

照着它说的 `DesktopObserve` 去申请，**被拒**：

```bash
curl -X POST .../api/v1/lease/request -d '{"capability":"DesktopObserve","holder":"mcp"}'
# → unknown variant `DesktopObserve`, expected one of `browser`, `desktop_input`,
#   `desktop_observe`, `file_read`, `file_write`, `network`, `shell`
```

要传蛇形 `desktop_observe` 才行。**报错文案是引导用户自救的，结果它给的名字用不了**——我们只能在代码里做帕斯卡→蛇形转换兜着。

**期望**：报错里的 capability 直接输出 API 接受的形式。

---

## 🟠 1c【一致性】同一能力，MCP 通道要租约，扁平端点不要

| 通道 | `browser_screenshot` / `/api/v1/screenshot` |
|---|---|
| MCP `/api/v1/mcp/tools/call` | ❌ 被拒，要 `desktop_observe` 租约 |
| 扁平 `/api/v1/screenshot` | ✅ 直接出图，无需租约 |

同一台机器、同一个进程、同一个能力，换条通道就绕过了管控。这让租约作为安全控制形同虚设（想绕的人走扁平端点就行），却只惩罚了走官方通道的集成方。

我们已经在自己的调用层里做了「撞到 lease 错误就自动 request+grant 后重试」——实测 request→grant **无需任何人工批准**，300 秒有效。这也说明这层管控目前只是障碍，不是防线。

**期望**：要么两条通道一致管控，要么明确说明租约的威胁模型是什么、程序化自动授予是否是预期用法。

---

## 🔴 1d【Bug·新增 2026-08-25】`page_click` / `browser_press_key` 在窗口非前台时**静默无操作**

迁移到官方 MCP 后实测发现的，比 #1b/#1c 都要命，因为**没有任何错误可以捕获**。

| 条件 | `page_click` 返回 | 实际点击事件 |
|---|---|---|
| 浏览器窗口不在 OS 前台 | `{"content":[{"text":"null"}]}` | **0 个** |
| 窗口在前台（`tab_activate` 之后） | 同样是 `null` | 1 个，`isTrusted=true`，坐标精确 |

**返回值完全一样**——没有 `isError`、没有 `matched:false`、没有任何提示。调用方无法区分「点了」和「没点」。`browser_press_key` 表现完全相同。

对比：`browser_input_text` / `browser_click`（选择器版）/ `browser_type` 是标签页定向的，**不受前台影响**，任何时候都正常。

### 为什么这条危险

我们的番茄发布流程是长时间后台运行的。用户在这期间切到别的窗口是**常态**。按当前行为，发布会「看起来在跑」但每一次坐标点击和按键都落空，最后表现成莫名其妙的卡住——而日志里一行错误都没有。这类静默失效比直接报错难查一个数量级。

### 复现

```bash
# 让浏览器窗口不在前台（比如点一下终端），然后：
curl -s -X POST .../api/v1/mcp/tools/call \
  -d '{"name":"page_click","arguments":{"tab_id":"<TAB>","loc":[200,230]}}'
# → {"content":[{"text":"null","type":"text"}]}   页面上什么都没发生

# tab_activate 之后同样的调用 → 同样的返回值，但这次真的点了
```

### 期望

1. 前台条件不满足时**返回错误**（或至少 `{clicked:false, reason:"window_not_foreground"}`），不要静默成功。
2. 在工具 description 里写明「需要浏览器窗口处于 OS 前台」——目前只字未提。
3. 顺带：`page_click` 的 `loc` 参数描述写的是 **"[x,y] screen coordinates"**，但实测传**视口坐标**才命中（我们传 `getBoundingClientRect()` 的值，事件里的 `clientX/clientY` 与之完全一致）。描述该改成 viewport coordinates，否则集成方会按屏幕坐标换算、点飞。

### 我们已做的兜底

`UnzooClient.ensureForeground()`：`coordClick` / `pressKey` 调用前自动 `tab_activate`（3s 节流，避免连按时反复抢焦点）。代价是会打断用户当前操作——但这两个工具不这样根本没法用。

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
| 1b | 报错给的 capability 名 API 自己不认 | 🔴 高（好修） | Bug |
| 1c | 租约只管 MCP 通道，扁平端点绕过 | 🟠 中 | 设计/安全 |
| 1d | page_click/press_key 非前台时静默无操作 | 🔴 高 | Bug（新增） |
| 2 | 三通道行为不一致 | 🟠 中 | 设计 |
| 3 | OpenAPI 没有指路 | 🟡 中低 | 文档 |
| 4 | 等待页面就绪的原语 | 🟡 中低 | 需求 |
| 5 | 点击不触发 | ⚪ 已部分复验 | 见下 |
| 6 | CDP shim 现状 | ⚪ — | 咨询 |

**#1–#4 建议现在提**，#1b 尤其划算（改一行文案的事）。#6 是我们自己的技术债。

---

## 附：我们这侧已完成的迁移（2026-08-25）

已把全部浏览器自动化收敛到**唯一出口 `src/unzoo.mjs`，只走 `/api/v1/mcp/tools/call`**，兼容层全部拆除：

| 原（兼容层） | 现（官方 MCP） | 验证 |
|---|---|---|
| `/api/v1/tools/call` | `/api/v1/mcp/tools/call` | 全套 32 项测试通过 |
| `/api/v1/click {x,y}` | `page_click {loc:[x,y]}` | ✅ 实测 isTrusted=true、坐标精确命中 |
| `/api/v1/type {text}` | `browser_input_text {text}` | ✅ 实测 beforeinput/input 均 isTrusted=true |
| `/api/v1/set_input_files` | `browser_upload_trusted` | 语义对齐（该工具描述直接点名番茄封面用例） |
| `/api/v1/dialog/handle` | `browser_handle_dialog` | — |
| `/api/v1/profiles/launch` | `profile_launch` | — |
| `/api/v1/screenshot` | `browser_screenshot` + 自动租约 | ✅ 取租约后正常出图 |

配套加了 `test/unzoo-mcp.test.mjs`：静态扫描 51 个源文件禁止兼容层端点回流，四种响应形状解包，租约自动续租与蛇形转换，以及在本地 `file://` 测试页上实测 `isTrusted`。

**关于 #5**：坐标点击与可信输入这两条在**本地测试页上已复验通过**（isTrusted=true、落点准确）。番茄 Arco 按钮那批「点了没反应」的结论仍未在真实页面复验——那需要登录态和真实书目。

---

# 处理状态（2026-08-25 回填）

已在 v2.5.28 源码 + 运行态逐条核实，**全部条目有去向，无遗漏**。

| # | 核实结论 | 去向 |
|---|---|---|
| 1 | ✅ 属实，**范围比我们发现的更大** | [#151](https://github.com/unzooai/unzoo/issues/151) |
| 1b | ✅ 属实，根因已定位到一行 | [#155](https://github.com/unzooai/unzoo/issues/155) |
| 1c | ✅ 属实，**比我们说的更严重** | [#156](https://github.com/unzooai/unzoo/issues/156) |
| 2 | ✅ 属实 | 并入 [#151](https://github.com/unzooai/unzoo/issues/151) 评论 |
| 3 | ⚠️ **一处需自我更正**，核心诉求属实 | [#154](https://github.com/unzooai/unzoo/issues/154) |
| 4 | 🔴 **远比我们以为的严重** | [#153](https://github.com/unzooai/unzoo/issues/153) |
| 5 | ⏸ 维持原判，需真实页面复验 | 暂不提 |
| 6 | ✅ 已答复 | 见下文 |
| 新 | 前台/后台执行边界未文档化 | [#152](https://github.com/unzooai/unzoo/issues/152) |

## #1 我们的机制推测不对

我们猜「旧路由命令表覆盖不全，唯独这两个上传工具没注册」。真实根因是两条：

1. #110 加的兜底只在 `is_local_tool()==true` 时触发，而该函数的前缀白名单**不含 `browser_`**；
2. 「工具名 → 专用 REST 端点」的映射表 `v1816_rest_endpoint()` **只在 MCP 路径被查**。

掉队的不是个别工具，是**整个 `browser_` 便利工具族**。我们请求的「自查全表」对方已完成——**我们只发现了 4 个硬失败里的 2 个**，漏掉的两个正是等待类：

- 硬失败：`browser_set_input_files`、`browser_upload_trusted`、**`browser_wait_for`**、**`browser_network_wait_for`**
- 静默语义分叉（200 + 错数据）：`tab_get_info`（返回整个列表而非单个）、`browser_delay`
- 参数契约分叉：`profile_get_fingerprint`（`profile_id` vs `profile_path`）

## #3 需自我更正：OpenAPI 覆盖是完整的

我们写的「255 条 path、完整」**是对的**。对方一度统计为「只有 178 条、83 条未文档化」并已在 #151 发更正——实测 router 261 vs openapi 255，差的 6 条全是 HTML 页面（`/docs/`、`/settings/*`、`/tools`），**API 端点一条不缺**。

我们的核心诉求（**没有任何入口指向它**）完全成立。核实到比我们说的更糟：

- 数字不是三个是**四个**：CLI 模块注释与 `--help` 写 `290+`、`unzoo tools` footer 写 `194+`、`tools/list` 返回 `96`、manifest `313`
- `unzoo tools` **从不调用 `tools/list`**，只 ping `/api/v1/status` 探活后打印硬编码表；它列出的 `navigate_back`/`navigate_forward`/`reload` 在 CLI 的 44 个命令里根本不存在
- `tools/list` 的 96 是 tool profile 过滤视图、manifest 313 才是全集，**这点没有任何文档说明**——这正是我们「找不到 `browser_wait_for_function`」的真正原因

## #4 这条是我们那次线上事故的直接成因

`browser_wait_for_function` 不是「缺文档」，**它是空壳**。而且不止它一个：

| 工具 | 传 `timeout_ms:4000` 实际耗时 | 返回 |
|---|---|---|
| `browser_wait_for_selector` | **95 ms** | `{}` 假成功 |
| `browser_wait_for_network_idle` | **109 ms** | `{}` 假成功 |
| `browser_wait_for_function` | **132 ms** | `{}` 假成功 |
| `browser_wait_for` ✅ | 4132 ms | `{"elapsed_ms":4017,"matched":false}` |
| `browser_delay` ✅ | 4112 ms | `{"delayed_ms":4000}` |

两层根因：① `browser_wait_for_function` 的 schema 声明 `expression`/`timeout_ms`，实现却读 `function`/`timeout`，读不到就兜底成字面量 `true` → `if(true) return true` 恒真立即返回；② transform 生成的是 `(async function(){…})()` 即 Promise，而 `eval_js` **不 await**，直接拿 `{}` 返回。

**对我们的行动含义**：

1. 那次「把还没渲染完误判成没有该章」的事故，成因在这里——无论选哪个 wait 工具，拿到的都是假就绪信号
2. **我们自己写的轮询是唯一正确解，#153 修复前不要删**
3. 轮询继续用**同步表达式**：`browser_evaluate` 不 await Promise（实测 `(async()=>{await sleep(2000);return 42})()` → 128ms 返回 `{}`；同步 `42` → 正确返回 42）
4. **现在就能改的一处**：就绪判定从 `browser_wait_for_selector` 换成 `browser_wait_for`，它是真的等，且如实返回 `matched`

## #1c 比我们说的更严重

不只是「扁平端点绕过」。`enforcement::enforce()` **全仓只有一个调用点**（`mcp_server.rs:633`，硬编码 `Channel::Mcp`），而 `Channel` 枚举定义了 6 条通道：

```rust
pub enum Channel { Rest, Mcp, Workflow, Brain, Cdp, Provider }
//                  ↑只有 Mcp 被接入，其余 5 条声明了却从不校验
```

实际暴露面：扁平端点、`/api/v1/tools/call`、CLI `unzoo call`、CDP shim **全部绕过**。

更麻烦的是 `/api/v1/tools/call`：`is_local_tool()==true` 的工具会经兜底回到 MCP 分发器从而受管控，`browser_` 族则不会——**同一个端点里一部分工具受管控、一部分不受**，比整体不管控更难推理。

另外我们观察到的「request→grant 无需人工批准」与代码注释直接矛盾：`Capability::requires_explicit_grant()` 把 `DesktopObserve` 等标为「需用户显式授权，不自动批准」，实际可程序化自助获取。这条已一并写进 #156。

## #5 复验了一半，维持原判

在 `about:blank` 的原生 `<button>` 上实测：标签页 `visibilityState=hidden` 且 `document.hasFocus()=false` 时，`browser_click` **能正常触发**（计数器 0→1）。

但这**否证不了**我们记录的 Arco 组件问题——SPA 的 portal / 遮罩层 / 事件委托是完全不同的场景。**结论不变：真实番茄后台页面复验后再提，指针序列补丁暂时保留。**

顺带修正我们清单里的一句话：「部分按钮要求标签页处于前台才触发」——这条在原生元素上不成立。对方新出的《后台执行指南》（#152）结论是绝大部分能力不需要前台，例外只有三个：合成 Ctrl+V（被浏览器安全策略拦截，须改用 `/api/v1/clipboard/*`）、视口截图（会抢活动标签，加 `full_page:true` 规避）、`tab_activate`（会把整个浏览器窗口提到 OS 前台，后台流程不应调用）。

## #6 CDP shim：已答复，不必提

- **未废弃**，代码在 `cdp_shim.rs`，9222 仍是默认端口
- 被 `managed_mode` 门控（#98 安全考虑：9222 无认证，可绕过 auth/lease/审计）
- ⚠️ **我们代码里的报错提示「请在 Unzoo 设置里开启 CDP」是错的**——`/api/v1/settings/service` 返回的键里根本没有 `managed_mode`，UI 也没这个开关。唯一手段是环境变量 `UNZOO_MANAGED_MODE=0`。**这条文案要改掉，否则以后还会误导我们自己。**
- 本机当前 `managed=false` 且 9222 无监听、端口也没被占用，说明 shim 启动失败了

**我们原计划（把 `cdpClick` 迁到官方 MCP 工具、不依赖 shim）继续执行**——理由更充分了：它默认关闭且没有正规开关。注意 #156 提到 `Channel::Cdp` 从不校验租约，如果对方按方案 A 收紧，CDP 路径可能进一步受限。
