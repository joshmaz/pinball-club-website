# Club machine profiles

Implemented against main `4254d7718fa9c96be043ce8ffb74bd8bb1105e14` after the October 26 game-card review.

## Behavior

- Cards use a brief excerpt of existing Details; the full text remains in **About our machine**. Editors see guidance to describe the actual club machine. Custom mods, public owner/lender credits, sale information, scores and Pingolf retain their existing fields and public/private boundaries.
- Haines/Bridge addresses are abbreviated only for display. History is current first, then newest first. Exact stored dates and addresses are retained. Missing historical ends are not rendered as Present. Only the newest eligible open stint for a machine currently at the club ends in Present; unknown starts remain explicit.
- Era is derived from the existing OPDB `display` field: reels/lights = EM, alphanumeric = Solid State, dmd/lcd = Modern. No year cutoff or stored era field. Unknown values omit the badge. Seven reviewed display corrections are included in the snapshot and migration; exact OPDB ID and previous display must match before a live correction is applied. Other metadata is preserved. Major League and Play Boy still need OPDB identity matching.
- Existing Kineticist/Pinside/IPDB/PinTips artwork is reused in the profile. PinTips keeps its current import, attribution and text handling. External bulb icons and the Tips resource link open the OPDB entry Info page rather than its external PinTips tab.
- Photos fetch approved associations when that tab is first opened. Primary first, club next, other approved images after; ties use creation time and ID. Thumbnails, image count, previous/next, credits and a native-dialog photo viewer reuse existing image delivery variants. A failed request retains the primary preview and offers retry. No additional image storage system or approvals are introduced.
- Notes shows signed-in users the existing game-linked records from the same authenticated RPC used by Member Tools, with unresolved notes first and resolved notes collapsed. It offers a game-prefilled Add a note form using the existing write RPC. The link to Member Tools carries `issueGame` through the existing sign-in `next` route; the Notes editor filters and prefills that game, including historical games. Ordinary members still submit as Incoming. Existing helpers retain full edit/resolution access.
- A helper can write an optional **Public machine summary** (280 characters). This is a separate editorial field, never an automatic copy/redaction of private title/body. Only nonblank summaries for unresolved issues on non-deleted games appear publicly. Public responses contain only summary and status, with no reporter, report ID, private body, provenance or exact timestamps. Existing reports remain private until a helper deliberately writes a summary. Resolution hides it; reopening shows it again until cleared.
- No maintenance history, service log, parts tracking or Pinventory replacement is added.

## Access and verification

`20261026151512_game_card_profiles.sql` adds the optional summary, extends the existing authenticated list/upsert, and defines two narrow public read functions. Public projections use explicit approval/status/deletion filters and an empty search path. Execute is revoked from PUBLIC and granted only to anon/authenticated. No new direct table grants or changes to existing member/helper rules. The existing account-existence guard remains enforced, including against stale tokens after account deletion. Explicit anon grants on the two member issue RPCs are revoked.

Tests execute the migration in local PGlite with anon/authenticated roles, real issue helper/editability definitions and fixture records. They cover ordinary-member create versus helper update/publication, all helper families, public field allowlisting, blank/resolved/deleted exclusion, secondary-image approval/ordering, delivery variants and guarded metadata updates. This is local PostgreSQL-compatible verification, not a claim that production policies or endpoints have been deployed.

Run:

```sh
node --test scripts/game-card-formatting.test.mjs scripts/game-card-profiles-db.test.mjs scripts/member-routes.test.mjs scripts/game-deep-links.test.mjs scripts/games-contextual-edit.test.mjs scripts/game-image-delivery.test.mjs scripts/game-image-authorization.test.mjs scripts/pintips-db.test.mjs scripts/pintips-provider.test.mjs scripts/pingolf-db.test.mjs
```

Optional browser QA uses Playwright (install locally without saving a dependency) and isolated RPC fixtures. It never submits a production report:

```sh
node scripts/game-card-profiles-browser-check.mjs
```

Optional environment variables: `CHROMIUM_EXECUTABLE` selects an installed Chromium binary; `GAME_CARD_QA_PHOTO` supplies a local image fixture; `GAME_CARD_QA_DIR` selects screenshot output (defaults to `/tmp/game-card-qa`). Covers desktop 1280×900 and phone 390×844, lazy gallery requests, credits, lightbox Escape, focus containment, retained photo selection/drafts during slow responses, PinTips, visitor invitation, member submission/failure, retries, empty states, helper summary publication and ordinary-member field exclusion.

## Release order

1. Review and apply the migration through the normal database deployment process. Inspect advisors/policies in the deployed environment. The migration changes no existing summary visibility by default.
2. Verify public functions as visitor/member/editor against a non-production game, including a reference-only secondary photo and an unpublished report. Confirm direct private issue reads remain inaccessible to visitors.
3. Publish frontend changes, then refresh the public games snapshot from the database so live metadata and fallback agree. The checked-in snapshot includes the seven reviewed display corrections; deployment skips any live record independently edited since review.
4. With test accounts, verify sign-in/sign-up return context, member report creation, helper summary publication/clear/resolution, primary fallback and approved image credits. Check real image `currentSrc` at phone/desktop densities.
5. Helpers can start adding public summaries after editorial review. Do not copy reporter names, contact information or private notes into them.

