# Public snapshots

Supabase is authoritative for Games and Events. Their committed JSON files are
public snapshots for static mode and temporary database failures, not database
backups. The refresh command performs GET requests only and never changes the
database, authentication, storage, or permissions.

## Refresh and check

```bash
node --env-file=.env scripts/snapshots.mjs refresh
node scripts/snapshots.mjs check
node scripts/snapshots.mjs check --max-age-days=7
```

Refresh requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The latter must be an anon
JWT or a publishable key. Service-role keys are neither selected nor accepted:
exports must respect public RLS. Events additionally uses the same published
filter as its public page; the Games public view excludes soft-deleted games.
Only the public Event fields used by cards are selected.

The exporter paginates with stable ordering and exact row counts, including when
the server caps pages below the requested size. It fetches and validates both
datasets before writing either one. Each file is replaced via a temporary file
and rename; the pair is not a database transaction. A network/schema failure
leaves both previous snapshots intact. Changes made during a multi-page read are
not transactionally isolated; retry if pagination consistency checks fail.

Review generated diffs and commit them through a PR. The single-dataset exporter
filenames remain compatibility wrappers around the same implementation.

`check` is offline. It validates metadata, record shape, IDs, dates, and duplicate
IDs. Snapshots older than seven days warn by default. An explicit
`--max-age-days=N` makes the age threshold a failure. Both AWS and Netlify builds
run validation, but intentionally do not fail solely because a snapshot aged:
scheduled refresh and CI freshness enforcement belong to the next PR.

## Snapshot contract (version 1)

```json
{
  "_meta": {
    "schemaVersion": 1,
    "dataset": "events",
    "source": "events",
    "generatedAt": "2026-09-21T00:00:00.000Z",
    "recordCount": 0
  },
  "events": []
}
```

Games uses `dataset: games`, `source: games_catalog_v1`, and a `games` array.
Events records retain UUID `id`, `title`, UTC calendar `date` (or `TBD`),
`location`, `description`, `url`, and `source`. The mapping uses `starts_at` and
`external_url`; it does not query removed legacy columns. Game objects retain
the public view's existing structure, including UUIDs and primary-image data.

`assets/js/public-data.js` owns the shared browser/export validation contract.
Readers accept legacy `{ games: [...] }` and bare Events arrays during rollout;
those have unknown freshness. Newly generated files and build-time checks require
versioned metadata and valid UUIDs. The Events duplicate checker and legacy import
reader accept both Events shapes. Legacy import scripts are migration tools, not
round-trip database restore commands.

## Runtime source rules

- Events attempts Supabase first. Games and the homepage game gallery do so when
  `GAMES_CATALOG_SOURCE=db`; explicit JSON mode reads the saved snapshot.
- A successful database response, including an empty array, is authoritative.
- Missing clients, rejected queries, network errors, or invalid live records may
  use a validated snapshot. Invalid or unavailable snapshots produce the existing
  failure state instead of silently presenting malformed content.
- Results identify their source as `supabase`, `static-fallback`, or `static`.
- Games and Events show the snapshot save date and warn if freshness is unknown
  or over seven days. The homepage game carousel shares the same loader.
- UUIDs survive fallback, so authorized contextual Edit links still work.

A snapshot can temporarily contain a subsequently deleted or unpublished record.
It is public data at generation time, not an immediate revocation mechanism. This
PR avoids resurrecting snapshots after valid empty queries; it cannot guarantee
current data during an outage. Automated refresh is the next mitigation.

## Other JSON files

- `data/highlights.json` is an intentionally curated photo fallback, not an export
  of all albums. Its existing fallback behavior is unchanged, including curated
  content when no eligible dynamic highlights exist. Gallery ownership/redesign
  should decide whether to replace it with an automated public photo snapshot.
- `data/resources.json` is authoritative static content, not database redundancy.
- `data/latest-opdb.json` and Pinball Map activity JSON are maintenance inputs.
  They are not runtime fallbacks and are excluded from the Netlify publish build.
- Historical Markdown/Facebook import scripts are not snapshot refresh tools.
  Do not use them to overwrite the generated `data/events.json`; export from
  Supabase after intentional import work.

## Next separate PR

Add manual/scheduled refresh automation that opens a snapshot-update PR, reports
export/validation failures, and applies an agreed freshness threshold. No workflow
in this foundation PR automatically refreshes data or writes directly to `main`.

Event snapshots now preserve the canonical `starts_at` timestamp. Cards use it
for both local date and time, matching the editor's browser-local conversion;
`date` remains available for older date-only snapshots. Existing snapshots without
`starts_at` keep showing “Time not listed” until refreshed. The legacy migration
and JSON importer encoded date-only values as midnight UTC, so cards preserve
those UTC calendar dates without claiming a known time. The current schema cannot
distinguish a genuine midnight-UTC start from that placeholder; resolving that
ambiguity requires explicit time precision metadata. Local midnight at other UTC
offsets remains a known time. No separate presentation `time` field is used.

### Historical time recovery

See `event-time-recovery-proposal.md` and its JSON companion for the September 25,
2026 review set. This is a proposal, not a migration: no database updates have
been applied. Regenerate it with:

```bash
python3 scripts/prepare-event-time-recovery.py /path/to/event-audit.json docs/event-time-recovery-proposal.json
```

The input audit contains `checkedAt` and an `unknown` array of public event rows.
Monday league and Wednesday knockout defaults use the user's confirmed 7:30 PM
America/New_York rule; off-weekday exceptions remain for review. Verified source
times are identified separately. Any eventual application must update by UUID,
compare the old timestamp, modify only `starts_at`, and record applied changes.
Do not run the legacy bulk upsert for recovery: it can overwrite descriptions,
publication state, and other edits. Refresh the public snapshot after recovery.

Both Facebook importers now retain explicit offset-bearing start timestamps as
`starts_at`; the database JSON importer prefers that canonical value over `date`.
Date-only source data still uses the documented legacy placeholder. Ambiguous
full timestamps without a timezone offset are rejected instead of guessed.
The legacy import key retains the original calendar date when available so a
winter evening's UTC date rollover does not change its deduplication identity.
