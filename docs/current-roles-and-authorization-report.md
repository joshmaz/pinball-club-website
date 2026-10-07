# SNHPC website roles and authorization: historical current-state report

> **Historical/as-of report — superseded by the deployed canonical RBAC model.** This preserves the 2026-09-29 review of the repository boundary below, not current production truth. Statements about absent inheritance/catalogs, equal membership delegation authority, role presentation, and Pingolf sessions describe that reviewed state. Some later annotations point to replacement behavior.
> Read the [canonical roles and authorization policy](website-roles-and-authorization-policy.md) for current roles, inheritance, delegation, deletion, notification authorization, and Pinball Map authentication; see [Pingolf targets](pingolf-targets.md) for the replacement data model.

**Review date:** 2026-09-29  
**Scope:** Current repository implementation, traced through browser code, Supabase migrations/RLS, RPCs, Edge Functions, and role-management UI. This is an implementation inventory, not a proposed target model.

> **Repository boundary.** Reviewed `/workspace/scratch/42c10a6e9154/pinball-club-website`, branch `feature/notification-foundation`. The working tree already had a user modification in `supabase/migrations/20260924130000_notification_foundation.sql` (a `service_role` SELECT grant on the notification queue); it was left untouched. The repository is evidence of intended migration/application state, not proof of what is currently deployed in Supabase. No live database was queried.

## Executive summary

- There are **nine role slugs** accepted by the current role-assignment RPC allowlist: `club_admin`, `membership_editor`, `membership_admin`, `events_editor`, `events_admin`, `photos_editor`, `photos_admin`, `games_editor`, and `games_admin`. The database stores these as free-form text in `member_roles.role_slug`; there is no role catalog table, display-name field, parent-role relation, or permission table. The allowlist is what constrains normal RPC assignment.
- The app has **no explicit inheritance engine**. Effective access is the union of independent “any of these role slugs” checks in browser helpers, RLS policies, SQL functions, and Edge Functions. Names such as `photos_admin` imply an editor/admin ladder, and those roles do overlap on many operations, but neither role is defined as a child of the other.
- The clearest tier difference is delete/administrative work: `events_admin` and `club_admin` may delete events; `photos_admin` and `club_admin` may delete albums/assets; `games_admin` and `club_admin` may soft-delete/restore games, delete game stints, and manage Pingolf sessions. The general create/edit/read checks usually admit both editor and admin slugs.
- `membership_editor` and `membership_admin` currently have the same Member Tools read/update access and the same role-grant/revoke target scope. Both can assign/revoke every allowlisted role other than `membership_admin` and `club_admin`; `club_admin` can manage all allowlisted roles. Thus the membership names imply levels, but the current checks do not give the two membership roles different effective authority.
- `club_admin` is a broad composite by repeated explicit checks: it passes the membership, events, photos, and games access checks; passes the module admin checks; may view audit history; may set the door code; may manage all assignable roles; and receives general portal-helper capabilities. It is not implemented as a database grant of the other eight rows.
- Most high-impact writes have server/database checks (RLS or `SECURITY DEFINER` RPCs); photo Edge Functions also authenticate and check roles. Browser-side hiding is generally convenience only. A notable mismatch: the Games UI labels/hides Pingolf session editing as games-admin-only, but the target create/update/delete RPCs accept the broader games-editor access helper. Direct Pingolf table access is explicitly denied, so the RPC is the operative gate.
- Member Admin shows an at-a-glance **count of each member’s role assignments**, not the role names, in the directory row. Expanding the row shows the raw role slugs and grant/revoke controls. The user’s own account does not have a general role summary. Access notes say a panel is shown because of module access but do not name the specific granting role.
- The repository contains an older `members_manager` check in an early migration. Later migrations replace that function, and the current assignment allowlist excludes `members_manager`; it is historical/stale in the migration sequence, not one of the current assignable roles.

## 1. Role catalog

There is no canonical human-readable-name registry. The identifiers below are the database slugs. In Member Admin, existing roles are printed as raw slugs; grant-option labels replace underscores with spaces, without a separate product name.

