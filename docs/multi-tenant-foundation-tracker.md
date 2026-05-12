# Multi-Tenant Foundation Tracker

Use this as the single durable thread for future multi-tenant alignment work while continuing current feature delivery.

## Goal

Keep daily development compatible with a future tenant-scoped architecture without forcing a full migration now.

## References

- `docs/multi-tenant-notes.md`
- `docs/photos-foundation.md` (first feature designed against this tracker)
- `README.md` -> "Lightweight PR checklist (tenant-safe by default)"

## Next Up

- [ ] Add first automated DB policy tests for scope/isolation assumptions.
- [ ] Inventory current privileged RPCs and expected ownership boundaries.
- [ ] Define initial `tenants` + `tenant_members` draft schema (design note only).
- [ ] Photos: per-scope storage quota (read aggregate `original_byte_size`) and visible quota in editor UI.
- [ ] Photos: pending-asset garbage collection job (delete `photo_assets` rows stuck in `pending` > 24 h and matching storage objects).
- [ ] Photos: storage policy regression tests (anon denied on `photos-private`, authenticated denied write on either bucket, signed URL scope check).

## Ongoing Rule

For any PR touching schema, RPCs, or authz-sensitive UI:

- Include a one-line note in PR: `tenant-safe review: pass/fail + reason`.

## Parking Lot

- Tenant resolver strategy (subdomain/custom-domain + selector fallback).
- Tenant-scoped billing model (platform subscription vs member dues).
