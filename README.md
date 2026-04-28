# Pinball Club Website

Official site for the Southern New Hampshire Pinball Club, including public pages and an in-progress member portal.

## What is live now

- Public club pages (`index.html`, `events.html`, `games.html`, `about.html`, etc.)
- Home page "Right now" transition messaging (new venue lease update + Slack to Discord migration note)
- Games page history explorer with:
  - timeline slider (`Now` -> `Origins`)
  - date jump input for custom snapshots
  - show-all mode for full historical lineup
  - between-locations messaging when no current lineup exists
  - per-machine PinTips links to Match Play Events when available
- Supabase-backed sign up and sign in
- Member dashboard (`members.html`) with:
  - expanded profile updates (`first_name`, `last_name`, `display_name`, `avatar_url`, `ifpa_player_id`, `stern_insider_username`)
  - live IFPA profile link preview based on entered IFPA player number
  - current membership status display
  - password change for signed-in users
  - role-gated Members admin panel backed by Supabase RPCs
- Password recovery from `signin.html` ("Forgot Password" email flow)

## Membership roadmap (working notes)

- **Billing:** Stripe Checkout + webhooks will be the source of truth for paid membership state.
- **Tiering:** support free web users who can upgrade into paid/on-prem access tiers.
- **Admin roles:** continue iterating on admin tooling and auditing around existing role-based controls.
- **RBAC expansion:** continue evaluating scoped permissions for areas like events, machines, and membership management.

Keep auth and billing concerns separated:

- Supabase Auth handles identity and sessions.
- Stripe handles payment and subscription lifecycle.
- Supabase database stores derived membership state (status/tier/period end) for app logic.

## Project layout

- `assets/css/styles.css` - shared site styles
- `assets/js/supabase-init.js` - creates Supabase client from runtime config
- `assets/js/games.js` - games catalog rendering, timeline/date travel, and enrichment link behavior
- `assets/js/member-portal.js` - auth/session helpers, profile/membership helpers, member-role/RPC helpers
- `signin.html` - sign up/sign in experience
- `members.html` - authenticated account page

## Supabase notes (current implementation)

- `public.members` now stores `first_name`, `last_name`, and `stern_insider_username` alongside `display_name`.
- Avatar URL and IFPA player id are stored in Supabase Auth `user_metadata` and synchronized through the member portal profile save flow.
- Member admin capabilities use security-definer RPCs (`snh_get_member_admin_stats`, `snh_list_members_for_admin`, `snh_grant_member_role`, `snh_revoke_member_role`) gated by `club_admin`/`members_manager`.

## Deployment

The site deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Architecture notes

- Audit logging design: `docs/audit-logging-design.md`
- Website task agents planning: `docs/website-task-agents.md`

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