| Database identifier | Human-readable name in current UI/docs | Definition / assignment evidence | Current effective access summary |
|---|---|---|---|
| `club_admin` | “Club Admin” appears in the last-admin guard; other UI generally shows `club_admin` | Allowed by `snh_is_assignable_member_role`; managed through role RPCs. Bootstrap example in `20260423190000_create_member_roles.sql`. Last-admin protection in `20260921150000_membership_door_access.sql`. | Broad role checks for every module, module-admin checks, Member Tools, audit history, door-code administration, general helper access; can grant/revoke any allowlisted role. Exact aggregate below. |
| `membership_editor` | Grant option renders “membership editor”; no richer label | Allowlist in `20260427201536_member_role_slug_allowlist.sql`; role scope in `20260921140000_member_role_scope.sql`. | Member Tools: directory/stats, manual membership state updates, and role grant/revoke subject to assignment scope; coordinator recipient role for signup notification; general helper access. |
| `membership_admin` | Grant option renders “membership admin”; no richer label | Same allowlist and role-scope function. | Same Member Tools operations and same assignable target set as `membership_editor`; notification recipient role; general helper access. No distinct admin-only operation found for this slug. |
| `events_editor` | Grant option renders “events editor” | Role allowlist; event RLS checks in `20260426170000_event_management_foundation.sql`, reset in `20260426174500_reset_events_policies_and_grants.sql`, final delete split in `20260427191015_restrict_event_delete_to_admin_roles.sql`. | Read all events (including unpublished), create/update events, use event editor integrations/digests, MatchPlay review; cannot delete events; general helper access. |
| `events_admin` | Grant option renders “events admin” | Same allowlist; same event policies and Edge Function role check. | Same event editor access plus event delete; MatchPlay review; general helper access. No other distinct event-admin-only behavior found. |
| `photos_editor` | Grant option renders “photos editor” | Allowlist; access helpers in `20260512100000_photos_foundation.sql`; write operations in `20260512120000_photos_rpcs.sql`; storage policies in `20260512110000_photos_storage_buckets.sql`. | Read editor/private photo metadata; album create/update; issue/finalize upload, set metadata, publish/unpublish, regenerate derivatives; cannot hard-delete albums/assets; general helper access. |
| `photos_admin` | Grant option renders “photos admin” | Same photo migrations; admin helper is separate from general photo access helper. | All photo-editor operations plus hard-delete albums/assets; general helper access. |
| `games_editor` | Grant option renders “games editor” | Allowlist; access helpers and editor RPCs in `20260501103000_games_catalog.sql`; later game-image permissions in `20260916100000_game_images.sql`. | Games editor load/create/update and images, game/location/sale-listing data operations permitted by editor helper, Pinball Map ingest and OPDB/AI tools, Pingolf target RPCs, club-issue game association; cannot use functions explicitly guarded by games-admin helper; general helper access. |
| `games_admin` | Grant option renders “games admin” | Same games migrations; admin helper `snh_member_has_games_admin_access()`. | Games-editor operations plus game soft-delete/restore, game-stint delete, Pingolf session upsert (and UI access to Pingolf management); general helper access. |

The assignment allowlist is in `public.snh_is_assignable_member_role()` in `supabase/migrations/20260427201536_member_role_slug_allowlist.sql`. The table itself only checks slug format, uniqueness per member, and member foreign key (`20260423190000_create_member_roles.sql`). Therefore the allowlist protects the app’s grant/revoke RPC path; it is not a database enum or a complete catalog constraint on privileged/manual inserts.

### Historical or non-role terms

- **`members_manager`** appears in the first version of `snh_member_can_manage_roles()` in `20260423203000_member_admin_rpcs.sql` and comments there. `20260427202201_membership_role_manager_access.sql` replaces the effective function with `membership_editor`, `membership_admin`, and `club_admin`. The later allowlist has no `members_manager`. Treat it as stale historical migration text, not a current supported role.
- **“Full Access Member” / “Basic Member”** are membership-status presentations, not `member_roles` roles. Door-code retrieval is checked against the latest membership status `active`, not a named role; see `20260921150000_membership_door_access.sql` and `members.html` membership UI.
- **“portal helper role”** is a generic capability test implemented as “any `member_roles` row exists” (`snh_member_has_any_assigned_role()` in `20260510120000_club_issues_any_named_role.sql`). It is not an additional role.
- Photo asset `promo_role` values such as `event_hero` and `event_branding` describe image usage, not user authorization roles.

