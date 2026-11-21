# StoryAlter 品牌规范

版本 1.0 · 2026-11-18 · 适用于桌面客户端、Web、iOS/Android、宣传物料

![StoryAlter](png/lockup-dark.png)

## 1. 品牌核心

| 项目 | 内容 |
|---|---|
| 品牌名 | **StoryAlter**（Story + Alter Ego）。全平台统一写法，不翻译；S 与 A 大写，中间无空格 |
| 中文描述语 | **AI 故事工作室**（窗口标题、应用商店副标题、组合标下方） |
| 主口号 | **你的 AI 分身，写成小说，拍成短剧。** |
| 英文口号 | *Your AI alter ego — from novel to screen.* |
| 标准写法 | `StoryAlter · AI 故事工作室`（中点前后各一个空格） |

> 历史名称 “Novel Studio / 网文工作室” 停止对外使用，仅在迁移说明中以“原 Novel Studio”出现。

## 2. 标识

**寓意**：一本打开的书，两页是两张相对的侧脸。左页青色代表**作者**，右页紫色代表 **AI 分身**；两张脸之间的空白是一只花瓶（鲁宾花瓶），表示两者在对话、共同创作。

| 文件 | 用途 |
|---|---|
| `storyalter-icon.svg` | 应用图标主稿（1024，圆角深底），≥ 64px 使用 |
| `storyalter-icon-small.svg` | 小尺寸简化版（去掉封底细线与唇部起伏），16–48px、favicon、侧栏 |
| `storyalter-symbol.svg` | 纯符号（透明底），用于组合标和插画 |
| `storyalter-symbol-mono-white.svg` / `-mono-ink.svg` | 单色版：深底用白色，浅底用墨色；用于单色印刷、水印、系统托盘 |
| `storyalter-lockup-dark.svg` / `-light.svg` | 横版组合标（符号 + 字标 + 中文描述语），深色和浅色背景各一版 |
| `storyalter-og-image.svg` | 社交分享图 1200×630 |
| `storyalter-splash.svg` | 移动端启动页 1242×2436 |
| `png/` | 由 `build_icons.py`、`build_art.py` 生成的光栅图，**不要手改**，改 SVG 后重新生成 |

### 留白与最小尺寸
- 符号四周留白 ≥ 符号高度的 1/4；组合标中，字标与符号的间距 = 符号高度的 1/4。
- 最小尺寸：完整图标 64px，简化版 16px；组合标宽度 ≥ 120px。
- 小于 64px 一律用简化版。

### 错误用法
- 不要拉伸变形、旋转、给符号加描边或投影（桌面端侧栏现有的柔光除外）。
- 不要交换左右两页的颜色：青色必须在左（作者），紫色在右（分身）。
- 不要在浅色背景上使用深底版组合标，也不要在照片上直接放渐变符号；照片背景用单色白版。
- 不要重新排版字标、改字体或在 Story 与 Alter 之间加空格。

## 3. 色彩

| 名称 | 色值 | 用途 |
|---|---|---|
| 墨色 Ink | `#15151F` | 图标底色、深色界面背景、浅底上的文字 |
| 作者青 Author Teal | `#1FD1B2` → `#3AA6C8` | 符号左页渐变、次要强调 |
| 分身紫 Alter Violet | `#7D8BFF` → `#9A6BFF` | 符号右页渐变 |
| 品牌紫（界面） | `#6A4FE6` | 浅色界面主色、按钮、链接、字标中的 “Alter” |
| 品牌紫（深色界面） | `#A99BFF` | 深色界面中的主色和字标中的 “Alter” |
| 纸白 Paper | `#FAF9F5` | 浅色背景 |
| 雾灰 Mist | `#9C9AB8` | 深底上的次要文字、描述语 |

浅色背景上，符号使用加深版渐变（`#12B89B→#2B8FB3`、`#6271F2→#7F4EF0`），见 `storyalter-lockup-light.svg`。

## 4. 字体

| 场景 | 字体 |
|---|---|
| 英文字标、标题 | Inter SemiBold（650），回退 Segoe UI Variable Display / Segoe UI；字距 -2% |
| 中文描述语、正文 | 苹方 PingFang SC / 思源黑体 Noto Sans SC / 微软雅黑 UI，字重 500，字距约 +8% |

> 当前 SVG 字标用系统字体渲染。对外发布的物料（应用商店、印刷）建议先把文字转成轮廓，再导出。

## 5. 资产落地位置

| 位置 | 内容 |
|---|---|
| novel-studio `desktop/src-tauri/icons/` | 全套桌面、Windows 商店、iOS、Android 图标；由 `python docs/brand/build_icons.py desktop/src-tauri/icons` 重新生成 |
| novel-studio `ui/index.html`、`ui/favicon.svg` | 侧栏标识、窗口图标 |
| storyalter `apps/web/public/` | `favicon.svg`、`favicon.ico`、`apple-touch-icon.png`、`icon-192/512.png`、`og-image.svg/png` |
| storyalter `apps/web/src/components/Logo.tsx` | Web 组件（传 `color` 即为单色版） |
| storyalter `apps/ios/assets/` | `icon.png`（满版无透明）、`adaptive-icon.png`、`splash.png`、`logo.svg`、`splash.svg` |

## 6. 技术标识（已于 2026-11-18 统一）

| 标识 | 新值 | 兼容策略 |
|---|---|---|
| Tauri `identifier` | `com.storyalter.desktop` | — |
| Crate / 包名 | `storyalter-desktop` / `storyalter` | — |
| 配置目录 | `~/.storyalter/`（工作区 `~/StoryAlter/books`） | 首次启动自动从 `~/.novel-studio/` 复制迁入，保留旧目录作备份 |
| localStorage 键 | `storyalter:*` | 读取时回退读取 `novelstudio:*` |
| CLI 命令 | `storyalter`（保留 `novel` 别名） | 兼容现有脚本 |
| Web 导出书包 | `/api/export/project/:id/novel-studio`（文件名 `*-storyalter.zip`） | 保留旧路径以兼容旧链接 |
