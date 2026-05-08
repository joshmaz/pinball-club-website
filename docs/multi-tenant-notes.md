# Multi-Tenant Notes (Build-Now Guardrails)

This project is still single-tenant today. These notes help us ship features now without blocking a future multi-tenant migration.

## Core Rules

- Model ownership explicitly for every new table and feature.
- Keep authn, authz, and billing concerns separate.
- Enforce permissions in the database (RLS/RPC), not only in UI.
- Prefer scoped queries over broad reads filtered in JavaScript.
- Use stable IDs for relationships; avoid name-based joins.

## Quick Design Check (Use For New Features)

Before shipping a feature, answer:

1. Who owns this record?
2. Who can read it?
3. Who can create/update/delete it?
4. Where is access enforced (policy/RPC)?
5. If `tenant_id` were added tomorrow, where would it live?

If these are unclear, stop and define them before merging.

## Schema Guidance (Now)

- New tables should include a clear ownership key (at minimum user/member ownership).
- Avoid schema patterns that imply global, unscoped data unless truly global.
- Keep role assignments structured and machine-readable (slug + constraints).
- Prefer append-only audit/event tables for privileged actions.

## API/RPC Guidance (Now)

- Keep privileged writes behind RPCs with explicit authorization checks.
- Avoid "list all" admin endpoints without strict scope rules.
- Make function inputs explicit; do not rely on hidden global assumptions.
- Return minimal data needed by the caller.

## UI Guidance (Now)

- UI role gating is convenience only, never the security boundary.
- Keep tenant-agnostic wording and config-driven labels.
- Centralize access checks in shared helpers to avoid drift.

## Testing Guidance (Incremental)

- Start with DB policy tests for data isolation and role enforcement.
- Add RPC contract tests for allowed/denied behavior.
- Add smoke tests for critical auth + admin flows.
- Treat cross-scope leakage as a release-blocking defect.

## Anti-Patterns To Avoid

- Global roles with no scope.
- Unscoped background jobs modifying broad datasets.
- Table reads/writes that cannot be traced to an owner.
- Feature logic that assumes exactly one club forever.

## Future Migration Intent

When multi-tenancy begins, expected direction:

- Add first-class `tenants` + tenant membership + tenant-scoped roles.
- Add tenant FKs to tenant-owned tables.
- Move all privileged access to tenant-aware policy/RPC checks.