## 2. Effective hierarchy and inheritance

No parent/child role hierarchy is stored or computed. Each check independently lists the accepted slug(s). The diagram below shows **effective overlap in checks**, not explicit inheritance:

```text
All role assignments are independent rows; effective access is the union of matching checks.

club_admin
  ├─ matches membership access + all role-assignment scopes
  ├─ matches events editor access + events delete access
  ├─ matches photos editor access + photo-admin/delete access
  ├─ matches games editor access + games-admin/delete access
  ├─ matches Club Admin-only audit and door-code administration checks
  └─ matches “any assigned role” helper access

membership_editor ─┐
membership_admin  ──┴─ Member Tools access; same current target-role grant/revoke scope

events_editor ─────── Events read/create/update
   events_admin ───── Events read/create/update + delete

photos_editor ─────── Photos read/create/update/upload/publish/unpublish
   photos_admin ───── Photos editor actions + hard delete

games_editor ──────── Games editor actions and game helper tools
   games_admin ────── Games editor actions + selected admin-only operations
```

“Admin” checks are explicit overlapping sets, e.g. `events_admin` is included in the event-manage set and additionally in event-delete set; the admin role does not cause the editor role to be assigned or inherited. Similarly, there is no transitive implication from `club_admin` in stored role data. Instead, the literal `club_admin` slug is repeated in each relevant permission check.

### `club_admin`: exact effective capabilities found

Across current source, `club_admin` is accepted for:

1. **Role/member administration:** read member-admin stats and full member directory; set membership status/tier/end-date via the current restricted membership RPC; grant/revoke every allowlisted role. It is also subject to protection against removing its own Club Admin assignment and against removing the last Club Admin (`snh_protect_club_admin()` trigger in `20260921150000_membership_door_access.sql`).
2. **Events:** read all events, including unpublished; create/update; delete; use event editor digests and MatchPlay event review.
3. **Photos:** read editor photo metadata; create/update albums; upload/finalize/manage metadata; publish/unpublish; delete albums and assets; use the photo upload/publish/purge flows.
4. **Games:** all functions gated by games access and games-admin access, including game catalog/image edits, soft-delete/restore, game-stint delete, Pingolf session administration, OPDB image sync, AI enrichment proposal, Pinball Map ingest, and related editor payloads.
5. **Audit/operations:** read paginated audit history and door-code view/change events. No standalone Operations page or broader Ops-control role was found.
6. **Door code:** set/change the club code. Retrieving the code instead requires a latest active Full Access membership and does not require `club_admin`.
7. **Club issues/notes:** full edit/status capability because it satisfies the any-assigned-role test; game association options because it passes game-editor access.
8. **Generic editor UIs:** displays role-gated navigation and public Events/Games edit links through the same explicit role lists.

## 3. Role-to-capability matrix

Legend: **Yes** means the role is explicitly included by a corresponding code/database check; **No** means excluded by the relevant check. Public/member access not based on a role is listed separately below.