Rollback: revert frontend changes. Existing primary images, issue workflows and Tips remain usable; the additive summary column and public projections can remain until a separately reviewed cleanup. Do not delete images or issue records as rollback.

## Staging deployment — October 26, 2026

Applied only `20261026151512_game_card_profiles.sql` to **SNHPC Staging** (`eptbdrwmcwogxcjleudv`). The staging schema was already restored but had no recorded migration history; older migrations were not replayed. The repository filename matches the version recorded by the deployment tool.

Verified the summary column and public read functions, retained account-existence checks, and revoked visitor execution of member-only list/upsert. No public summaries were auto-published. Staging had two of the seven reviewed OPDB entries; both now use LCD. Public gallery reads include only approved images. Production is unchanged.

Security advisors retain existing baseline findings. The two new public read functions intentionally appear as SECURITY DEFINER executable advisories because they return allowlisted public projections; member-only issue functions are no longer executable by anon.

## Follow-up refinements

New OPDB imports prefer closeup, then playfield, backglass, and other images, with OPDB primary only breaking ties within a type. Existing primary selections, uploaded club images (including an approved upload without an explicit primary flag), and supplied legacy defaults retain priority. No existing images are reselected. The shared parser order and the authoritative database selection use the same preference.

Applied `20261026153013_opdb_primary_image_preference.sql` to staging and verified closeup preference plus upload preservation inside a rolled-back transaction. The shared parser change is included for subsequent Edge Function deployment; the staging database already enforces primary selection independently of incoming array order. Production is unchanged.

Only Close stays visible while scrolling; the title scrolls with the content rather than covering photos. Opening resets scroll position to the top. External bulb links open OPDB Info; local Tips content remains on the club card. Desktop/phone checks verify header alignment and link destinations.

Presentation refinement: stint dates ending in Present no longer repeat Current. The OPDB resource label now reads OPDB, while actual tip-source credit still reads PinTips. The title is not sticky; only the compact Close control stays available.

## Unified Notes presentation

The game-card tab and Member Tools use the same Notes mechanism (`club_issues` internally); no second notes store or new permissions were introduced. Signed-in users see original title/body/status for notes linked to that exact machine, including records without a public summary. General club notes and other machines' notes stay out of that card. Resolved notes are collapsed by default. Successful submission refreshes the linked notes; read retries preserve the draft. Sign-out immediately clears private content and invalidates in-flight requests.

Visitors see only helper-authored public summaries, never the authenticated notes list. The four existing Member Tools status filters (All, Incoming, In progress, Resolved) are now prominent header buttons, with a clear selected state and two columns on phones. Status semantics and helper editing rights are unchanged. These are frontend-only changes; no additional database migration is required.

Public summaries remain visible to signed-in users above the original machine notes. The two reads complete and retry independently, preserving the note draft if either request fails. Visitors still never request member-only notes.

Game-linked Notes now displays a prominent game-filter banner with Show all notes. The All header button also clears the game filter from both the list and URL and exits editing. Unsaved text requires confirmation before discarding; cancelling leaves the draft and scope intact. Cancel editing is explicit in the edit form. Returning to Notes after clearing the scope stays unfiltered.

## Photo zoom and size selection

The enlarged viewer fills most of the viewport and supports 1–4× zoom, Fit photo, drag/scroll panning, two-finger pinch, double-click toggle, and keyboard +/−/0. Arrow keys change photos while fitted; when zoomed, the focusable photo region can scroll. An original-image link is available. Credits stay visible below the image.

Gallery and enlarged-view sizing use measured CSS width and device density to select the smallest sufficient candidate. Responsive hints are assigned before the fallback src. The viewer updates its size hint when zoom or viewport dimensions change. The full source is requested only if explicit zoom needs more pixels than the available variants; records without variants necessarily fall back to their source. All 242 approved staging OPDB images were checked and have responsive candidates. Browser tests verify a fresh phone fit does not request the large/original URL, then requests a larger candidate on zoom. No database migration is needed.

## Era labels and filters

Cards show an era badge beside At club / Club history; Overview retains the era in the metadata line. Show eras checkboxes allow any combination of EM, Solid State and Modern, alongside search, the selected timeline date and Show all games. All eras resets only the era choices. Other appears when the catalog has unclassified records, so intentional non-OPDB entries such as Play Boy and Major League remain browseable without invented OPDB metadata. Turning every category off produces an explanatory empty state. Deep links reset restored era choices so the requested machine is not hidden.

Staging's seed data had 104 missing display values. These were filled from exact existing OPDB IDs (alias display inherited from the parent machine where needed), without overwriting existing values or changing IDs. Staging now classifies all 106 catalog records: 26 EM, 43 Solid State and 37 Modern. The importer also carries canonical OPDB display on new records in the next Edge deployment. These are data updates plus frontend/import-helper changes, not a new schema. Production is unchanged.
