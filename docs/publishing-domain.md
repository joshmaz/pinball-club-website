# Publishing authorization foundation

This change adds an independent Publishing domain for homepage announcements
(What's New) and featured activities (What's Happening). It establishes the
permission model; content tables, publication RPCs, the editor, and homepage
rendering follow in a separate change. No empty Publishing panel is added.

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