| Capability | `membership_editor` | `membership_admin` | `events_editor` | `events_admin` | `photos_editor` | `photos_admin` | `games_editor` | `games_admin` | `club_admin` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Member Tools: stats/directory | Yes | Yes | — | — | — | — | — | — | Yes |
| Change membership status in Member Tools | Yes | Yes | — | — | — | — | — | — | Yes |
| Grant/revoke `events_admin`, `photos_admin`, `games_admin` | Yes | Yes | — | — | — | — | — | — | Yes |
| Grant/revoke `membership_admin` or `club_admin` | No | No | — | — | — | — | — | — | Yes |
| Event read/create/update/editor extras | — | — | Yes | Yes | — | — | — | — | Yes |
| Delete events | — | — | No | Yes | — | — | — | — | Yes |
| Photo editor actions (incl. upload/publish/unpublish) | — | — | — | — | Yes | Yes | — | — | Yes |
| Hard-delete photo album or asset | — | — | — | — | No | Yes | — | — | Yes |
| Games editor actions and game images | — | — | — | — | — | — | Yes | Yes | Yes |
| Games admin-only functions (e.g. soft-delete/restore, Pingolf session upsert) | — | — | — | — | — | — | No | Yes | Yes |
| Game/Pingolf target RPC CRUD | — | — | — | — | — | — | Yes | Yes | Yes |
| Club Admin audit-history read | No | No | No | No | No | No | No | No | Yes |
| Change door code | No | No | No | No | No | No | No | No | Yes |
| Receive signup notification (recipient role eligibility) | Yes | Yes | No | No | No | No | No | No | Yes |
| Edit/status-change club issue notes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

### Non-role access relevant to the matrix

- Any signed-in member can read and submit club issue notes; any assigned role opens the fuller edit/status controls. This is backed by the shared issue RPCs, not merely UI text.
- Published events and public/approved games/photos are readable anonymously under their public RLS policies.
- Door-code retrieval checks latest membership status `active`; no authorization role is required. Changing the code is Club Admin-only.
- A person’s own account/profile functions have authentication and ownership checks; they are not granted by one of the nine roles.

## 4. Functional-domain breakdown

### Events

- **Read:** public/anonymous reads of `published = true`; event managers can read all events. RLS in `20260426170000_event_management_foundation.sql` and the later reset/final policy files.
- **Create/update:** `events_editor`, `events_admin`, `club_admin`, through RLS insert/update policies; editor UI includes draft/unpublished rows.
- **Delete:** only `events_admin` or `club_admin`, independently enforced by `events_admin_delete` RLS in `20260427191015_restrict_event_delete_to_admin_roles.sql`. The page also hides/rejects the delete action client-side and displays “Only events_admin or club_admin can delete events.”
- **Editor extras:** event photo digest RPCs accept either the photo-access helper **or** event editor/admin/club-admin roles (`20260520100000_event_editor_photo_digest.sql`, updated by `20260520103000_event_digest_editor_hero.sql` and `20260521120000_fix_event_digest_order_by_scope.sql`). MatchPlay review Edge Function separately checks event roles. This is an intentional cross-domain permission path, but it is a second set of hard-coded role lists.

### Photos and images

- **Read:** public clients read published public albums/assets/variants; photo roles read unpublished/private editor records through RLS helper `snh_member_has_photos_access()` (`20260512100000_photos_foundation.sql`). Private originals are stored separately; client direct writes are not used.
- **Editor actions:** album upsert; asset upload intent, finalization, metadata changes, publish/unpublish and derivative work are gated by `snh_member_has_photos_access()` in SECURITY DEFINER RPCs and/or `photo-upload-intent` / `photo-publish` Edge Functions. `photo-purge` calls RPCs under the user JWT, so its unpublish/delete authorization and audit are enforced by those RPCs.
- **Admin actions:** album and asset hard deletes use `snh_member_has_photos_admin_access()` (`photos_admin`, `club_admin`).
- **Storage:** `20260512110000_photos_storage_buckets.sql` separates client-visible public derivatives from private originals and blocks ordinary clients from direct unrestricted access; upload uses short-lived server-issued signed URLs.
- **Event cross-link:** event digest procedures also permit users who have event access; photos editor can access the photo side. Exact pair of checks is documented in the digest RPC migrations.

### Games and game imagery

