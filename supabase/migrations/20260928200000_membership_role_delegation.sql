-- Role delegation is separate from ordinary membership upkeep.
-- Both existing grant/revoke RPCs call this target-specific helper.
create or replace function public.snh_member_can_assign_role(p_role_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.snh_is_assignable_member_role(p_role_slug)
    and exists (
      select 1 from public.member_roles mr
      join public.members m on m.id = mr.member_id
      where m.user_id = auth.uid()
        and (
          mr.role_slug = 'club_admin'
          or (
            mr.role_slug = 'membership_admin'
            and btrim(lower(p_role_slug)) not in ('club_admin', 'membership_admin')
          )
        )
    );
$$;
revoke all on function public.snh_member_can_assign_role(text) from public;
grant execute on function public.snh_member_can_assign_role(text) to authenticated;
