# Email (Resend + Supabase Auth)

Transactional email for the club site runs through **Resend**, with **Supabase Auth** as the primary sender for member-facing auth mail (password reset, signup confirmation, etc.).

Public contact address on the website: **support@snhpinballclub.com**.

## Architecture

```
Browser (signin.html, etc.)
   ↓ Supabase Auth API
Supabase Auth (custom SMTP)
   ↓ smtp.resend.com
Resend
   ↓
Member inbox

Optional: local/Edge Function scripts
   ↓ Resend HTTP API (RESEND_API_KEY)
Resend
```

Two separate integration paths share the same Resend account and API key:

| Path | Purpose | Where configured |
|------|---------|------------------|
| **Supabase Auth SMTP** | Password reset, signup confirm, magic links | Supabase Dashboard → Authentication → Email → SMTP Settings |
| **Resend API** | One-off or app-triggered mail (scripts, future Edge Functions) | `.env` locally; `supabase secrets set` for hosted functions |

## App notifications (first slice)

`20260924130000_notification_foundation.sql` adds a private-to-clients outbox.
`20260925020000_queue_notifications_from_auth_signup.sql` connects it to the
Auth account-creation function, which creates a member before a signed-in session
exists. New Auth accounts (including accounts created through Auth administration)
and signed-in users creating their first profile queue one signup alert
for each existing account with `membership_editor`, `membership_admin`, or
`club_admin`. Profile edits and direct member-table imports do not queue alerts.
The migration does not backfill accounts created before it was applied; test with
a fresh account after deployment. At least one existing eligible recipient must
have a valid email address.
Duplicate role assignments do not create duplicate alerts. The notice describes
the website account and does not imply paid membership.

The `notification-dispatch` Edge Function reads the outbox and sends through
Resend. It requires an independent `NOTIFICATION_DISPATCH_SECRET` header. Its
default mode is `preview`, which reports a safe summary of the
oldest pending message (kind, subject, queued time, and whether it is within the
24-hour live-delivery window). It does not expose the message body or recipient
in job history and does not consume the queue. `test` sends a synthetic test
message only to `NOTIFICATION_TEST_EMAIL`; it does not read or change the
outbox. Each test run sends another copy to that test destination. Staging test
messages use a `[STAGING TEST]` subject prefix and a visible staging note in
the body; live delivery is rejected in staging before any queued message is
claimed. Production test messages use `[TEST]`.
`live` is selected with `NOTIFICATION_DELIVERY_MODE=live`. Claims are
serialized in Postgres and reserve capacity for in-flight sends, enforcing a
maximum of ten messages per run and ten per rolling 24-hour window across
repeated or concurrent runs. Operations shows remaining capacity and
pending/expired counts. Staging rejects live mode. Live sends go to the queued
recipient and record the provider ID or a safe error summary. Recipient
authorization occurs only at enqueue, using the canonical effective Membership
Editor role. Removing a qualifying role afterward does not suppress already
queued mail; removing it before the next signup prevents new mail for that
recipient. The dispatcher retries failures at most three times during the first
24 hours. Resend's idempotency key uses the outbox ID for safe short-term
retries; delivery beyond that window is held for manual review.

### Activation

1. Apply the migration and deploy `notification-dispatch` with its configured
   `verify_jwt = false` setting. Until the dispatcher is deployed and called,
   the migration only queues messages.
2. Publish the `snhpc-member-signup-alert-v1` template in Resend and
   confirm the API key configured for each project can access it.
3. Configure project-specific Edge Function secrets:
   `NOTIFICATION_DISPATCH_SECRET` (a unique, random high-entropy value per
   project), `RESEND_API_KEY` (Sending access, restricted to the verified
   sending domain), `NOTIFICATION_FROM` (a sender on the verified domain),
   and `NOTIFICATION_TEST_EMAIL` (a controlled test inbox or group).
4. In Operations → Messaging, inspect queued content and use **Send preview**
   on a staging item to receive the rendered template at the configured test
   inbox. The item remains pending and its intended recipient is not contacted.
   Use **Send test email** separately to verify the dispatcher with a synthetic
   message. Repeated test runs send additional copies to the test destination.
5. Keep delivery mode at `preview` by default. Enable `live` only after the
   staging preview and production configuration review are complete. A
   scheduled caller is not configured by default. Keep dispatch secrets out
   of browser code and public build variables.

### Queue review and staging cleanup

Operations → Messaging can expand **Preview message** to show the queued text and recipient. This content can include member names and email addresses, so it is available only to Club Administrators. Pending messages can be canceled individually. In staging, **Clear staging pending queue** cancels all pending messages in that project; it does not send them or affect messages already being sent. These actions leave canceled records visible in history and write an Operations audit entry.

