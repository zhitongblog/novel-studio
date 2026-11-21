# Local video engine (MiniMax H3)

This is the first integration layer, not a cloud rendering endpoint. Keep ComfyUI on loopback.

## Setup

```powershell
# 1. Models from ModelScope (China CDN, resumable, SHA256-verified) -> D:/AI/models/minimax-h3
powershell -ExecutionPolicy Bypass -File tools/video/download-h3.ps1

# 2. Start ComfyUI (models mounted via C:/AI/StoryAlter/ComfyUI/extra_model_paths.yaml)
& C:/AI/StoryAlter/ComfyUI/.venv/Scripts/python.exe C:/AI/StoryAlter/ComfyUI/main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
```

When reinstalling Python deps, always pass `-c torch-constraints.txt` so uv does not replace the cu130 torch with the CPU wheel from PyPI.

## Checks

```powershell
python tools/video/doctor.py                     # read-only preflight
python tools/video/h3_smoke_test.py --image <keyframe.png> --prompt "<shot description>" --seconds 3
```

`doctor.py` exit 0 means files, CUDA, tools and the API passed preflight; it does not prove a render. `h3_smoke_test.py` renders one i2v shot (official template, turbo 4-step), checks it with ffprobe and extracts first/mid/last frames into `tmp/video-smoke/` for visual QA.

Baseline on RTX 3060 12GB: 480x608, 73 frames, 4 steps -> ~75 s, ~11.6GB VRAM.

See `docs/video/local-video-engine-audit.md` for the chapter snapshot, storyboard, asset and worker integration plan. No remote database migrations or deployments are part of this bootstrap.
