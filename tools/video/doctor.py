"""Read-only local rendering preflight. Uses no third-party Python packages."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
from urllib.parse import urlparse


def diagnose(config):
    root = Path(config['comfyRoot'])
    url = config['comfyUrl'].rstrip('/')
    if urlparse(url).hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Local engine URL must use a loopback host')
    checks = []

    def record(name, ok, detail):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))

    python = root / '.venv/Scripts/python.exe'
    record('comfy-python', python.is_file(), str(python))
    model_root = Path(config.get('modelRoot') or root / 'models')
    for category, filename in config['models'].items():
        path = model_root / category / filename
        record('model:' + category, path.is_file() and path.stat().st_size > 0, str(path))
    for name in ('ffmpeg', 'ffprobe'):
        binary = shutil.which(name)
        record(name, binary is not None, binary)
    tts = Path(config['ttsRoot']) / '.venv/Scripts/indextts2.exe'
    record('tts-cli', tts.is_file(), str(tts))
    if python.is_file():
        try:
            result = subprocess.run([str(python), '-c',
                'import torch; print(torch.__version__); print(torch.cuda.is_available()); '
                'raise SystemExit(0 if torch.cuda.is_available() else 1)'],
                capture_output=True, text=True, timeout=30)
            record('cuda', result.returncode == 0, (result.stdout + result.stderr).strip())
        except (OSError, subprocess.TimeoutExpired) as error:
            record('cuda', False, str(error))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for endpoint in ('system_stats', 'queue'):
        try:
            with opener.open(url + '/' + endpoint, timeout=5) as response:
                body = json.load(response)
            record(endpoint, isinstance(body, dict), body)
        except (OSError, ValueError) as error:
            record(endpoint, False, str(error))
    return {'ready': all(item['ok'] for item in checks), 'checks': checks,
            'note': 'Preflight only; readiness does not prove a successful render or TTS synthesis.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parent / 'video-engine.example.json')
    args = parser.parse_args()
    report = diagnose(json.loads(args.config.read_text(encoding='utf-8-sig')))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ready'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
