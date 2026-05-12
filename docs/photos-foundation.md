# Dynamic Photos Foundation

This is the durable design + ops note for the photos system. It documents
the storage contract, the authorization model, the threat model, the test
plan we expect to run before declaring the feature production-ready, and the
operational controls in place. Pair this with `docs/multi-tenant-notes.md`
and `docs/multi-tenant-foundation-tracker.md`.

## Goals

- Photos are first-class data: members can change them without a code deploy.
- Authorization is enforced server-side (RLS + RPC + Edge Function role
  checks). UI gating is convenience only.
- Originals never appear in any public bucket.
- Public delivery uses stable IDs and content-hashed URLs so publish /
  unpublish / delete take effect immediately and CDN caches do not stale.
- Schema and storage paths are tenant-friendly: `scope_type` + `scope_id`
  are present from day one so a future `tenants` table is a mechanical
  migration, not a schema rewrite.

## Components

### Database

Migrations:

- `supabase/migrations/20260512100000_photos_foundation.sql`
  - `public.photo_albums` (scope columns + slug + publish flag)
  - `public.photo_assets` (scope columns + status lifecycle + original
    metadata)
  - `public.photo_asset_variants` (server-generated derivatives)
  - Helper functions `snh_member_has_photos_access()` and
    `snh_member_has_photos_admin_access()`
  - Audit shim `private.snh_audit_photo()`
  - RLS policies: public read only when published; editors read all; no
    direct INSERT / UPDATE / DELETE for client roles.
  - Public read views `photo_albums_public_v1`, `photo_assets_public_v1`,
    `photo_asset_variants_public_v1`.

- `supabase/migrations/20260512110000_photos_storage_buckets.sql`
  - Creates `photos-private` (private) and `photos-public` (public).
  - Drops any prior storage.objects policies for these buckets.
  - No INSERT / UPDATE / DELETE policy for client roles. service_role
    bypasses RLS, which is how the Edge Functions write.

- `supabase/migrations/20260512130000_photos_drop_redundant_public_select_policy.sql`
  - Drops the `photos_public_anon_read` SELECT policy added in the
    previous migration. Public reads of derivatives go through the
    `photos-public` bucket's `public = true` flag and the
    `/storage/v1/object/public/...` URL, which bypasses RLS. The SELECT
    policy on `storage.objects` was redundant for serving images and
    enabled anonymous bucket enumeration, which Supabase Security
    Advisor correctly flagged.

- `supabase/migrations/20260512120000_photos_rpcs.sql`
  - Editor RPCs: `snh_photo_albums_list_editor`,
    `snh_photo_album_upsert`, `snh_photo_album_delete`,
    `snh_photo_assets_list_editor`, `snh_photo_asset_set_metadata`,
    `snh_photo_asset_finalize_upload`, `snh_photo_asset_publish`,
    `snh_photo_asset_unpublish`, `snh_photo_asset_delete`.
  - Service-only RPCs: `snh_photo_assets_create_pending`,
    `snh_photo_asset_record_variants`. Granted `execute` to service_role
    only.
  - Public RPC: `snh_public_photo_albums` (anon + authenticated).
  - All write RPCs are `SECURITY DEFINER` with `set search_path = public`,
    explicit role checks, allow-listed mutable fields, and audit log
    inserts via `private.snh_audit_photo`.

### Edge Functions

- `supabase/functions/photo-upload-intent` — issues short-lived signed PUT
  URLs to `photos-private`. Validates JWT, role, content-type, byte size.
  Reserves the asset_id and final object key server-side.
- `supabase/functions/photo-publish` — downloads original from
  `photos-private`, re-encodes via imagescript (strips EXIF), writes
  `web` and `thumb` derivatives to `photos-public`, records variant rows,
  then publishes the asset.
- `supabase/functions/photo-purge` — wraps `snh_photo_asset_unpublish` and
  `snh_photo_asset_delete`, then removes the storage objects the RPC
  reported as safe to purge.

`supabase/config.toml` enables JWT verification for all three functions.

### Frontend

