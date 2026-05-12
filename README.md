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
  - profile editing grouped into Account (name basics + avatar URL), Pinball profiles (IFPA, Stern Insider, MatchPlay player ID), Privacy (scaffolding only), and Password
  - live IFPA profile link preview based on entered IFPA player number
  - current membership status display (status, tier, renews/ends) plus a phase-0 writeup of how membership works today (treasurer-tracked, $40/month or $480/year, pay via cash or PayPal at [paypal.me/snhpinball](https://paypal.me/snhpinball))
  - role-gated **Member Tools** panel (member directory with membership status fields, stats, role grants/revokes, and manual membership updates) backed by Supabase RPCs
  - role-gated Events, Photos, and Games panels for designated helpers (Photos panel ships full upload/caption/publish/regenerate/unpublish/delete via Supabase Storage; see `docs/photos-foundation.md`)
  - shared Club & machine notes panel readable by every signed-in member; writable by anyone with a portal helper role
  - password change for signed-in users
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

- `public.members` stores `first_name`, `last_name`, `display_name`, and `avatar_url` for each member, keyed by `user_id` (the Supabase Auth UID).
- External pinball-platform identifiers live in `public.external_accounts`, one row per (`member_id`, `provider_slug`):
  - `ifpa` for an IFPA player number (also stores the `ifpapinball.com` profile URL in `account_url`)
  - `stern_insider` for a Stern Insider username
  - `matchplay_events` for a MatchPlay player ID
  - The portal reads these via the `snh_get_my_external_accounts` RPC and writes them with `upsert`/`delete` on the table; clearing a field deletes the matching row.
- Member admin capabilities use security-definer RPCs (`snh_get_member_admin_stats`, `snh_list_members_for_admin`, `snh_grant_member_role`, `snh_revoke_member_role`, `snh_set_member_membership`) gated by the `MEMBERSHIP_MANAGE_ACCESS` role group (see role table below).
- Manual membership updates in Member Tools use `snh_set_member_membership` with allowlisted status values (`active`, `past_due`, `expired`, `canceled`, `inactive`) and a latest-record update pattern in `public.memberships` (fallback insert when no membership row exists yet).

## Role-gated UI sections

The member dashboard sidebar shows a section if the signed-in member has any of the role slugs listed below. UI gating is **not** a security boundary; the same role checks must exist in RLS policies and `SECURITY DEFINER` RPCs.

| Sidebar label  | Panel heading            | Roles that grant access                                       | Notes                                                                                  |
|----------------|--------------------------|---------------------------------------------------------------|----------------------------------------------------------------------------------------|
| Profile        | Profile                  | Any signed-in member                                          | Always shown.                                                                          |
| Membership     | Membership               | Any signed-in member                                          | Always shown.                                                                          |
| Notes          | Club & machine notes     | Any signed-in member can read                                 | Add/edit requires any portal helper role (events, photos, games, or membership).       |
| Member Tools   | Member Tools             | `membership_editor`, `membership_admin`, `club_admin`         | Listed in code as `ROLE_GROUPS.MEMBERSHIP_MANAGE_ACCESS`; includes manual membership status/tier/end-date updates plus role grants/revokes. |
| Events         | Events                   | `events_editor`, `events_admin`, `club_admin`                 | `ROLE_GROUPS.EVENTS_MANAGE_ACCESS`. Delete also requires `events_admin` or `club_admin` (`ROLE_GROUPS.EVENTS_DELETE_ACCESS`). |
| Photos         | Photos                   | `photos_editor`, `photos_admin`, `club_admin`                 | `ROLE_GROUPS.PHOTOS_ACCESS`. Album/asset editor: upload, caption, publish, regenerate, unpublish. Delete (album/asset) requires `photos_admin` or `club_admin`. See `docs/photos-foundation.md`. |
| Games          | Games                    | `games_editor`, `games_admin`, `club_admin`                   | `ROLE_GROUPS.GAMES_ACCESS`.                                                            |

Role groups are defined in `assets/js/member-portal.js` as `SNHMemberPortal.ROLE_GROUPS`. Keep that map in sync with the RLS/RPC checks in `supabase/migrations/`. See `CLAUDE.md` for the full `member_roles` model and bootstrap instructions.

## Games catalog (relational)

After applying migrations, bulk-load from the repo JSON (requires **service role** in `.env` as `SUPABASE_SERVICE_ROLE_KEY`; local only, never in CI for public builds):

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

The legacy Wix-era snapshot lives in `wix_archive/` (static mirror + landing page at `wix_archive/index.html`). It is included in the repo so `aws s3 sync ... --delete` does not remove it on deploy. The deploy workflow also publishes an S3 object at key `wix_archive/` with `WebsiteRedirectLocation` to `/wix_archive/index.html` so that `https://<domain>/wix_archive/` (trailing slash) works with CloudFront + the S3 REST API, which do not treat directories like a static website’s default index document. To refresh the mirror before Wix is shut down, run `npm install` and `node mirror.mjs` from `scripts/wix-mirror/` at the repo root (`node scripts/wix-mirror/mirror.mjs`). That script rewrites absolute `snhpinball.wixsite.com` URLs to `/wix_archive/site/...` so navigation keeps working after Wix is offline. After a deploy, confirm `/wix_archive/` on the live domain and spot-check the archived home page; repeat once Wix is shut down to confirm nothing still depends on the live Wix host. On Windows, if `git add wix_archive` fails with “Filename too long”, run `git config core.longpaths true` once in this repo (mirrored asset paths can exceed the legacy path limit). The mirrored Wix home page (`wix_archive/site/.../home/index.html`) loads `archive-marquee.js` / `archive-marquee.css`, which replace the original slideshow with an eight-slide carousel (logo, six club photos, parking; duplicate logo panel for seamless looping) sourced from `static.wixstatic.com`.

## Architecture notes

- Audit logging design: `docs/audit-logging-design.md`
- Website task agents planning: `docs/website-task-agents.md`
- Games catalog (Supabase + optional DB-backed public page): `docs/games-relational-migration-plan.md`
- Games AI enrichment assistant (member editor, Edge Function, rollback): `docs/games-ai-assistant.md`
- Multi-tenant guardrails while building single-tenant features: `docs/multi-tenant-notes.md`
- Dynamic photos foundation (schema, RPCs, Edge Functions, threat model, test plan): `docs/photos-foundation.md`

## Lightweight PR checklist (tenant-safe by default)

Before merging, quickly confirm:

- Ownership is explicit for new/changed data (who owns each record?).
- Read/write access rules are clear (who can read, create, update, delete?).
- Authorization is enforced server-side (RLS/RPC), not only in UI.
- Queries are scoped (avoid broad reads filtered in client code).
- New schema/API work has a clear future path to `tenant_id`.

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
