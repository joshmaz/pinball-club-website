# CLAUDE.md — AI Assistant Guide for SNH Pinball Club Website

---

# 🎯 What This Project Does

This project powers the **Southern New Hampshire Pinball Club website and member system**.

It includes:

- Public website (events, gallery, donate, info)
- Member authentication, account profiles, and staff-maintained membership state
- Role-gated member tools for events, photos, games, publishing, and operations
- Integrations with Pinball Map, MatchPlay, OPDB, IPDB, Kineticist, PinTips,
  Discord, Umami, and Resend

The system is designed to be:

- Low-cost
- Portable
- Simple to maintain
- Extensible over time

---

# 🧭 System Architecture

Frontend (Static Site)
   ↓
AWS S3 + CloudFront (Production and staging)
   ↓
Supabase (Auth, Database, Storage, Edge Functions)
   ↓
Resend (Auth SMTP and configured app email)

---

# 🏗️ Tech Stack

- HTML / CSS / Vanilla JavaScript
- GitHub (source control)
- AWS S3 + CloudFront (primary hosting)
- Supabase (auth + database; games catalog tables + `games_catalog_v1` when using DB mode — see `docs/games-relational-migration-plan.md`)
- Resend (transactional email; Supabase Auth sends via Resend SMTP — see `docs/email.md`)

Optional:
- Netlify (preview deploys only)

---

# 📁 Project Structure

Repository areas:

- Root HTML files contain public pages, sign-in, and the member portal.
- `assets/css/`, `assets/js/`, and `assets/images/` contain browser assets.
- `data/` contains public snapshots and static content.
- `scripts/` contains build, import, validation, and maintenance tools.
- `supabase/functions/` and `supabase/migrations/` contain backend source.
- `cloudfront/` and `infrastructure/` contain AWS routing and staging setup.
- `docs/` contains feature, operator, and historical documentation.

---

# 🧠 Core Data Model (Supabase)

The current Auth-to-member identity, membership status, external accounts, and
role assignment model are described in the [README](README.md),
[member identity guide](docs/member-identity.md), and
[canonical role policy](docs/website-roles-and-authorization-policy.md).
Membership records are maintained by club staff. Stripe Checkout, subscription
IDs, and payment webhooks are not part of the current implementation.

## member_roles

RBAC for the **member portal** (`members.html`): which extra sidebar sections (Events, Photos, Games, **Members** admin, etc.) are shown. The browser loads slugs via `SNHMemberPortal.fetchMemberRoles(userId)` in `assets/js/member-portal.js`, which resolves `members.id` for the signed-in user and reads `member_roles` by `member_id`.

**Columns**

- `id` UUID PRIMARY KEY (default `gen_random_uuid()`)
- `member_id` UUID NOT NULL REFERENCES `members(id)` ON DELETE CASCADE
- `role_slug` TEXT NOT NULL — canonical role identifier (lowercase `^[a-z][a-z0-9_]*$`)
- `granted_at` TIMESTAMPTZ NOT NULL (default now())

**Constraints**

- UNIQUE (`member_id`, `role_slug`)
- `role_slug` must match the identifier format and one of the eleven canonical assignable roles after the Publishing role migration. Derived Website Volunteer status is not stored.

**RLS**

- `authenticated` may **SELECT** only rows where the linked `members.user_id` equals `auth.uid()`.
- There is **no** direct INSERT/UPDATE/DELETE policy on `member_roles` for `authenticated` clients (writes go through **SECURITY DEFINER** RPCs below, or privileged SQL / service role for bootstrapping).

The table and effective-role rules evolve through forward migrations. See the
[canonical role policy](docs/website-roles-and-authorization-policy.md) and
the hosted migration-history guidance in `docs/netlify-previews.md` before
making a database change.

**Member admin RPCs** (`members.html` → `SNHMemberPortal.*`)

Ordinary membership RPCs remain available to authenticated Membership Editors, Membership Admins, and Website Administrators. Despite its name, `snh_member_can_manage_roles()` is the general membership-access helper; do not narrow it to implement delegation policy.

Grant and revoke RPCs additionally call `snh_member_can_assign_role(text)`: Membership Editor cannot delegate any role; Membership Admin may delegate Membership Editor and Events/Photos/Games Editor and Admin; only Website Administrator (`club_admin`) may delegate Membership Admin or Website Administrator. Existing self-removal and last-Website-Administrator triggers remain authoritative. See [delegation migration](supabase/migrations/20260928200000_membership_role_delegation.sql).

| Role assignment and member administration RPCs | Check current definitions in `supabase/migrations/` and the [canonical role policy](docs/website-roles-and-authorization-policy.md). |

`SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES` derives from assignable entries in `SNHSiteAuth.ROLE_CATALOG`. Keep these entries aligned with the SQL role allowlist and canonical role constraint. The table enforces both slug format and canonical identifiers, including for privileged writes. Unknown identifiers and derived `website_volunteer` status cannot be persisted. Website Volunteer/helper authority requires a recognized assignable role.

