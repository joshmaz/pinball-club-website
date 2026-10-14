# SNHPC Photo Management 2.0

The gallery is public. It offers viewing and a keyboard-accessible lightbox,
without a download button. Browser users can still save a publicly displayed
image; this is a product choice, not a DRM promise.

## Upload and publication contract

- New JPEG, PNG and WebP inputs are converted **in the browser** to still WebP
  at quality 0.82: longest edge at most 1920 px for `web`, 640 px for `thumb`.
  Small photos are not enlarged. Browser decoding applies EXIF orientation;
  canvas output discards source metadata. Inputs are capped at 50 MB and
  80 million decoded pixels; each output is capped at 8 MB.
- There is **no enabled server image-conversion fallback**. The retired
  ImageScript JPEG converter was not a verified hosted WebP fallback. Unsupported
  formats receive an actionable error and a retry control. Browsers without native
  canvas WebP encoding use a lazy-loaded local WebAssembly worker (@jsquash/webp
  1.5.0 baseline libwebp, quality 82). Both derivatives remain on-device until
  encoded; the worker terminates after each photo. No remote CDN or server codec
  is used. Encoder load failures are retryable.
- `photo-upload-intent` checks the caller's identity and Photos capability,
  allocates a pending row, and signs **insert-only private derivative** paths.
  Supabase signed upload URLs last two hours, not the old implementation's
  advertised five minutes. No source original is uploaded for new photos.
- `photo-finalize` downloads the two bounded derivatives, verifies WebP container,
  still-frame headers, dimensions, metadata exclusions and SHA-256, then records
  them in a service-only, locked transaction. This checks the container and frame
  header, not a full pixel decode in the Edge runtime.
- The per-file queue continues past failures and retains its reservation for
  retries, including lost upload/finalization responses. Queue state lives in the
  current page; after a reload, incomplete new uploads can be reselected and old
  abandoned reservations are collected. Legacy conversion reservations can be
  resumed from the retained original.
- `photo-publish` copies the verified private derivatives to fresh public keys.
  Every publication has a new UUID plus a content hash. A revision check prevents
  an earlier publish from undoing a later unpublish. Uploads are tracked for
  cleanup **before** public storage writes, including failed commits.
- Private resized copies remain available for previews and republication.
  They are derivatives, not originals. Existing legacy originals and JPEG
  variants are not bulk converted, rewritten or deleted by this migration.
  Legacy uploaded/unpublished photos without derivatives can be converted in
  the editor by downloading their retained original to the browser. Explicit
  administrator deletion still removes a photo and its original.
- A photo's publication and its album's publication are separate. Album
  publication controls gallery discovery. Public bucket URLs are accessible
  independently of that discovery flag, as in the previous system.

## Editor, gallery and event integration

The volunteer editor auto-fills album URLs from titles, places URL/order controls
in optional settings, shows progress for each file, supports individual retry,
selects album covers and can publish all ready photos. Captions, accessibility
text, event links, highlight exclusions and the existing promo flags remain.
Album/asset deletion retains the existing administrator boundary.

`photos.html` lists published albums and photos, honors covers, supports
`?album=<id-or-slug>` and `?event=<event-id>`, and offers previous/next, arrow keys,
Escape, native dialog focus containment and focus restoration. Event cards link
to their albums; the Events spotlight title links to the full album.

A published photo in a published album can be reused as the promotional hero for
multiple published events without copying its storage objects. The editor's
“Reuse for event promotion” control writes `event_photo_promotions`; a cleared
or unavailable override falls back to the previous album-linked hero. Public
and editor hero readers honor overrides. No Games or Merch image code or
storage is changed.

## Durable storage cleanup

The migration adds a private outbox, with no client table access. Triggers
record variant replacement/deletion and asset/album cascade deletion in the
same database transaction. Current references, staged copies and retained
originals are checked before removing storage.

`photo-purge` runs a bounded cleanup pass after unpublish/delete/album-delete.
Photos administrators also have a **Retry storage cleanup** control. Storage
failures retain the job, its attempt count and error, with a five-minute retry
backoff; they are reported as queued work rather than silent success. A pass
processes at most 100 objects. Keep invoking cleanup until the eligible queue is
empty; no hosted scheduler is installed by this PR. Administrators can invoke
`photo-purge` with `{ "action": "cleanup" }` using their user JWT.

