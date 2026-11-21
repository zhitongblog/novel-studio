# 本地视频引擎检查与小说视频一体化方案

## 2026-11-16 更新：MiniMax H3 引擎已恢复并通过单镜头验收

| 项目 | 结果 |
| --- | --- |
| ComfyUI | `C:/AI/StoryAlter/ComfyUI`，v0.45.2，仅监听 127.0.0.1:8188 |
| PyTorch | 2.14.1+cu130（南大镜像），torchvision 0.29.1、torchaudio 2.11.0；`torch-constraints.txt` 锁版本，防止被 PyPI CPU 包覆盖 |
| 模型 | ModelScope `Comfy-Org/MiniMax-H3`，放在 `D:/AI/models/minimax-h3`，由 `extra_model_paths.yaml` 挂载；5 个文件均通过 SHA256 校验 |
| 选型 | `fl2va_pruned_int8_convrot` + `qwen3vl_32b_nvfp4_awq` + `video_vae_int8_convrot` + `audio_vae_fp32` + `fl2v_turbo_4step_768p` LoRA，与官方 `video_minimax_h3_i2v` 模板一致 |
| 下载 | `scripts/video/download-h3.ps1`（国内 CDN，断点续传，SHA256 校验） |
| 验收 | `scripts/video/h3_smoke_test.py`：480×608、73 帧/24fps、4 步，**渲染 75 秒**，峰值显存约 11.6GB；ffprobe 确认 h264 视频 + AAC 立体声 32kHz；首/中/尾帧人物一致、推镜与握拳动作正确 |
| 5 秒基线 | 480×608、124 帧（5.17s）、4 步：**渲染约 98–100 秒**，峰值显存 11.6GB；转身、上前、握拳多动作连贯，人物一致。估算 1 分钟成片（12 镜）≈ 20 分钟渲染 |

旧 LTX 路线已不再作为默认；下文的历史检查记录保留作参考。

检查日期：2026-11-16。此文记录实测与建议，不代表视频功能已实现或模型已完成生成验证。

## 补充纠正：原先安装过 MiniMax H3

经用户指出，检查 D:/AI/downloads 后发现 MiniMax-H3-ComfyUI-ModelScope 与 MiniMax-H3-ModelScopeSDK。后者 install-after-download.log 明确记录 2026-08-06 22:44:03 已将四项权重移入 D:/AI/ltx-2.3/ComfyUI/models：视频扩散权重 20,970,379,616 字节、Qwen3VL 编码器 15,687,142,551 字节、视频 VAE 5,207,808,496 字节、音频 VAE 605,254,808 字节。历史安装完成有日志依据，但日志没有证明实际生成测试成功。

下载目录内 134–136 字节的 safetensors 是 Git LFS 文本指针，不是真实权重；SDK 下载目录中的模型已在历史安装时移出。原目标路径本次检查不存在，需继续定位是否迁移。此前只考虑 LTX、未先核对 H3 安装记录，检查范围不足；不应据此直接决定更换模型。

本轮曾另建 C:/AI/StoryAlter/ComfyUI，官方 v0.45.0，独立 Python 3.11 环境，并复制现有 PyTorch CUDA 组件及开始下载依赖与 LTX 模型。用户澄清 H3 后已停止相关 uv/curl 进程；该目录是未验收的安装中间状态，不是生产引擎。未删除原有资产，也未替换 IndexTTS。新增 config/video-engine.example.json 与 scripts/video/doctor.py 目前只是 LTX 示例及预检查，不代表已选定最终模型。

## 实测结果

| 项目 | 结果 | 处理建议 |
| --- | --- | --- |
| GPU | RTX 3060，12288 MiB，驱动 610.88 | 以 12GB 显存预算设计，配音与视频串行使用 GPU |
| 磁盘 | C 盘约 35.8GB 空闲，D 盘约 9.1GB | 安装前按模型、Python/CUDA 依赖、缓存和输出总量估算；不自动删除用户文件 |
| 原 ComfyUI | D:/AI/ltx-2.3/ComfyUI 不存在，127.0.0.1:8188 拒绝连接 | 先恢复可运行环境，不是直接 git pull |
| 找到的源码 | D:/AI/downloads/ComfyUI-master/extract/ComfyUI-master，版本 0.31.0 | 无 .venv，models 下未发现大于 10MB 文件，不能视为可用引擎 |
| LTX 模型 | 已检查 D:/AI、Documents、D:/Downloads、D:/backup，未发现所需 LTX/T5 权重 | 检查范围内缺失，不声称全盘不存在 |
| IndexTTS | D:/AI/codex-tools/index-tts，提交 c7d3cff（2026-07-06） | CLI check 返回模型文件、Python 包正常，CUDA available；尚未进行实际合成 |
| TTS 文件 | gpt.pth、s2mel.pth 存在，另有约 3.34GB gpt.pth.bad | .bad 仅列为人工确认的清理候选，不删除 |
| FFmpeg/FFprobe | WinGet 安装可定位 | 保留，用于合成和媒体质量检查 |
| 原输出 | D:/AI/comfyui-output-backup 有历史图片 | 保留，不能替代模型、工作流或运行环境 |

