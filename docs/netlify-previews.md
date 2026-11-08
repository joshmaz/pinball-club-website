# Staging and review workflow

AWS S3 + CloudFront host both persistent environments:

- Pushes to `staging` publish the staging site at
  [staging.snhpinballclub.com](https://staging.snhpinballclub.com).
- Pushes to `main` publish production at
  [snhpinballclub.com](https://snhpinballclub.com).
- Netlify is retained for pull request Deploy Previews targeting `staging`.

Netlify's `ignore` command stops production-context and branch-deploy builds,
so the persistent staging branch does not consume a Netlify deployment. Deploy
Previews still build. A Deploy Preview isolates frontend code, not backend
writes: authenticated writes go to the Supabase project selected by that deploy's
public URL and anon/publishable key.

## Shared public build

`netlify.toml` and the AWS workflow both run `node scripts/build-site.mjs`
with Node 22 and publish only `dist/`. The builder runs all
`scripts/*.test.mjs` tests and the Events duplicate check, validates public
snapshots, and generates public Supabase configuration. Missing configuration
fails the build.

Only root HTML/favicon files, `assets/`, `wix_archive/`, and the four selected
runtime JSON files (Games, Events, Highlights, Resources) are copied. Repository
internals, maintenance datasets, environment files, and symlinks are excluded or
rejected. Existing local `assets/js/config.js` is not copied or modified.

The staging build is noindexed through a blocking `robots.txt`, an
`X-Robots-Tag` response header, and the generated staging config. Production
uses the repository's normal robots file. Netlify redirects and the AWS
CloudFront Function map `/donate`, `/store`, `/slideshow`, and
`/slideshow/play` to their corresponding HTML objects. Pretty URLs remain
disabled to preserve the `.html` routes used by authentication and editor
deep links.

## AWS staging infrastructure

`infrastructure/aws-staging.yaml` defines the isolated staging bucket,
CloudFront distribution and clean-URL function, TLS certificate and DNS
records, noindex response header policy, and a GitHub OIDC role restricted to
the `staging` branch. The bucket is private, encrypted, and readable through
its CloudFront distribution only.

The stack is deployed in `us-east-1` as `snhpc-staging-site`. The staging
GitHub Actions role can list and update only the staging bucket, and invalidate
only the staging distribution. The existing production role and production AWS
resources stay separate.

## Build configuration and public backend values

In the Netlify staging project, keep Deploy Previews enabled for PRs targeting
`staging`. Scope the public `SUPABASE_URL` and
`SUPABASE_ANON_KEY` to the staging Supabase project in the Deploy Preview
context. Do not provide service-role, Resend, Stripe secret, or AWS credentials
to Netlify builds. Leave approval requirements for untrusted fork deploys
enabled.

Configure these repository Actions secrets for AWS builds:

- `STAGING_SUPABASE_URL` and `STAGING_SUPABASE_ANON_KEY`: public credentials
  for the staging Supabase project.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: public credentials for production.

The workflow uses the staging pair only on `staging` and production pair only
on `main`. `GAMES_CATALOG_SOURCE` remains `db`. These are browser-readable
public credentials; never use a Supabase service-role key.

In the staging Supabase project's Authentication → URL Configuration, set the
staging Site URL and allow `https://staging.snhpinballclub.com/**`. If using
Netlify Deploy Previews, also allow the project's
`https://deploy-preview-*--snhpinballclub-staging.netlify.app/**` hostname
pattern. Do not allow all of `netlify.app`. Signing in on the live domain does
not sign a user into another origin.

## Routine review and release workflow

1. Create a feature branch from `staging`, implement, and run checks.
2. Open a PR against `staging`; review its Netlify Deploy Preview.
3. Check public pages and relevant authenticated behavior without saving live
   data. Confirm the preview's Supabase URL and staging banner first.
4. Push feedback fixes to the same feature branch; the PR preview updates.
5. Merge into `staging` to publish the shared build to the AWS staging site.
6. Verify the persistent staging site, including friendly URLs and authenticated
   behavior.
7. Promote `staging` to `main` through a separate release PR. Production
   publishes only after that PR is approved and merged.

No Supabase migrations or Edge Functions are deployed by this static site build.

## First-preview acceptance checks

- Games and Events load database content without missing-config messages.
- Anonymous visitors see Members navigation and no editing controls.
- Sign-in shows My Account; Dashboard and sign-out work on public pages.
- Authorized Game/Event Edit links open the correct item and preserve their
  destination through sign-in.
- Password recovery returns to the preview after its redirect allowlist is set.
- The friendly routes `/donate`, `/store`, `/slideshow`, and
  `/slideshow/play` resolve on Netlify and AWS staging.
- Homepage photo content and `wix_archive/index.html` load or redirect to the
  independent archive.
- `/scripts/build-site.mjs`, `/supabase/config.toml`, `/.env`, and
  `/README.md` are not published.

## Local preview build

With Node 22 installed and public credentials in `.env`:

```bash
GAMES_CATALOG_SOURCE=db node --env-file=.env scripts/build-site.mjs
python3 -m http.server 8080 --directory dist
```

The local server checks generated files; Netlify-specific redirects must also
be checked on a Deploy Preview. The build does not refresh static JSON snapshots;
that is a separate roadmap item.

References: [Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/),
[Netlify build configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/),
[Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
