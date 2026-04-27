-- Align member admin management access with membership role names.

create or replace function public.snh_member_can_manage_roles()
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
    where m.user_id = auth.uid()
      and mr.role_slug in ('membership_editor', 'membership_admin', 'club_admin')
  );
$$;

revoke all on function public.snh_member_can_manage_roles() from public;
grant execute on function public.snh_member_can_manage_roles() to authenticated;
