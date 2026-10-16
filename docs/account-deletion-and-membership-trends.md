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

Capture daily at **04:00 America/New_York**, including daylight saving time. The cron job runs at 08:00 and 09:00 UTC, but a local-hour guard executes the snapshot only at 04:00 Eastern. No midnight job is used and no global cron timezone setting changes. One row per local date, first successful capture wins; retries do not overwrite it. Missed days are not backfilled with invented historical counts.

Snapshots retain only aggregate counts, capture timestamp and definition version, indefinitely. Definitions match the existing overview: all registered Auth accounts; Full Access from the latest membership's active status, ignoring legacy end dates; Basic from verified accounts without Full Access; unverified without Full Access as a separate reconciliation category; Website Volunteers from recognized roles, counted once per account. Volunteers overlap membership categories. A signup and deletion between captures may not appear; this is a net-size trend, not a join/leave ledger.

The existing Member Tools page has an expandable 12-month graph and accessible table. It uses the last observed daily snapshot for each calendar month, labels the current month as partial, exposes the actual snapshot date and breaks lines across missing months. There is no reconstructed pre-launch history. History requires the same server-side membership permission as current overview counts. Historical snapshots do not change when accounts are deleted.

The private tables are explicitly scoped to this single-club installation. Future multi-tenant deployment must add club/tenant scope to their keys, authorization and scheduler before sharing a database.

## Deployment after PR review

1. Back up and verify migration parity against the deployed schema. The base members/memberships tables predate the repository migration history; do not assume a blank database can replay every migration.
2. Apply the two new forward migrations through the normal reviewed deployment process. The account-existence changes and database deletion guard should precede enabling the UI.
3. Deploy the `account-delete` Edge Function with the existing Supabase URL and service credentials. It validates Auth itself; gateway `verify_jwt=false` permits post-deletion receipt checks. Do not log request bodies or receipts. Keep billing mode manual until a cancellation adapter is ready.
4. Deploy the static site. Test deletion only with disposable accounts in a non-production environment, including a contribution owner, role changes during confirmation, last-admin/self-admin denial, wrong password, invalid/expired receipts, rollback on an unexpected FK blocker, and a lost success response.
5. Verify `snh-membership-snapshot-daily` and `snh-account-deletion-receipts-cleanup` in `cron.job`, and inspect `cron.job_run_details` after execution. The first real trend point appears after the next 04:00 capture. No historical backfill is claimed.

Local checks: `node --test --test-concurrency=1 scripts/account-deletion-db.test.mjs scripts/account-deletion-edge.test.mjs scripts/account-deletion-ui.test.mjs`. Database tests use disposable PGlite with the production migrations; cron registration is stubbed, so hosted Auth API and the scheduler still need non-production end-to-end validation before rollout.
