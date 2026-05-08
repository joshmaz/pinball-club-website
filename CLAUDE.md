# CLAUDE.md — AI Assistant Guide for SNH Pinball Club Website

---

# 🎯 What This Project Does

This project powers the **Southern New Hampshire Pinball Club website and member system**.

It includes:

- Public website (events, gallery, donate, info)
- Member authentication (signup/login)
- Member profiles
- Subscription-based membership management
- Integration with external tools (Discord, MatchPlay, etc.)

The system is designed to be:

- Low-cost
- Portable
- Simple to maintain
- Extensible over time

---

# 🧭 System Architecture

Frontend (Static Site)
   ↓
Supabase (Auth + Database)
   ↓
Stripe (Subscriptions + Billing)

---

# 🏗️ Tech Stack

- HTML / CSS / Vanilla JavaScript
- GitHub (source control)
- AWS S3 + CloudFront (primary hosting)
- Supabase (auth + database; games catalog tables + `games_catalog_v1` when using DB mode — see `docs/games-relational-migration-plan.md`)
- Stripe (payments)

Optional:
- Netlify (preview deploys only)

---

# 📁 Project Structure

snh-pinball-club-site/
├── CLAUDE.md
├── README.md
├── index.html
├── donate.html
├── members.html
├── login.html
├── signup.html
├── assets/
├── css/
├── js/
│   ├── auth.js
│   ├── api.js
│   └── main.js
├── supabase/
│   └── migrations/
│       └── (Postgres DDL, e.g. member_roles)
└── data/
    └── events.json

---

# 🧠 Core Data Model (Supabase)

## profiles

id UUID PRIMARY KEY REFERENCES auth.users(id)
email TEXT
display_name TEXT
created_at TIMESTAMP

---

## memberships

id UUID PRIMARY KEY
user_id UUID REFERENCES profiles(id)

status TEXT
-- values: active, canceled, past_due, inactive

tier TEXT
-- values: standard

stripe_customer_id TEXT
stripe_subscription_id TEXT

current_period_end TIMESTAMP
created_at TIMESTAMP

---

## member_roles

RBAC for the **member portal** (`members.html`): which extra sidebar sections (Events, Photos, Games, **Members** admin, etc.) are shown. The browser loads slugs via `SNHMemberPortal.fetchMemberRoles(userId)` in `assets/js/member-portal.js`, which resolves `members.id` for the signed-in user and reads `member_roles` by `member_id`.

**Columns**

- `id` UUID PRIMARY KEY (default `gen_random_uuid()`)
- `member_id` UUID NOT NULL REFERENCES `members(id)` ON DELETE CASCADE
- `role_slug` TEXT NOT NULL — e.g. `membership_editor`, `membership_admin`, `events_editor`, `events_admin`, `games_editor`, `games_admin`, `club_admin` (lowercase `^[a-z][a-z0-9_]*$`)
- `granted_at` TIMESTAMPTZ NOT NULL (default now())

**Constraints**

- UNIQUE (`member_id`, `role_slug`)

**RLS**

- `authenticated` may **SELECT** only rows where the linked `members.user_id` equals `auth.uid()`.
- There is **no** direct INSERT/UPDATE/DELETE policy on `member_roles` for `authenticated` clients (writes go through **SECURITY DEFINER** RPCs below, or privileged SQL / service role for bootstrapping).

**Migrations**

- `supabase/migrations/20260423190000_create_member_roles.sql` — table + RLS.
- `supabase/migrations/20260423203000_member_admin_rpcs.sql` — admin RPCs for the **Members** panel.

**Member admin RPCs** (`members.html` → `SNHMemberPortal.*`)

Callable by `authenticated` users who already have **`membership_editor`**, **`membership_admin`**, or **`club_admin`** on their own `member_roles` rows (checked inside each function).

| RPC | Purpose |
|-----|---------|
| `snh_member_can_manage_roles()` | Returns boolean; used internally / for debugging. |
| `snh_get_member_admin_stats()` | JSON: member count, membership row counts, active memberships, role-assignment count. |
| `snh_list_members_for_admin()` | JSON array: each member `member_id`, `email`, `display_name`, `role_slugs[]`. |
| `snh_grant_member_role(p_member_id, p_role_slug)` | Inserts role (idempotent on conflict). |
| `snh_revoke_member_role(p_member_id, p_role_slug)` | Deletes role row. |

Assignable slugs from the portal UI are listed in `SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES` in `member-portal.js` (must stay compatible with the `member_roles` check constraint).

**Bootstrap first admin**

- Still use SQL Editor (service role): `INSERT INTO member_roles …` for at least one `club_admin` (or a temporary `membership_admin`) row for an initial operator.

**Slug alignment**

- Use the same slugs as `data-rbac-roles` on nav items in `members.html` (comma-separated = any match). UI gating is not a security boundary; protect sensitive data/APIs with RLS and server-side checks.

---

# 🔐 Authentication Rules

- Use Supabase Auth
- Automatically create profile on signup
- Never store passwords manually

---

# 💳 Subscription Model

- Stripe handles all billing
- No custom billing logic

Flow:
User signs up → Supabase Auth
User subscribes → Stripe Checkout
Webhook → updates membership

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
- Use Stripe for billing
- Create/use a feature branch for all work, then open a PR before merging to `main`

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

1. Create or switch to a feature branch (never commit on `main`)
2. Edit locally
3. Commit
4. Push branch
5. Open PR and review
6. Verify
7. Iterate

---

# 🗃️ Supabase Migration Workflow (CLI)

- Use Supabase CLI + `supabase/migrations/*.sql` as the source of truth for schema changes.
- Run CLI from repo root and ensure project is linked:
  - `supabase login`
  - `supabase link --project-ref <project-ref>`
- Apply hosted schema changes with:
  - `supabase db push`
- Validate parity with:
  - `supabase migration list --linked`

Guardrails:
- Never edit an already-applied migration; add a new forward migration.
- Do not rely on ad-hoc SQL as normal workflow.
- Use `supabase migration repair --linked --status applied ...` only to reconcile migration history after manual/out-of-band applies; do not use it to perform schema changes.

---

# 🔐 Environment Variables

SUPABASE_URL=
SUPABASE_ANON_KEY=
STRIPE_PUBLIC_KEY=

(optional backend)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

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
- Be specific and helpful for unfinished workflows rather than vague (e.g. "Billing self-service is not connected yet. Email us and we'll help with your record.").

---

# 🔮 Future Enhancements

- Discord role sync
- MatchPlay integration
- Admin dashboard
- Member directory

---

# 🧠 AI Guidance

- Prefer simple solutions
- Avoid new infrastructure
- Extend existing patterns
