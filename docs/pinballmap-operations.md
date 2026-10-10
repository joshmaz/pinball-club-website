# Pinball Map in Operations

Integrations shows the last attempt, last successful completion, last manual
invocation and verified actor, schedule status/cadence, and the last import that
changed data. Jobs shows the latest ten runs and Run Now, using the same existing
`pinballmap-ingest` endpoint and Games authorization as the Games tools.
Operations remains Website Administrator-only.

Changes count actual committed records in games, location history, imported
conditions and images. Reprocessing identical records, including image upserts,
counts zero. Expandable details retain at most 100 record summaries per run,
including game names, game links and changed field names, with total counts
retained beyond that cap. Old/new values and provider payloads are not stored in
job results. A later no-change run does not replace the last meaningful change.
Several categories can describe the same game; counts are records, not distinct
games. Transaction-local comparisons exclude timestamp-only updates.

The existing merge RPC implementations are preserved as private functions.
Public service-only wrappers record their actual changes in the same transaction
as the import. Existing callers without a run ID retain their previous behavior.
The dedicated tracked image wrapper is used only by this ingest; other OPDB
imports keep their existing behavior. Run completion is recorded after all stages.
Image refresh failures remain nonblocking warnings. A later condition failure
retains and reports previously committed catalog/image changes.

Concurrent/rapid repeated imports return a conflict before fetching. A run that
never records completion displays Completion unknown after ten minutes. The next
authorized attempt marks that stale run failed before starting a replacement.
Fetches share a four-minute deadline, and hitting the activity pagination cap
fails rather than silently importing an incomplete activity history.

## Schedule and notifications

The existing six-hour UTC cron schedule is neither recreated nor changed.
Operations reads enabled state and cadence from its actual scheduler row. For
the standard `0 */6 * * *` schedule only, it calculates the next invocation and
shows a possible-overdue indicator after seven hours without a completed success.
A disabled or unknown/custom schedule does not produce a speculative overdue
indicator. No successful run yet is shown explicitly. The next timestamp is a
schedule estimate, not a promise that a worker will run.

Missing Vault configuration records a failed scheduled invocation without
exposing secret values. Queuing an HTTP request is not counted as import success.
Failures before the authenticated worker starts (gateway rejection, invalid
scheduler credential, unavailable runtime/database) cannot reliably create a run.
The last-success timestamp and overdue indicator help reveal that gap. There is
no independent watchdog, polling, automatic retry, log query, or overdue email.

The first recorded failure in an episode queues one notification per distinct
Website Administrator email using `notification_outbox`. Further failed runs do
not enqueue more alerts until a completed successful run resets the episode.
Success with an image warning counts as successful. Alerts link to Operations
Jobs and contain a safe stage summary, not raw provider/database errors. Existing
dispatcher preview/test/live controls, retries and delivery deadlines apply:
queued does not mean sent, and preview/test never consumes real alerts. Recipient
authorization follows the queue's existing enqueue-time rule.

## Deployment

1. Apply `20261009010000_pinballmap_operations.sql` through the reviewed migration
   workflow. It extends the queue kind constraint and adds the service-only
   tracking functions and administrator-only read RPC.
2. Deploy `pinballmap-ingest` and `operations` Edge Functions.
3. Deploy the frontend. Frontend previews alone cannot enable backend tracking.
4. In Operations, verify schedule status, run one authorized manual import, then
   repeat after at least 30 seconds and check zero actual changes for identical
   source data. Confirm an ordinary member cannot read Operations data.
5. Verify a scheduled invocation and alert delivery using the existing notification
   preview/test mode before relying on live alerts. No new secrets are required.

History begins when tracking is enabled; old audit entries are not reconstructed.
The ledger retains its existing history policy, with only ten runs loaded in the
UI. If the Pinball Map read RPC is unavailable, other Operations sections still
load and show a specific import-information error.

## Local verification

`pinballmap-operations-db.test.mjs` exercises the real catalog, condition and image
import implementations with PostgreSQL/PGlite: actual changes, idempotence,
transaction rollback, partial failure, manual attribution, scheduler skips,
configuration absence, administrator access and deduplicated failure notifications.
Existing worker/auth tests cover rejected requests before side effects, verified
actors, failure/warning completion, conflicting runs and completion-record failures.
Panel tests cover overdue/disabled schedules, changes, game links and Run Now.
