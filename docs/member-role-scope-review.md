# Member role scope follow-up

The [membership delegation migration](../supabase/migrations/20260928200000_membership_role_delegation.sql) separates role delegation from ordinary Member Tools access:

- Membership Editor retains directory access and routine membership upkeep but cannot grant or revoke roles.
- Membership Admin may grant/revoke Membership Editor and Events, Photos, and Games Editor/Admin roles.
- Website Administrator (`club_admin`) may grant/revoke all nine assignable roles. Only this role may delegate Membership Admin or Website Administrator.
- The existing trigger blocks self-removal of Website Administrator and removal of the last Website Administrator. These protections also cover direct deletion and guarded updates.
- `website_volunteer` is derived; neither it nor unknown identifiers can be assigned through the RPCs. Existing stored role identifiers are unchanged.

The shared general membership-access helper is deliberately unchanged. Directory pagination and search remain client side; broader directory access changes are outside this slice.

[Focused PGlite coverage](../scripts/member-role-delegation-db.test.mjs) loads the real role migrations and runs the [SQL boundary matrix](../scripts/member-role-rpc-boundaries.sql), followed by client-role and membership-upkeep regression checks. Run from the repository root:

```sh
node scripts/member-role-delegation-db.test.mjs
node --test scripts/site-auth.test.mjs scripts/member-tools-redesign.test.mjs scripts/member-view-acceptance.test.mjs
```

The SQL matrix requires a disposable migrated database with four distinct role-free member accounts and rolls back its fixtures. The PGlite runner creates those accounts automatically; no hosted database or Docker is needed for it. These checks have not been run as part of this implementation.

## Future Full Access approval requirement (2026-09-23)

A paid account must receive human approval before it can access Full Access resources, including the door code. Payment alone must not grant that access. Plan the approval and revocation workflow and enforce approval when serving protected resources, not only when displaying navigation.

Consider showing the club code of ethics when the door code is revealed. The wording and whether acknowledgment is required remain decisions for the club. This is a future requirement only; no approval workflow, access-policy changes, or code-of-ethics UI are implemented in this visual cleanup.
