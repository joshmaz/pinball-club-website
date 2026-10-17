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