- **Read:** published/public game catalog data is available under public policies/views; editor payload is returned by `snh_games_editor_load()` after game-access check.
- **Editor writes:** game create/upsert and many catalog operations use `snh_member_has_games_access()` (`games_editor`, `games_admin`, `club_admin`) in `20260501103000_games_catalog.sql`, `20260501124500_games_create_rpc.sql`, `20260516100000_club_issues_pinballmap_enrich.sql`, `20260916100000_game_images.sql`, and related migrations.
- **Admin-only writes:** game soft-delete and restore and some destructive data operations use `snh_member_has_games_admin_access()` (`games_admin`, `club_admin`), including `snh_games_soft_delete`, `snh_games_restore`, and `snh_games_delete_stint`. The UI also shows special admin-only controls based on those role slugs.
- **Pingolf:** session create/update is games-admin-gated in SQL; target list/upsert/delete RPCs use general games-editor access. `members.html`/`member-games-panel.js` labels the session control “Pingolf sessions (games admin)” and hides/guards that UI to admins, so the UI currently narrows target RPC access relative to the server RPC policy. Direct API-role access to Pingolf tables is explicitly denied in `20260523140000_rls_explicit_deny_client_roles.sql`.
- **Images:** `game_images` public read requires approved usage or game-editor access; upsert/set-primary and OPDB import are game-editor gated (`20260916100000_game_images.sql`). Game image storage upload policies and intent function use same helper (`20260917190000_game_image_storage.sql`).
- **Integrations:** OPDB image sync, AI-game enrichment proposal, and Pinball Map manual ingest independently check games-editor/admin/club-admin (Edge Functions and database RPCs). They do not use a universal central capability service.

### Membership and member administration

- Member Tools navigation and RPCs are accessible to `membership_editor`, `membership_admin`, `club_admin` (`assets/js/site-auth.js`, `20260427202201_membership_role_manager_access.sql`). The backend RPCs gate stats, full directory, membership update, and role grant/revoke.
- Current manual membership RPC only permits `active` or `inactive`, `standard` tier, and no end date (final replacement in `20260921150000_membership_door_access.sql`); the earlier broader status allowlist in `20260508153118_manual_membership_admin_rpcs.sql` is superseded.
- No member/account deletion action or delete RPC gated by these roles was found in the Member Admin path reviewed; Member Tools currently exposes membership updates and role grant/revoke.
- Role grant/revoke policy is enforced in `snh_member_can_assign_role()` in `20260921140000_member_role_scope.sql`: any Club Admin may grant/revoke any allowlisted role; otherwise either membership role may manage roles other than `club_admin` and `membership_admin`. A user with either membership role can therefore assign module-admin roles. The UI applies a matching filter, and the RPC checks again.
- Member roles and memberships are audited by database triggers (`20260921121000_audit_member_admin_changes.sql`). A trigger prevents deleting/changing the final Club Admin and prevents a Club Admin from removing their own Club Admin role.
- `membership_editor`/`membership_admin`/`club_admin` are recipient eligibility roles for the queued new-account/signup notification (canonical effective Membership Editor eligibility at enqueue via [the forward migration](../supabase/migrations/20260928235800_notification_enqueue_authorization.sql); no dispatch-time role recheck). They do not authorize calling the dispatcher; dispatcher invocation uses a shared secret and service credentials.

### Operations, audit, and door access

- **Audit UI:** “Audit Log” navigation is Club Admin-only in `members.html`; `member-audit-panel.js` also hides the section unless the current roles include `club_admin`. The actual paginated read is protected by `snh_audit_history_for_admin(...)`, which independently checks Club Admin (`20260921123000_audit_admin_history.sql`, replacement/filter updates in `20260921130000_audit_automated_activity_filter.sql` and `20260921131000_audit_history_record_labels.sql`). Audit tables are not directly readable by normal clients.
- **Operations UI:** no general Operations page or role-specific integration/queue health panel was found in this checkout. The audit log is the only operations-like member panel located. Notification queue processing is service-triggered, not a member-role page.
- **Door:** `snh_get_door_code()` checks active membership; `snh_set_door_code()` checks `club_admin`. The secret table has RLS enabled and all table privileges revoked from ordinary API roles. View/change actions are audited; no secret is included in the audit record (`20260921150000_membership_door_access.sql`, `20260924115500_audit_door_code_changes.sql`).

### Club issues / notes and owner records

