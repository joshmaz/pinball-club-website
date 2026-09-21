# Audit Logging Design

This note captures the current audit-trail approach for SNHPC and why it scales as new modules are added.

## Current coverage

Games and photos write to the shared `public.audit_log` through privileged database
functions. Event create, update, publish, unpublish, and delete operations are
recorded by `trg_events_audit_change` on `public.events`. The event trigger covers
both browser editor writes and service-role imports; it runs in the same
transaction as the event mutation. Event updates record changed fields only,
excluding operational timestamps. A service-role import has no member actor, so
its audit row records the authentication role and the event's `source` field in
metadata.

Role grants/revocations and membership status, tier, and end-date changes are
recorded by triggers on `member_roles` and `memberships`. Those logs include the
target member ID, acting auth user when available, and only the relevant
administrative fields. No profile or contact fields are copied into these logs.

Member profile and external-account mutations are recorded separately with the
actor, target member ID, action, and changed field names. Personal values such
as names, email, profile handles, and profile URLs are intentionally omitted.
The current profile save flow writes the member and external accounts in
separate requests, so their audit entries may be separate even for one save.

`snh_audit_history_for_admin` exposes up to 100 entries at a time to
`club_admin` only. It supports module filtering and cursor pagination; the
Member Tools panel presents 50 entries per page. The underlying table remains
unreadable by ordinary API roles. Audit history is a record of changes, not a
rollback tool.
The new triggers record changes made after their migrations are applied; they
do not reconstruct older event or member edits.

## Migration verification

After applying the migrations in timestamp order, use a club-admin account to
edit and restore one low-impact event field. Confirm that **Member Tools → Recent
changes** shows both entries with the expected actor and changed field. If a
test member account is available, grant and revoke a non-admin role through
Member Tools, then confirm those actions appear.
Check that a non-club-admin account cannot call
`snh_audit_history_for_admin`, even if it can open Member Tools. Avoid testing
with production member profile values because audit checks do not need them.

This is change history, not a record of page views or sign-ins. Other write
paths and retention still need review before calling the website audit-complete.

## Core idea

Use one shared audit table with a `module` identifier (for example `photos`, `members`, `events`) and JSON payloads describing what changed:

- `old_data` (`jsonb`): previous values before the change
- `new_data` (`jsonb`): values after the change

This avoids creating a different audit table per feature area. New modules can be onboarded by adding a module type and writing module-specific payloads.

## Recommended audit record shape

Required columns:

- `id` (`uuid`) unique log record id
- `created_at` (`timestamptz`) when the change happened
- `module` (`text`) domain area (`photos`, `members`, `events`, ...)
- `action` (`text`) operation (`create`, `update`, `delete`, `publish`, ...)
- `actor_user_id` (`uuid`) auth user that performed the action (if known)
- `entity_type` (`text`) object type inside module (`album`, `member_profile`, `event`)
- `entity_id` (`text`) identifier of the changed object
- `old_data` (`jsonb`) previous state (or changed subset)
- `new_data` (`jsonb`) new state (or changed subset)
- `metadata` (`jsonb`) request context (`ip`, `user_agent`, source page, reason code)

Optional but useful:

- `request_id` (`text`) correlate multi-row writes from one request
- `actor_email` (`text`) denormalized snapshot for easier audit review

## Why JSON payloads are the key

Each module evolves differently. JSON payloads let each module store only relevant fields without schema churn:

- `members` update can include `display_name`, `ifpa_player_id`, `stern_insider_username`
- `events` update can include schedule, location, capacity, registration policy
- `photos` update can include image url, caption, attribution, ordering

As modules grow, no audit table migration is required for every new tracked attribute. The log contract stays stable while payloads remain module-specific.

## Example payloads by module

`members` profile update:

- `old_data`: `{ "display_name": "Josh", "ifpa_player_id": "12345" }`
- `new_data`: `{ "display_name": "Josh M", "ifpa_player_id": "12345", "stern_insider_username": "player123" }`

