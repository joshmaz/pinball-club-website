#!/usr/bin/env python3
"""Generate immutable WebP variants; dry-run by default. Requires Pillow."""
import argparse, hashlib, io, json, os
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from PIL import Image, ImageOps

WIDTHS = (320, 640, 1200)

def request(url, key, method='GET', data=None, headers=None):
    req = Request(url, data=data, method=method, headers={
        'apikey': key, 'Authorization': 'Bearer ' + key, **(headers or {})})
    with urlopen(req, timeout=60) as response:
        return response.read()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--report', default='game-image-derivative-report.json')
    args = parser.parse_args()
    env = dict(os.environ)
    if Path('.env').exists():
        for line in Path('.env').read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                env.setdefault(k.strip(), v.strip().strip('\"').strip("'"))
    base = env['SUPABASE_URL'].rstrip('/')
    key = env['SUPABASE_SERVICE_ROLE_KEY']
    # Explicit pagination: PostgREST defaults to at most 1000 rows.
    rows = []
    offset = 0
    while True:
        page = json.loads(request(base + '/rest/v1/game_images?select=*&source_type=eq.club&order=id&limit=500&offset=' + str(offset), key))
        rows.extend(page)
        if len(page) < 500: break
        offset += 500
    report = []
    for row in rows[:args.limit] if args.limit else rows:
        result = {'id': row['id']}
        try:
            meta = row['metadata']
            path = meta.get('storagePath', '')
            if meta.get('storageBucket') != 'game-images' or not path.startswith(row['game_id'] + '/'):
                raise ValueError('Storage identity requires manual review')
            original_url = base + '/storage/v1/object/public/game-images/' + quote(path, safe='/')
            if row['location_value'] != original_url:
                raise ValueError('URL does not match storage identity')
            if meta.get('deliveryVariants'):
                result['status'] = 'already processed'; report.append(result); continue
            source = request(original_url, key)
            image = Image.open(io.BytesIO(source))
            result.update(originalBytes=len(source), originalWidth=image.width, originalHeight=image.height)
            if getattr(image, 'is_animated', False):
                result['status'] = 'animated: retained original'; report.append(result); continue
            if image.width * image.height > 40000000: raise ValueError('Exceeds 40 megapixel limit')
            image = ImageOps.exif_transpose(image)
            image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
            variants = []
            for target in WIDTHS:
                width = min(target, image.width)
                if any(v['width'] == width for v in variants): continue
                resized = image.resize((width, max(1, round(image.height * width / image.width))), Image.Resampling.LANCZOS)
                output = io.BytesIO(); resized.save(output, format='WEBP', quality=78, method=6)
                binary = output.getvalue()
                derivative_path = path + '.w' + str(target) + '.webp'
                url = base + '/storage/v1/object/public/game-images/' + quote(derivative_path, safe='/')
                if args.apply:
                    storage_url = base + '/storage/v1/object/game-images/' + quote(derivative_path, safe='/')
                    # Retry-safe: verify an existing immutable object; never overwrite it.
                    try:
                        existing = request(url, key)
                    except Exception as error:
                        code = getattr(error, 'code', None)
                        body = error.read().decode() if hasattr(error, 'read') else ''
                        if code != 404 and not (code == 400 and 'not found' in body.lower()): raise
                        request(storage_url, key, 'POST', binary, {'Content-Type': 'image/webp', 'Cache-Control': 'max-age=31536000', 'x-upsert': 'false'})
                        existing = request(url, key)
                    if hashlib.sha256(existing).digest() != hashlib.sha256(binary).digest():
                        raise ValueError('Existing derivative differs; manual review required')
                variants.append(dict(url=url, path=derivative_path, width=width, height=resized.height, sizeBytes=len(binary)))
            if args.apply:
                # Compare-and-swap protects concurrent approval, metadata, or primary edits.
                endpoint = base + '/rest/v1/game_images?id=eq.' + row['id'] + '&updated_at=eq.' + quote(row['updated_at'], safe='')
                updated = json.loads(request(endpoint, key, 'PATCH', json.dumps({'metadata': {**meta, 'deliveryVariants': variants}}).encode(), {'Content-Type': 'application/json', 'Prefer': 'return=representation'}))
                if len(updated) != 1: raise ValueError('Concurrent edit; variants uploaded but row left unchanged. Rerun after review.')
            result.update(status='applied' if args.apply else 'planned', variants=variants)
        except Exception as error:
            result.update(status='error', error=str(error))
        report.append(result)
        print(result['id'], result['status'], result.get('error', ''))
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    measured = [r for r in report if 'variants' in r]
    before = sum(r['originalBytes'] for r in measured)
    card = sum(r['variants'][0]['sizeBytes'] for r in measured)
    detail = sum(r['variants'][-1]['sizeBytes'] for r in measured)
    print(json.dumps(dict(images=len(measured), originalBytes=before, card320Bytes=card, detailBytes=detail, mode='apply' if args.apply else 'dry-run')))
    if any(r['status'] == 'error' for r in report): raise SystemExit(1)

if __name__ == '__main__': main()
