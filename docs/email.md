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
