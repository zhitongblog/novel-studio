# 番茄封面上传

**结论：可以全自动。** 但只有一条路走得通，其余全部试过、全部不行。

> 早年一份分析曾判定"Unzoo 没有可信上传能力，只能半自动"。**错的不是能力，是通道**——能力一直都在，我们用的路由到不了。

## 唯一走得通的上传法

```
POST http://127.0.0.1:9399/api/v1/mcp/tools/call
{ "name": "browser_upload_trusted",
  "arguments": { "tab_id": 123, "selector": ".byte-upload input[type=file]",
                 "file_paths": ["C:/tmp/x.png"] } }
```

它产生的 `change` 事件 `isTrusted=true`，番茄才收。

**必须走官方 MCP 端点 `/api/v1/mcp/tools/call`。** 经"统一分发"的 `/api/v1/tools/call` 或 `unzoo call` CLI 调它，实测 2.5.28 一律报 `Unknown command: browser.set_input_files`——那套旧路由的命令表覆盖不全，而能力清单还声明它 transport 含 cli/rest。

> ⚠️ **`browser_upload_trusted` ≠ `browser_set_input_files`**。后者是"预备拦截下一个文件对话框"，名字几乎一样、行为完全不同。混用会让上传**静默失效**。

selector 依次试：`.byte-upload input[type=file]` → `.cover-modal-upload input[type=file]` → `input[type=file]`。文件框此时已在遮罩面板里，**不需要先点触发器**。

### 试过但不行的

| 方法 | 现象 | 原因 |
|---|---|---|
| `browser_upload`（旧工具桥） | `files:0` | 新版上传器不认（旧版曾能用，改版后失效） |
| `DataTransfer` + `input.files=` + 派发 `change` | 番茄立刻清空、没有上传请求 | 合成 `change` 没有 `isTrusted` |
| `human_upload` / 拖拽 | `accepted:false` / 0 请求 | 事件非 trusted |
| CDP `DOM.setFileInputFiles` | 命令不存在 | Unzoo 的 CDP shim 只实现了 `Runtime.evaluate`、`Input.dispatchMouseEvent` 等一小撮，没有 DOM 域 |
| `browser_upload_trusted` 走 `/api/v1/tools/call` 或 CLI | `Unknown command` | 旧路由命令表覆盖不全——**能力是对的，通道错了** |

## 全流程

```
navigate book-info/<bookId>?type=1 → 强制 reload → 点「修改」进编辑态
  → 点「选择封面」→ 切到「本地上传」tab
  → browser_upload_trusted 注入文件
  → 点「确认上传」→ 点「确定」（两步！）→ 遮罩关闭、回到编辑表单
  → （autoSubmit 时）点「立即修改」→ toast「修改成功，等审核」
```

- 封面是竖版 **3:4**。`600×800` 正好，3:4 图不弹裁剪、直接出预览。
- `autoSubmit:false`（默认）停在待提交，等人点「立即修改」；`autoSubmit:true` 自动上线，**不可逆、直接进番茄审核**。

## 三个坑

### 1. 临时文件不能删早

中文书名目录的路径先 `copyFileSync` 到 `os.tmpdir()/xxx.png`（ASCII）再传，避编码坑。

**但删除必须等到「确认按钮点亮」之后。** 可信注入只是把磁盘文件的引用塞给 input，番茄是**异步读取上传**的——删早了上传失败，确认按钮永远不亮。

### 2. 是全屏遮罩，不是小弹窗

封面选择器是**全屏遮罩面板**。按 `.arco-modal` / `[role=dialog]` / `[class*=modal]` 去找按钮会返回 `[]`（踩过：`确定:[]`）。

### 3. 两步确认，且确认按钮绝不能兜底匹配

先【确认上传】（确认这张文件），再出现橙色【确定】（最终确认），遮罩才关。

确认按钮**只精确匹配** `['确认上传','确定','确认']`（whitespace 归一化），**绝不兜底取「最后一个按钮」或「主按钮」**——同页的主按钮是【立即修改】，误点会提前保存并退出编辑态（`isEdit=0`）。

做法：循环点确认按钮直到遮罩关闭，最多 4 次——这样一步确认和两步确认都能吃掉。判据是：不存在「`children.length===0` 且文本 === `本地上传`」的 tab 元素。

## 按钮点不动时

番茄的封面相关按钮（修改 / 选择封面 / 本地上传 / 确认 / 立即修改）合成 `.click()`、CDP 坐标点、`browser_click` **都不稳**。靠谱做法是在**元素本身**派发完整指针序列：

```js
['pointerdown','mousedown','pointerup','mouseup','click']
  .forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
```

位置无关。优先找真 `<button>`：同样的文字常有 `span` 子节点，点 span 不触发。

## 编辑态会残留脏态

navigate 到 `book-info` 时若已在该页会跳过刷新 → 残留脏态让「修改」点了不进编辑态。**navigate 后强制 `reload()`**，再容错判断（页面上有「选择封面」= 已在编辑态，否则点「修改」进）。

反复测试会累积脏态 → 测前先把 tab 导到 `book-manage` 清一下。
