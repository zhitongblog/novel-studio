# 番茄换封面：Unzoo 全自动上传【已打通】

> **结论先行（2026-07-11 更新，推翻旧结论）**：番茄封面上传【可以全自动】。关键是用 **Unzoo daemon 的 REST 直连端点 `POST /api/v1/set_input_files`**——它产生 `isTrusted=true` 的真实文件事件，番茄接受。全流程已实测 `autoSubmit:true` 端到端跑通（番茄弹「修改成功，等审核」）。
>
> 早先本文曾判定"走不通、只能半自动"——那是因为只试了 `browser_upload` / `DataTransfer` / 拖拽 / CDP-shim 的 `DOM.setFileInputFiles`（这些番茄确实都不认或 Unzoo 不支持），**漏了 daemon 上还有个独立的 `/api/v1/set_input_files` REST 端点**。用户给出这个线索后一次打通。旧分析保留在文末「附录」备查。

相关代码：`src/fanqie.mjs` → `changeFanqieCover({ bookId, coverPath, profilePath, autoSubmit, onLog })`（约 2924 行起，坑都写在注释里）。

---

## 1. 全自动序列（实测跑通）

导航 `book-info/<bookId>` → **修改**(进编辑态) → **选择封面** → **本地上传** tab → **`set_input_files` 注入文件** → **确认上传** → **确定** → **立即修改**(保存上线) → 番茄弹 toast「修改成功，等审核」。

- 番茄封面竖版 3:4；本地 `cover.png`（600×800）正好，3:4 图不弹裁剪、直接出预览。
- `autoSubmit:false`(默认)→停在"待提交"(封面已进编辑表单、等人点"立即修改")；`autoSubmit:true`→自动点"立即修改"保存上线(不可逆·进番茄审核)。

## 2. ❗核心突破：`POST /api/v1/set_input_files`

```
POST http://127.0.0.1:9399/api/v1/set_input_files
{ "tab_id": <Number>, "selector": ".byte-upload input[type=file]", "file_paths": ["C:/tmp/xxx.png"] }
→ { "data": { "count":1, "trusted":true, "uploaded":true }, "success":true }
```

- 这是 **Unzoo daemon 的独立 REST 端点**，不是 `/api/v1/tools/call` 那个 MCP 工具桥（桥对 set_input_files 报 `Unknown command`）。MCP 层没有 `set_input_files`、也没有 `browser_upload_trusted`——只有这个 REST 直连端点走得通。
- 产生的文件事件 `isTrusted=true`，番茄接受（这正是旧结论以为拿不到的那把钥匙——其实 daemon 早就有）。
- selector 依次试 `.byte-upload input[type=file]` → `.cover-modal-upload input[type=file]` → `input[type=file]`。文件框此时已在遮罩面板里，直接选得到，**不需要先点触发器**。
- ⚠️中文书名目录路径先 `copyFileSync` 到 `os.tmpdir()/ns_fqcover_*.png`(ASCII) 再传，避编码坑。**临时文件在"确认按钮点亮"校验之后才删**——set_input_files 只是把磁盘文件引用塞给 input，番茄异步读取上传，删早了上传失败、确认按钮永不点亮。

## 3. ❗第二个坑：全屏遮罩 + 两步确认

- 封面选择器是**全屏遮罩面板**，不是 `.arco-modal` 小弹窗 → 按 `.arco-modal/[role=dialog]/[class*=modal]` 找按钮返回 `[]`（踩过：`确定:[]`）。
- 确认是**两步**：先【**确认上传**】(确认这张文件)，再出现橙色【**确定**】(最终确认)，遮罩才关、回到编辑表单。
- 确认按钮**只精确匹配** `['确认上传','确定','确认']`（whitespace 归一化），**绝不兜底取"最后一个/主按钮"**——否则误点同页的【立即修改】(主按钮)提前保存、直接退出编辑态(`isEdit=0`)。用循环点确认按钮直到遮罩关闭（判据：不存在 `children.length===0` 且文本===`本地上传` 的 tab 元素），最多 4 次，天然吃掉一步/两步确认。

## 4. 其他坑（仍有效）

1. 番茄按钮(修改/选择封面/本地上传/确认/立即修改) **合成 `.click()`、CDP 坐标点、`browser_click` 都不稳/不触发**；靠谱做法=在【元素本身】派发完整指针序列 `['pointerdown','mousedown','pointerup','mouseup','click']`（位置无关）。优先真 `<button>`（同文字常有 span 子节点，点 span 不触发）。
2. **编辑态刷新不重置**：navigate 到 book-info 若已在该页会跳过刷新→残留脏态让"修改"点了不进编辑态。代码 navigate 后**强制 `client.reload()`** + 容错（有"选择封面"当已在编辑态，否则点"修改"进）。反复测试会累积脏态 → 测前先把 tab 导到 `book-manage` 清一下。

---

## 附录：旧「受阻」分析（已被推翻，保留备查）

早先判定走不通，是基于这批失败尝试——它们**确实**都不行，但都不是 `set_input_files`：

| 方法 | 结果 | 失败原因 |
|---|---|---|
| `browser_upload {tab_id,selector,file_paths}` | `files:0`/未上传 | 新版上传器不认它注入的文件（旧版曾 `uploaded:true`，改版后失效） |
| `DataTransfer`+`input.files=`+派发 `change` | 番茄立刻清空、无上传 POST | 合成 `change` 不带 `isTrusted` |
| `human_upload` / `drag-drop-file` | `accepted:false` / 0 上传请求 | 事件非 trusted |
| CDP `DOM.setFileInputFiles`（via Unzoo CDP shim） | 命令不存在 | shim 只实现了 `Runtime.evaluate`/`Input.dispatchMouseEvent` 等一小撮，无 DOM 域 |

**教训**：番茄确实只收 `isTrusted` 文件事件；但"Unzoo 没有产出真文件事件的能力"这个二段论**错了**——CDP shim 没有不代表 daemon 没有，daemon 的 REST 层就藏着 `/api/v1/set_input_files`。下次遇到"某能力 MCP/CDP 都没有"，先把 daemon 的 REST 端点列表翻一遍再下结论。
