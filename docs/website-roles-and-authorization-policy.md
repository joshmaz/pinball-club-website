# SNHPC Website Roles and Authorization Policy

**Status:** Canonical deployed RBAC/security model (status updated 2026-10-07)

**Purpose:** Describe the deployed role hierarchy, role semantics, delegation model, and effective authorization principles for the Southern New Hampshire Pinball Club website.

## 1. Purpose and scope

The SNHPC website uses role-based authorization to delegate responsibility for maintaining different areas of the website. This policy defines what those roles mean, how they relate to one another, and how effective access should be determined.

This is the canonical description of the deployed authorization model. See the [historical implementation report](current-roles-and-authorization-report.md) for the earlier state.

Membership status and website authorization are separate concepts. Terms such as **Basic Member** and **Full Access Member** describe membership state or benefits; they are not website-management roles. The current implementation already treats these as separate concepts.

## 2. Canonical role hierarchy

The effective hierarchy is:

```text
Website Administrator
│
├── Membership Admin
│   └── Membership Editor
│
├── Events Admin
│   └── Events Editor
│
├── Photos Admin
│   └── Photos Editor
│
└── Games Admin
    └── Games Editor
```

This hierarchy represents **effective authorization**, not merely naming convention.

A domain Admin includes all capabilities of that domain's Editor role. Website Administrator includes all capabilities of every domain Admin role.

Canonical SQL effective-role helpers and the browser role catalog implement this hierarchy. Inherited access does not create additional persisted assignments.

## 3. Universal Editor policy

An **Editor** is a trusted website volunteer responsible for routine upkeep within a specific functional domain.

Editors may perform the normal work necessary to maintain that domain. Depending on the domain, this may include creating records, editing content and metadata, publishing and unpublishing content, organizing information, uploading or replacing assets, correcting errors, and using normal maintenance tools and integrations associated with that domain.

Editors should not normally perform destructive or elevated administrative actions.

Permanent deletion is reserved for Admin roles unless a specific capability is intentionally classified otherwise.

Role delegation is an administrative capability reserved to Membership Admin and Website Administrator within the scope below. Events, Photos, and Games Admins do not gain delegation authority from their domain role.

## 4. Universal Admin policy

A domain **Admin** has all capabilities of the corresponding Editor role plus reserved administrative capabilities for that domain.

Reserved capabilities may include permanent deletion, restoration of deleted records, destructive maintenance actions, higher-impact configuration, and role delegation where explicitly authorized below.

The guiding rule is:

> **Admin = Editor capabilities + explicitly reserved administrative capabilities.**

An Admin role does not need a separate Editor role assignment to receive Editor-level access.

## 5. Website Administrator

The top-level role is **Website Administrator**.

This name is preferred for user-facing presentation because it clearly describes responsibility for administration of the club's website and avoids implying that the holder is necessarily an officer or administrator of the club organization itself.

Website Administrator is the display name for the persisted identifier `club_admin`.

Website Administrator includes the effective capabilities of:

```text
Membership Admin
Events Admin
Photos Admin
Games Admin
```

It also includes website-wide administrative capabilities that do not naturally belong to a single domain, including audit access and administrative website configuration.

Website Administrator should be treated as a true top-level role. New domain capabilities should inherit appropriately rather than requiring every subsystem to remember to add the Website Administrator role to an independent allowlist.

Existing `club_admin` safeguards block removing one's own Website Administrator role and removing the last Website Administrator, including through cascading member deletion.

## 6. Membership roles

**Membership Editor** is responsible for routine membership upkeep. This includes ordinary member-management work such as viewing member information, maintaining membership-related data, and performing routine membership state updates.

**Membership Admin** includes all Membership Editor capabilities and adds reserved membership-administration capabilities.

Role assignment and revocation are Membership Admin capabilities.

Membership Editor cannot grant or revoke website roles.

Membership Admin may assign and revoke Membership Editor and the Editor and Admin roles for Events, Photos, and Games, but cannot manage `membership_admin` or `club_admin`.

Website Administrator may assign and revoke all nine assignable roles, including Membership Admin and Website Administrator, subject to self-removal and last-administrator safeguards.

Membership Editor retains ordinary membership upkeep but cannot grant or revoke any role. The general membership-access helper name `snh_member_can_manage_roles()` does not confer delegation; grant/revoke RPCs additionally enforce target-specific assignment authority.

## 7. Domain roles

**Events Editor** may perform normal event upkeep, including creating, editing, publishing, unpublishing, and maintaining event information and related integrations.

**Events Admin** includes all Events Editor capabilities and reserved administrative actions such as permanent event deletion.

**Photos Editor** may perform normal photo and album maintenance, including creating and updating albums, uploading assets, editing metadata, publishing and unpublishing content, and managing derivatives.

**Photos Admin** includes all Photos Editor capabilities and reserved destructive actions such as permanent deletion of albums and photo assets.

**Games Editor** may perform normal game-catalog upkeep, including maintaining game information and imagery, using normal game-data integrations, and maintaining Pingolf targets.

**Games Admin** includes all Games Editor capabilities plus reserved administrative operations such as game deletion/restoration, destructive game-record maintenance, permanent uploaded game-image deletion, and permanent Pingolf target deletion.

