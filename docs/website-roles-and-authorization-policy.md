# SNHPC Website Roles and Authorization Policy

**Status:** Draft v1  
**Purpose:** Define the intended role hierarchy, role semantics, delegation model, and effective authorization principles for the Southern New Hampshire Pinball Club website.

## 1. Purpose and scope

The SNHPC website uses role-based authorization to delegate responsibility for maintaining different areas of the website. This policy defines what those roles mean, how they relate to one another, and how effective access should be determined.

The policy is intended to be the canonical description of the authorization model. Application code, database policies, RPCs, Edge Functions, and user-interface behavior should implement this policy consistently.

Membership status and website authorization are separate concepts. Terms such as **Basic Member** and **Full Access Member** describe membership state or benefits; they are not website-management roles. The current implementation already treats these as separate concepts.

## 2. Canonical role hierarchy

The intended hierarchy is:

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

The current implementation approximates this hierarchy through repeated role checks rather than through an explicit inheritance model. This policy establishes the hierarchy as the intended model going forward.

## 3. Universal Editor policy

An **Editor** is a trusted website volunteer responsible for routine upkeep within a specific functional domain.

Editors may perform the normal work necessary to maintain that domain. Depending on the domain, this may include creating records, editing content and metadata, publishing and unpublishing content, organizing information, uploading or replacing assets, correcting errors, and using normal maintenance tools and integrations associated with that domain.

Editors should not normally perform destructive or elevated administrative actions.

Permanent deletion is reserved for Admin roles unless a specific capability is intentionally classified otherwise.

Role delegation is also considered an administrative capability. Domain-level role delegation is not required in the current implementation, but the model should allow for it in the future.

## 4. Universal Admin policy

A domain **Admin** has all capabilities of the corresponding Editor role plus reserved administrative capabilities for that domain.

Reserved capabilities may include permanent deletion, restoration of deleted records, destructive maintenance actions, higher-impact configuration, and—if implemented in the future—delegation of that domain's Editor role.

The guiding rule is:

> **Admin = Editor capabilities + explicitly reserved administrative capabilities.**

An Admin role should not need a separate Editor role assignment in order to receive Editor-level access.

## 5. Website Administrator

The top-level role is **Website Administrator**.

This name is preferred for user-facing presentation because it clearly describes responsibility for administration of the club's website and avoids implying that the holder is necessarily an officer or administrator of the club organization itself.

The existing internal role identifier may remain `club_admin` unless and until a deliberate migration is undertaken. Display naming and database naming do not need to change at the same time.

Website Administrator includes the effective capabilities of:

```text
Membership Admin
Events Admin
Photos Admin
Games Admin
```

It also includes website-wide administrative capabilities that do not naturally belong to a single domain, including audit access and administrative website configuration.

Website Administrator should be treated as a true top-level role. New domain capabilities should inherit appropriately rather than requiring every subsystem to remember to add the Website Administrator role to an independent allowlist.

The existing protections against removing one's own final administrator assignment or removing the last administrator should be preserved. The current implementation already contains such safeguards for `club_admin`.

## 6. Membership roles

**Membership Editor** is responsible for routine membership upkeep. This includes ordinary member-management work such as viewing member information, maintaining membership-related data, and performing routine membership state updates.

**Membership Admin** includes all Membership Editor capabilities and adds reserved membership-administration capabilities.

Role assignment and revocation are Membership Admin capabilities.

Membership Editor should not have general authority to grant or revoke website roles.

Membership Admin may assign and revoke domain roles, including Editor and Admin roles for Events, Photos, and Games.

Website Administrator may assign and revoke all roles, including Membership Admin and Website Administrator, subject to administrator-protection rules.

This changes the current policy in one important respect: today, `membership_editor` and `membership_admin` have effectively identical role-management authority, and both may assign module Admin roles. Under this policy, role delegation becomes an Admin-level responsibility.

## 7. Domain roles

