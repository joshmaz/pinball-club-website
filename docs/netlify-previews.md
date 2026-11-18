# Staging, migration, and release workflow

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

The AWS workflow is triggered only by pushes to `staging` and `main`, or by
manual dispatch against those branches. A Netlify Deploy Preview does not publish
to AWS. Netlify and AWS builds run the static site build; neither applies SQL
migrations nor deploys Supabase Edge Functions.

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

The canonical function source is `cloudfront/clean-url-rewrite.js`. The AWS workflow
publishes it to the existing environment-specific function only when that file
changes (or when the workflow is manually dispatched). `scripts/deploy-cloudfront-function.mjs`
updates the DEVELOPMENT stage, tests the four friendly routes plus an unchanged
HTML route, then publishes the tested version to LIVE. It does not update the
distribution association. Function source changes should be validated on
staging before promotion to `main`. The CloudFormation staging template keeps
the same initial function code for infrastructure creation.

## AWS staging infrastructure

`infrastructure/aws-staging.yaml` defines the isolated staging bucket,
CloudFront distribution and clean-URL function, TLS certificate, noindex
response header policy, and a GitHub OIDC role restricted to the `staging`
branch. The bucket is private, encrypted, and readable through its CloudFront
distribution only.

The stack is deployed in `us-east-1` as `snhpc-staging-site`. Public DNS is
authoritative in Cloudflare; the Route 53 zone in this AWS account is not
authoritative. Add the ACM validation CNAME from the stack's certificate to the
Cloudflare zone as DNS-only, then add a DNS-only CNAME for
`staging.snhpinballclub.com` pointing at the CloudFront domain output. The
CloudFormation template does not create public Route 53 aliases. The GitHub Actions role can list and update only the staging bucket,
invalidate only the staging distribution, and publish only the staging
clean-URL function. `infrastructure/aws-staging.yaml` scopes those function
permissions to that single function ARN. The production role gets equivalent
permissions through `infrastructure/aws-production-cloudfront-function-policy.yaml`;
that separate policy must be applied before a rewrite-source change is merged to
`main`. The staging and production roles and resources remain separate.

## Build configuration and public backend values

Keep Deploy Previews enabled only on the Netlify staging project for
PRs targeting `staging`; disable Deploy Previews on the production project to
avoid duplicate preview deployments. Keep branch deploys disabled. The
`ignore` command in `netlify.toml` also skips production-context and
branch-deploy builds, leaving Netlify for PR previews only.

Scope the public `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the staging
Supabase project in the staging project's Deploy Preview context. Do not provide
service-role, Resend, Stripe secret, or AWS credentials to Netlify builds.
Leave approval requirements for untrusted fork deploys enabled.

Configure these repository Actions secrets for AWS builds:

- `STAGING_SUPABASE_URL` and `STAGING_SUPABASE_ANON_KEY`: public credentials
  for the staging Supabase project.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: public credentials for production.

The workflow uses the staging pair only on `staging` and production pair only
on `main`. `GAMES_CATALOG_SOURCE` is set to `db` in both builds. These are
browser-readable public credentials; never use a Supabase service-role key.

In the staging Supabase project's Authentication → URL Configuration, set the
staging Site URL and allow `https://staging.snhpinballclub.com/**`. If using
Netlify Deploy Previews, also allow the project's
`https://deploy-preview-*--snhpinballclub-staging.netlify.app/**` hostname
pattern. Do not allow all of `netlify.app`. Signing in on the live domain does
not sign a user into another origin.

## Routine review and release workflow

1. Update the local `staging` branch and create a feature branch from it.
2. Open a PR to `staging`. Review its Netlify Deploy Preview, confirm the
   displayed staging banner, and verify the generated Supabase URL before any
   action that writes data.
3. Deploy required migrations and Edge Functions to the staging Supabase
   project as separate reviewed actions. Check the full pending migration list
   and dry run before applying migrations.
4. Merge the feature PR to `staging`. The AWS workflow publishes the static
   site. Verify the persistent staging site and the backend capabilities the
   change needs.
