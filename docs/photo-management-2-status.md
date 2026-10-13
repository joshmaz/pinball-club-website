# Photo Management 2.0 implementation status

## Foundation already implemented

- Browser JPEG/PNG/WebP conversion into WebP main (maximum 1920px) and thumbnail
  (maximum 640px), quality 0.82, without retaining new originals.
- Authenticated upload reservation/finalization, public publication, private previews,
  revision checks, durable cleanup records and abandoned-upload collection.
- Existing originals retained; explicit legacy conversion reads them in the browser.
- Public albums, filtering, keyboard lightbox and no download button.
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

- Hosted smoke testing with a disposable album: signed uploads, JWT/role enforcement,
  previews, publication, legacy conversion and cleanup. Local browser/backend tests
  use synthetic files and mocked services; they do not prove hosted Storage behavior.
- The operator reported applying migration 20261013120000 and deploying finalize,
  publish and purge. Deployment of photo-upload-intent has not been confirmed.
- Phase 2 itself needs no additional migration or function deployment; it needs the
  updated website assets after review. The PR stays open; no production deployment
  or merge was performed by the agent.
- Retry state is page-local; it does not resume after reload or browser closure.
  Unfinished storage reservations are handled by the existing cleanup mechanism.
- Publication is a sequence of backend operations, not one database transaction.
  Draft albums remain draft when a photo fails; already-public albums can show
  successfully published new photos while remaining failures await retry.
- No server codec fallback is enabled: runtime viability has not been verified.
  Unsupported input must be converted by the user before uploading.
- Cleanup retries are durable, but execution requires another cleanup/admin action;
  an unattended cleanup scheduler has not been configured.

See [photos-foundation.md](photos-foundation.md) for the backend contract, release
commands and verification procedure.
