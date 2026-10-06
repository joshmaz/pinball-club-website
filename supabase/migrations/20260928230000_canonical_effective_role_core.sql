-- Additive policy core only. Existing authorization consumers are unchanged.
-- The fixed catalog below describes which superior role inherits each role.
-- Persisted assignments remain governed by the literal table CHECK.
create function public.snh_member_has_effective_role(p_required_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
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
      ('games_editor', 'games_admin')
  ), effective_roles(role_slug) as (
    select catalog.role_slug
    from public.members m
    join public.member_roles assignment on assignment.member_id = m.id
    join role_catalog catalog on catalog.role_slug = assignment.role_slug
    where m.user_id = auth.uid()
    union
    select catalog.role_slug
    from effective_roles superior
    join role_catalog catalog on catalog.inherited_by = superior.role_slug
  )
  select exists (
    select 1 from effective_roles effective
    where effective.role_slug = p_required_role
      or p_required_role = 'website_volunteer'
  );
$$;

revoke all on function public.snh_member_has_effective_role(text) from public, anon, authenticated;
grant execute on function public.snh_member_has_effective_role(text) to authenticated;

comment on function public.snh_member_has_effective_role(text) is
  'Caller-scoped canonical role inheritance. Exact recognized assignments only; Website Volunteer is derived, never assignable. Unknown requirements fail closed.';