Club Administrators can also send a copy of a pending staging message to `NOTIFICATION_TEST_EMAIL`. The subject is prefixed with `[STAGING PREVIEW]` and the body identifies it as a test copy. This action is staging-only, leaves the queue item pending, does not contact its intended recipient, and records an Operations audit entry. It requires the staging test address, Resend API key, and sender to be configured.

The `member_signup` notice uses the published Resend template alias `snhpc-member-signup-alert-v1`. New queue rows store `NEW_USER_NAME` and `NEW_USER_EMAIL` in `template_variables`, alongside a plain-text snapshot for queue review and legacy fallback. The template explains why the recipient is getting the informational notice, says no action is needed, and clarifies that a website profile does not confirm or change paid membership.

The live dispatcher and the staging-only queued-message preview use the same Resend template and values. A staging preview adds a `[STAGING PREVIEW]` subject prefix and a visible banner, sends only to `NOTIFICATION_TEST_EMAIL`, and leaves the queue item pending. Rows queued before the template migration have null template variables and continue through the plain-text delivery path. HTML-specific name and email variables are escaped by the dispatcher; their plain-text counterparts remain readable. No member-facing unsubscribe link is included: this is a role-based operational alert, not a member campaign.

The Resend template must be published and available to the API key configured for each project before template delivery can succeed. Editing and publishing a new version changes future sends without a code change, so inspect a staging preview after template edits before enabling production delivery.

### Template tester

Operations → Messaging includes an Email template tester for the templates registered in
the Operations Edge Function. It offers editable example values and optional
LLM-generated fictional values, then sends the rendered Resend template only to
`NOTIFICATION_TEST_EMAIL`. It does not create or consume an outbox item and is
available independently of notification delivery mode. Test subjects and a
visible banner identify the email as a template test. The send request is
audited without storing the sample values.

AI sample generation uses `OPENAI_PLATFORM_KEY` and the existing monthly AI
spending cap. Its usage is tracked as `email_template_test_data` in Operations
→ AI Usage. Sample email fields are restricted to the reserved `example.com`
domain. When adding a template, register its alias, variable descriptions and
safe example values in `supabase/functions/operations/index.ts`; the tester
only sends templates from this allowlist.

Staging intentionally rejects live delivery. Test mode sends a synthetic message to the configured test inbox and never reads or changes queued messages. Use queue preview to verify the event and message content, then cancel or clear staging items when finished.

Inspect queue totals in the Supabase SQL editor:

```sql
select kind, status, count(*) from public.notification_outbox
group by kind, status order by kind, status;
```

No addresses are hardcoded in the notification code. The queue is inaccessible
to `anon` and `authenticated` clients. The first signup alert has no member
preference toggle because it goes only to designated membership volunteers;
future optional game and note alerts should get per-member opt-ins before they
are queued. Wider member email campaigns need a separate consent and audience
workflow.

Never put `RESEND_API_KEY` in browser code or `assets/js/config.js`.

## Supabase Auth SMTP (live)

Configured and tested for password reset. Standard Resend SMTP values:

| Field | Value |
|-------|--------|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Resend API key (`re_…`) |
| Sender email | Address on the verified Resend domain (e.g. `support@snhpinballclub.com`) |
| Sender name | e.g. `SNH Pinball Club` |

Reference: [Resend — Send with Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp).

Auth email templates are edited in Supabase Dashboard → Authentication → Email Templates. A few templates already reference `support@snhpinballclub.com` for help copy.

## Inbound mail (temporary)

Until a dedicated mailbox exists, **Cloudflare Email Routing** forwards `support@snhpinballclub.com` to the operator inbox. Outbound auth mail still sends through Resend; forwarding only affects replies and mail sent *to* the support address.

## Secrets checklist

| Secret | Local `.env` | Supabase Edge secrets | Supabase Auth SMTP |
|--------|--------------|----------------------|-------------------|
| `RESEND_API_KEY` | Yes (scripts) | Yes (when an Edge Function sends mail) | Same key as SMTP password |

Local `.env` is **not** synced automatically to hosted Supabase. After adding or rotating the key, update each store that uses it.

Local test script:

```bash
cd scripts/resend
node --env-file=../../.env send-test-email.mjs
```

## Roadmap: branded auth templates

Supabase ships default auth email HTML. Planned follow-up:

- [ ] Branded HTML for all Supabase Auth templates (confirm signup, reset password, magic link, invite, email change)
- [ ] Consistent header/footer, club logo, and tone aligned with site copy
- [ ] Help/contact line using `support@snhpinballclub.com` on every template
- [ ] Optional: move complex templates to Resend + Auth Hooks later if Supabase template limits become a problem

Track template work in repo issues or PRs; keep Supabase Dashboard exports or template source in version control once branding is finalized.

## Operator notes

- Verify the sending domain in [Resend Domains](https://resend.com/domains) before changing the SMTP sender address.
- Check delivery in Resend → Emails and Supabase → Authentication → Logs after template or SMTP changes.
- Avoid trailing spaces in the SMTP host field (`smtp.resend.com` only).