- `assets/js/member-portal.js` exports the photo helpers
  (`photoAlbumsListEditor`, `photoUploadAndRegister`, `photoPublishAsset`,
  `photoPurgeAsset`, `publicPhotoAlbums`, `buildPublicPhotoUrl`, etc.).
- `assets/js/member-photos-panel.js` renders the `Photos` panel inside
  `members.html`: album list, album editor, per-asset upload, captions,
  publish/unpublish, regenerate, delete (admin).
- `assets/js/home-highlights.js` prefers
  `snh_public_photo_albums` and falls back to `data/highlights.json` +
  `assets/images/highlights/processed/*` if Supabase is unavailable or
  empty.

## Storage path layout

All photos use the same path prefix so a future tenant migration can
mechanically rewrite the prefix:

```
<scope_type>/<scope_id>/<album_id>/<asset_id>/<file>
```

- `photos-private`: `<prefix>/original.<ext>`
- `photos-public`: `<prefix>/web-<hash12>.jpg` and `<prefix>/thumb-<hash12>.jpg`

`<scope_type>` defaults to `club`; `<scope_id>` defaults to `snh`. We treat
both as opaque strings today; the tenant migration will populate them from
a tenants table without changing the path shape.

## Asset lifecycle

```
pending  -> uploaded  -> published  <-> unpublished
```

- `pending`: row exists; original has not yet been finalized.
- `uploaded`: client confirmed the original landed in `photos-private` and
  reported `byte_size` + `content_hash`.
- `published`: at least one `web` derivative exists in `photos-public` and
  the public read views/RPC will surface this asset.
- `unpublished`: assets that were once public and have been pulled back.
  Public derivatives are removed from `photos-public` immediately.

`snh_photo_asset_publish` refuses to flip status without a `web` variant
in `photos-public`; this prevents accidentally publishing an asset whose
derivatives never made it to the public bucket.

## Authorization matrix

| Action                              | Required roles                                    | Enforcement layer            |
|-------------------------------------|---------------------------------------------------|------------------------------|
| Read public albums / assets / URLs  | `anon`, `authenticated`                           | RLS on tables + RPC          |
| List editor album / asset metadata  | `photos_editor`, `photos_admin`, `club_admin`     | RPC role check               |
| Create / update album               | `photos_editor`, `photos_admin`, `club_admin`     | RPC role check               |
| Delete album                        | `photos_admin`, `club_admin`                      | RPC role check (admin)       |
| Issue upload intent                 | `photos_editor`, `photos_admin`, `club_admin`     | Edge Function role check     |
| Finalize upload                     | `photos_editor`, `photos_admin`, `club_admin`     | RPC role check               |
| Publish / regenerate variants       | `photos_editor`, `photos_admin`, `club_admin`     | Edge Function + RPC          |
| Unpublish                           | `photos_editor`, `photos_admin`, `club_admin`     | RPC + Edge Function purge    |
| Delete asset                        | `photos_admin`, `club_admin`                      | RPC role check (admin)       |
| Direct write to either bucket       | none (no policy)                                  | Storage policy               |

UI gating in `members.html` mirrors these slugs but is not the security
boundary.

## Threat model (for Phase 1.5 gate)

| Threat                                                        | Mitigation                                                                                          |
|---------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Authenticated user uploads to an arbitrary path               | Object key is computed server-side in `snh_photo_assets_create_pending` from album/asset IDs only.   |
| Authenticated user uploads outside their role                 | Edge Function checks `snh_member_has_photos_access()` before issuing a signed URL.                   |
| Anyone reads originals via public bucket                      | Originals only exist in `photos-private`; bucket has no public/anon read policy.                     |
| Anyone reads originals via authenticated client               | `photos-private` has no select/insert/update/delete policy for client roles. service_role only.      |
| Anyone reads private metadata via PostgREST                   | `photo_assets` SELECT for anon/authenticated is gated on `status='published'` + album published.     |
| Stale CDN cache after unpublish                               | Public URLs include a 12-char content hash; new uploads/regen produce new URLs and new objects.      |
| Unpublish leaves orphan public objects                        | `snh_photo_asset_unpublish` returns key list; `photo-purge` Edge Function removes them immediately.  |
| Image processor runs untrusted EXIF / metadata into variants  | imagescript decodes pixels and re-encodes JPEG; metadata is dropped on re-encode.                    |
| Oversized upload / DoS via huge files                         | Hard limits in DB constraint, RPC validation, and Edge Function (50 MB).                             |
| Wrong content type / non-image upload                         | Allowlist (`image/jpeg`, `image/png`) checked in Edge Function and RPC. WebP intentionally excluded for now (decoder limitation; see Future work). |
| Publish without derivatives                                   | `snh_photo_asset_publish` errors unless a `web` variant exists in `photos-public`.                   |
| Audit gaps                                                    | Every privileged write inserts to `public.audit_log` via `private.snh_audit_photo`.                  |
| Multi-tenant leakage when tenants are added later             | `scope_type` + `scope_id` are present everywhere already; queries can be scoped without a rewrite.    |

