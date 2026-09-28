# External API caching

## Agreed architecture

All credentialed provider requests go through our server/Edge Functions. Browsers
receive application-shaped responses, freshness metadata and safe errors; credentials
and raw responses remain server-side. A generic cache supports many future platforms
without adding a table per provider. Adapters validate provider responses and normalize
at the adapter/application boundary. Retain raw-ish responses in JSONB, excluding
secrets and unnecessary sensitive fields.

`external_api_cache` is keyed by provider, resource type and cache key, and stores
payload, fetched_at and expires_at (timestamptz). Separate API requests are separate
resources: Match Play event metadata and standings must not share a row.
`integration_status` is separate from cached content and records last attempt,
success, error, a safe error summary, and the latest completed request's latency,
per provider/resource type. Hits do not count as provider attempts. Historical error
time/summary remains after recovery; compare success and error times. Under concurrent
requests this is approximate operational status, not an ordered audit trail.

## Freshness defaults

| Provider/resource | TTL |
| --- | --- |
| Match Play search/discovery | 30 minutes |
| Match Play upcoming event | 2 hours |
| Match Play active standings | 2 minutes |
| Match Play completed event/results | 24 hours |
| IFPA event | 6 hours |
| IFPA rankings/results | 6 hours |
| Pinball Map data | 12 hours |

Policies live in `external_api_cache_policies` and are read when storing a new
response. A policy change affects subsequent fetches, not existing expiry times.
Operations will eventually expose these settings via an authorized admin endpoint;
no browser has direct access to cache, status or policy tables in v1.

Normal reads use unexpired data. Check Standings will force a refresh unless the
resource was successfully fetched in the previous 30 seconds. The shared helper
implements this rule with `force: true`; the standings endpoint/UI is future work.
If a provider request or validation fails and cached data exists, return stale data
with its original last-updated time and a visible refresh-failed message. Without
cached data, report the error. There is no maximum stale age in v1. Cache database
failures currently fail the request; observability writes are best effort.

## Keys and isolation

Normalize validated request inputs before building paths (trim title input, validate
IDs, supply explicit pagination defaults). Canonicalize URL encoding and sort query
parameter names, then SHA-256 hash the path and complete parameter set. Preserve
case and meaningful whitespace, pagination and filters rather than assuming provider
search semantics. Version keys when response shape or request semantics change.

The first Match Play adapter partitions keys by a SHA-256 credential fingerprint,
so changing credentials cannot expose an earlier token's cached resources. No token
is persisted. The profile request remains uncached because it identifies the token
owner. Future providers must explicitly choose public, account or tenant scope and
review sensitive fields; never reuse private responses across authorization scopes.

## Retention and operations

Initially clean up only search/discovery rows. The service-only
`cleanup_external_api_search_cache()` removes search rows expired more than seven
days ago, retaining a useful stale fallback window. Invoke daily using the existing
operations scheduler after deployment; this PR does not install a new cron job.
Event/results rows remain retained. Revisit retention as volume becomes measurable.

Future observability: cache hits/misses, request counts, refresh failures, stale serves,
provider rate limits, latency distributions and per-platform health. Add dedicated
aggregates/events with retention and access controls; do not infer these from the
latest status row. Future work also includes distributed refresh leases, a failure
cooldown, retry/backoff and background refresh. Concurrent misses may make duplicate
provider calls in v1; the 30-second rule is not a distributed lock.

## Implementation and rollout

Inspected main after PRs #109 (single-tournament JSONB lookup) and #110 (CLI dependency).
No open PRs were present during inspection. Preserve those changes and all existing
migration files. New migration `20260928150000_external_api_cache.sql` sorts after
`20260927010000_cleanup_repeated_event_urls.sql` and adds only new objects.

1. Apply the additive migration through the normal reviewed Supabase migration path.
   Compare remote migration history before deployment; do not repair or renumber
   deployed migrations automatically.
2. Deploy `matchplay-event-review` with shared cache and adapter modules. Existing
   event-editor authorization remains before all cache reads. Discovery and event
   lookup now return an additive `cache` object; UI displays last-updated information
   and stale fallback notices. The recent linked-event JSONB fix is preserved.
3. Verify a miss, hit and provider-error stale fallback with the deployed service.
   No production database or Edge Function is changed by this PR itself.
4. Schedule search cleanup; add Operations policy/status controls with existing
   club-admin authorization and audit conventions.
5. Build the standings endpoint and Check Standings UI, then IFPA and Pinball Map
   adapters. Existing Pinball Map ingestion is intentionally unchanged.

Current event metadata uses two hours for non-completed events; live standings will
have its own two-minute policy. Completed payloads use 24 hours. Tests cover cache
expiry, forced refresh boundary, stale fallback, key normalization, adapter behavior,
SQL grants/cleanup, and the existing Match Play lookup flow. Rollback the function/UI
if needed; the new tables can remain without affecting existing features.

Remaining rollout choices: daily cleanup scheduler ownership and Operations UI design.
No further architecture decision is required for the implemented foundation.
