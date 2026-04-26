# Southern New Hampshire Pinball Club Website

Public website and member portal for SNHPC. The site is static-first (GitHub Pages), with Supabase for auth/member data and Stripe planned for subscription billing lifecycle.

## Current status

- Public pages are live: `index.html`, `events.html`, `games.html`, `about.html`, `resources.html`, `donate.html`, and `merch.html`.
- Member access is live through `signin.html` and `members.html` with Supabase Auth.
- Member portal includes:
  - sign up / sign in / sign out
  - profile editing (`first_name`, `last_name`, `display_name`, IFPA/Stern fields)
  - password reset and recovery flow
  - role-aware navigation and member admin tools for authorized roles
- Home page media is data-driven (highlights/gallery JSON + image assets).

## Architecture

Frontend (static HTML/CSS/vanilla JS)
-> Supabase (Auth + Postgres with RLS)
-> Stripe (billing/subscription source of truth, integration in progress)

Keep concerns separate:
- Supabase Auth: identity, sessions, and user metadata
- Supabase DB: member profile and role/membership state used by the UI
- Stripe: payment events and recurring billing lifecycle

## Repository layout

- `index.html`, `events.html`, `games.html`, `about.html`, `resources.html`, `donate.html`, `merch.html` - public-facing pages
- `signin.html` - sign in / sign up / password reset entry point
- `members.html` - authenticated member portal
- `assets/css/styles.css` - shared site styling
- `assets/js/supabase-init.js` - Supabase client bootstrap from runtime config
- `assets/js/member-portal.js` - auth/session, profile, membership, and role management logic
- `assets/js/home-gallery.js` + `assets/js/home-highlights.js` - homepage media rendering
- `assets/js/events.js`, `assets/js/games.js`, `assets/js/resources.js` - page-specific data rendering
- `data/events.json`, `data/games.json`, `data/resources.json`, `data/highlights.json` - content/data sources
- `supabase/migrations/` - schema + RPC migrations
- `scripts/` - helper scripts for config generation and content sync/build tasks

## Local development

No build step is required for the static site itself; pages can be opened directly or served with any local static server.

Supabase-backed pages require a generated runtime config file:

1. Copy `.env.example` to `.env`.
2. Set:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. Generate config:

```bash
node --env-file=.env scripts/write-config.mjs
```

This writes `assets/js/config.js` (gitignored). Without it, auth/member features gracefully fail as unavailable.

## Deployment (GitHub Pages)

Deploy is handled by `.github/workflows/deploy.yml` on pushes to `main`.

Workflow steps:
- checkout repository
- setup Node 20
- run `node scripts/write-config.mjs` using GitHub Actions secrets
- publish the repository root to GitHub Pages

Required repository secrets:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## Supabase notes

- Browser code uses the Supabase anon key (expected/public).
- Never expose service role keys in frontend code or Actions secrets intended for static deploys.
- Use Row Level Security for all sensitive tables.
- Member role management is implemented via `member_roles` + admin RPCs in `supabase/migrations/`.

## Supabase CLI workflow (hosted)

Use migration files as the source of truth across all workstations.

1. Install CLI and authenticate once:
   - `supabase login`
2. Link this repo to the hosted project (run from repo root):
   - `supabase link --project-ref <project-ref>`
3. For schema changes:
   - add SQL migration files under `supabase/migrations/`
   - apply to hosted with `supabase db push`
4. Verify migration parity:
   - `supabase migration list --linked`

Rules:
- Do not edit migration files that were already applied; create a new forward migration.
- If schema was applied manually and history drift occurs, reconcile ledger only:
  - `supabase migration repair --linked --status applied <versions...>`
- Use `migration repair` only for migration history reconciliation, not for making schema changes.

## Content and data workflows

- Events and games are primarily data-driven from JSON in `data/`.
- Helper scripts in `scripts/` support external sync/enrichment workflows (for example Facebook or PinballMap sync).
- Home highlights are controlled by `data/highlights.json` and corresponding files under `assets/images/highlights/`.

### Events migration to Supabase

The public `events.html` page now prefers reading from `public.events` in Supabase and falls back to `data/events.json` if Supabase is unavailable.

To backfill historical events from `data/events.json` into Supabase:

1. Apply migrations (`supabase db push`) so `public.events` includes `legacy_import_key` and related columns.
2. Run the import script with service-role credentials:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-events-json-to-supabase.mjs
```

Optional dry run:

```bash
DRY_RUN=true SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-events-json-to-supabase.mjs
```

To prevent duplicate legacy entries from being reintroduced into `data/events.json`, run:

```bash
node scripts/check-events-duplicates.mjs
```

This check also runs in the GitHub Pages deploy workflow and fails deploy if duplicates are found (duplicate key = `title/name + date`).