## 更新判断

先修复缺失的运行环境，再谈追新。官方 ComfyUI releases 已有比源码副本更新的发布；本次 GitHub API 精确版本查询受本机 7897 代理关闭影响失败，不能把搜索摘要当作已验证的最新版本号。恢复时选定官方稳定 tag，固定 Python/PyTorch/工作流版本，做单镜头回归后再切换。

IndexTTS 当前健康检查通过，不建议与视频引擎一起盲目升级。先合成短中文样本，测时长、音质、显存，再在独立环境比较新版。

模型默认采用现有 vertical-premium-video 已适配的 LTXV 2B 0.9.8 distilled fp8，而非直接换到 22B。两者不是同一个模型版本。现有 skill 记载 22B 两阶段在本机曾使服务不可达；该历史记录不是本次重新压测结论。

初始回归配置：512×896、49 帧、24fps、12 steps，单并发。通过后再按镜头测试 3–6 秒；不能把两秒画面无限拉长冒充连续动作。1290×2796 是最终导出尺寸，不是本地原生生成能力。

参考：
- https://github.com/Comfy-Org/ComfyUI/releases
- https://github.com/Lightricks/LTX-Video
- https://github.com/index-tts/index-tts/releases

## Skills 迁移边界

- gaoshang-chaoshuai-skill：保留单镜头单动作、输入落盘、逐镜头生成、首中尾抽帧、失败重跑。
- vertical-premium-video：保留句级音频时间轴、IndexTTS、BGM、封面和发布包；修复用户绝对路径依赖。
- 解决两个 skill 的 LTX2.3 / LTXV 2B 默认冲突：由引擎配置明确 model family、checkpoint、workflow hash 和参数，不按名称推断。
- 科学故事会品牌、固定开场、四首 BGM、无字幕、特殊画幅应为可选节目预设，不能强加给所有小说改编。
- 聊天中的 imagegen 能力不等于网站后台可调用的服务。第一阶段支持上传关键帧；自动生图须接入明确的服务商接口、凭据和文件持久化。
- 不直接执行任意 skill shell 文本；将脚本封装成固定参数、固定工作目录的 worker 操作。

## StoryAlter 接入设计

当前 React/Vite 前端、Hono/Bun 后端已注册 projects、characters、canonical-state、snapshots、writing 等路由。检索 apps/server/src、apps/web/src、packages 未发现 ComfyUI/IndexTTS/分镜生成接入。继续增量实现，保留写作服务和分身成长能力。

用户流程：选择小说章节 → 固定章节与人物快照 → 改编脚本 → 确认分镜与人物参考图 → 配音和关键帧 → 单镜头视频 → 预览重做 → 合成 → 导出视频、封面和发布文案。

每个分镜记录 chapterId、sourceRevision、characterIds、场景、旁白、动作、正负提示词、seed、音频实际时长、输入图片 hash、workflow/model 版本、输出和 QA 结果。章节修改产生新改编版本，旧成片仍能追溯；镜头反馈作为独立分身学习信号，不覆盖原文。

部署采用云端创作服务 + 本机渲染 worker。云服务器的 localhost 不是用户电脑，不能让线上 API 直接访问 127.0.0.1:8188。由已配对 worker 主动领取属于该用户的任务，回传进度及成品；ComfyUI 保持 loopback。凭据不进入项目清单或日志。

建议增量数据实体：video_projects、video_shots、video_assets、render_jobs、render_attempts。都关联 user/project；应用接口检查所有权。生产数据库迁移须遵循 AGENTS.md 的检查、幂等和 owner 规则，本次未执行迁移。

任务状态：draft → queued → running → needs_review → completed；另有 failed/cancelled。配音、关键帧、渲染、合成分别持久化；lease/heartbeat 回收异常 worker，重试新增 attempt，用输入 hash 防止重复渲染。prompt_id 仅表示提交成功，必须确认 history 输出、文件存在与 ffprobe 检查后才算生成成功。多用户不能通过全局 /interrupt 误取消别人的任务。

## 分阶段验收

1. 恢复引擎：确认安装位置和空间预算；固定稳定版本与三项 2B 路线资产；启动 API，生成一个镜头，ffprobe 和首中尾画面检查通过。保留原 TTS 环境。
2. 最小闭环：小说页增加“改编视频”，导入章节快照，编辑分镜，上传关键帧，worker 完成配音、镜头和合成。用 30–60 秒片段验收，失败重启能续作。
3. 创作一致性：人物参考图、场景资产、章节版本变更提示、镜头独立重做、旁白实际时长驱动剪辑。
4. 成品工具：节目预设、字幕开关、BGM、多个封面比例和发布文案；发布为独立的显式操作。

本次只完成检查与设计；未下载模型、未升级引擎、未删除资产、未部署或宣称已打通视频生产。
