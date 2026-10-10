# Operations

Operations is a club-admin-only section of My Account, with Overview, Integrations,
Cache, Messaging, Jobs, and Audit. Legacy Audit links redirect into Operations. Section and message-status
links survive refreshes and can be shared. Ordinary member
management remains in Member Tools; self-delete remains in My Account.

## Implemented

- Overview aggregates cache row counts, expired/search-cleanup counts, unresolved
  integration request errors, queue counts, and the latest run of each job.
- Integrations shows current server configuration booleans, per-resource attempt,
  success, error and latency, and a conservative provider summary. Match Play has
  Test Connection using its uncached profile endpoint; the response is discarded.
  Historical errors remain visible after recovery. “Last request succeeded” does
  not claim that a provider is currently healthy. IFPA is not connected; Pinball
  Map ingestion now records authorized attempts, completions, committed changes,
  manual actors, safe failures and image warnings. Its configured state reflects
  the required provider token, not a live connectivity test.
- Cache edits persist in `external_api_cache_policies`. Only known provider/policy
  pairs and integer seconds from 1 to 604800 are accepted. Reset deletes an override.
  The additive migration removes seeded values equal to the original defaults,
  preserving customized values. `private.snh_cache_defaults()` defines the displayed
  defaults, matching adapter fallback values documented in `external-api-caching.md`.
  Future changes must update both and keep the agreement tests passing.
- Each provider has a `force_refresh_minimum` policy (default 30 seconds), read by
  the shared cache helper on forced requests. This is a successful-fetch freshness
  guard, not a distributed refresh lock. TTL edits affect future fetches only.
  IFPA, standings and Pinball Map policies are reserved until those adapters exist.
- Cleanup removes only search rows expired more than seven days ago, retaining
  recent stale fallback data and all event/results rows. The confirmation names
  that scope. Both Cache and Jobs call the same audited RPC.
- Messaging shows counts and pages of 50 records, filterable by status, including
  recipient, kind, subject, created/available/sent times, attempts and safe errors.
  Pagination uses `(created_at,id)`. Bodies and provider response payloads are omitted.
- Retry locks the failed row, retains ID/content/recipient/attempt count and the
  original creation time, and grants one claim beyond the automatic attempt cap.
  Only failed rows younger than 23 hours, without a provider ID or active lease,
  qualify. The worker still enforces the original 24-hour delivery deadline,
  provider idempotency key, and enqueue-time recipient authorization. A second concurrent retry
  fails because the first changes the state. Expired exhausted leases become failed
  rather than permanently stuck in sending. Old messages are never re-created.
- Jobs uses a generic `operations_job_runs` ledger. The dispatcher records start,
  completion, counts and a fixed safe failure summary in every delivery mode.
  Cleanup records both successful and failed runs. A nested transaction rolls back
  deletions on failure, retaining a safe error and an audit entry. Its existing bigint
  API returns a nonnegative removal count on success and -1 on failure; scheduler
  callers must treat -1 as failure. Failures that prevent recording the run or audit
  itself still fail the whole transaction. Unfinished worker runs remain
  explicitly “running”, with a warning that completion is unknown.
- Run Now uses the existing dispatcher secret exclusively server-side. It audits
  the authenticated actor before invoking the worker, and uses the configured
  preview/test/live mode. Preview does not claim mail; test sends only to the test
  inbox; live processes up to ten messages. No preview message body is forwarded
  through the Operations endpoint. An HTTP timeout leaves the run outcome unknown;
  inspect Jobs before trying again.

All browser RPCs check `club_admin` server-side with a fixed empty search path.
The Operations Edge Function independently validates the session and club-admin
membership before configuration or provider access. All exposed mutations write
`module = operations` audit entries; database changes and their audit records are
atomic. Connection tests record integration status without creating audit noise.
Raw cache data, credentials, dispatch secrets and message bodies are not exposed.

## Deployment and migration safety

Baseline: main at `1c8c6b8` (caching PR #111). Linked migration history was inspected
and matched local migrations through `20260928150000`. No historical migration is
rewritten. This change adds `20260928160000_operations.sql`.

1. Recheck `supabase migration list --linked` from the target checkout before deploy.
2. Apply the new migration using the normal reviewed migration workflow.
3. Deploy `notification-dispatch`, `matchplay-event-review` (shared cache policy
   change), and the new `operations` Edge Function. Deploy the migration first:
   the updated dispatcher deliberately refuses to send if recording its run fails.
4. Deploy the frontend. The Netlify PR preview includes frontend changes only;
   it cannot exercise the new RPCs before the migration/functions are deployed.
5. Verify an ordinary member cannot access any Operations endpoint, a club admin
   can load sections, and policy save/reset appears in Audit Log. Use preview mode
   or a staging queue to verify Run Now without delivering real messages.

No hosted migration, function deployment, scheduler change or production mutation
is performed by the PR build. Existing scheduling continues invoking the dispatcher
and `cleanup_external_api_search_cache()` as before. Scheduler configuration and
next-run times are not inferred from run history.

## Deliberately deferred

Tournament standings, IFPA adapters, arbitrary
cache purges/refreshes, dangerous account tools, scheduler editing/next-run reporting,
provider delivery webhooks, job-run history pagination/retention, and richer cache
hit/miss metrics. The generic job ledger accepts future server-side job names;
unknown jobs appear without a manual action.

## Verification

`operations-db.test.mjs` executes both foundation migrations and the new migration
in PostgreSQL/PGlite. It tests anonymous and non-admin denial, override preservation,
validation/reset, atomic audit rollback, retry eligibility/leases, and cleanup scope.
`operations-edge.test.mjs` tests authorization before provider access, secret-safe
configuration, safe connection errors, audit-before-dispatch and preview-mode run
recording. `operations-panel.test.mjs` exercises section changes, policy save/reset,
retry confirmation and disabled-state recovery. The cache suite checks the tunable
forced-refresh boundary. Run the full preview build and Deno check before release.

## Finishing pass

`20260928170000_operations_cleanup_failures.sql` adds failure tracking without editing
an applied migration. Apply it before using the updated cleanup result messages.
Deploy the updated `operations` function for mode-specific dispatcher results.
Cache policies show readable durations, unused-policy labels, and Save/Reset buttons
that are disabled when unchanged. Overview shortcuts open failures, cache, jobs, and
integrations. Audit retains its filters, pagination, automated toggle and access rules.

Acceptance verified on the signed-in PR preview: an unused IFPA event policy was
saved and reset to its original default, both audit records appeared under Operations,
legacy `panel=audit-log` redirected to `panel=operations&section=audit`, Match Play
Test Connection succeeded, and the failed-message filter survived reload. A 390px
viewport showed no page-level horizontal overflow. No messages were dispatched.
The cleanup-failure migration and updated Operations function have been deployed.
