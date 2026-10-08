#!/usr/bin/env python3
"""Regenerate committed non-game delivery assets: Python 3 + Pillow 12.1.1.
Originals stay untouched. No upscale, crop, metadata, or alpha flattening.
"""
import hashlib
import json
import re
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SIZES = {
    'merch.html': '(max-width: 638px) calc(100vw - clamp(32px, 6vw, 64px) - 50px), (max-width: 973px) calc((100vw - clamp(32px, 6vw, 64px) - 20px) / 2 - 50px), calc((min(100vw, 1200px) - clamp(32px, 6vw, 64px) - 40px) / 3 - 50px)',
    'about.html': '(max-width: 468px) calc(100vw - clamp(32px, 6vw, 64px)), calc((min(100vw, 1200px) - clamp(32px, 6vw, 64px) - 20px) / 2)',
}
payload = json.loads((ROOT / 'data/highlights.json').read_text())
sources = set('assets/images/highlights/processed/' + item['filename'] for item in payload['highlights'])
previous_path = ROOT / 'data/static-image-variants.json'
previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
original_by_variant = {v['url']: source for source, entry in previous.items() for v in entry['variants']}
for page in SIZES:
    for source in re.findall(r'<img src="(assets/images/(?:merch|highlights/processed)/[^"]+)"', (ROOT / page).read_text()):
        sources.add(original_by_variant.get(source, source))
manifest = {}
for source in sorted(sources):
    path = ROOT / source
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert('RGBA' if 'A' in opened.getbands() else 'RGB')
        widths = sorted({min(width, image.width) for width in (320, 640, 960, 1600) if width <= (960 if '/merch/' in source else 1600)})
        variants = []
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        for width in widths:
            resized = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
            target = path.parent / 'responsive' / f'{path.stem}-{digest}.w{width}.webp'
            target.parent.mkdir(exist_ok=True)
            resized.save(target, 'WEBP', quality=82, method=6)
            variants.append(dict(url=target.relative_to(ROOT).as_posix(), width=width, height=resized.height, bytes=target.stat().st_size))
        manifest[source] = dict(bytes=path.stat().st_size, width=image.width, height=image.height, variants=variants)
for page, sizes in SIZES.items():
    text = (ROOT / page).read_text()
    # Match either originals or our prior generated URLs, so regeneration is idempotent.
    for source, entry in manifest.items():
        candidates = entry['variants'] if page == 'about.html' else entry['variants'][:3]
        srcset = ', '.join(f"{v['url']} {v['width']}w" for v in candidates)
        attrs = f'src="{candidates[1 if len(candidates)>1 else 0]["url"]}" srcset="{srcset}" sizes="{sizes}" width="{entry["width"]}" height="{entry["height"]}" loading="lazy" decoding="async"'
        pattern = r'<img\s+[^>]*src="(?:' + re.escape(source) + '|' + re.escape(str(Path(source).parent)) + r'/responsive/' + re.escape(Path(source).stem) + r'-[^" ]+)"[^>]*>'
        def replace(match):
            tag = match.group()
            retained = re.findall(r'\b(?:alt|class)="[^"]*"', tag)
            return '<img ' + attrs + ' ' + ' '.join(retained) + '>'
        text = re.sub(pattern, replace, text)
    (ROOT / page).write_text(text)
for item in payload['highlights']:
    item['deliveryVariants'] = manifest['assets/images/highlights/processed/' + item['filename']]['variants']
(ROOT / 'data/highlights.json').write_text(json.dumps(payload, indent=2) + '\n')
(ROOT / 'data/static-image-variants.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Generated variants for {len(manifest)} originals')
