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

## Content and data workflows

- Events and games are primarily data-driven from JSON in `data/`.
- Helper scripts in `scripts/` support external sync/enrichment workflows (for example Facebook or PinballMap sync).
- Home highlights are controlled by `data/highlights.json` and corresponding files under `assets/images/highlights/`.