Signed stage paths are held until their two-hour upload window plus a ten-minute
safety margin has elapsed when deleting an asset, so a late signed PUT cannot
recreate a permanently untracked object. Abandoned new reservations are removed
24 hours after expiry during a cleanup pass. Expired legacy upgrades instead
return to the legacy state; their original is retained. Unpublishing removes
public paths and keeps private resized copies. Fresh publication paths avoid
old cleanup jobs deleting republished photos.

Storage deletion cannot erase an already downloaded browser/CDN copy. Public
photo cache lifetime for new objects is one hour. Removing an album from gallery
discovery alone does not remove its published object bytes; unpublish the photos
or delete the album for a storage takedown.

## Stale static fallback

The homepage now shows only managed published photos. An empty gallery or outage
cannot resurrect old static highlight photos. `data/highlights.json` and
`assets/images/highlights/` are retained as existing photo/archive material;
there is no destructive static-file removal or unverified bulk import.

## Authorization and migration

Migration: `20261013120000_photo_management_v2.sql`.
Existing effective role helpers, RLS policies and the Games/Merch systems remain.
Editor operations use Photos Editor effective access; deletion/cleanup uses the
existing Photos Administrator effective access. All service-only ingestion,
commit and cleanup RPCs revoke execution from public/anon/authenticated. The
retired original-ingestion and client-finalization RPC grants are revoked.

The migration touches only the two photo buckets, allowing legacy JPEG/PNG and
new WebP, with an 8 MB limit on **new writes**. Existing stored originals remain.
Cross-album cover assignments are rejected when assigning a new cover.

## Release commands — operator action after PR review

Run from the repository root, using the committed Supabase CLI dependency. The
project reference below was read from the existing local linked-project file.
Confirm it is the intended release target. **None of these commands were run
against the hosted project during implementation.** Keep the editor unavailable
while changing functions: the migration revokes the old original-upload path.
Apply the database first, then all functions, then release the website assets
through the normal reviewed workflow. Do not publish the new frontend before
the backend is ready.

```sh
npx supabase link --project-ref dawypferbucqanrkcdkj
npx supabase db push --linked --dry-run
npx supabase db push --linked
npx supabase functions deploy photo-upload-intent --project-ref dawypferbucqanrkcdkj
npx supabase functions deploy photo-finalize --project-ref dawypferbucqanrkcdkj
npx supabase functions deploy photo-publish --project-ref dawypferbucqanrkcdkj
npx supabase functions deploy photo-purge --project-ref dawypferbucqanrkcdkj
```

Inspect the dry run: it must include the new migration and no unexpected pending
migrations. Existing Supabase authentication/service-role environment variables
are sufficient; no new secret is required. All four functions retain gateway JWT
verification and independently authenticate/authorize the user.

After release, verify signed uploads, role denials, a legacy conversion, album
publication, anonymous gallery access, covers/event reuse, unpublish/republish,
and administrator album deletion on a disposable album. Hosted Storage behavior,
gateway behavior and Edge runtime execution still need this smoke test: local
checks use an embedded PostgreSQL engine and mocked Storage/auth services.

Do not roll back only the frontend/functions: their old original-upload grants
are intentionally revoked. Any rollback needs a reviewed forward migration;
never drop photo tables or delete existing originals as rollback.

## Local verification

```sh
node --test --test-concurrency=2 scripts/*.test.mjs
node scripts/check-events-duplicates.mjs
node scripts/snapshots.mjs check
node scripts/photo-management-browser.mjs
```

Browser QA needs Playwright and Chromium. Set `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_CHROMIUM` when using a separately installed runtime. It uses only a
local server and synthetic/mocked data, including native and bundled WASM WebP
conversion, encoder download failure/retry, backend acceptance of fallback bytes,
EXIF orientation, no enlargement, gallery filtering, keyboard/focus behavior,
mobile layout, and multi-upload failure/continuation/retry. Database tests apply
the actual photo migrations and exercise permissions, publication, cross-album
covers, event reuse, revision races, cleanup failures, cascade deletion,
expired/abandoned uploads and original retention. Edge tests execute the actual
handlers against mocked clients and cover authentication, limits, metadata
rejection, signed URLs, queued upload failure and storage deletion failure.

