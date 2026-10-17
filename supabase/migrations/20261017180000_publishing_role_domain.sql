-- Publishing owns homepage announcements and featured activities.
-- Existing assignments, verification prerequisites, audit triggers, and
-- administrator safeguards are preserved. No new roles are assigned here.
begin;

alter table public.member_roles
  drop constraint member_roles_canonical_role,
  add constraint member_roles_canonical_role check (role_slug in (
    'club_admin', 'membership_editor', 'membership_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
    'games_editor', 'games_admin', 'publishing_editor', 'publishing_admin'
  ));

create or replace function public.snh_is_assignable_member_role(p_role_slug text)
returns boolean language sql stable set search_path = public as $$
  select coalesce(btrim(lower(p_role_slug)), '') = any (array[
    'club_admin', 'membership_editor', 'membership_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
    'games_editor', 'games_admin', 'publishing_editor', 'publishing_admin'
  ]::text[]);
$$;
revoke all on function public.snh_is_assignable_member_role(text) from public;
grant execute on function public.snh_is_assignable_member_role(text) to authenticated;

-- The public caller-scoped helper delegates to this existing private predicate.
-- Update that one hierarchy so Auth, notifications, and volunteer statistics
-- recognize the new assignments consistently.
create or replace function private.snh_member_has_effective_role(p_member_id uuid, p_required_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive role_catalog(role_slug, inherited_by) as (
    values
      ('club_admin'::text, null::text),
      ('membership_admin', 'club_admin'),
      ('membership_editor', 'membership_admin'),
      ('events_admin', 'club_admin'),
      ('events_editor', 'events_admin'),
      ('photos_admin', 'club_admin'),
      ('photos_editor', 'photos_admin'),
      ('games_admin', 'club_admin'),
      ('games_editor', 'games_admin'),
      ('publishing_admin', 'club_admin'),
      ('publishing_editor', 'publishing_admin')
  ), effective_roles(role_slug) as (
    select catalog.role_slug
    from public.members m
    join public.member_roles assignment on assignment.member_id=m.id
    join role_catalog catalog on catalog.role_slug=assignment.role_slug
    where m.id=p_member_id
    union
    select catalog.role_slug from effective_roles superior
    join role_catalog catalog on catalog.inherited_by=superior.role_slug
  )
  select exists (
    select 1 from effective_roles effective
    where effective.role_slug=p_required_role or p_required_role='website_volunteer'
  );
$$;
revoke all on function private.snh_member_has_effective_role(uuid,text)
  from public,anon,authenticated,service_role;

create function public.snh_member_has_publishing_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.snh_member_has_effective_role('publishing_editor');
$$;
revoke all on function public.snh_member_has_publishing_access() from public,anon,authenticated;
grant execute on function public.snh_member_has_publishing_access() to authenticated;

create function public.snh_member_has_publishing_admin_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.snh_member_has_effective_role('publishing_admin');
$$;
revoke all on function public.snh_member_has_publishing_admin_access() from public,anon,authenticated;
grant execute on function public.snh_member_has_publishing_admin_access() to authenticated;

comment on function public.snh_member_has_publishing_access() is
  'Caller has effective Publishing Editor access for announcements and featured activities.';
comment on function public.snh_member_has_publishing_admin_access() is
  'Caller has effective Publishing Admin access for reserved Publishing operations.';

-- snh_member_can_assign_role already delegates recognized non-top-level roles
-- to Membership Admin and all recognized roles to Website Administrator.
-- snh_grant_member_role still requires the target account's confirmed email.
-- Publishing Admin does not gain Membership access or role-delegation rights.
commit;
