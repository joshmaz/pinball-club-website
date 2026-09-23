# Events: clubhouse / retro digital experiment

Branch base: main `6e6691a`, including merged reconciliation PR #98. The recovered audit styling and regression test are present. This branch does not depend on an outstanding reconciliation PR.

## Scope and architecture

The existing site is static HTML, a shared `assets/css/styles.css` token sheet, and plain browser JavaScript. `events.js` owns the public calendar, year navigator, capability-gated editor links, and photo spotlight. `public-data.js` loads live public events with the existing JSON snapshot fallback. Those loading, authorization, and archive contracts are unchanged.

Only Events loads `events-prototype.css` and `events-prototype.js`; its root class scopes the new token palette. Existing shared CSS and theme.js are unchanged. There is one card DOM for both themes. The existing synchronous theme controller supports light/dark/system via `snh-theme` local storage, tracks system changes, and sets color-scheme before paint. The Events selector calls its public API; the existing icon-only toggle is hidden on Events. The preference remains shared with the rest of the site, whose appearance stays unchanged except for that existing theme behavior.

`--club-bg`, `--club-surface`, `--club-soft`, `--club-ink`, `--club-muted`, `--club-teal`, `--club-line`, and `--club-amber` define deliberate light/dark pairs with CSS light-dark(), consistent with the existing browser baseline. Light uses warm off-white and navy with deep teal; dark uses navy with pale text/cyan and limited amber labels. Selected existing tokens are mapped to these values. Radius, spacing, and monospace display font are tokens too. System sans-serif remains the body font; no external font download. Monospace dates and small labels provide the digital character.

Changes: Events-only brand/navigation layout, editorial introduction, welcome panel, explicit theme selector, date-led compact cards, semantic full dates, readable metadata and complete descriptions, provider-labeled external links, contained event images, and restyled archive controls. Photo highlights retain their existing behavior. Member edit actions remain plain and permission-gated. Focus rings, a skip link, 44px controls, responsive cards, textual statuses and reduced-motion scrolling are included.

## Brand inventory

Existing assets inspected before editing:
- `SNHPC_logo_color.png` (511×461): used as the header home link, entire image at natural aspect ratio.
- `SNHPC_logo_mono.png` (613×612): available, unused.
- `snhpc_logo_small.png` (613×613): available, unused.
- `snhpc_logo_small_cropped.png` (442×201): existing footer asset, kept exactly as supplied. No new crop.
- `snhpc_original-logo.jpg`: historical asset, unused.

Partner/event artwork includes Pintastic, NEPL, lobster, and American Pinball Warrior assets; these are not substitutes for the club identity. No artwork files changed; no filters, recoloring, transforms, cropping or generated logos.

## Real data and deferred modeling

No sample events, links, migrations, or writes are introduced. `eventPresentationLinks` accepts optional presentation input `externalLinks: [{url, label?}]`, and appends/deduplicates today's single `event.url`. Known hostnames receive Match Play / Facebook / Discord labels; other HTTP(S) URLs are labeled Event details. Unsafe schemes are omitted. Optional multi-link input is exercised only by tests; current production loader still supplies one URL. Future schema/editor/export work must deliberately supply the array, with server-side validation and authorization. Nothing is secretly fabricated from a title or club social URL.

The current public loader/snapshot supplies calendar dates, not reliable times. Cards explicitly say Time not listed unless presentation input supplies `time`. Existing free-text details remain fully visible. Proper time/zone and all-day semantics need a separate data contract; do not render midnight placeholders as start times.

## Extending or rejecting

To extend later, promote approved semantic tokens to shared CSS, then opt in one page at a time. Extract common card/link conventions only where useful; keep member/admin layouts neutral and dense. Review time and multi-link modeling separately. To reject, close the PR/delete its branch. Production remains unchanged; no database or content cleanup is needed. Other pages in the preview remain direct visual comparisons. Preview and production use separate browser storage origins.

## Validation

Run the normal `node scripts/build-preview.mjs` pipeline with public Supabase configuration. It runs every `scripts/*.test.mjs`, duplicate-event validation, public snapshot checks, and the static build. Local validation uses placeholder public settings, so live featured photos require the configured Netlify preview. The new tests cover safe multiple-link presentation and System/explicit persisted theme behavior. Existing archive-navigation and authorization tests still run. There is no separate repository lint command; use `git diff --check` plus JavaScript syntax checks.

Verified locally: all 18 test files pass, snapshot/duplicate checks and build pass, JavaScript syntax and diff whitespace checks pass. Browser inspection covered desktop light/dark, 390px and 320px mobile widths without horizontal overflow, year selection/previous year/collapse, explicit theme after reload, System selection, and visible keyboard focus. Measured primary text/accent contrast pairs exceed 5.2:1 in both palettes. Live signed-in editing and photo RPC require the configured preview; their existing code paths are retained, with authorization covered by the repository tests.

## Optional homepage study (requested during review)

`home-prototype.html` is a standalone, noindex homepage mock-up. `index.html` and navigation from all existing pages stay unchanged. The mock-up reuses the Events palette and theme selector plus `home-prototype.css`, with the original color logo and footer asset unchanged. Its hero uses the existing `snhpc_club02.jpg`, explicitly captioned as archive photography, not a claim about the current venue. Existing club highlights/lightbox and account controls are reused. The layout explores a hero, current-status strip, three discovery cards, visit information, highlights, and support/contact sections. Copy uses the repository's open-club status/address and omits contradictory older reopening language; final homepage copy remains subject to review. This page is an opt-in visual study, not a replacement of the production homepage. Its token CSS still has the prototype Events name until a broader design system is approved.
