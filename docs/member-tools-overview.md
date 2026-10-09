# Member Tools overview and assigned roles

The overview RPC keeps its existing Membership Editor authorization boundary. Deploy both overview migrations, including `20261009003000_member_overview_ignore_legacy_end_date.sql`, before checking the new cards. No tables, assignment rules, RLS policies or access checks change.

- **Accounts:** rows in `auth.users`, including accounts without a member profile and accounts awaiting email confirmation. Orphaned member profiles are not registered accounts.
- **Full-Access Members:** accounts whose latest membership (ordered by `created_at`, then `id`, descending) has status `active`. Legacy end dates do not affect membership status. Each account counts once.
- **Basic Members:** email-confirmed accounts (`auth.users.email_confirmed_at`) outside the Full-Access count. This includes accounts without any membership record.
- **Website Volunteers:** unique accounts for which an associated member satisfies `private.snh_member_has_effective_role(member_id, 'website_volunteer')`. This existing internal canonical predicate recognizes assigned website roles and derives Volunteer eligibility. Notes/Issues use `snh_member_has_any_assigned_role`, which checks the canonical assignable-role allowlist; the database regression test compares both predicates. Multiple assigned roles do not increase the total.

Volunteer status overlaps membership. Full Access follows the membership record regardless of email verification, consistent with the existing access model; Basic requires email verification explicitly.

## Legacy end dates

Membership end dates are deprecated. Overview, directory and door access all use the latest membership's status; historical end dates do not override `active`. Latest `inactive`, `expired`, `canceled` or `past_due` records do not count as Full Access. The corrective migration only changes reporting; authorization is unchanged.

## Assigned-role presentation

The existing shared role presentation component now renders compact icons in the directory and expanded member cards, with full labeled badges on the user Profile. Each domain has one SVG outline; Editor and Admin share the domain symbol. Admin also has a heavier border, and every icon has the complete role name through its accessible label and tooltip on hover/focus. Club Admin preserves the star-shield. The expanded member editor uses compact role icons; remove buttons and the assign selector retain full role labels. Effective access stays explanatory text; inherited capabilities are never expanded into extra assigned-role icons.

## Verification

The regression tests exercise latest-record ordering, historical rows, expiration, account verification, missing profiles, unique volunteer totals, the Notes/Issues predicate, RPC authorization, all nine role icons, accessible labels, and full-text management controls. Live database reconciliation and desktop/mobile browser preview review remain necessary before merge.

## Directory verification

Apply `20261009004500_member_directory_verification.sql` to expose `email_verified` from `auth.users.email_confirmed_at` through the existing protected directory RPC. Basic filtering requires verification and a non-active latest membership. Unverified Accounts has its own filter and label. Full Access still follows membership status; an unverified Full-Access account is labeled with both states and appears in both relevant filters. Missing verification data displays “Verification unavailable” rather than assuming Basic membership.
