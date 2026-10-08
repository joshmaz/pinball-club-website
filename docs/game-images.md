# Game image model and workflow

Game images are normalized in `public.game_images`, which is now the
authoritative image source. Migration `20260916100000_game_images.sql`
backfilled the former repo-hosted filenames before the files were moved to
Supabase Storage. Migration `20260918194500_retire_legacy_game_image_fallback.sql`
clears those compatibility values after successful production verification.

## Record model

Each association belongs to one game and records:

- source: `club`, `opdb`, or `external`
- stable source key (the OPDB image `group` for OPDB records)
- delivery location: Supabase Storage public URL or another HTTPS remote URL
- image kind and alt text
- source page, attribution text/link, and optional license name/link
- usage state: `reference_only` or `approved`
- primary selection and structured source metadata

Database constraints require a source URL and attribution text for every
non-club image. Only one image per game may be primary, and a reference-only
image cannot be primary.

## Selection and legacy compatibility

`games_catalog_v1` emits `primaryImage` using this order:

1. explicitly selected approved primary image;
2. another approved club image;
3. another approved external image;
4. no image.

The browser renders `primaryImage` only. Static catalog exports retain the same
normalized field; a game without an approved association renders without an
image rather than constructing an obsolete repository path.

Adding or selecting a club image never deletes OPDB associations. This makes it
possible to replace an OPDB image publicly while retaining its provenance and
review history.

## OPDB acquisition

OPDB image discovery is deterministic and does not involve an AI model. The
implementation uses the structured daily V1 OPDB export documented by Match
Play:

`https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-opdb.json`

The parser reads only `opdbId`, `images[].group`, `title`, `type`, `primary`,
`urls`, and `sizes`; it does not scrape HTML or recursively guess URLs.
The source URL prefers `large`, then `medium`, then `small`; delivery metadata retains all documented size URLs with valid pixel widths for responsive rendering. The stable image group is the
upsert key.

Pinball Map ingestion runs an image sync after creating/updating rows that just
received an OPDB ID. OPDB failure is reported as `imageSyncWarning` but does not
fail the floor-list ingest. Editors can also run **Sync images from OPDB** for a
single game. `snh_game_images_import_opdb` is service-role only and preserves
any prior editor approval when refreshing a known image.

## Rights, hotlinking, and caching assumptions

The OPDB/Match Play API documentation establishes a structured export intended
for application consumption and recommends storing data instead of repeatedly
using the API as a backend. It does **not**, in the documentation reviewed for
this change, grant an image license or explicitly authorize third-party
hotlinking/caching.

Therefore:

- newly synced OPDB images are always `reference_only`;
- reference-only records are hidden from public queries and cannot be primary;
- the editor warns that reuse and hotlink permission must be confirmed;
- explicit editor approval is required before a remote OPDB URL can render;
- visible public credit links to the OPDB entry page;
- no OPDB binary is downloaded into club storage by this change.

This is a deliberate policy boundary, not a claim that approval alone creates
legal permission. Recommended follow-up: obtain/document OPDB's reuse and
hotlink policy. If hotlinking is disallowed but reuse is licensed, add a
server-side download/derivative pipeline with source metadata retained. That
would require a separate storage, bandwidth, retention, and takedown decision.

## Club upload storage

Migration `20260917190000_game_image_storage.sql` creates the public Supabase
Storage bucket `game-images`. Uploaded objects use the stable convention
`<game UUID>/<random UUID>.<validated extension>`. The bucket accepts JPEG,
PNG, WebP, and GIF files up to 10 MB.

Public reads are allowed because approved club photos render on the public
catalog. Inserts require an authenticated member with games access. Permanent deletion
requires Games Admin or Website Administrator in both the association-deletion
RPC and the Storage DELETE policy. The RPC also checks game editability.
Migration `20260928210000_game_image_delete_authorization.sql` removes the old
Editor DELETE policy; there are no Editor exceptions for own, unassociated,
reference-only, or pending objects. Upload, association editing, approval, and
primary selection remain available to Games Editors. The browser records the public URL as the normal
`remote_url` location and stores `storageBucket`, `storagePath`, original
filename, content type, and byte size in `metadata`. This keeps uploads in the
existing image model and makes stored objects distinguishable from hotlinked
external images.

If association creation fails after upload, the client preserves the original
error and attempts to refresh the image list. It never deletes the object as
rollback: a lost response may follow a successfully committed association.
There is no protected pending/staged upload state. Failed or abandoned uploads
may leave objects requiring deferred administrator cleanup. This is operational
debt for future Operations functionality, not an Editor deletion exception.
Review exact objects, current references, and image audit history before using
the Storage API to clean them up; absence of a current reference alone does not
prove an object was never established. Do not delete Storage metadata with SQL.
On removal, the database association is deleted first, a deterministic approved
fallback becomes primary when needed, and the stored object is then deleted.
This ordering avoids leaving a public record that points to a missing object; a
storage cleanup failure can leave only an unreferenced object and is reported to
the administrator.

