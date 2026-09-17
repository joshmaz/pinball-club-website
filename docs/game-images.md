# Game image model and workflow

## Data model

`game_images` is the source of truth for image associations. A game may have many active or archived rows.

| Field | Purpose |
| --- | --- |
| `source_type` | `club`, `opdb`, or another `external` provider |
| `image_filename` | Repository-local filename for club images under `assets/images/machines/` |
| `image_url` | Provider-hosted image URL for external images |
| `source_record_id` | Stable provider image identifier (OPDB's image `group`) |
| `source_page_url` | Provider record endpoint used to obtain the metadata |
| attribution/license fields | Visible credit and any license information the provider supplies |
| `is_preferred` | Explicit editor selection; at most one active row per game |
| `is_active` | Archives an association without deleting its provenance |
| `metadata` | Provider-specific mechanical metadata, such as OPDB's `primary` flag |

External rows require an image URL, source page, attribution text, and attribution URL. License fields are nullable because the OPDB machine API does not currently return a per-image license.

## Selection priority

The public catalog selects one active image in this order:

1. The editor-designated preferred image.
2. A club-owned image.
3. An OPDB image (playfield type first, then OPDB's provider-primary flag).
4. Another attributed external image.

This lets a club photo supersede OPDB without removing OPDB metadata. Public pages display attribution whenever the selected image has it.

## Existing image compatibility

Migration `20260917120000_game_images.sql` creates one preferred `club` row for every non-empty `games.image_filename`. The column remains in place. When the legacy editor field changes, a trigger creates or reactivates the matching normalized club row and makes it preferred. Clearing the legacy field does not delete image history.

Static `data/games.json` deployments continue to use `imageFilename`. Database-backed deployments prefer `selectedImage` and fall back to `imageFilename`, so rollout does not require an all-at-once data or frontend cutover.

## OPDB acquisition

Pinball Map's structured machine-details response supplies `opdb_id`. After a successful ingest, the Edge Function downloads OPDB's once-daily full V1 export:

`GET https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-opdb.json`

OPDB's API documentation recommends the complete data export instead of fetching many entries individually. Only structured `images` entries are accepted. Exact aliases fall back to their physical-machine and machine-group IDs when needed. The sync stores OPDB's `group`, `type`, `title`, `primary`, dimensions, and the largest advertised URL (`large`, then `medium`, then `small`). URLs must use `https://img.opdb.org/`. Upserts are deterministic on `(game_id, source_type, source_record_id)`. AI enrichment is not involved in IDs, URLs, attribution, or primary selection.

An OPDB export failure is reported separately and does not roll back otherwise successful Pinball Map location history.

## Remote-image policy and follow-up

The current implementation **hotlinks** the URLs deliberately returned by OPDB's authenticated API. It does not download, cache, transform, or claim ownership of OPDB images. The public credit links to OPDB, and the source record URL is retained.

Repository research did not find a license or terms statement granting redistribution or documenting permanent hotlink availability. Therefore:

- do not copy OPDB images into the repository or Supabase Storage without confirming rights;
- treat OPDB URLs as provider-controlled and potentially changeable;
- confirm with OPDB whether public hotlinking is permitted and whether more specific contributor/license attribution is required;
- if OPDB requests caching, implement it only after deciding storage cost, refresh/retention behavior, and takedown handling.

That policy question is intentionally documented rather than encoded as an unsupported claim. Editors can always choose a club-owned image as preferred.

## Editor workflow

The Images and attribution section lists every active association with its source, locator, credit, and preferred state. Editors may:

- make any association preferred;
- add a club-owned filename;
- add another external image only with complete source and attribution fields;
- archive an association without deleting the asset.

OPDB rows are normally created/refreshed by ingestion. Editors should not manually invent OPDB identifiers or URLs.
