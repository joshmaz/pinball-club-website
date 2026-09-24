# Member role scope follow-up

The September 2026 role RPC migration restricts `club_admin` and `membership_admin` grants and revokes in the database. The existing allowlist and general Member Tools access remain in place.

A broader RBAC review should consider these existing scopes separately:

- `membership_editor` can still grant and revoke other allowlisted module admin roles, including `events_admin`, `photos_admin`, and `games_admin`. This patch intentionally preserves that established permission.
- Any permitted role manager can revoke their own qualifying role. The present RPC checks authorization before mutation, but a club could lose its last administrator. Consider a last-admin guard.
- Member Tools still returns the full directory, including email and roles, to all three membership management roles. Pagination and search here are client side; consider server side pagination and a narrower read scope for large clubs.

Direct RPC checks require a running local Supabase stack with seeded member accounts. This environment does not provide Docker access, so those checks could not run here.

## Future Full Access approval requirement (2026-09-23)

A paid account must receive human approval before it can access Full Access resources, including the door code. Payment alone must not grant that access. Plan the approval and revocation workflow and enforce approval when serving protected resources, not only when displaying navigation.

Consider showing the club code of ethics when the door code is revealed. The wording and whether acknowledgment is required remain decisions for the club. This is a future requirement only; no approval workflow, access-policy changes, or code-of-ethics UI are implemented in this visual cleanup.
