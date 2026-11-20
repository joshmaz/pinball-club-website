# Account deletion and membership trends

## Agreed behavior

Members can permanently delete their own website account, including while Full Access is active. Membership Admins can delete ordinary members and domain volunteers. Membership Admin and Website Administrator targets require a Website Administrator. A Website Administrator cannot delete their own account; the final Website Administrator cannot be removed. Membership Editors cannot delete other accounts.

Both paths require the operator's current password, typing DELETE, and acknowledging that website deletion does not cancel PayPal recurring payments. The warning is shown for every membership status. Administrator deletions require a short reason, without personal/payment details. Recovery-only or passwordless sessions must first establish a password; MFA accounts must also have a two-factor session.

The account's Auth user, profile, memberships, roles, external links and attendance rows are deleted. Shared club events, photos, scores, machine issues and modifications remain; creator/deleter attribution is cleared. Existing audit records remain under the 12-month audit retention policy, with deleted actor references cleared. Audit record payloads can still contain historical content or member identifiers; account deletion is not a promise to scrub all free text. Personal-information removal within retained content is handled via support@snhpinballclub.com. Deletion cannot make a former member forget a shared door code; rotation is a separate club decision. External PayPal/treasurer records are not changed.

## Implementation and failure handling

`account-delete` is a server-only privileged Edge Function. Prepare verifies a live Auth session, reauthenticates the verified caller using their current password, checks explicit confirmations and current database permissions, and creates a random five-minute receipt. The browser never supplies a trusted actor ID/email. No passwords are logged or stored.

Execute binds the receipt to that live caller and uses `auth.admin.deleteUser(id, false)`. A BEFORE DELETE Auth trigger rechecks the actor and target roles under a table lock that serializes role writes for the transaction. It redacts stored signup messages about the member, cancels pending/sending copies, creates a minimal deletion audit event, and marks the receipt complete. Those writes and the existing account cascade commit or roll back together. The five creator/actor foreign keys use SET NULL. The existing last-administrator role guard remains in force.

The receipt is a random capability: unauthenticated status requests return only a completion boolean, because a self-deleted caller no longer has a live account. It must never appear in logs or URLs. Receipts contain only UUIDs, a short reason, timestamps and state, and are removed after two days. The browser keeps pending receipts in sessionStorage where available. An ambiguous response offers a status check; it does not automatically issue another delete. A failed attempt leaves the account records intact. At most one unexpired execution per target is active; subsequent confirmations must wait for completion or expiry. Fresh retries repeat permission/password checks.

Auth deletion also checks Storage ownership. The read-only inventory found 462 objects with neither ownership field set, so there is no current object ownership blocker. Future ownership changes can cause deletion to fail safely; never delete shared club files or edit Storage metadata directly to force account removal.

Messages already delivered, or already handed to an in-flight mail provider call, cannot be recalled. Stored signup copies are redacted using the exact member-ID event-key prefix. Other retained content is subject to the support process described above.

Deleted-account JWTs may remain cryptographically valid until expiry. Restrictive account-existence policies cover the direct signed-in Club Issues read path and member profile writes. Signed-in-only Club Issues and external-account SECURITY DEFINER entrypoints also check live account existence. Other private domain operations derive permission from the member/roles that cascade away, or verify a live Auth user at their Edge boundary. Public website data remains public.

The Auth trigger requires a valid prepared execution. Supabase dashboard/direct SQL deletion is intentionally rejected; use the website flow or the same controlled server API. There is no administrator bypass hidden in the browser.

## Billing boundary

Today, no provider integration is present: the payment acknowledgment is a warning, not a claim that PayPal cancellation was verified. `ACCOUNT_DELETION_BILLING_MODE` defaults to `manual`; any other value blocks preparation and execution until an adapter exists. Do not connect billing without changing this mode.

A future adapter must resolve the member's subscription from trusted provider identifiers and confirm cancellation of further recurring charges before authorizing deletion. Confirmed end-of-period cancellation is sufficient; website access ends immediately. Failed or unknown cancellation needs retry or staff assistance. The provider-backed guard must be enforced server-side and must not rely on the membership status or a browser checkbox. No speculative provider SDK or automatic cancellation is implemented now.

## Trends

The intended capture cadence is daily at **04:00 America/New_York**, including daylight saving time. The scheduler uses UTC ticks at 08:00 and 09:00 with a local-hour guard so the snapshot runs only at 04:00 Eastern; no midnight job or global cron timezone change is used. **Current staging verification found no `snh-membership-snapshot-daily` cron registration**, so this cadence describes the implementation, not an active staging schedule. Confirm the hosted scheduler before relying on new snapshots. One row per local date, first successful capture wins; retries do not overwrite it. Missed days are not backfilled with invented historical counts.

