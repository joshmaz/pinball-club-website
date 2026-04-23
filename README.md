# Pinball Club Website

Official site for the Southern New Hampshire Pinball Club, including public pages and an in-progress member portal.

## What is live now

- Public club pages (`index.html`, `events.html`, `games.html`, `about.html`, etc.)
- Supabase-backed sign up and sign in
- Member dashboard (`members.html`) with:
  - basic profile updates
  - current membership status display
  - password change for signed-in users
- Password recovery from `signin.html` ("Forgot Password" email flow)

## Membership roadmap (working notes)

- **Billing:** Stripe Checkout + webhooks will be the source of truth for paid membership state.
- **Tiering:** support free web users who can upgrade into paid/on-prem access tiers.
- **Admin roles:** introduce site admins who can edit content safely.
- **RBAC expansion:** evaluate scoped permissions for areas like events, machines, and membership management.

Keep auth and billing concerns separated:

- Supabase Auth handles identity and sessions.
- Stripe handles payment and subscription lifecycle.
- Supabase database stores derived membership state (status/tier/period end) for app logic.

## Project layout

- `assets/css/styles.css` - shared site styles
- `assets/js/supabase-init.js` - creates Supabase client from runtime config
- `assets/js/member-portal.js` - auth/session helpers, profile/membership helpers
- `signin.html` - sign up/sign in experience
- `members.html` - authenticated account page

## Deployment

The site deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Secrets and local configuration

Supabase URL and anon key are not committed. They are generated into `assets/js/config.js` by `scripts/write-config.mjs`.

1. In GitHub, add Actions secrets:
   - `SUPABASE_URL` (example: `https://xxxx.supabase.co`)
   - `SUPABASE_ANON_KEY` (Supabase Project Settings -> API)
2. On push to `main`, deploy writes `assets/js/config.js` from those secrets.
3. For local development, copy `.env.example` to `.env`, set the same values, then run:

   ```bash
   node --env-file=.env scripts/write-config.mjs
   ```

`assets/js/config.js` is gitignored. If missing, Supabase-backed pages will show unavailable auth behavior.

## Security notes

- The Supabase anon key is expected to be public in browser code.
- Protect sensitive data with Row Level Security policies.
- Never expose the Supabase service role key in frontend code or GitHub Pages secrets.
