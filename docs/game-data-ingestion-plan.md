# Game data ingestion plan

## Current state

- `data/latest-opdb.json` is a checked-in OPDB export with machine groups, machines, and aliases. The current snapshot contains 1,706 groups, 2,154 machines, and 205 aliases. `scripts/enrich_games_from_opdb.py` joins games by IPDB ID and fills missing values without overwriting existing values.
- OPDB data is fetched at runtime by the new-game/image helpers, but the repository has no routine downloader or scheduled import for the full catalog. `docs/pintips.md` mentions the OPDB V2 export as an implementation reference; it is not currently a recurring dependency.
- `data/pinballmap-location-8908-activity.json` is a separate snapshot of 314 submissions for the club's Pinball Map location, dated through April 2026. `scripts/Refresh-PinballMapLocationActivity.ps1` can refresh it in full or incremental mode; `scripts/merge_pinballmap_into_games.py` uses it to maintain our club location stints and related floor history. It is not a global historical game catalog.
- The existing one-off web fetch path is a poor source-ingestion mechanism: it depends on remote pages permitting automated requests, and has already encountered 403/429 responses. Structured bulk/API feeds are a better fit for catalog data.

## Recommended source roles

| Source | Use it for | Keep out of the source's authority |
| --- | --- | --- |
| OPDB V2 full export | Primary machine identity and cross-reference catalog: OPDB IDs, aliases, manufacturer, type, display, player count, manufacture date, and images/metadata when present | Club-specific title corrections, descriptions, ownership, notes, or Pinball Map floor state |
| Kineticist read API | Supplemental game-level fields, editions, credits, and a second candidate for resolving missing or conflicting OPDB facts | Bulk replacement of OPDB identity or club-authored fields; full-database replication beyond its API terms |
| Pinball Map location API/activity export | Current lineup and our club's location/machine activity history | Canonical global game identity or a replacement for OPDB's catalog |
| Operator notes and verified references | Human-approved corrections and evidence for club descriptions | Unreviewed commands or instructions embedded in pasted source text |

OPDB explicitly recommends its full export for consumers that need the catalog rather than repeatedly calling its API. Kineticist exposes paginated game and machine read endpoints, supports OPDB ID lookups, and includes editions on detail responses. Its documentation requires visible attribution for displayed data and says not to scrape its full database to build a competing catalog. So the proposed use is targeted enrichment through the API, not a second full mirror. OPDB's coverage is powered-flipper pinball, so it does not replace broader historical sources for flipperless games.

## Proposed ingestion design

1. **Acquire and preserve source snapshots.** Add a scheduled/manual OPDB V2 download job that writes to a temporary file, validates HTTP status, JSON shape, record counts, and required identifiers, then atomically publishes the snapshot with `fetched_at`, source URL, schema/version, and checksum. Retain the prior known-good snapshot on failure. Avoid committing a routinely changing full JSON file into the application bundle; store the snapshot in a durable object store or database staging area.
2. **Normalize into source-owned tables.** Store source records and crosswalks separately from `games`. Keep the original source payload (or a compact raw snapshot) for auditability. Crosswalk by OPDB group/machine/alias IDs and IPDB IDs, then use title/year/manufacturer matching only as a review queue, never as an automatic destructive merge.
3. **Reconcile into club games with explicit provenance.** Record each candidate value with source, source record ID, fetch time, and status. Classify proposals as `add`, `update`, or `conflict`; show old value and proposed value side by side. Default to filling blanks. Never overwrite club-confirmed values without an operator choice. Distinguish club-owned content (public title/slug/description, notes, floor overrides) from source-owned facts and read-only imported identifiers.
4. **Use Kineticist selectively.** First resolve a local game through OPDB ID or an explicit verified Kineticist URL/ID. Query its structured game/machine endpoint for missing fields or a meaningful disagreement, cache the response, apply rate limits, and retain attribution/provenance. Don't make public-page scraping or the MCP interface a production ingestion dependency; MCP is helpful for ad hoc exploration, while the REST API is more predictable for the application.
5. **Keep Pinball Map history as its own feed.** Continue its existing snapshot process for location-level history. Store that history separately from source catalog facts, then link it to the club game via Pinball Map machine ID/OPDB crosswalk where available. Refreshing the activity feed must never create or replace the global games catalog implicitly.
6. **Make sync reviewable and safe to rerun.** Start with a dry-run report: source record counts, linked/unlinked games, proposed adds/updates/conflicts, stale links, and dropped/changed identifiers. Add an operator-approved apply step and an audit log. Make the process idempotent and keep a rollback/export path.

## Rollout sequence

1. Inventory staging versus production games and current OPDB/IPDB/Pinball Map identifiers. Compare the staging catalog to the known production and historical sources before importing anything; preserve both copies and produce a diff first.
2. Prototype the OPDB V2 downloader/validator and reconciliation report without writing to the live game table.
3. Review match quality on a representative sample, including aliases/remakes/editions and older games; then run an approved fill-only import in staging.
4. Add Kineticist targeted lookups for unresolved or conflicting fields with attribution and cache behavior.
5. Once reconciliation and rollback are proven, schedule catalog refreshes and surface source freshness/errors in the Integrations area.

## Games editor usability direction

The edit path should keep title, club-owned metadata, third-party links, operator context, and our description work easy to find. Location stints, sale listing, high scores, custom mods, and Pingolf targets are now grouped under a collapsed **More game tools** section. Soft-delete/restore controls are in a separate collapsed **Game administration** section. This preserves those capabilities while reducing the initial visual weight of editing a game's identity and description.

The next design pass should make field ownership explicit: source-imported identifiers/canonical names are read-only with provenance, club-maintained values are editable, and proposed source corrections appear as reviewable changes rather than silently changing form inputs. The description assistant should follow metadata review and use operator-provided context; it should not depend on third-party pages being scrapeable.
