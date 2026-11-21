# Render brand SVGs to transparent PNG masters via Edge headless, then build every
# raster asset by matching the size/name of the files that already exist in each target.
# Usage: python build_icons.py   (uses Pillow from the ComfyUI venv)
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BRAND = Path(__file__).resolve().parent
OUT = BRAND / 'png'
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
INK = (21, 21, 31, 255)


def render(svg: str, size: int, name: str) -> Path:
    """Render an SVG to an exact size PNG with transparent background."""
    OUT.mkdir(exist_ok=True)
    html = OUT / f'_{name}.html'
    html.write_text(
        f'<!doctype html><html><body style="margin:0;background:transparent">'
        f'<img src="../{svg}" style="width:{size}px;height:{size}px;display:block"></body></html>',
        encoding='utf-8')
    png = OUT / f'{name}.png'
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--default-background-color=00000000', f'--window-size={size},{size}',
                    f'--screenshot={png}', html.as_uri()], capture_output=True, timeout=60)
    html.unlink()
    img = Image.open(png).convert('RGBA')
    if img.size != (size, size):
        img = img.crop((0, 0, size, size))
    img.save(png)
    return png


def masters():
    icon = Image.open(render('storyalter-icon.svg', 1024, 'icon-1024'))
    small = Image.open(render('storyalter-icon-small.svg', 512, 'icon-small-512'))
    symbol = Image.open(render('storyalter-symbol.svg', 1024, 'symbol-1024'))
    return icon, small, symbol


def icon_at(icon, small, px):
    src = small if px <= 48 else icon
    return src.resize((px, px), Image.LANCZOS)


def foreground(symbol, px, safe=0.62):
    """Android adaptive foreground: symbol centered in the 66% safe zone, transparent."""
    canvas = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    w = int(px * safe)
    sym = symbol.resize((w, int(w * symbol.height / symbol.width)), Image.LANCZOS)
    canvas.alpha_composite(sym, ((px - sym.width) // 2, (px - sym.height) // 2))
    return canvas


def round_icon(icon, small, px):
    base = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    disc = Image.new('RGBA', (px, px), INK)
    mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
    base.paste(disc, (0, 0), mask)
    inner = foreground(MASTERS[2], px, safe=0.66)
    base.alpha_composite(inner)
    return base


def opaque(img):
    """iOS App Store icons must not have alpha: flatten the rounded icon's square bg."""
    bg = Image.new('RGBA', img.size, INK)
    bg.alpha_composite(img)
    return bg.convert('RGB')


def rebuild_dir(root: Path, icon, small, symbol, report):
    for f in sorted(root.rglob('*.png')):
        px = Image.open(f).size[0]
        name = f.name.lower()
        if 'foreground' in name:
            img = foreground(symbol, px)
        elif 'round' in name:
            img = round_icon(icon, small, px)
        elif 'appicon' in name:
            # iOS draws its own corner mask: use a full-bleed square, no alpha.
            img = opaque(full_bleed(px))
        else:
            img = icon_at(icon, small, px)
        img.save(f)
        report.append(f'{f} {px}px')


def full_bleed(px):
    sq = Image.new('RGBA', (px, px), INK)
    sym = foreground(MASTERS[2], px, safe=0.74)
    sq.alpha_composite(sym)
    return sq


def write_ico(path: Path, icon, small):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [icon_at(icon, small, s) for s in sizes]
    imgs[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])


def write_icns(path: Path, icon, small):
    icon.resize((1024, 1024), Image.LANCZOS).save(path, format='ICNS')


if __name__ == '__main__':
    MASTERS = masters()
    icon, small, symbol = MASTERS
    report = []
    targets = [Path(p) for p in sys.argv[1:]]
    for t in targets:
        if t.is_dir():
            rebuild_dir(t, icon, small, symbol, report)
            ico, icns = t / 'icon.ico', t / 'icon.icns'
            if ico.exists():
                write_ico(ico, icon, small); report.append(f'{ico} ico')
            if icns.exists():
                write_icns(icns, icon, small); report.append(f'{icns} icns')
    # standalone exports for web / store / docs
    for px in (16, 32, 48, 180, 192, 512):
        icon_at(icon, small, px).save(OUT / f'icon-{px}.png')
    full_bleed(1024).convert('RGB').save(OUT / 'icon-1024-fullbleed.png')
    foreground(symbol, 1024).save(OUT / 'adaptive-foreground-1024.png')
    write_ico(OUT / 'favicon.ico', icon, small)
    print('\n'.join(report))
    print('masters + exports in', OUT)
