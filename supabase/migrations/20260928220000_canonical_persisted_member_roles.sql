-- Pre-deployment inventory (read-only): run before applying this migration.
-- Any returned assignments require explicit review; this migration never remaps
-- or deletes them. The validated CHECK below fails if any remain.
-- select role_slug, count(*) as assignment_count
-- from public.member_roles
-- where role_slug not in (
--   'club_admin', 'membership_editor', 'membership_admin',
--   'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
--   'games_editor', 'games_admin'
-- )
-- group by role_slug
-- order by role_slug;

alter table public.member_roles
  add constraint member_roles_canonical_role check (role_slug in (
    'club_admin', 'membership_editor', 'membership_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
    'games_editor', 'games_admin'
  ));

-- Website Volunteer is derived from a recognized assignment, never assigned.
create or replace function public.snh_member_has_any_assigned_role ()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid ()
      and public.snh_is_assignable_member_role(mr.role_slug)
  );
$$;

revoke all on function public.snh_member_has_any_assigned_role () from public;
grant execute on function public.snh_member_has_any_assigned_role () to authenticated;

comment on function public.snh_member_has_any_assigned_role () is
  'True when the signed-in member has a canonical assignable website role; Website Volunteer is derived, not persisted.';
