# SNHPC clubhouse redesign branch

The existing `codex/events-clubhouse-prototype` branch is an evolving site-design experiment. Initial work started from main `6e6691a`, after reconciliation PR #98 was merged. Subsequent commits preserve that work and add independently revertible refinements. Do not merge automatically.

## Normal routes and scope

- `index.html`: the redesigned homepage, promoted from the initial comparison study. The comparison wrapper and duplicate `home-prototype.html` are removed. All original homepage link destinations, contact/location details, current-club status, dynamic photo highlights/lightbox, data-driven machine gallery, and shared account menu remain. Old contradictory reopening copy is replaced by the already-established open-club copy. The machine slideshow has a pause/play control and respects reduced motion and background tabs.
- `events.html`: existing date-led cards, year archive, dynamic selected-year hint, data loading, photo spotlight, provider-labeled links, and authorized edit actions remain. Only shared foundation names changed in this increment.
- `games.html`: artwork-first responsive cards, semantic titles, current/history badges with an explanatory legend, native expandable location histories, larger controls, and search within the selected timeline lineup. Timeline/date/all-history behavior, sorting, live/snapshot loading, image attribution, provider links, tabbed dialogs, and permission-gated editor routes are retained.
- `members.html`: My Account on its existing route. Quieter heading/navigation, semantic profile fieldsets, paired name inputs, associated helper text, password grouping, readable membership card, and textual success/error notices. Existing fields, saves, recovery flow, role-gated tools, deep links, door-code behavior, server authorization, and membership semantics remain.

Resources, Merch, About, sign-in and other routes are not redesigned. No new database schema, integration, backend query, authentication bypass, or production fixture is added.

## Shared design pieces

`assets/css/clubhouse.css` is an opt-in foundation loaded after the legacy stylesheet by the four redesigned routes, identified by the `clubhouse` root class. It extracts/renames the earlier Events foundation rather than adding a competing palette. Page-specific composition lives in `home.css`, `club-games.css`, and `club-account.css`; existing Events rules remain in the foundation for now.

The `--club-*` semantic tokens cover warm-neutral/navy light and navy/cyan dark surfaces, text, teal, amber, borders, control boundaries, success/error palettes, radius, spacing, and monospace display typography. Relevant legacy variables are mapped to these values so existing components inherit the system. System sans-serif is used for body/forms; local monospace is limited to display labels and status/date treatments. No external fonts.

Unchanged `theme.js` resolves Light/Dark/System synchronously and persists explicit preferences under `snh-theme`. `clubhouse.js` binds the same labeled native Appearance selector on all four pages and follows changes to the controller's preference. There is one DOM per page, not duplicated light/dark markup. Preferences are shared across this preview's pages; production is a separate storage origin. The existing CSS light-dark() browser baseline is unchanged.

New reusable patterns include an optional quiet page heading, labeled search/control field, semantic fieldset surface, compact application sidebar, membership/status card, and success/error notice. Game cards use the same surfaces with little ornament so the images dominate. Native details/summary exposes location history without hiding or truncating the underlying data. Search matches all entered words against the currently selected lineup's title/description, preserving timeline membership and ordering.

## Brand assets

Inventory inspected before the initial design:
- `SNHPC_logo_color.png` (511×461): entire header image, natural aspect ratio.
- `SNHPC_logo_mono.png` (613×612): available, unused.
- `snhpc_logo_small.png` (613×613): available, unused.
- `snhpc_logo_small_cropped.png` (442×201): existing footer asset retained exactly; no new crop.
- `snhpc_original-logo.jpg`: historical asset, unused.

All artwork bytes are unchanged. Logos have no filters, recoloring, cropping, transformation, or generated substitute. A neutral backing behind the full header asset keeps the navy artwork legible in dark mode. The homepage's existing `snhpc_club02.jpg` is captioned as archive photography, not represented as a current venue photo. Machine artwork and attribution come from the existing catalog pipeline.

## Data intentionally deferred

Events still receives a single URL from its production loader. Its isolated presentation adapter accepts optional `externalLinks: [{url, label?}]`, appends/deduplicates the legacy URL, labels known HTTP(S) hosts, and rejects unsafe schemes. Multiple links occur only in tests until a separate schema/editor/export change is approved. No event links are fabricated.

Public event records supply calendar dates without reliable start times. Cards retain “Time not listed” unless explicit presentation time is supplied. Database timestamp/timezone/all-day semantics remain a separate contract decision. Existing event descriptions remain complete. Payment automation, Discord connections, notifications, and new account integrations are not implemented.

## Validation and review

The normal `node scripts/build-preview.mjs` pipeline runs all `scripts/*.test.mjs`, duplicate-event validation, public-snapshot checks and the static build. Local builds use placeholder public Supabase settings and exercise real checked-in snapshot fallback. No separate repository lint command exists; JavaScript/inline-script syntax checks and `git diff --check` supplement the build.

Browser review covers desktop/mobile light and dark, normal Home/Events/Games routes, search including no-results/clear and all-history, timeline selection, game dialog tabs/Escape/focus return, account field grouping, membership, role-gated navigation, simulated save success/error, and recovery layout. Account interactions use a temporary localhost-only fixture with fake data and stubbed writes; it is removed by the final clean build and is never committed or deployed. Live authenticated writes, role changes, door-code access and payment operations are not exercised.

## Before wider rollout

Extract Events-only rules out of the shared foundation; reconcile the remaining legacy token aliases; standardize header/footer markup with the site's build approach; and consolidate older admin inputs/status helpers onto the new field/control/notice patterns. Verify less common privileged panels and full authenticated workflows with club reviewers. Improve remaining legacy page designs incrementally, rather than importing this opt-in foundation everywhere at once.

The branch stays separate from production. Each increment is a new commit; reverting the homepage/Games/account increment restores the preceding Events/homepage study without database or content cleanup.

Latest increment validation: all 19 test files, snapshot/duplicate checks, build, syntax and whitespace checks passed. Four normal-route asset references resolve; the old homepage route and local account fixture are absent from the final build. All original homepage link destinations are retained. Home/Events fit at 320px; Games/account were reviewed at 390px without horizontal overflow. Signed-out `members.html` still redirects to sign-in. The shared logo backing and stronger input borders were checked as presentation changes only.