- Signed-in users can read/add notes. Role-bearing members can edit existing issue details and change status; the database helper uses any role assignment rather than a per-domain allowlist (`20260510120000_club_issues_any_named_role.sql`, `20260525120000_club_issues_helpers_full_edit.sql`, `20260524120000_club_issues_submission_provenance.sql`).
- Game selection/linking for issue records is separately gated on games access, not merely any role (`20260523141000_club_issues_game_options_on_site.sql`).
- Owner-party CRUD uses games access for most operations, with selected deletions guarded by games-admin access (`20260508140000_owner_parties.sql`).

## 5. Authorization architecture

### Role storage and effective-role resolution

1. `public.member_roles` is a many-to-one assignment table: `member_id` references `members.id`; each row has `role_slug`, `granted_at`, unique `(member_id, role_slug)`, and a lowercase identifier-format regex. No role label, role class, hierarchy, or capability rows are stored.
2. Browser login obtains the Supabase Auth user, finds `members.id` by `user_id`, and selects the user’s own `member_roles.role_slug` rows (`assets/js/site-auth.js:fetchMemberRoles`). Results are cached per user until auth state changes or an explicit refresh. RLS on `member_roles` restricts direct SELECT to that user (`20260423190000_create_member_roles.sql`; optimized equivalent `20260426111000_optimize_remaining_rls_policies.sql`).
3. `memberHasAnyRole()` is a literal OR comparison. `ROLE_GROUPS` and `CAPABILITY_ROLES` in `assets/js/site-auth.js` are front-end conveniences; they do not derive roles from one another.
4. Admin directory reads run through SECURITY DEFINER RPCs, which return the full role-slug list to an authorized role manager. Direct client role writes have no permissive RLS policy; grant/revoke go through restricted RPCs. `snh_is_assignable_member_role()` supplies the allowlist; `snh_member_can_assign_role()` applies actor-to-target role scope.

### Enforcement layers

| Layer | Current use | Security significance |
|---|---|---|
| Static-page/browser UI | Hides member sidebar items, role-specific controls, public-page edit links, delete buttons; shows access notes. | Presentation only. Users can call APIs/RPCs directly; role-sensitive backend checks are required and usually present. |
| Supabase Auth/JWT | Authenticated session for member routes and most role-aware RPC/Edge endpoints. | Establishes caller identity; role itself is resolved from `members` + `member_roles`, not trusted from browser metadata. |
| RLS | Events reads/writes/deletes; public/member photos and game-image reads; own member_roles reads; deny-client-write policies for sensitive tables. | Database enforcement for direct PostgREST access. `SECURITY DEFINER` RPCs intentionally mediate protected writes. |
| SECURITY DEFINER RPCs | Member admin, photo operations, game catalog/images, issue notes, audit history, door code, Pingolf, owner data. | Core independent server/database authorization boundary. Functions typically revoke `PUBLIC` execute and grant to `authenticated` or service role, then check role helper(s). |
| Edge Functions | Photo upload/publish/purge, MatchPlay event review, OPDB image sync, Pinball Map ingest, AI enrichment. | Most user-triggered functions validate JWT and explicitly check role access or invoke user-JWT RPCs. A few perform explicit role queries using elevated/service clients. |
| Service/cron processing | Notification dispatch, scheduled imports/audits. | Uses service credentials/shared secrets; not a browser role grant. Notification role list is recipient eligibility, not dispatch authorization. |

### Direct table/RPC patterns worth noting

- Sensitive data tables commonly have RLS enabled and no direct client write policy. The code then exposes targeted SECURITY DEFINER RPCs with explicit role tests and field validation. Photos and door secrets are clear examples.
- Events use direct RLS DML and separate insert/update/delete policies, with admin delete split.
- Role management uses an explicit allowlist in the grant/revoke RPCs but `member_roles.role_slug` itself is not a foreign key to a catalog or check-constrained to the nine known values.
- Role logic is duplicated across browser role groups, inline `data-rbac-roles`, SQL helpers/policies, RPC checks, and Edge Function arrays. This produces visible drift risk and exceptions (including Pingolf) even though critical paths mostly have server-side guards.
- Because Supabase migration files are append/replace-over-time, early migration definitions may be superseded. This report describes the final intended state implied by the complete migration sequence, not the first occurrence of each function.

