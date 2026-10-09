-- Align overview with directory and access checks: end_date is legacy data.
-- Preserve account verification, volunteer eligibility and authorization.
create or replace function public.snh_get_member_admin_stats()
returns json language plpgsql security definer set search_path = public as $$
declare payload json;
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  with accounts as (
    select u.id, u.email_confirmed_at is not null as verified,
      coalesce(ms.status = 'active', false) as full_access,
      exists (
        select 1 from public.members m where m.user_id = u.id
          and private.snh_member_has_effective_role(m.id, 'website_volunteer')
      ) as volunteer
    from auth.users u
    left join lateral (
      select ms.status from public.memberships ms
      join public.members m on m.id = ms.member_id
      where m.user_id = u.id
      order by ms.created_at desc, ms.id desc limit 1
    ) ms on true
  )
  select json_build_object(
    'account_count', count(*),
    'full_access_count', count(*) filter (where full_access),
    'basic_count', count(*) filter (where verified and not full_access),
    'volunteer_count', count(*) filter (where volunteer)
  ) into payload from accounts;
  return payload;
end;
$$;
revoke all on function public.snh_get_member_admin_stats() from public;
grant execute on function public.snh_get_member_admin_stats() to authenticated;