**Events Editor** may perform normal event upkeep, including creating, editing, publishing, unpublishing, and maintaining event information and related integrations.

**Events Admin** includes all Events Editor capabilities and reserved administrative actions such as permanent event deletion.

**Photos Editor** may perform normal photo and album maintenance, including creating and updating albums, uploading assets, editing metadata, publishing and unpublishing content, and managing derivatives.

**Photos Admin** includes all Photos Editor capabilities and reserved destructive actions such as permanent deletion of albums and photo assets.

**Games Editor** may perform normal game-catalog upkeep, including maintaining game information and imagery, using normal game-data integrations, and maintaining Pingolf targets.

**Games Admin** includes all Games Editor capabilities plus reserved administrative operations such as game deletion/restoration, destructive game-record maintenance, and permanent Pingolf target deletion.

These distinctions are broadly consistent with the current implementation for Events, Photos, and Games, although some individual checks require alignment.

## 8. Pingolf policy

Pingolf target listing, creation, editing, and preferred selection are normal Games-domain upkeep and belong to **Games Editor**.

Permanent Pingolf target deletion belongs to **Games Admin**, following the general policy for permanent deletion.

Targets belong directly to games. There are no Pingolf sessions or session-specific roles. See [Pingolf targets](pingolf-targets.md) for the model, RPC behavior, and deployment procedure.

## 9. Website Volunteer concept

Any member with at least one assigned website role is considered a **Website Volunteer**.

Website Volunteer is an effective status, not a separately assignable role.

The intent is:

> If SNHPC trusts a member with responsibility for any website-management domain, that person is trusted to assist with general website-maintenance tasks that are appropriate for volunteers.

Accordingly, Website Volunteers may perform general cross-domain helper activities such as maintaining Club Issues and issue status, unless a specific action requires a more specialized role.

This formalizes the existing behavior in which any assigned role enables broader Club Issues helper access.

## 10. Assigned roles versus effective capabilities

The system should distinguish between **assigned roles** and **effective capabilities**.

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

The website should maintain a canonical role catalog that defines, for every assignable role:

- internal role identifier;
- user-facing display name;
- domain;
- level;
- parent/inherited role where applicable;
- description;
- effective capabilities;
- which roles may assign or revoke it.

This catalog should become the authoritative definition used by both presentation and authorization logic where practical.

The goal is not to introduce unnecessary enterprise-style complexity. The purpose is to ensure that concepts such as **Games Admin includes Games Editor** and **Website Administrator includes all domain Admin capabilities** are defined rules rather than duplicated conventions.

The current implementation has no such canonical catalog; role logic is spread across browser helpers, HTML attributes, SQL helpers, policies, RPCs, and Edge Functions.

## 13. User-facing role presentation

Members should be able to see their website roles and understand what those roles allow them to do.

The Profile area should include a read-only **Roles & Permissions** section showing assigned roles, readable descriptions, and effective inherited access where relevant.

Member administration should display meaningful role/domain information rather than only a count of assignments.

Visual representations may use domain icons and level distinctions—for example, an Events icon with different treatment for Editor versus Admin—but color alone should not communicate authorization level. Text labels, tooltips, and accessible descriptions should identify the exact role.

Inherited access should be presented as inherited/effective access rather than as a separate assigned role.

This addresses a current gap: Member Admin presently shows an assignment count in the directory, role slugs only after expansion, and there is no general self-service role summary.

## 14. Policy principles

The authorization model should remain simple enough for club volunteers and administrators to understand.

The core principles are:

> **Editors maintain.**  
> **Admins maintain and administer.**  
> **Website Administrator administers the entire website.**  
> **Any assigned role makes a member a Website Volunteer.**  
> **Higher roles include the effective capabilities of lower roles.**  
> **Authorization is enforced at the backend, not merely in the UI.**

Implementation details may evolve, but changes should preserve these principles unless this policy is deliberately revised.


