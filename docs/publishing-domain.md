# Publishing authorization foundation

This change adds an independent Publishing domain for homepage announcements
(What's New) and featured activities (What's Happening). The authorization foundation is followed by the announcements workflow
documented below. Featured activities remain a separate phase.

## Roles and boundaries

`publishing_editor` maintains announcements and activities, including drafts,
preview, publication, scheduling, withdrawal, archiving, and ordering when those
operations ship. `publishing_admin` inherits Editor and adds reserved actions
such as permanent deletion. Website Administrator inherits Publishing Admin.

Membership Admin and Website Administrator may assign or revoke either
Publishing role. Publishing Admin cannot delegate roles or manage memberships.
New grants still require confirmed email in Supabase Auth. Basic membership can
hold either role; paid membership is independent of website responsibilities.

Publishing assignments derive Website Volunteer status and existing general
Club & machine notes helper access. They confer no Events, Photos, Games,
Membership, Operations, or website-wide administrative permissions.

The public helpers `snh_member_has_publishing_access()` and
`snh_member_has_publishing_admin_access()` are caller-scoped, stable, restricted
security-definer functions. The browser exposes `publishing.manage` and
`publishing.delete` for presentation; future content writes must enforce the
same distinction through RLS or restricted RPCs. Neither a hidden button nor
the browser's role catalog is an authorization boundary.

## Audit and migration behavior

The forward migration changes the literal persisted-role constraint, assignment
allowlist, private effective-role hierarchy, and new domain helpers. Existing
public caller authorization, delegation, email-verification checks, audit
triggers, and self/last-administrator protections remain in place.

No roles are assigned or revoked by the migration. Role grant/revoke RPCs
continue to create the existing `members` / `member_role` audit records with the
actual authenticated actor. Duplicate grants and denied grants create no
business-change audit entries. The future content change will use the same
audit infrastructure under the Publishing module, with 12-month audit retention
independent of retained content.

## Staging rollout

Migration: `supabase/migrations/20261017180000_publishing_role_domain.sql`.

Apply only to SNHPC Staging (`eptbdrwmcwogxcjleudv`) for this phase. Verify the
new backend helpers before deploying the matching frontend role catalog. The
staging Website Administrator gains effective Publishing Admin/Editor through
inheritance without any extra stored assignment. Do not grant additional users
roles as part of this rollout.

The snapshot-based staging baseline does not have reconciled historical CLI
migration tracking. Apply this single reviewed forward migration explicitly;
do not blindly run the full historical migration chain with `supabase db push`.
Production application/merge is a separate release step.

The matching frontend adds readable role names and a Publishing icon to the
existing Profile and Member Tools role UI. Existing catalog-derived selectors
automatically include both roles for authorized administrators. Deploying the
frontend first could show a selector for roles the backend still rejects.

## Validation

`publishing-role-domain-db.test.mjs` runs the actual forward migration on the
existing authorization migration chain in an isolated PostgreSQL fixture. It
tests role inheritance/isolation, caller identity, Membership Admin delegation,
Publishing Admin non-delegation, verified-target prerequisites, unchanged
assignments/membership data, grant/revoke auditing, literal role persistence,
anonymous denial, and restricted function properties.

Browser helper and existing presentation tests cover both role names, inherited
access, assignable role selectors, Publishing badges, and removal messages.
The full preview build runs the repository tests and public-data checks.

## Announcements workflow

The forward migration `20261017200000_publishing_announcements.sql` introduces
`publishing_entries`, a shared private store with independent draft and
published snapshots. This phase exposes announcements only; the activity kind
is reserved for the next phase. No existing homepage text is seeded as news.

Publishing Editors and Admins open **My Account → Publishing**. They can save a
plain-text title (120 characters), body (2,000 characters), optional HTTP(S)
link, and local publication/expiry dates. Preview uses the same renderer as the
homepage. Saving does not affect a published snapshot. Publish copies the
saved draft, defaulting its start to the server's current time. The homepage
shows the newest eligible announcement by publication start and ID. Scheduled
announcements remain private until their start; expiry is evaluated by the
database without a cron job. An already-open page updates on reload.

Expired announcements remain available in paginated public history. Archive
removes an announcement from the homepage while retaining its published
snapshot in history. Restore reverses archive. Withdraw removes the snapshot
from all public views while preserving the private draft. Publishing Admin may
permanently delete only after withdrawal and archive. No content is deleted
automatically; the existing 12-month audit cleanup remains separate.

All writes lock the record and compare an expected version, preventing silent
concurrent overwrites. Direct table access is revoked and RLS enabled; manager
RPCs enforce Publishing access. The public RPC projects published text and
dates only, with bounded cursor pagination and no drafts or actor identity.
Every successful content mutation is logged atomically under `publishing` in
the existing shared audit log. Denied, stale, and unchanged draft writes do not
create change entries. Audit remains Website Administrator-only under
Operations → Audit Log, with a Publishing filter.

