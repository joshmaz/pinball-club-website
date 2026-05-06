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

## Games catalog (relational)

After applying migrations, bulk-load from the repo JSON (requires **service role** in `.env` as `SUPABASE_SERVICE_ROLE_KEY` — local only, never in CI for public builds):

```bash
node --env-file=.env scripts/import-games-json.mjs
```

To refresh the static fallback from DB (`games_catalog_v1` -> `data/games.json`):

```bash
node --env-file=.env scripts/export-games-json-from-supabase.mjs
```

Pinball Map activity ingest runs in the Edge Function `supabase/functions/pinballmap-ingest` (see `docs/games-relational-migration-plan.md` for secrets and scheduling).

## Deployment

The site deploys to AWS S3 via `.github/workflows/deploy.yml`, with optional CloudFront cache invalidation.

The legacy Wix-era snapshot lives in `wix_archive/` (static mirror + landing page at `wix_archive/index.html`). It is included in the repo so `aws s3 sync ... --delete` does not remove it on deploy. The deploy workflow also publishes an S3 object at key `wix_archive/` with `WebsiteRedirectLocation` to `/wix_archive/index.html` so that `https://<domain>/wix_archive/` (trailing slash) works with CloudFront + the S3 REST API, which do not treat directories like a static website’s default index document. To refresh the mirror before Wix is shut down, run `npm install` and `node mirror.mjs` from `scripts/wix-mirror/` at the repo root (`node scripts/wix-mirror/mirror.mjs`). That script rewrites absolute `snhpinball.wixsite.com` URLs to `/wix_archive/site/...` so navigation keeps working after Wix is offline. After a deploy, confirm `/wix_archive/` on the live domain and spot-check the archived home page; repeat once Wix is shut down to confirm nothing still depends on the live Wix host. On Windows, if `git add wix_archive` fails with “Filename too long”, run `git config core.longpaths true` once in this repo (mirrored asset paths can exceed the legacy path limit).

## Architecture notes

- Audit logging design: `docs/audit-logging-design.md`
- Website task agents planning: `docs/website-task-agents.md`
- Games catalog (Supabase + optional DB-backed public page): `docs/games-relational-migration-plan.md`

## Secrets and local configuration

Supabase URL and anon key are not committed. They are generated into `assets/js/config.js` by `scripts/write-config.mjs`.

1. In GitHub, add Actions secrets:
  - `SUPABASE_URL` (example: `https://xxxx.supabase.co`)
  - `SUPABASE_ANON_KEY` (Supabase Project Settings -> API)
  - `AWS_ROLE_ARN` (IAM role to assume via GitHub OIDC)
  - `AWS_REGION` (example: `us-east-1`)
  - `S3_BUCKET` (target static site bucket name)
  - `CLOUDFRONT_DISTRIBUTION_ID` (optional, to invalidate CDN cache after deploy)
  - `GAMES_CATALOG_SOURCE` (optional: `json` default, or `db` to load games from Supabase view `games_catalog_v1` on the public games page)
2. On push to `main`, deploy writes `assets/js/config.js` from those secrets.
3. For local development, copy `.env.example` to `.env`, set the same values, then run:
  ```bash
   node --env-file=.env scripts/write-config.mjs
  ```

`assets/js/config.js` is gitignored. If missing, Supabase-backed pages will show unavailable auth behavior.

## Security notes

- The Supabase anon key is expected to be public in browser code.
- Protect sensitive data with Row Level Security policies.
- Never expose the Supabase service role key in frontend code or GitHub Actions secrets.