## 6. Current UI presentation of roles

1. **Role-gated navigation:** `members.html` marks Member Tools, Audit Log, Events, Photos, and Games with `data-rbac-roles`. At runtime `applyRbacNav()` hides a nav item unless any listed role matches. The datasets are then synchronized from `ROLE_GROUPS` by `syncRbacRoleDatasets()`.
2. **Panel access messaging:** Events, Member Tools, Photos, and Games intros receive a note such as “Shown because your account has Events access.” Although `findGrantingRole()` computes the matching role, `setPanelAccessNote()` does not include the role name in the message. Club Issues explains the broad “portal helper role” behavior in plain language.
3. **Member Admin directory:** directory columns show member name, “Full Access Member”/“Basic Member”, and a **Roles count** (assignment count). It does not show role names inline. Expanding a row lists each raw slug with remove controls; grant selector labels replace underscores with spaces. Summary cards include a global “Role assignments” total, not per-role counts.
4. **Specific action messages:** the event delete path tells users only `events_admin` or `club_admin` can delete. Games panel says “Games admin role required for Pingolf sessions.” Photo delete controls are visible only to photos-admin/club-admin; user-facing errors also reflect RPC rejection.
5. **Other role display:** no general My Account role list, role badges, individual readable role descriptions, or dedicated role documentation page was found in the UI. The Audit Log explanation says “Club admins can review changes to events, members, games, and photos.”
6. **Public site controls:** `assets/js/events.js` and `assets/js/games.js` display event/game editor links after client-side role checks. Their editor RPCs enforce access independently, so these links are discoverability controls rather than the security boundary.

## 7. Inconsistencies, ambiguities, and policy questions

### Confirmed from source

- **No real inheritance:** all effective “parent” behavior comes from repeated OR lists. Role names communicate a hierarchy more strongly than the role data model does.
- **Membership roles have identical current authority:** both `membership_editor` and `membership_admin` can access the same Member Tools operations and both have the same target-role scope. Neither is treated as the other’s inherited parent/child.
- **Membership role managers can grant module-admin roles:** both membership roles may grant/revoke `events_admin`, `photos_admin`, and `games_admin`. Their access is not restricted to granting editor roles. This is also called out in `docs/member-role-scope-review.md`.
- **Club Admin is intentionally broad but only by scattered checks:** it is not an all-capability wildcard in code; each subsystem must name `club_admin`. New tools must include it separately to make them available.
- **Pingolf UI/backend split:** session management is admin-gated, but target CRUD RPCs are editor-gated while the UI presents Pingolf as an admin section. Direct table access is denied, making the broader RPC authorization effective for direct callers.
- **Assignment-count display is ambiguous:** a bare number under “Roles” counts assignments, not users or privilege level. Role names appear only after opening the editor.
- **Club issue permissions are broader than module labels may suggest:** any assigned slug enables the same issue edit/status helper; game-link selection is a separate narrower games role check.
- **Role storage allows unknown slugs outside the normal grant path:** format constraint permits arbitrary role text; RPC allowlist prevents normal UI assignment. Behavior for a manually inserted unknown slug is not a designed/documented role and can still satisfy the generic “any assigned role” issue helper.
- **`members_manager` is stale migration history:** later function replacement and allowlist exclude it. It should not be counted as current without evidence from the live DB.
- **Role documentation is uneven:** `README.md` has a current sidebar table, but the role examples in `CLAUDE.md` omit the two photo roles even though they are in the current allowlist and UI. `docs/member-role-scope-review.md` records useful membership-scope concerns but is explicitly a follow-up note rather than a complete role catalog.
- **Current checked-out code has an uncommitted notification migration change:** it adds service-role access to the outbox; it does not define a user-facing role but may matter to deployment review. It was not edited during this work.

### Questions for the planning session

