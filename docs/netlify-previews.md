# Netlify previews and review workflow

AWS S3 + CloudFront deployment still runs when `main` changes. Netlify's existing
`snhpinballclub` project is connected to this repository and builds PR previews
against `main`. A preview isolates frontend code, **not database writes**.

## Build configuration

`netlify.toml` pins Node 22, runs `node scripts/build-preview.mjs`, and publishes
`dist/`. The script runs all `scripts/*.test.mjs` tests and the Events duplicate
check, then generates public Supabase configuration using the same generator as
the AWS build. Missing configuration fails the build instead of silently shipping
an unauthenticated preview.

Only root HTML/favicon files, `assets/`, `donate/`, `wix_archive/`, and the four
runtime JSON files (Games, Events, Highlights, Resources) are copied. Repository
internals, maintenance datasets, environment files, and symlinks are excluded or
rejected. Existing local `assets/js/config.js` is not copied or modified.

Preview and branch builds receive `noindex` headers and a blocking robots file.
The Netlify production context retains the repository's normal robots file.
Pretty URLs are disabled to preserve the `.html` routes used by authentication
and editor deep links. `/donate` redirects to `/donate/`.

## One-time Netlify settings

In Project configuration → Developer settings:

- Repository: `joshmaz/pinball-club-website`.
- Production branch: `main`.
- Deploy Previews: any pull request against the production branch.
- Branch deploys: optional; not needed for the PR workflow.
- Build command and publish directory come from the checked-in configuration.

In Environment variables, set these public build values for Deploy Previews and
production (the same build also runs for the existing Netlify main deployment):

- `SUPABASE_URL`: the same project URL used by the live site.
- `SUPABASE_ANON_KEY`: the live site's public anon/publishable key.
- `GAMES_CATALOG_SOURCE`: `db` (also the Netlify configuration default).

These are intentionally browser-readable. Do not add service-role, Resend, Stripe
secret, or AWS credentials. Leave approval requirements for untrusted fork
deploys enabled. No Supabase migrations or Edge Functions are deployed by this
build.

## Supabase authentication redirects

Keep the production Site URL. In Authentication → URL Configuration, add this
additional redirect URL for this Netlify project's PR previews:

```text
https://deploy-preview-*--snhpinballclub.netlify.app/**
```

This is scoped to the project's preview hostnames. Do not allow all of
`netlify.app`. If branch deploys are enabled later, configure their hostnames
separately. Password recovery already requests a redirect to the current origin's
`members.html`. Signup confirmation currently uses Supabase's default Site URL;
it is expected to return to production before the user signs into a preview.

Signing in on the live domain does not sign a user into the preview origin.
Use an existing account to verify the preview. With the shared Supabase project,
editing games/events, uploading photos, and changing memberships affects live
data. Use a separate staging project before testing destructive workflows or
incompatible schema changes.

## Routine review workflow

1. Create a feature branch, implement, and run checks.
2. Commit, push, and open a draft PR against `main`.
3. Wait for the Netlify Deploy Preview check. Open its URL from the PR.
4. Review public pages and relevant authenticated behavior in that preview.
5. Push feedback fixes to the same branch; the same preview URL updates.
6. After user approval and passing checks, merge the PR.
7. Verify the AWS production deploy and the changed behavior on the live site.

Commit/push happens before previewing. Merge remains the approval point.

## First-preview acceptance checks

- Games and Events load database content without missing-config messages.
- Anonymous visitors see Members navigation and no editing controls.
- Sign-in shows My Account; Dashboard and sign-out work on public pages.
- Authorized Game/Event Edit links open the correct item and preserve their
  destination through sign-in. Avoid saving unnecessary changes to live data.
- Password recovery returns to the preview after the redirect allowlist update.
- Homepage photo content, `/donate/`, and `wix_archive/index.html` render.
- `/scripts/build-preview.mjs`, `/supabase/config.toml`, `/.env`, and `/README.md`
  are not published.

## Local preview build

With Node 22 installed and public credentials in `.env`:

```bash
GAMES_CATALOG_SOURCE=db node --env-file=.env scripts/build-preview.mjs
python3 -m http.server 8080 --directory dist
```

The local server checks the generated files; Netlify-specific redirects/headers
must also be checked on the deployed preview. This work does not refresh static
JSON snapshots; that is the next separate roadmap item.

References: [Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/),
[file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/),
[Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