References: [signed upload URL lifetime](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl),
[hosted Edge runtime limits](https://supabase.com/docs/guides/functions/limits).

## Phase 2 editor update

The volunteer editor now provides an album workspace with drag-and-drop uploads,
per-file and batch progress, individual/batch retry, prominent cover selection,
and a single album publishing action. See [implementation status](photo-management-2-status.md)
for implemented features, hosted verification still needed, and retry/publication
limitations. This frontend update adds no migration or Edge Function changes.

Run the same browser checks with `PLAYWRIGHT_BROWSER=webkit` for WebKit.
`PLAYWRIGHT_WEBKIT` can point to a custom WebKit executable when needed.

## Gallery browsing and album order

The gallery starts with collapsed summaries (12 albums per reveal). Opening an
album creates up to 24 lazy thumbnail images, with a Show more photos control.
Closing an album removes its grid. Direct album links open the requested album;
event links show matching album summaries. Lightbox navigation spans the full
album and loads the main variant only when viewed.

Album ordering is controlled by **Arrange albums** in the member editor:
- **Newest first** uses album display date, then linked event date, then creation
  date. The public gallery and editor library use the same database ordering.
- **Custom order** uses cover/title/status rows with drag handles, Move to top,
  Move up/down, Save order and Cancel. No album position numbers are shown.
  New albums go to the top and keep the relative order of existing albums.
- Switching to newest-first preserves the stored custom sequence. Switching back
  to custom starts from that sequence. Existing order remains custom on migration.
- Saves are atomic, Photos-role restricted and reject stale revisions, added or
  deleted albums, duplicates, missing albums and unknown album IDs. A stale-save
  error leaves the draft available; Cancel and reopen to load the latest state.

## Ordering migration — operator action after review

This follow-up requires `20261013140000_photo_album_ordering.sql`, applied after
`20261013120000_photo_management_v2.sql`. From the linked repository:

```sh
npx supabase db push --linked --dry-run
npx supabase db push --linked
```

The dry run should list only the expected outstanding migration(s). No additional
Edge Function deployment or secret is required. Apply the migration before the
reviewed website release. Without it, Arrange albums is disabled and existing
metadata saves retain their positions. No hosted migration was run by the agent.

These changes bound initial image/DOM work. The current public RPC still returns
all published metadata; server-side pagination remains a future scaling step.

## Hosted UPDATE safety correction

Migration `20261013150000_photo_album_ordering_safe_updates.sql` replaces the
ordering revision trigger and save RPC with explicit `where singleton=true`
predicates. Hosted safety checks rejected the prior unqualified settings update
when creating an album or saving order. Apply this forward migration after the
ordering migration, using `npx supabase db push --linked --dry-run`, then
`npx supabase db push --linked`. No Edge Function or frontend redeployment is
required for this database correction. The failed album transaction rolls back;
retry creation after applying the migration.

## Event photo digest alias correction

Migration `20261013200000_photo_event_digest_album_links.sql` replaces the event
digest function, ordering by the subquery column rather than an unavailable
`alb` table alias. Run `npx supabase db push --linked --dry-run`, then
`npx supabase db push --linked` from the updated branch. No new Edge Function
deployment is needed. Album view/copy controls and clickable event-editor album
links are website changes delivered through the existing reviewed release.

## Visual photo order deployment

Apply `20261013220000_photo_asset_ordering.sql` after the earlier photo migrations.
From the updated linked checkout, run `npx supabase db push --linked --dry-run`,
then `npx supabase db push --linked`. No Edge Function deployment is needed.
The existing per-photo metadata API cannot save a batch atomically and default
sort position zero cannot append reliably across clients; the migration adds a
role-gated atomic save and insert trigger using existing `sort_position` only.
It creates no new ordering columns or roles. Save locks briefly serialize photo
CRUD, validates the original ID/position snapshot, and changes only sort positions.
No hosted migration was performed by the agent. Apply it before the reviewed
website release; without it, Arrange photos stays disabled.
