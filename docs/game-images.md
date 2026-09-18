# Game image model and workflow

Game images are normalized in `public.game_images`; `games.image_filename`
remains as a compatibility field for static JSON exports and older clients.
Migration `20260916100000_game_images.sql` backfills every nonblank legacy
filename as an approved, primary, club-owned image. It does not delete or
rewrite the original value.

## Record model

Each association belongs to one game and records:

- source: `club`, `opdb`, or `external`
- stable source key (the OPDB image `group` for OPDB records)
- delivery location: repo-local asset or HTTPS remote URL
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
4. legacy `image_filename` fallback.

The view still emits `imageFilename`. The browser prefers `primaryImage` and
falls back to `imageFilename`, so static `data/games.json` deployments continue
to work. Selecting a repo-local club image also updates `image_filename`; an
external primary does not erase the legacy local fallback.

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
`large` is preferred, then `medium`, then `small`. The stable image group is the
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
catalog. Inserts and deletes require an authenticated member with games access;
the database RPC that removes an association repeats the games-role and
game-editability checks. The browser records the public URL as the normal
`remote_url` location and stores `storageBucket`, `storagePath`, original
filename, content type, and byte size in `metadata`. This keeps uploads in the
existing image model and makes stored objects distinguishable from hotlinked
external images.

If association creation fails after upload, the client removes the new object.
On removal, the database association is deleted first, a deterministic approved
fallback becomes primary when needed, and the stored object is then deleted.
This ordering avoids leaving a public record that points to a missing object; a
storage cleanup failure can leave only an unreferenced object and is reported to
the editor.

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

## Legacy repo image migration

The legacy folder currently has 89 files under `assets/images/machines`. The
static fallback has exactly 89 nonblank `imageFilename` values, matched
one-to-one by exact filename: there are no missing referenced files and no
orphan files in that folder as of this change. Migration
`20260916100000_game_images.sql` already represents these as approved club
`local_asset` rows with source keys prefixed by `legacy:`.

Run `supabase db push` before using the migration utility, then run:

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

The public catalog and home cabinet rotation prefer `primaryImage` from the
normalized resolver. `imageFilename` and all repo files remain as a rollback
fallback until a separately reviewed cleanup confirms the migrated URLs in the
target environment.