5. Promote `staging` to `main` through a separate release PR. Apply required
   production migrations and Edge Function deployments as separate actions,
   following their reviewed order. Verify production after the release.

### Hosted migration history

The staging project was restored from a database snapshot before repository
migration history was fully reconciled. On November 17, 2026, its migration
ledger contained nine entries, including the recent IPDB reference-data
migration. This is a partial history, not a clean record of every migration
already represented in the restored schema. The production ledger also includes
historical version aliases. A matching migration name or list entry alone does
not prove that the hosted SQL state matches the current repository migration.

Before applying hosted migrations:

1. Confirm the linked project reference and intended environment.
2. Inspect the complete hosted migration list and the SQL each migration would
   apply. Review a dry run for every pending entry.
3. Compare unexpected entries and the relevant hosted schema with the repository
   migration source. Pause for review if the dry run proposes historical work
   that the project already contains.
4. Apply only the reviewed, intended migration set using the established
   environment process. Record the result and verify the required table,
   function, policy, or column afterward.

Do not run the entire historical repository migration chain against the restored
staging project. Do not use migration-history repair to perform schema changes.
Repair is only a record reconciliation after an independently verified
out-of-band change. A new environment needs a separately reviewed baseline or
ordered initialization plan because core member tables predate this repository's
migration chain.

### Staging Edge Function availability

The following inventory was read from Supabase on November 17, 2026. It records
whether a function name was deployed, not whether its code matches the branch,
its secrets are configured, or its authenticated flow works.

| Function absent from staging at review time | Affected check |
| --- | --- |
| `account-delete` | Account deletion |
| `opdb-image-sync` | Manual OPDB image refresh |
| `photo-purge` | Photo unpublish and permanent-delete operations |
| `pintips-import` | PinTips import and refresh |

The staging project also had a `fourthwall-connection-test` function with no
matching function source in this repository. Confirm its owner and lifecycle
before relying on it. Recheck the deployed function list before every release
that depends on one of these capabilities.

## Failure and recovery references

Use the existing component procedure for the failing part of a release:

- **Static build or publish:** inspect the GitHub Actions run for the target
  branch. The workflow syncs the reviewed `dist/` output to that environment.
  A corrected commit or a reviewed prior commit can be deployed through the
  same branch workflow.
- **Friendly routes:** use [AWS clean URL routing](aws-clean-url-routing.md) to
  check the function source, its DEVELOPMENT test, LIVE publication, and
  distribution association. The deploy script does not create or change that
  association.
- **Schema and function behavior:** first confirm the hosted project and inspect
  its migration/function state. The feature guide defines the required ordering
  and any safe retry. A Netlify preview alone does not roll back or update
  either backend component.
- **Public content during a database outage:** [Public snapshots](public-snapshots.md)
  describes runtime fallback and its freshness. The files are public read
  snapshots, not database backups or point-in-time recovery.
- **Incorrect game data:** use the field-level checks in
  [Games AI rollback](games-ai-rollback-runbook.md) and the game catalog's
  audit history.
- **Other data changes:** follow the owning feature's runbook. Event timing,
  Photos, account deletion, publishing delivery, and provider imports each have
  different recovery behavior.

Repository documentation does not establish the current backup schedule,
retention, restore points, or a tested database-and-Storage restore procedure.
Confirm those details in the hosted service before a recovery depends on them.
Do not infer a full database restore from a successful SQL migration or the
presence of a public JSON snapshot.

## First-preview acceptance checks

- Games and Events load database content without missing-config messages.
- Anonymous visitors see Members navigation and no editing controls.
- Sign-in shows My Account; Dashboard and sign-out work on public pages.
- Authorized Game/Event Edit links open the correct item and preserve their
  destination through sign-in.
- Password recovery returns to the preview after its redirect allowlist is set.
- The friendly routes `/donate`, `/store`, `/slideshow`, and
  `/slideshow/play` resolve on Netlify and AWS staging.
- The preview's public Supabase URL points to the staging project before signing
  in, editing, or running any action that can write data.
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