Destructive deletion is Admin-only where implemented; ordinary upkeep remains Editor-level. Events RLS and the event photo digest use canonical effective-role helpers, retaining the digest’s Photos-access alternative.

## 8. Pingolf policy

Pingolf target listing, creation, editing, and preferred selection are normal Games-domain upkeep and belong to **Games Editor**.

Permanent Pingolf target deletion belongs to **Games Admin**, following the general policy for permanent deletion.

Targets belong directly to games. There are no Pingolf sessions or session-specific roles. See [Pingolf targets](pingolf-targets.md) for the model, RPC behavior, and deployment procedure.

## 9. Website Volunteer concept

Any member with at least one assigned website role is considered a **Website Volunteer**.

`website_volunteer` is derived effective status, never assignable or persisted. Only recognized canonical assignments confer it.

The intent is:

> If SNHPC trusts a member with responsibility for any website-management domain, that person is trusted to assist with general website-maintenance tasks that are appropriate for volunteers.

Accordingly, Website Volunteers may perform general cross-domain helper activities such as maintaining Club Issues and issue status, unless a specific action requires a more specialized role.

This formalizes the existing behavior in which any assigned role enables broader Club Issues helper access.

## 10. Assigned roles versus effective capabilities

The system distinguishes between **assigned roles** and **effective capabilities**.

If a member is explicitly assigned `events_admin`, that does not mean they must also have a separate `events_editor` assignment stored.

Instead:

```text
Assigned role: Events Admin
Effective access: Events Admin + Events Editor capabilities
```

Likewise:

```text
Assigned role: Website Administrator
Effective access:
  Membership Admin + Editor
  Events Admin + Editor
  Photos Admin + Editor
  Games Admin + Editor
  Website-wide administrative capabilities
```

User interfaces should communicate effective access without falsely implying that inherited capabilities are separately assigned roles.

## 11. Authorization enforcement

User-interface visibility is not a security boundary.

Role-sensitive operations must be authorized independently at the server or database layer through appropriate RLS policies, restricted RPCs, Edge Functions, or equivalent mechanisms.

The browser may use role information to hide or reveal navigation and controls for usability, but a user must not gain or lose actual authorization solely because a button is shown or hidden.

The existing application already follows this pattern for most high-impact operations, using RLS, `SECURITY DEFINER` RPCs, and Edge Function checks in addition to browser-side controls.

## 12. Canonical role catalog

Exactly nine persisted roles are assignable: `club_admin`, `membership_editor`, `membership_admin`, `events_editor`, `events_admin`, `photos_editor`, `photos_admin`, `games_editor`, and `games_admin`. The database CHECK constraint rejects other identifiers, including `website_volunteer`, even on privileged writes.

The browser role catalog describes each role with:

- internal role identifier;
- user-facing display name;
- domain;
- level;
- parent/inherited role where applicable;
- description;
- effective capabilities;
- which roles may assign or revoke it.

The browser catalog supplies presentation and capability helpers; SQL enforces canonical inheritance and delegation independently.

The goal is not to introduce unnecessary enterprise-style complexity. The purpose is to ensure that concepts such as **Games Admin includes Games Editor** and **Website Administrator includes all domain Admin capabilities** are defined rules rather than duplicated conventions.

Implementation references: [persisted-role constraint](../supabase/migrations/20260928220000_canonical_persisted_member_roles.sql), [effective-role core](../supabase/migrations/20260928230000_canonical_effective_role_core.sql), [domain helpers](../supabase/migrations/20260928235000_domain_helpers_use_effective_roles.sql), and [browser catalog](../assets/js/site-auth.js).

## 13. User-facing role presentation

Members should be able to see their website roles and understand what those roles allow them to do.

The Profile area should include a read-only **Roles & Permissions** section showing assigned roles, readable descriptions, and effective inherited access where relevant.

Member administration should display meaningful role/domain information rather than only a count of assignments.

Visual representations may use domain icons and level distinctions—for example, an Events icon with different treatment for Editor versus Admin—but color alone should not communicate authorization level. Text labels, tooltips, and accessible descriptions should identify the exact role.

Inherited access should be presented as inherited/effective access rather than as a separate assigned role.

The Profile Roles & Permissions section and member-directory badges present assigned roles separately from inherited access.

## 14. Notifications and scheduled ingestion

Signup notification recipients are authorized at enqueue using effective Membership Editor eligibility. The dispatcher sends to the stored recipients without re-checking roles at delivery; subsequent role removal does not cancel already queued mail. See [email operations](email.md).

Pinball Map interactive ingestion requires a verified user JWT and effective Games Editor authorization. Scheduled ingestion uses a separate scheduler-secret credential and System attribution. Scheduler-header presence selects that path; invalid scheduler credentials never fall back to interactive authentication. See [Pinball Map operations](games-relational-migration-plan.md#pinball-map-edge-function).

## 15. Policy principles

The authorization model should remain simple enough for club volunteers and administrators to understand.

The core principles are:

> **Editors maintain.**  
> **Admins maintain and administer.**  
> **Website Administrator administers the entire website.**  
> **Any assigned role makes a member a Website Volunteer.**  
> **Higher roles include the effective capabilities of lower roles.**  
> **Authorization is enforced at the backend, not merely in the UI.**

Implementation details may evolve, but changes should preserve these principles unless this policy is deliberately revised.