- Should the “editor/admin” names represent a standard rule (admin always includes editor actions plus a small enumerated set), or should each domain define its own tiers?
- Should membership management be one role or should `membership_editor` and `membership_admin` have explicitly different read/update/role-assignment powers?
- Should module editors be allowed to assign other modules’ admin roles? Today both membership roles can do so.
- Should Club Admin retain all current module powers, and should role management/audit/door-code administration be bundled with that title or separated?
- Should every role-bearing member continue to be a general club-issue helper, or should the current any-role shortcut be limited to named assignments?
- Should Pingolf target edits be intentionally editor-level (backend) or admin-level (current UI wording/visibility)? The current implementation does not settle that policy.
- Should directory display show role labels, role descriptions, or scopes inline? Current “Roles” count alone does not answer what a person can do.
- Should live deployed schema be checked against repository migrations before adopting this report as the formal board-facing description? This review could not verify migration status remotely.

## 8. Source guide

Primary implementation references (paths are relative to repository root):

- **Role table and own-row RLS:** `supabase/migrations/20260423190000_create_member_roles.sql`; `supabase/migrations/20260426111000_optimize_remaining_rls_policies.sql`.
- **Role allowlist and role manager:** `supabase/migrations/20260427201536_member_role_slug_allowlist.sql`; replacement manager authorization in `supabase/migrations/20260427202201_membership_role_manager_access.sql`; grant/revoke scope in `supabase/migrations/20260921140000_member_role_scope.sql`.
- **Browser identity and role helpers:** `assets/js/site-auth.js` (`ROLE_GROUPS`, `CAPABILITY_ROLES`, `fetchMemberRoles`, `memberHasAnyRole`, `can`); `assets/js/member-portal.js` (role re-export and assignable role list).
- **Member role UI:** `members.html` (sidebar role datasets, access notes, Member Admin directory/list/count/grant/revoke, event delete and door-admin UI); `assets/js/member-audit-panel.js`; `assets/js/member-photos-panel.js`; `assets/js/member-games-panel.js`; `assets/js/member-club-issues-panel.js`.
- **Events:** `supabase/migrations/20260426170000_event_management_foundation.sql`; `20260426174500_reset_events_policies_and_grants.sql`; `20260427191015_restrict_event_delete_to_admin_roles.sql`; event digest migrations from `20260520100000` through `20260521120000`; `supabase/functions/matchplay-event-review/index.ts`.
- **Photos:** `supabase/migrations/20260512100000_photos_foundation.sql`; `20260512110000_photos_storage_buckets.sql`; `20260512120000_photos_rpcs.sql`; `supabase/functions/photo-upload-intent/index.ts`; `photo-publish/index.ts`; `photo-purge/index.ts`.
- **Games:** `supabase/migrations/20260501103000_games_catalog.sql`; `20260501124500_games_create_rpc.sql`; `20260505135500_games_soft_delete.sql`; `20260507143000_extended_game_data.sql`; `20260508140000_owner_parties.sql`; `20260916100000_game_images.sql`; `20260917190000_game_image_storage.sql`; plus `supabase/functions/opdb-image-sync/index.ts`, `ai-game-enrich-propose/index.ts`, and `pinballmap-ingest/index.ts`.
- **Membership, audit, door and notifications:** `supabase/migrations/20260508153118_manual_membership_admin_rpcs.sql` (superseded membership update definition); final restriction/door admin in `20260921150000_membership_door_access.sql`; audit read in `20260921123000_audit_admin_history.sql` and subsequent audit replacements; door audit in `20260924115500_audit_door_code_changes.sql`; signup queue/recipient roles in `20260924130000_notification_foundation.sql` and `supabase/functions/notification-dispatch/index.ts`.
- **Club issues:** `supabase/migrations/20260510120000_club_issues_any_named_role.sql`; `20260525120000_club_issues_helpers_full_edit.sql`; `20260523141000_club_issues_game_options_on_site.sql`.
- **Existing documentation (helpful, not treated as authoritative over implementation):** `README.md` “Role-gated UI sections”; `docs/photos-foundation.md`; `docs/member-role-scope-review.md`; `docs/email.md`.
