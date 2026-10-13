# Photo Management 2.0 implementation status

## Foundation already implemented

- Browser WebP encoding fallback for iOS: a bundled, lazy-loaded WebAssembly
  worker handles browsers whose canvas returns PNG for a WebP request.
- Browser JPEG/PNG/WebP conversion into WebP main (maximum 1920px) and thumbnail
  (maximum 640px), quality 0.82, without retaining new originals.
- Authenticated upload reservation/finalization, public publication, private previews,
  revision checks, durable cleanup records and abandoned-upload collection.
- Existing originals retained; explicit legacy conversion reads them in the browser.
- Public albums, filtering, keyboard lightbox and no download button. Album summaries
  start collapsed, with 12 albums per reveal and 24 thumbnails per reveal. Closing
  an album removes its grid; direct album links open the requested album.
- Visual album ordering: Newest first or Custom order, with drag handles, move
  buttons, Save/Cancel and no visible album position numbers. Existing order is
  preserved on migration; new albums go to the top in custom mode. Saves are atomic
  and reject stale edits. Newest first uses album date, event date, then creation.
- Event album links and reusable event promotional photos.
- Photos navigation after Merch and before Resources.
- Effective roles and existing Games/Merch image systems preserved.

## Phase 2 implemented on the same branch and PR

- Album workspace with a responsive album library, draft/published labels and
  optional metadata tucked into expandable sections.
- Drag-and-drop and multiple-file picker uploads; additional files can be queued
  while a batch runs. Files are processed sequentially to limit browser memory.
- Persistent-on-screen batch summary, overall processing percentage and per-file
  stages/percentages. Upload stages use actual transferred-byte progress; conversion
  and finalization use milestone percentages, so overall progress is not an ETA.
- Individual retry, retry all failed files, dismiss failed files and clear completed
  entries. Retries retain conversion results, reservations and completed derivatives
  within the current page. Interrupted finalization reuses uploaded files.
- Prominent cover selection, selected-cover badge, preview and automatic-cover reset.
  Selecting a cover saves current album details but does not change publication.
- One Publish album action saves details, publishes ready photos and then makes the
  album public. An interrupted publication can be retried without republishing
  successes. Intentionally hidden photos stay hidden until individually republished.
- Hide from gallery changes album visibility without removing photos or originals.
- Unsaved album details survive upload/cover/publication refreshes. Busy publication
  blocks conflicting editor actions. Upload failures must be retried or dismissed
  before publishing the album.

## Outstanding verification and limits

- The gallery limits rendered albums and thumbnails, but the existing public RPC
  still returns all published album/photo metadata. Server-side pagination and
  per-album metadata requests remain future work for a very large archive.

- Hosted smoke testing with a disposable album: signed uploads, JWT/role enforcement,
  previews, publication, legacy conversion and cleanup. Local browser/backend tests
  use synthetic files and mocked services; they do not prove hosted Storage behavior.
- The operator reported applying migration 20261013120000 and deploying finalize,
  publish and purge. Deployment of photo-upload-intent has not been confirmed.
- The visual sorter requires migrations 20261013140000_photo_album_ordering.sql
  and 20261013150000_photo_album_ordering_safe_updates.sql;
  no additional Edge Function deployment is needed. The earlier Phase 2 editor
  layout needed no additional migration or function deployment; it needs the
  updated website assets after review. The PR stays open; no production deployment
  or merge was performed by the agent.
- Retry state is page-local; it does not resume after reload or browser closure.
  Unfinished storage reservations are handled by the existing cleanup mechanism.
- Publication is a sequence of backend operations, not one database transaction.
  Draft albums remain draft when a photo fails; already-public albums can show
  successfully published new photos while remaining failures await retry.
- No server codec fallback is enabled: runtime viability has not been verified.
  Unsupported input formats must be converted by the user before uploading. Native
  encoder limitations now use the browser WebAssembly fallback.
- Cleanup retries are durable, but execution requires another cleanup/admin action;
  an unattended cleanup scheduler has not been configured.

See [photos-foundation.md](photos-foundation.md) for the backend contract, release
commands and verification procedure.

## Follow-up testing

The operator confirmed desktop uploads worked, then tested deletion of a newly
uploaded photo. iOS Chrome reported native WebP encoding unavailable; the bundled
worker addresses that path. Chromium and WebKit checks passed for actual WASM
encoding, resize/orientation, backend acceptance and encoder download failure/retry.
All 308 regression tests passed. A physical iOS retest remains necessary.

## Contextual Edit Album access

Opened public albums show the established text-only outlined Edit Album link only
when the existing `photos.manage` effective capability allows it. Photos Editor,
Photos Admin and inherited Website Administrator access are supported; anonymous
visitors and other members see no link. Auth changes refresh visibility.

Links use `members.html?panel=photos&album=<uuid>` and the existing Photos panel.
The requested album is selected with its details expanded; Back to public album
returns to `photos.html?album=<uuid>`, which reopens it. Invalid IDs are rejected
by the shared member router. No new roles, migrations or functions are required.

## Album sharing and event digest correction

Opened public albums provide View album for everyone. It opens a standalone
album page with a shareable URL using the stable album UUID.
The event editor links published albums with published photos to that public view.
Migration `20261013200000_photo_event_digest_album_links.sql` fixes an out-of-scope
SQL alias in the event digest while preserving existing role checks. Apply it after
the preceding migrations; no Edge Function deployment is needed.

## Album-to-event navigation

An album’s linked event title opens `events.html?event=<event-id>`. The Events page
reveals the matching past year when needed, highlights and focuses that event.
Titles without an event ID remain plain text. No backend deployment is needed.

## Editor layout refinement

The album picker sits above the full-width editor on desktop and mobile. Desktop
album cards wrap in a height-bounded picker; mobile keeps a horizontal scroll row.
New/Arrange/Refresh and storage maintenance use a compact wrapping toolbar, with
no page-width action buttons. No backend deployment is needed.

## Visual photo ordering

Arrange photos uses current-order thumbnails, drag handles, Move Left/Right and
Save/Cancel. Numeric photo position fields are removed. Atomic saves update only
existing sort positions, reject stale snapshots and invalid/cross-album IDs, and
leave captions, covers, publication and visibility unchanged. Public gallery and
lightbox follow stored order; the cover only determines the album preview.
New inserts append to the album, including across clients. One narrow migration,
`20261013220000_photo_asset_ordering.sql`, supplies append-on-insert and atomic
order save. It reuses the existing settings read for feature availability; before
it is applied, Arrange photos is disabled. No new Edge Function is needed.
The single-album public view omits its redundant View album link.
