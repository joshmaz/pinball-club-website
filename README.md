# Pinball Club Website

This is the official website for the Southern New Hampshire Pinball Club. It includes information about events, standings, and more.

## Structure

- `index.html`: Home page
- `events.html`: Upcoming and past events
- `standings.html`: Player standings
- `about.html`: About the club
- `assets/css/styles.css`: Stylesheet
- `assets/js/`: JavaScript files (to be added)
- `assets/images/`: Images
- `assets/images-machines/`: Machine images
- `data/events.json`: Event data

## Deployment

This site is set up to deploy automatically to GitHub Pages via the workflow in `.github/workflows/deploy.yml`.

## Secrets and local configuration

Supabase URL and the anon key are **not** committed. They are written into `assets/js/config.js` by `scripts/write-config.mjs` before deploy or when you work locally.

1. In the GitHub repo, open **Settings → Secrets and variables → Actions** and add:
   - `SUPABASE_URL` — project URL (e.g. `https://xxxx.supabase.co`)
   - `SUPABASE_ANON_KEY` — anon/public key from Supabase **Project Settings → API**

2. On each push to `main`, the deploy workflow generates `assets/js/config.js` from those secrets, then publishes the site.

3. For **local development**, copy `.env.example` to `.env`, fill in the same two values, then run:

   ```bash
   node --env-file=.env scripts/write-config.mjs
   ```

   The file `assets/js/config.js` is gitignored. If it is missing, pages that use Supabase will log a console error until you run the command above.

**Note:** The anon key is still exposed to browsers after build (that is normal for Supabase). Protect data with Row Level Security in Supabase. Never put the **service role** key in the frontend or in these repository secrets for this workflow.
