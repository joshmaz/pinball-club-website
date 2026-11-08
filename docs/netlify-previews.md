# Netlify previews and review workflow

AWS S3 + CloudFront currently publishes on pushes to `main`. The Netlify
`snhpinballclub` project tracks `main`; the separate
`snhpinballclub-staging` project tracks `staging`. Deploy Previews are for reviewing frontend changes. A preview does not create
an isolated backend: authenticated writes go to the Supabase project selected by
the environment variables available to that deploy. The staging project currently
identifies its database as staging.

## Build configuration

`netlify.toml` pins Node 22, runs `node scripts/build-site.mjs`, and publishes
`dist/`. The shared builder runs all `scripts/*.test.mjs` tests and the Events
duplicate check, validates public snapshots, then generates public Supabase
configuration. Missing configuration fails the build instead of silently
shipping an unauthenticated preview.

Only root HTML/favicon files, `assets/`, `wix_archive/`, and the four selected
runtime JSON files (Games, Events, Highlights, Resources) are copied. Repository
internals, maintenance datasets, environment files, and symlinks are excluded or
rejected. Existing local `assets/js/config.js` is not copied or modified.

Deploy Previews and branch builds receive `noindex` headers and a blocking
robots file. The staging project's `staging` branch receives the same protections
even though Netlify reports it as a production context. The `main` production
branch retains the repository's normal robots file.
Pretty URLs are disabled to preserve the `.html` routes used by authentication
and editor deep links.

## One-time Netlify settings

In Project configuration → Developer settings:

- Repository: `joshmaz/pinball-club-website`.
- Production project branch: `main`.
- Staging project branch: `staging`.
- Enable Deploy Previews on the staging project for pull requests targeting
  `staging`; keep production deploys tied to `main`.
- Branch deploys are optional; the staging branch deploy is useful as a persistent
  review environment.
- Build command and publish directory come from the checked-in configuration.

In Environment variables, scope these public build values to the intended
backend for each deploy context:

- Staging project: staging Supabase URL and anon/publishable key for Deploy
  Previews and the `staging` branch deploy.
- Production Netlify project: live Supabase URL and anon/publishable key for the
  `main` production deploy.
- Verify the effective `SUPABASE_URL` for each deploy context before testing.
  These public credentials are intentionally browser-readable.
- `GAMES_CATALOG_SOURCE`: `db` (also the Netlify configuration default).

These are intentionally browser-readable. Do not add service-role, Resend, Stripe
secret, or AWS credentials. Leave approval requirements for untrusted fork
deploys enabled. No Supabase migrations or Edge Functions are deployed by this
build.

## Supabase authentication redirects

Keep the production Site URL. In Authentication → URL Configuration, add this
additional redirect URL for this Netlify project's PR previews:

```text
https://deploy-preview-*--snhpinballclub-staging.netlify.app/**
```

This is scoped to the project's preview hostnames. Do not allow all of
`netlify.app`. If branch deploys are enabled later, configure their hostnames
separately. Password recovery already requests a redirect to the current origin's
`members.html`. Signup confirmation currently uses Supabase's default Site URL;
it is expected to return to production before the user signs into a preview.

Signing in on the live domain does not sign a user into the preview origin.
Use an existing account to verify the preview. First confirm the preview's
configured `SUPABASE_URL` and its staging banner; edits, uploads, and membership
changes affect whichever database that URL identifies. Avoid destructive tests
until the target is confirmed.

## Routine review workflow

1. Create a feature branch from `staging`, implement, and run checks.
2. Push it and open a PR against `staging`.
3. Review the staging project's Deploy Preview and the persistent staging site.
4. Check public pages and relevant authenticated behavior without saving live data.
5. Push feedback fixes to the same branch; the preview updates with the PR.
6. After approval, merge into `staging`.
7. Promote `staging` to `main` through a separate release PR. Until the hosting
   decision changes, only `main` triggers the AWS production deploy.

Commit/push happens before previewing. Merge remains the approval point.

## First-preview acceptance checks

- Games and Events load database content without missing-config messages.
- Anonymous visitors see Members navigation and no editing controls.
- Sign-in shows My Account; Dashboard and sign-out work on public pages.
- Authorized Game/Event Edit links open the correct item and preserve their
  destination through sign-in. Avoid saving unnecessary changes to live data.
- Password recovery returns to the preview after the redirect allowlist update.
- The friendly routes `/donate`, `/store`, `/slideshow`, and `/slideshow/play` resolve.
- Homepage photo content and `wix_archive/index.html` load or redirect to the independent archive.
- `/scripts/build-site.mjs`, `/supabase/config.toml`, `/.env`, and `/README.md`
  are not published.

## Local preview build

With Node 22 installed and public credentials in `.env`:

```bash
GAMES_CATALOG_SOURCE=db node --env-file=.env scripts/build-site.mjs
python3 -m http.server 8080 --directory dist
```

The local server checks the generated files; Netlify-specific redirects/headers
must also be checked on the deployed preview. This work does not refresh static
JSON snapshots; that is the next separate roadmap item.

References: [Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/),
[file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/),
[Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
