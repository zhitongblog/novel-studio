# 坑表（按现象索引）

遇到问题先在这里找现象，别从头调。

---

**「下一步」按钮一直是灰的，正文明明已经在页面上了**

番茄的 ProseMirror 只认**可信输入**才触发内容识别/字数统计。合成 `ClipboardEvent('paste')` 只改了 DOM。
→ 用 `browser_input_text` 在正文末尾灌一个空格再 `browser_press_key` 退格，正文零残留。它走 Chromium IME 管线，`beforeinput`/`input` 均 `isTrusted=true`。

---

**nudge 了还是不亮**

`browser_input_text` 本身不要求前台，但 `browser_press_key` 是键盘事件、前台更稳。
→ nudge 之前先 `tab_activate`（没有副作用）。

---

**点「下一步」没反应**

该按钮在页面顶部（y≈16），坐标真实点击常落空。
→ 用 JS `.click()`。（错别字弹窗的「忽略」同理。）

---

**点封面相关按钮没反应**

合成 `.click()`、坐标点、`browser_click` 都不稳。
→ 在元素本身派发 `pointerdown→mousedown→pointerup→mouseup→click` 完整序列。优先真 `<button>`，同文字常有 `span` 子节点、点 span 不触发。

---

**重试之后正文变成两遍、三遍**

每次填之前没清空。
→ 填之前彻底清空编辑器**并验证为空**，再粘贴。

---

**发到了别的账号**

`tab_list` 没锁 `profile_path`，或者锁不到就兜底用了当前活动标签页。
→ 严格按 `profile_path` 过滤，**锁不到就报错，绝不兜底**。

---

**明明账号在跑，`tab_list` 却找不到它的标签页**

`tab_list` 偶发只返回部分窗口。
→ 重试几次取并集（实践中最多重试 6 次）。

---

**升级 Unzoo 之后所有账号都对不上了**

Unzoo 升级会改 profile 根目录（`Chromium\User Data` → `Unzoo\User Data`），配置里存的全路径失效。
→ 全路径匹配之外，再按 **profile 文件夹名**兜底匹配（如 `Profile_xxx`）。文件夹名唯一，不会串号。

---

**`profile_launch` 报 `failed to load profile`**

`profile_path` 的反斜杠被吞了。
→ 传完整反斜杠路径。

---

**`browser_evaluate` 超时**

页面弹了阻塞式 alert，eval 卡住了。
→ 先调 `browser_handle_dialog` 关掉弹窗，再重试一次。

---

**章节重复发布**

只看了本地记录，或者只统计了「已发布」。
→ 从 `chapter-manage/<bookId>?type=1` 读线上最大章号，**已发布 + 待发布的定时章都要算**。

---

**一直在空点「下一步」，停不下来**

软失败重试没有上限。
→ 同一章连续失败 N 次就暂停报错。

---

**封面上传成功但确认按钮永远不亮**

临时文件删早了。可信注入只塞了文件引用，番茄异步读取。
→ 等确认按钮点亮/上传完成之后再删临时文件。

---

**误点了「立即修改」，编辑态退出、改动提前上线**

确认按钮用了「取最后一个按钮」或「取主按钮」的兜底逻辑，而同页主按钮就是「立即修改」。
→ 确认按钮**只精确匹配**预期文案，绝不兜底。

---

**找不到弹窗里的按钮，选择器返回 `[]`**

封面选择器是**全屏遮罩面板**，不是 `.arco-modal` 小弹窗。
→ 别按 modal 类名找，直接在 document 范围内按文案找。

---

**「修改」点了不进编辑态**

navigate 到已在的页面会跳过刷新，残留脏态。
→ navigate 后强制 `reload()`。反复测试前先导到 `book-manage` 清一下。

---

**选了「全面检测」，次数用光了**

内容检测方式弹窗默认可能落在「全面检测」。
→ 只点「普通检测 / 仅基础检测 / 基础检测」，明确排除含「全面」的选项。

---

**调某个工具报 `Unknown command: browser.xxx`**

用了"统一分发"端点 `/api/v1/tools/call` 或 `unzoo call` CLI——它们共用一套点号命名空间的旧路由，**命令表覆盖不全**，而能力清单还声明该工具 transport 含 cli/rest。
→ 改走官方 MCP 端点 `POST /api/v1/mcp/tools/call`。

---

**上传静默失效：没报错，文件也没上去**

多半是把 `browser_set_input_files`（预备拦截下一个文件对话框）当成了"直接塞文件"。
→ 直接塞文件用 `browser_upload_trusted`。

---

**截图报 `no valid lease for capability=DesktopObserve`**

观察类工具在 MCP 通道受 capability lease 管控（扁平端点不管，这是两条通道的又一处不对等）。
→ 自动 `request`+`grant` 后重试，无需人工批准，租约 300s。**注意报错给的是 `DesktopObserve`（帕斯卡），`/lease/request` 只认 `desktop_observe`（蛇形），照抄会被拒。**

---

**某个能力调不通，就以为 Unzoo 做不到**

文件上传曾因此被判"走不通、只能半自动"，绕了很久。**能力一直都在，是通道到不了。**
→ 下结论之前，先换官方 MCP 端点再试一遍。
