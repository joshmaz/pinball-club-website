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
default mode is `preview`, which shows one queued message without consuming it.
`test` sends that message only to `NOTIFICATION_TEST_EMAIL` with a test label and
does not consume the queue. `live` claims up to ten messages per call, verifies
that each recipient still holds a membership role, sends, and records the
provider ID or an error. It retries failures at most three times during the
first 24 hours. Resend's idempotency key uses the outbox ID for safe short-term
retries; delivery beyond that window is held for manual review.

### Activation

1. Apply the migration and deploy `notification-dispatch` with its configured
   `verify_jwt = false` setting. Until the dispatcher is deployed and called,
   the migration only queues messages.
2. Configure Edge Function secrets `NOTIFICATION_DISPATCH_SECRET` (a random,
   high-entropy value), `RESEND_API_KEY`, `NOTIFICATION_FROM` (a verified club
   sender such as `SNH Pinball Club <support@snhpinballclub.com>`), and
   `NOTIFICATION_TEST_EMAIL` (an operator's inbox).
3. Call `POST /functions/v1/notification-dispatch` with
   `x-notification-secret: <secret>` while delivery mode is unset. Verify the
   preview. Set `NOTIFICATION_DELIVERY_MODE=test`, call again, and inspect the
   test inbox and Resend's delivery log. The test recipient is the only address
   used in this mode.
4. After confirming coordinator accounts and their membership roles, set
   `NOTIFICATION_DELIVERY_MODE=live` and call the function. Set up a server-side
   scheduled POST (for example, every few minutes) with the same secret.
   Keep the secret out of browser code and public build variables. The
   scheduled caller is intentionally not installed by this change because the
   destination and secret must be configured in the hosted project.

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
