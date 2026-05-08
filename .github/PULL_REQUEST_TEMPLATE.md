## Summary

- Describe what changed and why.

## Validation

- [ ] Verified locally (manual or automated)
- [ ] Updated docs if behavior changed

## Tenant-Safety Review

- [ ] Ownership is explicit for new/changed data.
- [ ] Access rules are clear (read/create/update/delete).
- [ ] Authorization is enforced server-side (RLS/RPC), not only in UI.
- [ ] Queries are scoped (no broad reads filtered client-side).
- [ ] New schema/API has a clear future path to `tenant_id`.

Notes:
- tenant-safe review result: pass/fail + short reason
