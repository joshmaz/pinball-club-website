# Authoritative member identity

The member directory previously combined the editable `members.email` value with
verification from `auth.users.email_confirmed_at`. A verified account could replace
its profile email through the API and make a different address appear verified.

Migration `20261023040000_authoritative_member_identity.sql` makes Auth the source
of both directory email and verification. A database trigger canonicalizes email
on profile writes, blocks client changes to existing member identity/creation
fields, and generates identity fields for first-profile inserts. Legacy clients
that still submit email in their profile upsert remain compatible. Names and
avatar updates remain self-service. An Auth email-change trigger synchronizes the
profile mirror; existing linked mirrors are repaired without changing roles or
membership status. Trusted offline contacts keep their contact data but are not
presented as Auth email addresses or used as notification recipients.

Signup and Pinball Map failure notifications resolve recipients from Auth. Signup
notification bodies use the signup account's Auth email. Existing pending or
expired-lease deliveries for these two kinds are canceled if their destination
no longer matches the recipient member's Auth email. The address and sent history
are retained for review; messages are never redirected to a replacement address.
The check also runs before subsequent claims, including manual retries. Active
worker leases are left alone because a delivery might already be in flight.

## Rollout

1. Apply and verify in the isolated staging Supabase project first. Confirm the
   linked project before running any hosted command.
2. Pause notification dispatch and let active invocations finish before applying
   the migration. This avoids leaving an already-claimed delivery in flight with
   an old destination. Do not redirect or replay canceled messages automatically.
3. From the repository root, apply the reviewed forward migration with
   `supabase db push --linked`, then confirm it appears in
   `supabase migration list --linked`. Review the pending migration list first;
   `db push` applies every pending migration for the linked project.
4. Use synthetic staging accounts to verify profile saves with current and cached
   clients, Auth signup/email change, directory email/verification, and notification
   destination matching. Check canceled-delivery counts without exporting member
   data. Resume dispatch after these checks.
5. Deploy the frontend through the normal staging review and production release.
   Apply the same reviewed database migration in production before that release.
   No Edge Function code changes are required for this fix.

The frontend change alone does not close the API vulnerability. The migration
has not been applied by preparing or merging this code. Previously sent messages
are historical records and are not recalled by the migration.

## Regression coverage

`node --test scripts/member-identity-db.test.mjs` reproduces the original mismatch
and exercises the actual new migration with client database roles, direct writes,
legacy/current upserts, Auth triggers, audit privacy, authoritative notification
sources, missing-email/offline accounts, and pending/active/expired delivery leases.
The normal Netlify build discovers this test alongside the existing suite.
