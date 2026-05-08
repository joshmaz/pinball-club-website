# Multi-Tenant Foundation Tracker

Use this as the single durable thread for future multi-tenant alignment work while continuing current feature delivery.

## Goal

Keep daily development compatible with a future tenant-scoped architecture without forcing a full migration now.

## References

- `docs/multi-tenant-notes.md`
- `README.md` -> "Lightweight PR checklist (tenant-safe by default)"

## Next Up

- [ ] Add first automated DB policy tests for scope/isolation assumptions.
- [ ] Inventory current privileged RPCs and expected ownership boundaries.
- [ ] Define initial `tenants` + `tenant_members` draft schema (design note only).

## Ongoing Rule

For any PR touching schema, RPCs, or authz-sensitive UI:

- Include a one-line note in PR: `tenant-safe review: pass/fail + reason`.

## Parking Lot

- Tenant resolver strategy (subdomain/custom-domain + selector fallback).
- Tenant-scoped billing model (platform subscription vs member dues).
