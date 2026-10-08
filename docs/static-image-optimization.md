# Non-game static image optimization

October 8, 2026. Base: `origin/main` at `1dac7e8` (merged OPDB/game-image work).

18 untouched originals now have committed WebP derivatives (quality 82, no upscaling, EXIF orientation applied, metadata stripped, alpha retained). Merchandise has up to 320/640/960px width candidates; photos additionally have up to 1600px. Actual dimensions are used in descriptors when a source is smaller. Existing crop/contain CSS, captions, ordering, random Highlights selection, live Photos selection, and game rendering remain intact.

Merchandise and About have width-based `srcset`/layout-specific `sizes`, intrinsic dimensions, lazy loading and async decoding. Static Highlights cards use up to 960px candidates; the largest derivative is assigned only on lightbox open. Existing manifests without derivatives still work. Live Photos thumb/web fallback and exclusions are unchanged.

## Browser delivery

Local headless Chromium, fresh context per page/viewport, external traffic blocked to force Highlights fallback. Deterministic shuffle; all relevant cards scrolled into view and decoded. These are sums of selected local response-body asset sizes, not complete-page transfer totals or billed egress. The baseline is the original URLs for the same selected images on main; it was calculated from preserved source bytes, not a second network benchmark.

| Page | Viewport / DPR | Before bytes | Delivered bytes | Reduction |
|---|---:|---:|---:|---:|
| merch.html | 1440 / 1 | 6,951,586 | 103,880 | 98.51% |
| about.html | 1440 / 1 | 1,876,845 | 269,714 | 85.63% |
| index.html | 1440 / 1 | 5,613,339 | 192,914 | 96.56% |
| merch.html | 1440 / 2 | 6,951,586 | 184,342 | 97.35% |
| about.html | 1440 / 2 | 1,876,845 | 1,080,324 | 42.44% |
| index.html | 1440 / 2 | 5,613,339 | 639,410 | 88.61% |
| merch.html | 390 / 1 | 6,951,586 | 103,880 | 98.51% |
| about.html | 390 / 1 | 1,876,845 | 269,714 | 85.63% |
| index.html | 390 / 1 | 2,562,329 | 308,426 | 87.96% |
| merch.html | 390 / 2 | 6,951,586 | 184,342 | 97.35% |
| about.html | 390 / 2 | 1,876,845 | 539,642 | 71.25% |
| index.html | 390 / 2 | 2,562,329 | 582,214 | 77.28% |
| merch.html | 768 / 2 | 6,951,586 | 184,342 | 97.35% |
| about.html | 768 / 2 | 1,876,845 | 539,642 | 71.25% |
| index.html | 768 / 2 | 5,613,339 | 1,220,624 | 78.25% |

Candy: 5,019,543 bytes → 19,158 (320px), 43,294 (640px), or 69,808 (960px). The observed desktop/mobile standard-density choice is 320px; DPR 2 uses 640px.

Every checked card decoded a responsive derivative, with its existing 4:3 box. Highlights loaded no largest lightbox derivative before opening; opening decoded the large derivative, and Escape closed it. Desktop screenshots of merchandise, About, and Highlights were visually inspected. Small product source images remain limited by their original resolution.

## Per-asset sizes

| Original | Original bytes | Variant width: bytes |
|---|---:|---|
| IMG_3044.jpg | 659,564 | 320: 35,856, 640: 95,350, 960: 162,750, 1536: 306,982 |
| IMG_4865.jpg | 745,969 | 320: 17,614, 640: 56,452, 960: 107,196, 1600: 230,512 |
| IMG_4873.jpg | 1,011,482 | 320: 38,424, 640: 137,298, 960: 272,032, 1600: 566,992 |
| IMG_5680.jpg | 682,690 | 320: 18,708, 640: 60,268, 960: 118,944, 1600: 246,664 |
| IMG_5947.jpg | 478,492 | 320: 21,550, 640: 60,152, 960: 106,484, 1536: 209,686 |
| knock-out_gloves.jpg | 363,499 | 320: 19,292, 640: 49,904, 960: 79,106, 1535: 137,126 |
| snhpc_club01.jpg | 472,505 | 320: 21,836, 640: 59,406, 960: 100,924, 1600: 201,952 |
| snhpc_club02.jpg | 865,363 | 320: 34,520, 640: 132,416, 960: 267,610, 1534: 513,332 |
| snhpc_club03.jpg | 757,501 | 320: 17,266, 640: 61,304, 960: 121,526, 1600: 254,678 |
| snhpc_yankee-swap2024.jpg | 599,337 | 320: 22,996, 640: 72,114, 960: 125,908, 1600: 229,454 |
| drink_koozie.png | 76,063 | 240: 9,286 |
| hoddie_red_back.png | 526,600 | 320: 19,124, 553: 33,808 |
| hoodie_red_front.png | 522,722 | 320: 16,794, 553: 30,762 |
| pin_snhpc-logo.png | 57,445 | 184: 7,094 |
| sticker_Candy.png | 5,019,543 | 320: 19,158, 640: 43,294, 960: 69,808 |
| sticker_snhpc-logo.png | 47,496 | 188: 7,132 |
| t-shirt_blue_front-back.png | 323,831 | 320: 9,686, 640: 20,394, 960: 31,360 |
| t-shirt_tan_front.png | 377,886 | 320: 15,606, 545: 32,572 |

## Validation and regeneration

- `node --test scripts/game-image-delivery.test.mjs scripts/home-gallery.test.mjs scripts/clubhouse-design.test.mjs scripts/public-snapshots.test.mjs` passed.
- Browser harness also verifies live Photos thumb/web, missing-thumb fallback, slideshow exclusions and legacy static-manifest compatibility.
- All original bytes compared with `origin/main`; all derivative dimensions, aspect ratios, no-upscale behavior and alpha channels verified.
- `git diff --check` and JavaScript syntax checks passed.

Regenerate from repository root with `python3 scripts/build-static-image-variants.py` (Pillow 12.1.1). It updates both pages, the Highlights manifest and the audit manifest. Output filenames include the original SHA-256 prefix and actual width. If encoder settings change, change the filename version to prevent stale cached URLs; source changes produce new names automatically. Old derivatives are not deleted automatically.

For browser checks, run `python3 -m http.server 8765 --bind 127.0.0.1` in the repository, then `node scripts/check-static-image-delivery.cjs` with Playwright installed. `PLAYWRIGHT_MODULE` can specify an absolute module path, and `CHROMIUM_PATH` a browser executable. The script writes `docs/static-image-browser-checks.json` and screenshots under `/tmp`.

No Storage, database, original, private-photo permission, game/gallery pipeline, hero, or Events delivery changes. Browser evidence is local; production deployment delivery/cache headers remain to be checked after approval and deployment. No merge performed.