## Test plan

Manual / scripted tests to run before declaring this stack ready for the
public site:

### DB policy tests (run with three personas: anon, member-without-role, photos_editor, club_admin)

- [ ] anon SELECT on `photo_albums` returns only `published = true`.
- [ ] anon SELECT on `photo_assets` returns only `status='published'` AND parent album published.
- [ ] anon SELECT on `photo_asset_variants` returns only `bucket='photos-public'` for published assets.
- [ ] authenticated user without photos role gets the same view as anon.
- [ ] photos_editor SELECT returns all albums / assets / variants regardless of publish state.
- [ ] No client role can `insert`, `update`, or `delete` rows in `photo_albums`, `photo_assets`, `photo_asset_variants`.
- [ ] `snh_public_photo_albums` returns only published albums and only published assets.

### RPC tests (executing as photos_editor and as a member without the role)

- [ ] All editor RPCs raise `42501` for callers without the role.
- [ ] `snh_photo_album_delete` raises `42501` for `photos_editor`; succeeds for `photos_admin` and `club_admin`.
- [ ] `snh_photo_asset_delete` raises `42501` for `photos_editor`; succeeds for `photos_admin` and `club_admin`.
- [ ] `snh_photo_album_upsert` rejects bad slug, missing title, oversized title.
- [ ] `snh_photo_asset_set_metadata` rejects oversized caption / alt text.
- [ ] `snh_photo_asset_finalize_upload` rejects byte size out of range and non-hex content hash.
- [ ] `snh_photo_asset_publish` raises `22023` if no `web` variant in `photos-public`.
- [ ] `snh_photo_assets_create_pending` and `snh_photo_asset_record_variants` are not callable by `authenticated` (only `service_role`).

### Storage policy tests

- [ ] anon attempting `select` on `photos-private` is denied.
- [ ] authenticated attempting `select` on `photos-private` is denied.
- [ ] authenticated attempting `insert` / `update` / `delete` on either bucket is denied.
- [ ] anon `select` on `photos-public` is allowed.
- [ ] A signed PUT URL issued for asset A cannot be reused to write to asset B's path.
- [ ] After unpublish or delete, GET on the previously-public derivative URL returns 404.

### Edge Function smoke tests

- [ ] `photo-upload-intent` returns 401 without a Bearer token.
- [ ] `photo-upload-intent` returns 403 for an authenticated member without photos roles.
- [ ] `photo-upload-intent` rejects unsupported content types and oversized byte sizes.
- [ ] `photo-publish` decodes JPEG, PNG, WebP originals; rejects multi-frame inputs cleanly.
- [ ] `photo-publish` upload, record_variants, and publish are idempotent (regenerate works).
- [ ] `photo-purge` with `unpublish` removes only `photos-public` objects; with `delete` removes both buckets.

### Frontend integration tests

- [ ] Member portal Photos panel hidden for members without `photos_*` / `club_admin` roles.
- [ ] Editors can upload, finalize, publish, unpublish, regenerate, delete from the UI.
- [ ] Public homepage falls back to `data/highlights.json` when Supabase is unreachable or returns no published albums.

## Operational controls

- **Quota**: 50 MB per file (DB constraint + Edge Function check). Per-scope
  quota and per-album cap can be added later by reading aggregate
  `original_byte_size` in a new RPC; flagged for follow-up.