Before applying [canonical persisted-role hardening](supabase/migrations/20260928220000_canonical_persisted_member_roles.sql), run its commented read-only inventory query. Existing noncanonical assignments cause constraint validation to fail and require explicit review; the migration does not translate or delete them.

**Bootstrap first admin**

- Still use SQL Editor (service role): `INSERT INTO member_roles …` for at least one `club_admin` (or a temporary `membership_admin`) row for an initial operator.

**Slug alignment**

- Use the same slugs as `data-rbac-roles` on nav items in `members.html` (comma-separated = any match). UI gating is not a security boundary; protect sensitive data/APIs with RLS and server-side checks.

---

# 🔐 Authentication Rules

- Use Supabase Auth
- Use the current Auth-to-member identity workflow
- Never store passwords manually

---

# 💳 Membership and billing boundary

- Club staff maintain membership status in the member tools.
- The website does not process dues, manage subscriptions, or receive payment
  provider webhooks.
- Do not add payment collection or provider-specific subscription behavior
  without an approved product plan and server-side authorization design.

---

# 🚨 Critical Rules

DO NOT:
- Build custom billing
- Store payment data
- Overengineer backend
- Commit directly to `main`

DO:
- Keep logic simple
- Use Supabase for membership state
- Keep membership administration consistent with the current staff-maintained
  model; do not assume a payment integration exists.
- Start feature branches from `staging`; merge feature PRs to `staging`, then
  promote reviewed staging to `main` through a separate release PR. See
  `docs/netlify-previews.md`.

---

# 🧩 Frontend Conventions

HTML:
- Semantic structure

CSS:
- Simple, centralized

JS:
- Vanilla only
- Small modules

---

# 🔄 Development Workflow

1. Update `staging` and create a feature branch from it
2. Edit locally
3. Commit
4. Push branch
5. Open a PR targeting `staging` and review its preview
6. Apply and verify any required database migration or Edge Function on staging
7. Verify the persistent staging site, then promote staging with a release PR
   to `main`

---

# 🗃️ Supabase Migration Workflow (CLI)

- Use `supabase/migrations/*.sql` as the reviewed source for schema changes.
- Before any hosted migration command, identify the target project explicitly
  and inspect `supabase migration list --linked`. Compare its actual schema and
  recorded history with the repository migrations. Staging was restored from a
  database snapshot and has a partial historical migration ledger. Production
  also contains historical version aliases. See `docs/netlify-previews.md` for
  the audited state and environment workflow.
- Run CLI from the repository root and link only after confirming the target:
  - `supabase login`
  - `supabase link --project-ref <project-ref>`
- Review the complete pending migration list and a dry run before applying any
  migration. `supabase db push` applies every migration the CLI considers
  pending for the linked project. Do not use it to replay the repository's full
  history onto the restored staging database.
- Apply a reviewed migration set only after confirming that each migration is
  intended for that environment. Recheck the hosted schema and migration list.

Guardrails:
- Never treat migration-list equality as proof of schema equality. A restored
  baseline or an out-of-band migration may need explicit schema comparison.
- Never edit an already-applied migration; add a new forward migration.
- Do not rely on ad-hoc SQL as normal workflow.
- Use `supabase migration repair --linked --status applied ...` only to reconcile migration history after manual/out-of-band applies; do not use it to perform schema changes.
- Migration filenames use a version prefix `YYYYMMDDHHMMSS` for **sort order only**, not as a literal “run at this instant.” Prefer stepping **time of day** (hours or minutes) on the **same calendar day** as the latest existing migration (for example one hour after `…23100000_*.sql` use `…23110000_*.sql`) instead of jumping several calendar days ahead, unless you have a deliberate reason for a gap.

---

# 🔐 Environment Variables

Use `.env.example` for local public configuration and optional scripts. See
`docs/email.md` for Resend SMTP and app email configuration. Do not add Stripe
credentials: billing integration is not implemented.

---

# ⚠️ Constraints

- Lightweight
- No unnecessary dependencies
- Fast load times
- Mobile friendly

---

# 🧭 Tone

- Friendly
- Community-driven
- Slightly playful

# ✍️ Copy & Writing Style

- Stop using em dashes (`—` / `&mdash;`) in user-facing copy and in assistant prose. Prefer a comma, period, parentheses, or a colon instead.
- Avoid rollout/backend language in user copy (e.g. "as we roll out", "when those systems go live", "RBAC", "role slugs").
- Be specific and helpful for unfinished workflows rather than vague (e.g. "Billing self-service is not connected yet. Email support@snhpinballclub.com and we'll help with your record.").

---

# 🔮 Future Enhancements

- Branded Supabase Auth email templates (see `docs/email.md`)
- Automated public-data snapshot refresh
- Future tenant-scoped deployment (see `docs/multi-tenant-notes.md`)

---

# 🧠 AI Guidance

- Prefer simple solutions
- Avoid new infrastructure
- Extend existing patterns
- Games catalog **propose-only** enrichment (Edge Function, portal UI, audit): see `docs/games-ai-assistant.md`