Snapshots retain only aggregate counts, capture timestamp and definition version, indefinitely. Definitions match the existing overview: all registered Auth accounts; Full Access from the latest membership's active status, ignoring legacy end dates; Basic from verified accounts without Full Access; unverified without Full Access as a separate reconciliation category; Website Volunteers from recognized roles, counted once per account. Volunteers overlap membership categories. A signup and deletion between captures may not appear; this is a net-size trend, not a join/leave ledger.

The existing Member Tools page has an expandable 12-month graph and accessible table. It shows weekly data points using the last observed daily snapshot in each Monday–Sunday week, with monthly divisions on a fixed twelve-calendar-month axis. The current week and month are partial; the table exposes actual snapshot dates and the line breaks across missing weeks. There is no reconstructed pre-launch history. History requires the same server-side membership permission as current overview counts. Historical snapshots do not change when accounts are deleted.

Operations → Jobs shows a compact Membership snapshots panel: the last recorded run/outcome and registered, Full Access and volunteer counts from that capture. The existing Operations ledger records each actual capture attempt; the UTC tick that falls outside 04:00 Eastern creates no run. Retried captures keep the original daily counts and report an existing snapshot. Normal capture/audit failures roll back new points while recording a failed outcome with a fixed safe error summary. Transaction cancellation or database unavailability remains visible through cron run details.

Successful and failed capture attempts write `members` audit entries with `metadata.automated=true`, the run ID, and aggregate-only data. They are hidden by default and shown through the existing Show automated activity checkbox. Filtering happens before pagination; the prior empty Pinball Map import rule is preserved. No new Edge Function is required for this job reporting. The reporting migration is present in the current staging ledger; its migration does not itself register the daily cron job. Existing runs are not reconstructed.

The private tables are explicitly scoped to this single-club installation. Future multi-tenant deployment must add club/tenant scope to their keys, authorization and scheduler before sharing a database.

## Current staging status and environment checks

The staging project currently has the `account-delete` Edge Function and the `snh-account-deletion-receipts-cleanup` cron job. The `snh-membership-snapshot-daily` cron job was not present in the read-only staging inventory, so trend capture is not confirmed active. Function-name presence does not prove code parity, secrets, or end-to-end behavior; verify the deployed project before relying on these paths. No secrets were read during this documentation review.

Before using or changing these features in any environment:

1. Confirm the linked project reference and verify migration/schema parity. The base members/memberships tables predate the repository migration history; do not assume a blank database can replay every migration or that the partial hosted ledger is complete.
2. Run the read-only verification inventory below. Apply only the reviewed forward migrations that are actually pending; do not replay an already represented schema or use migration-history repair as a schema change.
3. Verify the `account-delete` Edge Function deployment and its configuration through the normal protected operations process. It validates Auth itself; gateway `verify_jwt=false` permits post-deletion receipt checks. Do not log request bodies or receipts. Keep billing mode manual until a cancellation adapter is ready.
4. Test deletion only with disposable accounts in a non-production environment, including contribution ownership, role changes during confirmation, last-admin/self-admin denial, wrong password, invalid/expired receipts, rollback on an unexpected FK blocker, and a lost success response.
5. Verify `snh-account-deletion-receipts-cleanup` and, if daily trends are expected, `snh-membership-snapshot-daily` in `cron.job`; inspect `cron.job_run_details` after execution. The first real trend point appears after a successful 04:00 capture. No historical backfill is claimed.

For a genuinely new environment, first establish a separately reviewed baseline or ordered initialization plan because core member tables predate this repository's migration chain.

## Verification prerequisite for access grants

`20261016120000_require_verified_access_grants.sql` requires the target's Auth email to be verified before an authorized operator can assign a website role or grant Full Access. Verified Basic Members remain eligible for volunteer roles. The page disables unavailable grants and explains the requirement; the server independently checks Auth's current verification state at each grant. Authorized role removals, membership deactivation and deletion still work for unverified accounts. Existing access records are not changed automatically, and snapshot definitions and historical values remain unchanged.

Before deployment, run this read-only inventory in the linked database. Any returned account is an existing exception for review, not a request to revoke or delete it. An empty result means there are no unverified accounts with website roles or Full Access.

```sql
select m.id as member_id, m.email,
       coalesce(ms.status = 'active', false) as full_access,
       array(select r.role_slug from public.member_roles r
             where r.member_id = m.id order by r.role_slug) as assigned_roles
from public.members m
join auth.users u on u.id = m.user_id
left join lateral (
  select s.status from public.memberships s where s.member_id = m.id
  order by s.created_at desc, s.id desc limit 1
) ms on true
where u.email_confirmed_at is null
  and (coalesce(ms.status = 'active', false)
       or exists (select 1 from public.member_roles r where r.member_id = m.id))
order by m.id;
```

Deploy this migration before the static page update. This prerequisite adds no Edge Function change. Run `node --test scripts/member-role-delegation-db.test.mjs scripts/member-role-presentation.test.mjs` to check server rejection of unverified grants, success after verification, Basic Member volunteer eligibility, permitted removals/deactivation, preserved audit and delegation rules, and page controls.