- **Retention / cleanup**: assets stuck in `pending` for more than 24 hours
  should be considered orphaned. A future maintenance job (Edge Function)
  should delete the row and any `photos-private` object found at the
  reserved key. Tracked in `docs/multi-tenant-foundation-tracker.md`.
- **Moderation takedown**: photos_admin / club_admin can call
  `snh_photo_asset_unpublish` (immediate revoke + public-bucket purge) or
  `snh_photo_asset_delete` (full removal); both go through the
  `photo-purge` Edge Function, so DB state and storage state stay in sync.
- **Audit**: every privileged write inserts a row in `public.audit_log`
  with `module = 'photos'`. Use this to investigate uploads, publishes,
  unpublishes, deletes, and variant generation.

## Bootstrap checklist

1. Apply the migrations with `supabase db push` (initial three plus the
   `..._photos_drop_redundant_public_select_policy.sql` follow-up).
2. Deploy the three Edge Functions with `supabase functions deploy`.
3. Verify both buckets exist in the Supabase dashboard and that
   `photos-public` is marked public.
4. Grant `photos_editor` to at least one member via the SQL editor or
   the existing Member Tools UI.
5. Sign in to the member portal as that member; the Photos panel should
   appear.
6. Create a test album, upload a small JPEG, publish, confirm the home
   page picks it up.

## Future work

- WebP upload support (current `imagescript` decoder does not handle
  WebP; either swap to a decoder that does or transcode WebP to JPEG/PNG
  client-side before upload).
- Per-scope storage quota + visible quota in the editor UI.
- Pending-asset garbage collection job.
- Drag-and-drop reorder UX (the `sort_position` field is wired but the
  panel currently exposes a numeric input).
- Optional moderation queue for non-admin uploads.
- Migrate `home-gallery.js` (machine cabinet rotation) to a similar
  pattern when the games-photo workflow is in scope.

## Albums linked to events (2026-05-19)

Migrations:

- `supabase/migrations/20260519090000_photo_albums_events_schema.sql`
  - `photo_albums.event_id` optional FK to `events(id)` on delete set null.
  - `photo_albums.display_at` optional timestamptz for album display or sort.
  - `photo_assets.exclude_from_slideshow` boolean (home mosaic skips when true).
  - `photo_assets.promo_role` null or `event_hero` or `event_branding` (check constraint).
  - Index on `photo_albums(event_id)` where not null. Public views updated.

- `supabase/migrations/20260519091000_photo_albums_events_rpcs.sql`
  - Extends editor and public JSON with event and promo fields.
  - `snh_photo_album_upsert` accepts `eventId` and `displayAt` in `p_fields`;
    only **published** events may be linked; **photos editors only** (same
    `snh_member_has_photos_access()` gate). When `event_id` on an album
    changes, promo roles on assets in that album are cleared.
  - `snh_photo_asset_set_metadata` accepts `excludeFromSlideshow` and
    `promoRole`. `event_hero` and `event_branding` require the album to have
    an `event_id`. At most one **`event_hero` per event** across all albums
    sharing that event (other heroes cleared when a new one is set).
  - `snh_public_photo_albums` includes `eventId`, `eventStartsAt`,
    `eventTitle`, `displayAt` on albums and promo fields on assets.
  - `snh_events_list_for_photo_link()` for the member Photos event picker
    (published events only).
  - `snh_public_event_promo_asset(p_event_id)` small public payload for the
    event hero image (Open Graph style use cases).

- `supabase/migrations/20260520100000_event_editor_photo_digest.sql` (and follow-up
  `20260520103000_event_digest_editor_hero.sql`): `snh_event_photo_digest_for_editor(p_event_id)`
  returns linked albums plus the event hero asset JSON for **authenticated** events or
  photos editors. The member Events form shows this digest under **Photos for this event**
  (hero preview and album list; linking still happens from the Photos panel).

Product rules (locked):

- Multiple albums may share the same `event_id` (no unique constraint).
- Home highlights mosaic skips assets with `excludeFromSlideshow` or
  `promoRole === 'event_hero'`.

