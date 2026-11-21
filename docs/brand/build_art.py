# Render non-square brand artwork (OG image, splash) to PNG via Edge headless.
import subprocess
from pathlib import Path

BRAND = Path(__file__).resolve().parent
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
JOBS = [('storyalter-og-image.svg', 1200, 630, 'og-image.png'),
        ('storyalter-splash.svg', 1242, 2436, 'splash.png'),
        ('storyalter-lockup-dark.svg', 1200, 300, 'lockup-dark.png'),
        ('storyalter-lockup-light.svg', 1200, 300, 'lockup-light.png')]

for svg, w, h, out in JOBS:
    html = BRAND / 'png' / '_r.html'
    html.write_text(f'<!doctype html><body style="margin:0"><img src="../{svg}" style="width:{w}px;height:{h}px;display:block">', encoding='utf-8')
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--window-size={w},{h}',
                    f'--screenshot={BRAND / "png" / out}', html.as_uri()], capture_output=True, timeout=60)
    html.unlink()
    print(out)
