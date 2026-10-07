-- Preserve existing helper interfaces and security settings. Only hierarchy
-- evaluation moves to the canonical caller-scoped policy core.
create or replace function public.snh_member_can_manage_roles()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_member_has_effective_role('membership_editor');
$$;
revoke all on function public.snh_member_can_manage_roles() from public;
grant execute on function public.snh_member_can_manage_roles() to authenticated;

create or replace function public.snh_member_has_games_access()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_member_has_effective_role('games_editor');
$$;
revoke all on function public.snh_member_has_games_access() from public;
grant execute on function public.snh_member_has_games_access() to authenticated;

create or replace function public.snh_member_has_games_admin_access()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_member_has_effective_role('games_admin');
$$;
revoke all on function public.snh_member_has_games_admin_access() from public;
grant execute on function public.snh_member_has_games_admin_access() to authenticated;

create or replace function public.snh_member_has_photos_access()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_member_has_effective_role('photos_editor');
$$;
revoke all on function public.snh_member_has_photos_access() from public;
grant execute on function public.snh_member_has_photos_access() to authenticated;

create or replace function public.snh_member_has_photos_admin_access()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_member_has_effective_role('photos_admin');
$$;
revoke all on function public.snh_member_has_photos_admin_access() from public;
grant execute on function public.snh_member_has_photos_admin_access() to authenticated;
