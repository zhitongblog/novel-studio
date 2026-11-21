"""Single-shot MiniMax H3 image-to-video smoke test against a loopback ComfyUI.

Flattens the official `video_minimax_h3_i2v` template (turbo on) into API format,
uploads one keyframe, waits for history output, then verifies the file with ffprobe
and extracts first/middle/last frames for visual QA. Stdlib only.
"""
import argparse
import json
import mimetypes
import shutil
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlencode, urlparse

ROOT = Path(__file__).resolve().parents[2]


def http(url, data=None, headers=None, timeout=30):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()


def upload_image(base, path):
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
            f'Content-Type: {mime}\r\n\r\n').encode() + path.read_bytes() + \
           f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n'.encode()
    res = json.loads(http(base + '/upload/image', body, {'Content-Type': f'multipart/form-data; boundary={boundary}'}))
    return res['name']


def snap_length(seconds):
    """Same 17k+5 snapping as the template's ComfyMathExpression."""
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def build_graph(cfg, image_name, prompt, seed, width, height, length, steps, prefix):
    m = cfg['models']
    return {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': m['diffusion_models'], 'weight_dtype': 'default'}},
        '2': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': m['loras'], 'strength_model': 1.0}},
        '3': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': m['text_encoders'], 'type': 'minimax', 'device': 'default'}},
        '4': {'class_type': 'VAELoader', 'inputs': {'vae_name': m['vae']}},
        '5': {'class_type': 'VAELoader', 'inputs': {'vae_name': cfg['audioVae']}},
        '6': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '7': {'class_type': 'MiniMaxH3ImageToVideo', 'inputs': {
            'clip': ['3', 0], 'vae': ['4', 0], 'first_frame': ['6', 0], 'prompt': prompt,
            'width': width, 'height': height, 'length': length}},
        '8': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': seed}},
        '9': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'res_multistep'}},
        '10': {'class_type': 'BasicScheduler', 'inputs': {'model': ['2', 0], 'scheduler': 'simple', 'steps': steps, 'denoise': 1.0}},
        '11': {'class_type': 'BasicGuider', 'inputs': {'model': ['2', 0], 'conditioning': ['7', 0]}},
        '12': {'class_type': 'SamplerCustomAdvanced', 'inputs': {
            'noise': ['8', 0], 'guider': ['11', 0], 'sampler': ['9', 0], 'sigmas': ['10', 0], 'latent_image': ['7', 1]}},
        '13': {'class_type': 'VAEDecode', 'inputs': {'samples': ['12', 0], 'vae': ['4', 0]}},
        '14': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['12', 0], 'vae': ['5', 0]}},
        '15': {'class_type': 'CreateVideo', 'inputs': {'images': ['13', 0], 'audio': ['14', 0], 'fps': 24, 'bit_depth': 8}},
        '16': {'class_type': 'SaveVideo', 'inputs': {'video': ['15', 0], 'filename_prefix': prefix, 'format': 'auto', 'codec': 'auto'}},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--config', type=Path, default=Path(__file__).resolve().parent / 'video-engine.example.json')
    ap.add_argument('--image', type=Path, required=True)
    ap.add_argument('--prompt')
    ap.add_argument('--prompt-file', type=Path, help='UTF-8 text file; avoids shell quoting issues with CJK quotes')
    ap.add_argument('--seconds', type=float, default=3.0)
    ap.add_argument('--width', type=int, default=480)
    ap.add_argument('--height', type=int, default=608)
    ap.add_argument('--steps', type=int, default=4)
    ap.add_argument('--seed', type=int, default=20261116)
    ap.add_argument('--out', type=Path, default=ROOT / 'tmp/video-smoke')
    ap.add_argument('--timeout', type=int, default=3600)
    a = ap.parse_args()
    if a.prompt_file:
        a.prompt = a.prompt_file.read_text(encoding='utf-8-sig').strip()
    if not a.prompt:
        ap.error('--prompt or --prompt-file is required')

    cfg = json.loads(a.config.read_text(encoding='utf-8-sig'))
    base = cfg['comfyUrl'].rstrip('/')
    if urlparse(base).hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise SystemExit('ComfyUI URL must be loopback')
    length = snap_length(a.seconds)
    image_name = upload_image(base, a.image)
    prefix = f'storyalter/smoke_{int(time.time())}'
    graph = build_graph(cfg, image_name, a.prompt, a.seed, a.width, a.height, length, a.steps, prefix)
    client_id = uuid.uuid4().hex
    res = json.loads(http(base + '/prompt', json.dumps({'prompt': graph, 'client_id': client_id}).encode(),
                          {'Content-Type': 'application/json'}))
    pid = res['prompt_id']
    print(json.dumps({'prompt_id': pid, 'length': length, 'size': [a.width, a.height], 'steps': a.steps}))

    t0 = time.time()
    while True:
        hist = json.loads(http(f'{base}/history/{pid}')).get(pid)
        if hist and hist.get('status', {}).get('completed') is not None or (hist and hist.get('outputs')):
            break
        if hist and hist.get('status', {}).get('status_str') == 'error':
            break
        if time.time() - t0 > a.timeout:
            raise SystemExit('timeout waiting for render')
        time.sleep(5)
    elapsed = time.time() - t0
    status = hist.get('status', {})
    if status.get('status_str') == 'error':
        print(json.dumps(status.get('messages'), ensure_ascii=False, indent=1)[:4000])
        raise SystemExit(1)

    files = [f for o in hist['outputs'].values() for k in ('images', 'videos', 'gifs') for f in o.get(k, [])]
    if not files:
        raise SystemExit('render finished without output files')
    f = files[0]
    a.out.mkdir(parents=True, exist_ok=True)
    local = a.out / Path(f['filename']).name
    local.write_bytes(http(f"{base}/view?{urlencode({'filename': f['filename'], 'subfolder': f.get('subfolder', ''), 'type': f.get('type', 'output')})}", timeout=300))

    probe = json.loads(subprocess.run([shutil.which('ffprobe'), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(local)],
                                      capture_output=True, text=True, check=True).stdout)
    duration = float(probe['format']['duration'])
    for tag, ts in (('first', 0), ('mid', duration / 2), ('last', max(0, duration - 0.05))):
        subprocess.run([shutil.which('ffmpeg'), '-y', '-v', 'error', '-ss', f'{ts:.3f}', '-i', str(local), '-frames:v', '1',
                        str(a.out / f'{local.stem}_{tag}.png')], check=True)
    streams = [{k: s.get(k) for k in ('codec_type', 'codec_name', 'width', 'height', 'nb_frames', 'r_frame_rate', 'channels', 'sample_rate')}
               for s in probe['streams']]
    print(json.dumps({'ok': True, 'file': str(local), 'render_seconds': round(elapsed, 1),
                      'duration': duration, 'streams': streams}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
