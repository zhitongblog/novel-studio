# 📚 Novel Studio · 网文工作室

把 **Unterm** + **Codex / Claude Code / Gemini CLI** 编排起来，自动进行**多本长篇网文写作**，并在写作过程中**自动监控、自动应答**——AI 一发问就自动继续或采纳推荐项，无需盯着窗口。

> **三种界面，同一引擎**：
> - 🖥️ **桌面应用（Tauri 原生窗口）** — 推荐，`desktop/`，书架/写作工作台/实时镜像/用量都在图形界面里
> - ⌨️ **终端 TUI** — `novel`
> - 🔧 **CLI / MCP** — 脚本化与被 Claude Code 调用
>
> 桌面应用 = Tauri 原生外壳 + 网页前端(`ui/`) + Node 引擎(`novel serve`)。Tauri 启动时自动拉起引擎，零额外配置。

写作规范直接复用 codex 的 [`longform-webnovel-writer`](file://~/.codex/skills/longform-webnovel-writer) skill（设定圣经 / 分卷大纲 / 章节 .txt / 批次自检 / 反 AI 味标准），并落成每本书目录里的 `AGENTS.md` · `CLAUDE.md` · `GEMINI.md`，确保**换模型不换文风**。

## 核心理念

- **每本书 = 一个 Unterm profile = 一个项目目录**。profile 把身份/环境绑定到独立窗口。
- **半自动·可视窗口**：点一下，自动开一个绑定该书 profile 的新 Unterm 实例 → 开代理 → 启动你选的模型 → 注入写作指令 → 你在那个可见窗口里实时观看 AI 写作。
- **Autopilot 自动监控应答**：编排器直连该实例的 MCP（TCP JSON-RPC），轮询屏幕与 busy 状态：
  - 选择/审批型提问 → 回车采纳高亮的**推荐/默认项**
  - `y/n` 型提问 → 自动应答 `y`
  - 写完一批空闲 → 自动发"继续"驱动下一批（有上限保护）
  - **每写够 N 批 → 自动插入一次「全文逻辑自检」**（默认每 5 批；查全书时间线/伏笔/人设/设定矛盾，写报告并修硬伤、更新 `continuity_ledger.md`）
  - 命中完成短语 → 自动停止

> **关于"会不会一直写"**：默认 autopilot 会一批接一批连续写（适合长篇无人值守）。刹车有三道：①续写上限 `maxAutoContinue`（默认 40 次/会话）②完成短语 ③手动停止。
> 单批自检只看最近一批，**全书级逻辑漂移**靠周期性「全文逻辑自检」兜底（`fullCheckEvery`，设置页可调，0=关闭）。

## 是否需要 token / API Key？—— 不需要

Novel Studio 本身**零密钥**：它读取 Unterm 实例本地自动生成的 auth_token（自动，无需你提供），
写作额度消耗在 **codex/claude/gemini 各自的登录**上（与本软件无关）。装上即用。

## 安装 / 打包

> 零运行时依赖，需 Node ≥ 18 和已安装的 Unterm（`C:\Program Files\Unterm\`）。

三种安装方式（任选其一）：

```powershell
# ① 全局命令（推荐）：装完任意目录可用 `novel`
cd D:\PM\storybook\novel-studio
npm install -g .
novel                         # 启动 TUI

# ② npm 包（拷到别的机器安装）
npm install -g D:\PM\storybook\dist\novel-studio-1.0.0.tgz

# ③ 便携 zip / 免安装：解压 novel-studio-1.0.0-portable.zip 后
node bin\novel.mjs            # 或双击「启动 Novel Studio.cmd」
```

打包产物（`npm pack` + 便携 zip）位于 `D:\PM\storybook\dist\`。

### 桌面应用（Tauri）

```powershell
cd D:\PM\storybook\novel-studio\desktop\src-tauri
cargo tauri dev      # 开发运行（自动拉起 Node 引擎 + 打开原生窗口）
cargo tauri build    # 生成 Windows 安装包(NSIS) → src-tauri/target/release/bundle/
```

桌面应用要求本机有 Node（引擎用）、Rust/Tauri（仅构建时）、WebView2（Win11 自带）。
引擎默认监听 127.0.0.1:8787，仅本地访问。

## 用法速览

```powershell
novel                 # TUI：书架 / 新建 / 开始写作 / 设置 / 自检 / 实例
novel doctor          # 环境自检：Unterm、三模型可用性、运行实例、代理
novel models          # 三模型可用性

# 新建一本书（手动：生成 bible/index/outline + 三模型上下文 + profile）
novel book new --title "灯下记" --genre "民国国术·以武正道" --words 200万 --batch 5
# 桌面 GUI 里还有「AI 立项」：只填题材+目标字数 → AI 起 3 个书名你选 → 自动搭设定圣经+全卷大纲+台账并开写

novel book list       # 书架

# 开始写作：自动开窗 + 开代理 + 启动模型 + 注入指令 + autopilot
novel write --book 灯下记 --model codex --task "开写第一卷前5章，写完自检"
novel write --book 灯下记 --dry          # 只生成 launch.ps1，不开窗（排错用）

# 运行中：穿插指令 / 实时镜像 / 停止
novel sessions                            # 列出运行中的写作会话
novel send  --book 灯下记 --task "把第3章的雨夜改成清晨"   # 中途插入指令到那个窗口
novel watch --book 灯下记                  # 把那个窗口的实时内容镜像到本终端
novel stop  --book 灯下记                  # 停止并关闭该窗口

# Token 用量统计（每本书累计，来自各 agent TUI 的 token 计数）
novel usage                               # 所有书
novel usage --book 灯下记                  # 单本

novel config set --workspace D:\novels --model codex --proxy auto --autopilot on
novel mcp             # 作为 MCP server 运行（见 mcp.json）
```

## 穿插指令 & 实时镜像（边写边干预）

写作会话启动后会登记到 `~/.novel-studio/sessions/`（含实例端口/令牌/pane/pid），因此**任意进程**都能连上同一个窗口：

- **穿插指令**：`novel send` 或 TUI「运行中的写作 → 穿插一条指令」，把临时指令通过 `session.input` 注入正在写作的窗口。你手动发指令时屏幕变化，autopilot 检测到活动会自动让位，不与你抢。
- **实时镜像**：`novel watch` 或 TUI「实时镜像」，轮询 `screen.text` 把窗口内容实时打到本软件里（回车/Ctrl+C 停止）。
- 多本书各自独立会话，可同时穿插/镜像。

## 三种主控界面（都内置 CLI + MCP）

| 界面 | 入口 | 适合 |
|---|---|---|
| **TUI**（默认） | `novel` | 日常多本书管理 |
| **CLI** | `novel <cmd>` | 脚本化 / 批处理 |
| **MCP server** | `novel mcp` | 让 Claude Code 等直接调用（`novel_create_book` / `novel_start_writing` …）|

## 书的项目结构

```
<workspace>/<书名>/
  novel_bible.md            设定圣经
  chapter_index.md          全局章节索引
  outlines/卷01分章大纲.md
  chapters/卷01/001章名.txt  仅正文
  reviews/001-005内容自检.md
  AGENTS.md / CLAUDE.md / GEMINI.md   写作规范（codex skill 落地，三模型通用）
  .studio/launch.ps1        自动生成的启动脚本
```

## 配置（`~/.novel-studio/config.json`）

| 键 | 说明 |
|---|---|
| `workspace` | 书库根目录 |
| `defaultModel` | `codex` / `claude` / `gemini` |
| `enableProxy` / `proxyNode` | 启动实例时是否开代理、用哪个 unterm 代理节点（`auto`=跟随 proxy.json）|
| `autopilot.enabled` | 是否自动监控应答 |
| `autopilot.maxAutoContinue` | 自动"继续"次数上限（防失控）|
| `autopilot.continueText` | 自动续写时发送的指令文案 |
| `autopilot.pollMs` / `idleConfirms` | 轮询间隔 / 判定空闲所需稳定次数 |

## 工作原理（技术）

1. `unterm.exe --profile book-<slug> start --always-new-process --cwd <书目录> -e pwsh -File .studio/launch.ps1` 起一个**独立新实例**。
2. 轮询 `~/.unterm/instances/*.json` 定位新实例，拿到 `mcp_port` + `auth_token`。
3. TCP 连接该端口 → `auth.login {token}` → 用点号方法名驱动：`session.list` / `session.status`(busy) / `screen.text`(读屏) / `session.input`(注入按键) / `proxy.switch`(开代理)。
4. `Autopilot` 循环：busy 时等待；屏幕稳定且像在等待时，按规则注入应答。

— 生成于 Novel Studio，遵循 doaipm「高保真优先、speak it & AI builds it」。
