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

## Editor workflow

- Club image: deploy the file under `assets/images/machines`, enter its filename,
  and choose **Add club image and make primary**.
- OPDB image: save a valid OPDB ID, choose **Sync images from OPDB**, review the
  source and rights warning, then approve only after confirming permission.
- Any approved non-primary image can be selected with **Use as primary**.
- Approved external images can be returned to reference-only state; doing so
  also removes primary status and activates the normal fallback order.

The AI enrichment panel now reads persisted image associations only. It neither
discovers nor invents image URLs, IDs, provenance, attribution, or licenses.