Frontend rendering uses text nodes and checks link protocols. If the feed is
empty or unavailable, the homepage directs visitors to Events without reviving
old announcements. The public history is `announcements.html`.

Apply the new migration explicitly to staging before publishing its matching
frontend on the staging branch. No production rollout or PR is part of this
phase. Tests cover authorization across existing roles, draft isolation,
scheduling/expiry, public projections, pagination, optimistic concurrency,
withdrawal/archive/delete boundaries, audit attribution, and safe rendering.

## Bulletin board and Discord delivery

The next forward migration is `20261018120000_publishing_discord.sql`.
The public bulletin board uses ten-entry keyset pages with ordinary Newer/Older
links, so browser Back restores the previous URL. Permanent links use
`announcements.html?id=<announcement UUID>` and resolve through the public
published-only detail RPC. Withdrawn and future announcements are unavailable.
The presentation uses the existing clubhouse colors, date badges, readable
cards, keyboard focus and optional Discord discussion links. Copy link copies
that announcement's permanent URL. Discussion stays on Discord.

**Also share to Discord when published** is a draft setting, separate from the
currently published preference. Saving it sends nothing. Explicit publication
copies the preference and queues the published snapshot transactionally. Existing
announcements default to off. A dedicated queue follows the existing notification
worker pattern but does not reuse email recipients or email delivery semantics.

Delivery is server-side. Immediate publish/withdraw tries the authenticated
worker; a minute scheduler handles future publication and queued work. The
website save succeeds independently of delivery. The worker verifies an actual
Publishing user or dedicated scheduler secret before any protected work, then
checks the webhook's server and channel against its configured destination.
Mentions are disabled. Secrets never enter browser assets, queue rows or audit
payloads. Successful creation stores Discord's message ID; future edits PATCH
that message. Withdrawal replaces its embed with a withdrawal notice, including
removal of the announcement text/link. Homepage expiry leaves past Discord posts.

Claims serialize work and have a five-minute lease. Content revisions arriving
during a send remain queued after its confirmed result. Failed requests can be
retried by Publishing Editors. An uncertain first POST or expired worker lease
requires Publishing Admin reconciliation: find and attach the existing message
link, or explicitly confirm no message was created before retrying. This avoids
promising exactly-once creation across an external network. Delivery attempts,
results, retries and reconciliation enter the existing shared audit log; system
attempts have no human actor. Content and audit retention remain independent.

### Staging destination and setup

Approved staging server: `1473002560511021298`.
Approved staging channel: `1561436946780135464`.
The earlier proposed channel `1561436651136483338` was superseded and must not be
used. No test post has been sent during local validation.

Deploy `publishing-discord-dispatch` to **SNHPC Staging** with JWT gateway
verification disabled; the handler performs its own user/scheduler checks.
Configure these Edge Function environment values in that project:

- `PUBLISHING_SITE_URL=https://snhpinballclub-staging.netlify.app`
- `PUBLISHING_DISCORD_GUILD_ID=1473002560511021298`
- `PUBLISHING_DISCORD_CHANNEL_ID=1561436946780135464`
- `PUBLISHING_ALLOWED_ORIGINS=https://deploy-preview-132--snhpinballclub-staging.netlify.app` (comma-separated exact trusted HTTPS origins; no wildcards). This allows preview browser calls without changing canonical links.
- `PUBLISHING_DISCORD_MODE=preview` initially; `live` only for approved test delivery.
- `PUBLISHING_DISCORD_WEBHOOK`: the staging channel's dedicated incoming webhook.
- `PUBLISHING_DISPATCH_SECRET`: a strong random scheduler credential.

Credential creation and entry must be completed by the human in the service UI.
Store that same scheduler credential in Supabase Vault as
`publishing_dispatch_secret`, then apply the separate guarded staging scheduler
script in `../staging-bootstrap/07-enable-publishing-discord-schedule.sql`.
No webhook or credential belongs in Git, public config, chat, or Netlify variables.
The handler validates the webhook metadata against both configured IDs before
posting. Preview mode never claims or sends queue items.

Staging acceptance: create an opted-in test announcement, confirm both links,
edit/re-publish and confirm one Discord message, schedule a future announcement,
withdraw and check the replacement notice, and exercise failed-delivery recovery.
Use a dedicated staging webhook; production configuration is a separate release.

Permanent deletion is blocked while Discord delivery is pending, sending, failed, or uncertain unless the post was canceled before any attempt. Resolve the withdrawal first so its recovery controls remain accessible. A settled withdrawal is not requeued by local deletion.
