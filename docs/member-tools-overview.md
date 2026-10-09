# Member Tools overview and assigned roles

The overview RPC keeps its existing Membership Editor authorization boundary. Deploy `20261008233000_member_admin_overview.sql` before checking the new cards. No tables, assignment rules, RLS policies or access checks change.

- **Accounts:** rows in `auth.users`, including accounts without a member profile and accounts awaiting email confirmation. Orphaned member profiles are not registered accounts.
- **Full-Access Members:** accounts whose latest membership (ordered by `created_at`, then `id`, descending) has status `active` and no end date or an end date on/after the database current date. Each account counts once.
- **Basic Members:** email-confirmed accounts (`auth.users.email_confirmed_at`) outside the Full-Access count. This includes accounts without any membership record.
- **Website Volunteers:** unique accounts for which an associated member satisfies `private.snh_member_has_effective_role(member_id, 'website_volunteer')`. This existing internal canonical predicate recognizes assigned website roles and derives Volunteer eligibility. Notes/Issues use `snh_member_has_any_assigned_role`, which checks the canonical assignable-role allowlist; the database regression test compares both predicates. Multiple assigned roles do not increase the total.

Volunteer status overlaps membership. Full Access follows the membership record regardless of email verification, consistent with the existing access model; Basic requires email verification explicitly.

## Historical end-date discrepancy

The current directory and door-code checks use the latest membership's active status without inspecting end dates. Manual membership updates now require a null end date. Historical active rows can still carry past end dates. The overview excludes those rows as requested; the existing authorization and directory behavior are preserved. This is a reporting distinction, not an access-policy change.

## Assigned-role presentation

The existing shared role presentation component now renders compact icons in the directory and expanded member cards, with full labeled badges on the user Profile. Each domain has one SVG outline; Editor and Admin share the domain symbol. Admin also has a heavier border, and every icon has the complete role name through its accessible label and tooltip on hover/focus. Club Admin preserves the star-shield. The expanded member editor uses compact role icons; remove buttons and the assign selector retain full role labels. Effective access stays explanatory text; inherited capabilities are never expanded into extra assigned-role icons.

## Verification

The regression tests exercise latest-record ordering, historical rows, expiration, account verification, missing profiles, unique volunteer totals, the Notes/Issues predicate, RPC authorization, all nine role icons, accessible labels, and full-text management controls. Live database reconciliation and desktop/mobile browser preview review remain necessary before merge.