`events` publish:

- `old_data`: `{ "status": "draft" }`
- `new_data`: `{ "status": "published", "published_at": "2026-04-28T21:10:00Z" }`

`photos` reorder:

- `old_data`: `{ "album_id": "abc", "order": [3,1,2] }`
- `new_data`: `{ "album_id": "abc", "order": [1,2,3] }`

## Suggested SQL starter

```sql
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  module text not null,
  action text not null,
  actor_user_id uuid null references auth.users(id),
  entity_type text not null,
  entity_id text not null,
  old_data jsonb not null default '{}'::jsonb,
  new_data jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_id text null
);

create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);
create index if not exists audit_log_module_idx on public.audit_log (module, created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at desc);
```

## Operational guidance

- Write audit rows server-side (RPC/function/backend), not directly from browser clients.
- Keep module/action names consistent and lowercase.
- Prefer storing only changed fields in `old_data`/`new_data` for readability.
- For sensitive fields, redact before writing audit payloads.
- Use RLS so normal members cannot read full audit history; restrict read access to admin roles.

## Security hardening requirements

### 1) Append-only guarantees (tamper resistance)

Audit history should be immutable for application roles:

- deny `update` and `delete` for `anon` and `authenticated`
- allow inserts only through approved server-side writer path
- reserve any exceptional maintenance edits to tightly controlled owner/service workflows

If direct table writes are allowed to broad roles, audit data is not trustworthy.

### 2) Trusted writer boundary

Do not trust browser-provided actor/context fields. The writer path must derive identity server-side:

- `actor_user_id` from authenticated server context (not request body)
- request context (`ip`, `user_agent`) treated as untrusted metadata hints
- strict input validation for `module`, `action`, `entity_type`, and payload sizes

Prefer a private writer boundary (backend, edge function, or tightly-scoped privileged RPC) with explicit grants.

### 3) Payload redaction policy

JSON payloads are flexible, but they can become a leak vector. Define module-level allow/deny rules:

- denylist secrets and credentials (tokens, password reset artifacts, auth secrets)
- avoid full snapshots for sensitive entities; store changed non-sensitive fields only
- hash or truncate values when traceability is needed without full exposure

### 4) Write-failure semantics

Define behavior when business writes and audit writes diverge:

- strict mode (preferred for sensitive modules): if audit insert fails, business write fails
- fallback mode (for lower-risk flows): queue/dead-letter + alert, never silent drop

Choose mode per module and document it.

### 5) Read access boundaries

"Admin-only" is not enough by itself. Scope read access by role and, if needed, by module:

- global security admins may read all modules
- operational roles can be limited to relevant modules
- expose logs to UI only through constrained, paginated views/endpoints

### 6) Retention and performance

Plan for growth from day one:

- define retention windows by module/action criticality
- archive old partitions/rows for long-term history
- monitor index/query performance as volume grows

### 7) Optional integrity verification

For stronger forensic confidence, add periodic integrity checkpoints:

- compute hash snapshots over ordered log windows
- store checkpoints in a separate protected location
- verify periodically to detect unauthorized mutations

## Growth pattern

When adding a new module:

1. Add/allow the module name in app logic (or check constraint if you enforce one).
2. Start writing module-specific JSON payloads for old/new state.
3. Reuse the same query/reporting tools over the shared audit table.

This keeps the audit system extensible without repeated schema redesign.

## Implementation checklist

- [x] Create the shared `audit_log` table and time/module indexes.
- [x] Deny direct API-role access to the log.
- [x] Record event mutations in the database transaction, using server auth
  context for the actor and changed event fields for updates.
- [x] Audit member role and membership changes through database triggers.
- [x] Record member profile and external-account field names without personal
  values in audit payloads.
- [x] Add a scoped admin history read path and change-history panel.
- [ ] Define retention, monitoring, and exceptional maintenance procedures.
- [ ] (Optional) Add an integrity checkpoint process.
