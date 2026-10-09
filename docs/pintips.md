# PinTips imports and game-card Tips tab

## Source and matching

Reviewed 2026-10-08:

- [Official data exports](https://docs.matchplay.events/data-exports) recommend bulk exports instead of APIs.
- [API guidance](https://docs.matchplay.events/api) requires server-side storage and one fetch on behalf of all users, and explicitly directs OPDB/PinTips users to the CDN.
- [OPDB identifier specification](https://docs.matchplay.events/opdb-and-pintips-api) documents `Ggroup`, `Ggroup-Mmachine`, and `Ggroup-Mmachine-Aalias`.
- [PinTips JSON](https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-pintips.json) is a top-level array. The inspected export contains 3,477 rows, each with `tipId`, `opdbId`, `category`, `voteTotal`, `text`, `createdAt`, and `updatedAt`. Every `opdbId` is a group ID. There are no contributor names or IDs in this export. We show source credit and a source link, without inventing individual credit.
- The [OPDB V2 export](https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-v2.json) confirms that the documented group prefix equals `opdbGroup`, including aliases. It was downloaded for implementation verification only; it is not another runtime dependency.

The importer fetches the fixed PinTips CDN URL **once per accepted refresh**, never per game. Browsers call `snh_public_game_tips(game UUID)`, which joins the imported group to the current catalog's parsed OPDB ID. IDs are case-sensitive and must match the complete documented grammar. No title matching, manual fuzzy mapping, or edition guessing occurs. Group tips are shared across machines/aliases in that group; upstream edition-specific prose is preserved verbatim. Future machine-specific tip IDs fail validation rather than being broadened to the group.

Against the checked-in 126-game catalog, 115 games match tips. Major League and Play Boy lack OPDB IDs. Nine have valid current OPDB IDs but no tips in this export: Diamond Lady, Disco Fever, Hot Shot, Joust, Lightning Ball, Metallica (Pro), Monte Carlo, Mr. & Mrs. Pac-Man, and Mustang. All 124 supplied IDs exist in the inspected OPDB export. These are snapshot observations, not hardcoded exceptions. Removed/moved OPDB IDs are not automatically redirected; catalog corrections must be made through the existing catalog workflow. Operations reports current missing/invalid IDs and unmatched counts after each import.

## Data, security, and failure behavior

- `public.pintips` is dedicated imported content, keyed by upstream `tipId`. Editable game fields and club-authored Play content are never changed.
- RLS is enabled and direct client access is revoked. Explicit service-role grants permit imports; a narrow public read RPC returns tips only for an existing, non-deleted game.
- The UI uses the existing accessible tabs. Text is assigned with `textContent`, preserving newlines and wrapping long text; HTML and Markdown are not executed. Empty, loading, and failure states are separate.
- `pintips-import` verifies the user JWT and calls the existing `snh_member_has_games_admin_access()` capability using that JWT. Games Admin and Website Administrator can use **Member Tools → Games → Refresh PinTips now**. Games Editor cannot import. A public API key alone grants no access.
- Daily calls use a separate `PINTIPS_IMPORT_SCHEDULER_SECRET`, compared using the shared timing-safe authorization helper. Pinball Map's secret/header cannot authorize this importer. Gateway JWT verification is disabled only because the function verifies these two authentication paths itself.
- A service-only begin RPC serializes refreshes, rejects concurrent work, and enforces 30 seconds between attempts. A five-minute lease fences late workers. A later refresh marks abandoned jobs failed.
- Download, UTF-8/JSON/schema validation, duplicate IDs, empty exports, and a 20 MB size limit are checked before publishing. Source timestamps are retained as timezone-free timestamps because the export does not specify a timezone.
- A single database transaction stages the complete snapshot, upserts changed/new tips, removes upstream-deleted tips, and records success. Validation or database errors roll back the entire transaction. A separate failure RPC records the error while preserving the last successful tips and timestamp.
- No raw Storage object is needed: the complete normalized export is retained in the dedicated table, including tips outside the current catalog. This avoids a second storage write that could disagree with the committed snapshot. A repeated identical import creates no duplicates and reports zero added/changed/removed tips.
- Existing `integration_status`, `operations_job_runs`, and `audit_log` record attempts, verified manual actors, completion timestamps, errors, latency, and reconciliation/matching counts. Website Administrators can inspect **Operations → Integrations / Jobs**. Successful refreshes clear the current error summary and retain historical job results.

## Deployment (review required; not performed by this change)

Migrations:

1. `20261007130000_pintips.sql`: tips table, grants/RLS, read RPC, fenced import RPCs.
2. `20261007131000_pintips_schedule.sql`: private Vault-backed invocation and named daily cron job, `snh-pintips-import-daily`, at **07:20 UTC**.

Use the linked Supabase project and existing CLI authentication. Provision matching, independently generated random values in:

- Edge secret: `PINTIPS_IMPORT_SCHEDULER_SECRET`
- Vault secret: `snh_pintips_import_scheduler_secret`

The scheduler reuses the project's existing Vault entries `snh_pinballmap_ingest_supabase_url` and `snh_pinballmap_ingest_anon_key`. The latter is only a gateway header. Do not replace the Pinball Map scheduler secret. Existing `pg_cron`, `pg_net`, Vault, operations tables, and Games capability migrations must already be present.

Store the Edge secret in a private file outside the repository (example content `PINTIPS_IMPORT_SCHEDULER_SECRET=<generated value>`), then run:

```sh
npx supabase link --project-ref <project-ref>
npx supabase secrets set --env-file /secure/path/pintips-secrets.env
npx supabase functions deploy pintips-import
npx supabase functions deploy operations
npx supabase db push --dry-run
npx supabase db push
npx supabase migration list --linked
```

Deploying the function before its migration is safe: it fails closed until the RPCs exist. Create the matching named Vault secret through the project's existing secure provisioning process before the daily job runs. Never commit or paste its value into logs. Missing Vault configuration records an actionable failed job without changing tips. The ordinary frontend PR deployment includes the Tips UI; no visitor-side token or new public configuration is needed. Existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and backend service-role/secret-key settings remain in use.

After deployment, use the Games refresh button for the first import, inspect Operations counts, and open a known matched game and a game without tips. To inspect scheduling in SQL:

```sql
select jobid, jobname, schedule, active from cron.job where jobname='snh-pintips-import-daily';
select * from public.integration_status where provider='pintips';
select started_at, finished_at, status, result, error
from public.operations_job_runs where job='pintips_import' order by started_at desc limit 10;
```

For scheduler transport/auth failures, also inspect `cron.job_run_details`, `net._http_response`, and Edge Function logs. The private invoker cannot observe an asynchronous HTTP result itself. Do not expose response headers or Vault values in public reports. If a job remains `running` beyond five minutes, retry; the new attempt marks it failed and takes a fresh lease. For a complete pause, disable the named cron job with `cron.alter_job(jobid, active := false)`; existing tips remain available. No production migration, secret change, schedule activation, merge, or production deployment was performed during implementation.

## Local validation

```sh
npm ci
node --test scripts/pintips-provider.test.mjs scripts/pintips-db.test.mjs scripts/pintips-edge.test.mjs
node --test scripts/pinballmap-ingest-auth.test.mjs scripts/operations-edge.test.mjs scripts/operations-panel.test.mjs scripts/games-contextual-edit.test.mjs scripts/pingolf-ui.test.mjs scripts/member-view-acceptance.test.mjs scripts/external-api-cache.test.mjs
```

The database tests use isolated PGlite PostgreSQL, including real grants/RLS, group/machine/alias matches, deleted/missing games, repeat imports, changed/removed tips, invalid snapshots, transaction rollback, stale workers, catalog corrections, and preservation of club-authored text. Edge tests verify actual handler ordering and authorization, single downloads, concurrency rejection, and failure recording. Hosted cron execution remains a post-deployment check.

Optional browser validation (Playwright is temporary tooling, not an application dependency):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/pintips-browser-check.mjs
```

This serves the real page locally with fixture RPC responses and blocks external requests. It verifies populated/empty/error states, source and optional contributor credit, inert HTML-like text, preserved line breaks, keyboard navigation, and layouts at 1280px, 375px, and 320px. Screenshots are written to ignored `temp/pintips-qa/`. Desktop and mobile screenshots were visually inspected. Scheduler SQL is exercised with local Vault/pg_net/pg_cron stand-ins; this does not claim a hosted cron run.