## Future security hardening / accepted residual risk

Games Editors can currently set image metadata so that stored object identity
fields disagree with the displayed image URL. An Admin deleting such a
deliberately malformed association could consequently delete the wrong stored
object. After the game-image deletion authorization migration is applied,
Editors still cannot directly perform permanent deletion through either the
association-deletion RPC or the Storage DELETE API.

SNHPC consciously accepts this residual risk for now: Games Editors are trusted
club volunteers, exploitation requires deliberate malicious metadata followed
by Admin interaction, and the engineering cost of stronger identity and deletion
coordination is disproportionate to the current threat model. Future hardening
should bind uploaded associations to validated, immutable Storage identity and
safely handle shared references, including concurrent association changes.

## Editor workflow

- Club image: choose a local photo, optionally edit its alt text and whether it
  should become primary, then choose **Upload club photo**.
- OPDB image: save a valid OPDB ID, choose **Sync images from OPDB**, review the
  source and rights warning, then approve only after confirming permission.
- Any approved non-primary image can be selected with **Use as primary**.
- Approved external images can be returned to reference-only state; doing so
  also removes primary status and activates the normal fallback order.

The AI enrichment panel now reads persisted image associations only. It neither
discovers nor invents image URLs, IDs, provenance, attribution, or licenses.

## Completed legacy repo image migration

The former legacy folder contained 89 files under `assets/images/machines`.
All 89 mapped one-to-one to catalog games, were migrated into `game-images`,
and were verified in production before the repo files were removed.

The migration was performed from commit `e2f15d9`. To reconstruct or audit the
one-time tooling, check out that commit. Its operational commands were:

```sh
node --env-file=.env scripts/migrate-legacy-game-images.mjs --dry-run
node --env-file=.env scripts/migrate-legacy-game-images.mjs --apply
```

