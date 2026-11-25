"""
StoryAlter 2D 动画专用 GPU AI 超分器 (RealESRGAN_x4plus_anime_6B.pth -> 1080x1920 Full HD)。
用法: python upscale_anime.py <in.mp4> <out.mp4> [target_w] [target_h] [model_path]
"""
import os, subprocess, sys, time
import numpy as np
import torch
import torch.nn.functional as F
import spandrel

in_mp4, out_mp4 = sys.argv[1], sys.argv[2]
target_w = int(sys.argv[3]) if len(sys.argv) > 3 else 1080
target_h = int(sys.argv[4]) if len(sys.argv) > 4 else 1920
model_path = sys.argv[5] if len(sys.argv) > 5 else r"C:\AI\StoryAlter\ComfyUI\models\upscale_models\RealESRGAN_x4plus_anime_6B.pth"

probe = subprocess.check_output([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate",
    "-of", "default=noprint_wrappers=1:nokey=1", in_mp4
], text=True).strip().splitlines()
src_w, src_h, fps_str = int(probe[0]), int(probe[1]), probe[2]
print(f"[SR] Input: {src_w}x{src_h} @ {fps_str} -> Target: {target_w}x{target_h} via {os.path.basename(model_path)}", flush=True)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if device.type == "cuda":
    torch.backends.cudnn.benchmark = True
desc = spandrel.ModelLoader().load_from_file(model_path)
model = desc.model.to(device).eval()
use_fp16 = (device.type == "cuda")
if use_fp16:
    model = model.half()

dec = subprocess.Popen([
    "ffmpeg", "-v", "error", "-i", in_mp4,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
], stdout=subprocess.PIPE)

enc = subprocess.Popen([
    "ffmpeg", "-y", "-v", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{target_w}x{target_h}", "-r", fps_str, "-i", "-",
    "-i", in_mp4,
    "-map", "0:v:0", "-map", "1:a?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    out_mp4
], stdin=subprocess.PIPE)

frame_bytes = src_w * src_h * 3
t0 = time.time()
n = 0
with torch.inference_mode():
    while True:
        raw = dec.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        arr = np.frombuffer(raw, dtype=np.uint8).reshape(src_h, src_w, 3)
        t = torch.from_numpy(arr.copy()).to(device=device, dtype=torch.float16 if use_fp16 else torch.float32)
        t = t.permute(2, 0, 1).unsqueeze(0) / 255.0
        sr = model(t).clamp_(0.0, 1.0)
        if sr.shape[-2] != target_h or sr.shape[-1] != target_w:
            sr = F.interpolate(sr.float(), size=(target_h, target_w), mode="area").clamp_(0.0, 1.0)
        else:
            sr = sr.float()
        out_arr = sr.squeeze(0).permute(1, 2, 0).mul_(255.0).round_().byte().cpu().numpy()
        enc.stdin.write(out_arr.tobytes())
        n += 1

dec.stdout.close()
enc.stdin.close()
dec.wait()
rc = enc.wait()
if rc != 0:
    raise RuntimeError(f"ffmpeg encoder failed with {rc}")
dt = time.time() - t0
print(f"[SR] Done {n} frames in {dt:.1f}s ({n/max(0.1,dt):.1f} fps) -> {out_mp4}", flush=True)
