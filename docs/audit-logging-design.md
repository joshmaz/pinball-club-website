# Audit Logging Design

This note captures the current audit-trail approach for SNHPC and why it scales as new modules are added.

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

- [ ] Create append-only `audit_log` table and indexes.
- [ ] Enforce no `update`/`delete` for app-facing roles.
- [ ] Implement a trusted server-side writer path with strict validation.
- [ ] Derive actor identity from server auth context only.
- [ ] Add module-level redaction/allowlist rules for payload fields.
- [ ] Define strict vs fallback write-failure behavior per module.
- [ ] Add scoped read policies/views for audit consumers.
- [ ] Define retention/archival policy and monitoring.
- [ ] (Optional) Add integrity checkpoint process.