The local `.env` must define `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
The tool matches each file through the exact `data/games.json` filename and
game slug, then verifies the database `image_filename`. Ambiguous, missing, or
changed mappings are reported for manual review and are never guessed.

Objects use a content-derived UUID at
`game-images/<game UUID>/<content UUID>.<detected extension>`. This follows the
normal bucket/folder convention while making reruns deterministic. Image type
is detected from file bytes because a few historical filename extensions do
not match their encoded content.

The service-only RPC converts the existing `legacy:` row in place to the normal
uploaded-club representation (`remote_url`, `storage:` source key, and storage
metadata). It preserves row ID, creation time, approval, primary flag, alt
text, and all unrelated club/OPDB/external associations; `updated_at` records
the migration time. Consequently:

1. an explicitly selected primary is never replaced;
2. a legacy primary remains primary after migration;
3. a non-primary legacy row remains non-primary;
4. subsequent runs detect the deterministic storage association and skip it.

The public catalog and home cabinet rotation now use `primaryImage` exclusively.
The repository assets, static filename fields, and one-time migration utility
were removed only after production verification.

## Deletion authorization verification

Run `node --test scripts/game-image-authorization.test.mjs` for focused RPC,
client, UI, and migration-source coverage. Storage policy coverage is source
assertion only, not an emulation of the Supabase Storage service. Before rollout,
verify in a disposable environment that Editor Storage DELETE cannot remove an
object (including own/unassociated/reference-only uploads), admin deletion works,
and Editor INSERT still works. Inspect deployed `storage.objects` policies for
additional DELETE or ALL policies that could permit this bucket. Apply the
forward migration before publishing the frontend so older clients fail closed.

## Free-tier derivative delivery (October 2026)

The audit confirmed that the public catalog returned the stored original URL,
Games cards and the Photos detail tab both assigned it directly to `img.src`,
the home cabinet rotation did the same, and member image previews used the
original `displayUrl`. CSS cropping, lazy loading, and async decoding did not
reduce the encoded bytes downloaded. There was no ingestion resize step.
`game_images.location_value` is the source URL; `metadata.storageBucket` and
`storagePath` identify club objects. `games_catalog_v1` resolves approval and
primary selection; `assets/js/public-data.js` reads that view with a static
`data/games.json` fallback. The snapshot exporter preserves the view payload.

New still club uploads generate WebP variants locally before writing to Storage,
using widths 320, 640, and 1200, quality 78, preserving aspect ratio and avoiding
upscaling. Originals and their identity metadata remain intact. Derivatives use
`<original path>.w320.webp` (and 640/1200), immutable upload paths, and one-year
cache headers. `metadata.deliveryVariants` records URL, actual width/height,
path, and byte size. The catalog exposes these as `primaryImage.variants` only
for the same approved selected association. There is no paid transformation API.
See [Supabase image transformation plan requirements](https://supabase.com/docs/guides/storage/serving/image-transformations).

`assets/js/game-image-delivery.js` supplies `srcset`/`sizes` for cards, detail,
home rotation, and editor previews. The browser selects candidates for rendered
size and device pixel ratio. Cards default to 640, detail to the largest suitable
candidate. Missing derivative metadata falls back to the current source URL.
The home rotation clears old `srcset` when moving to a source-only record.
Attribution, approval, and primary selection behavior are preserved. GIF and detected animated PNG/WebP uploads
retain original delivery to preserve animation. Processing rejects still images
above 40 megapixels and browsers unable to encode WebP before uploading anything.
Failed uploads can still leave original/derivative orphans for administrator
review; no automated rollback deletes objects. Explicit Admin removal deletes the
association first, then original and conventional sibling derivative paths.

OPDB remains remote: its existing small/medium/large URLs are stored with their
reported dimensions for responsive delivery. The canonical large source URL,
source group, reference-only default, approval, and credits remain unchanged.
No OPDB binaries are downloaded or uploaded. Existing OPDB associations acquire
variant metadata on the next **Sync images from OPDB**; missing dimensions safely
retain original delivery. External URLs without variants remain unchanged.

### Measured payload

The October 7 dry run inspected all 90 stored club associations. Two animated
images were retained; all 88 still images passed identity checks and encoding.
Totals below are decimal MB and represent fetching each measured still image
once, rather than a measured page load or an assertion about billed usage:

| Delivery | Encoded bytes | Reduction from originals |
| --- | ---: | ---: |
| Originals | 165,341,567 (165.34 MB) | — |
| 320px variants | 2,165,992 (2.17 MB) | 98.69% |
| 640px candidates | 5,915,542 (5.92 MB) | 96.42% |
| Detail variants, at most 1200px | 12,423,046 (12.42 MB) | 92.49% |

The three derivative sets add about 20.20 MB of stored data. Mobile/high-density
browsers may choose larger candidates. Actual egress depends on visible cards,
scrolling, repeat visits, animation/external sources, and cache behavior. The
backfill itself downloads originals once, so schedule it with that one-time
cost in mind. Browser and Pillow encoders can produce slightly different sizes.

Representative source samples ranged from 800×535 to 2048×1367 and included
167,775-byte JPEG, 1,678,352-byte JPEG, and 818,598-byte PNG files. The full-library
measurement is more representative than those initial eight samples.

### Safe rollout and backfill

1. Review and apply `20261007120000_game_image_delivery_variants.sql` through
   the normal migration process. This only adds delivery metadata to the view;
   it changes no policies, approval state, association, or original object.
2. Use Python 3 with Pillow and local `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` environment settings. Never ship the service key.
   Run `python3 scripts/backfill-game-image-derivatives.py --limit 5 --report /tmp/game-images-canary.json`
   first, then omit `--limit` for the full dry run. Reports include source and
   derivative dimensions/bytes plus per-record errors; review them before apply.
3. Run the same canary with `--apply`, inspect the resulting public URLs and
   metadata, then run the full `--apply` only after verification. Live apply has
   not been run as part of the implementation audit. Keep the resulting report
   as an operational record; do not commit credentials or unnecessary live dumps.
4. The tool validates exact object URL and game-folder identity, skips animation
   and existing variants, never overwrites/deletes objects, verifies uploaded
   bytes before publishing metadata, and uses `updated_at` compare-and-swap to
   avoid clobbering concurrent editor changes. Errors exit nonzero. Reruns verify
   existing immutable derivatives after partial failures; differing bytes require
   manual review. Use the same Pillow version for deterministic reruns.
5. Deploy the frontend and updated `opdb-image-sync` / `pinballmap-ingest` shared
   code through the normal deployment workflow. Refresh public games snapshots
   after backfill so static fallback also carries variants. Confirm deployed
   Storage INSERT works for Editors; DELETE remains Admin-only. Browser preview
   tests do not emulate Storage policies or a live member upload.
6. Verify uncached requests on Games cards, Photos, home rotation, and editor
   previews, including phone/high-density screens. Check `currentSrc` points to
   a derivative and the network panel records its encoded bytes. The local
   browser preview passed at 1280×900 and 390×844 using resized real-photo
   fixtures; desktop detail selected 1200 and phone detail selected 640.

Rollback: revert the frontend to original URL delivery; originals remain usable.
Derivative metadata/objects can stay in place. Do not bulk-delete originals or
unreferenced derivatives. Cleanup remains a separate reviewed Admin operation.

Focused regression command:
`node --test scripts/game-image-delivery.test.mjs scripts/game-image-authorization.test.mjs scripts/opdb-images.test.mjs scripts/game-image-cleanup.test.mjs`.
