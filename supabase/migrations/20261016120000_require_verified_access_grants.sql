begin;

-- Email verification is a prerequisite for new access grants. Existing records
-- are left for review; role removal and membership deactivation remain available.
create or replace function public.snh_grant_member_role(p_member_id uuid, p_role_slug text)
returns void language plpgsql security definer set search_path = public as $$
declare v_slug text := btrim(lower(coalesce(p_role_slug, '')));
begin
  if not public.snh_member_can_manage_roles() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_id is null or not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'member not found' using errcode = '22023';
  end if;
  if v_slug = '' or v_slug !~ '^[a-z][a-z0-9_]*$' or not public.snh_is_assignable_member_role(v_slug) then
    raise exception 'role_slug is not assignable' using errcode = '22023';
  end if;
  if not public.snh_member_can_assign_role(v_slug) then
    raise exception 'not authorized for role' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.members m join auth.users u on u.id = m.user_id
    where m.id = p_member_id and u.email_confirmed_at is not null
  ) then
    raise exception 'This account must verify its email before receiving website roles or Full Access.' using errcode = '42501';
  end if;
  insert into public.member_roles (member_id, role_slug) values (p_member_id, v_slug)
  on conflict (member_id, role_slug) do nothing;
end;
$$;
revoke all on function public.snh_grant_member_role(uuid, text) from public;
grant execute on function public.snh_grant_member_role(uuid, text) to authenticated;

create or replace function public.snh_set_member_membership(
  p_member_id uuid, p_status text, p_tier text, p_end_date date
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_id is null or not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'member not found' using errcode = '22023';
  end if;
  if p_status not in ('active', 'inactive') or p_tier <> 'standard' or p_end_date is not null then
    raise exception 'invalid membership selection' using errcode = '22023';
  end if;
  if p_status = 'active' and not exists (
    select 1 from public.members m join auth.users u on u.id = m.user_id
    where m.id = p_member_id and u.email_confirmed_at is not null
  ) then
    raise exception 'This account must verify its email before receiving website roles or Full Access.' using errcode = '42501';
  end if;
  update public.memberships m set status = p_status, tier = 'standard', end_date = null
  where m.id = (select m2.id from public.memberships m2 where m2.member_id = p_member_id
                order by m2.created_at desc, m2.id desc limit 1);
  if not found then
    insert into public.memberships (member_id, status, tier, end_date)
    values (p_member_id, p_status, 'standard', null);
  end if;
end;
$$;
revoke all on function public.snh_set_member_membership(uuid, text, text, date) from public;
grant execute on function public.snh_set_member_membership(uuid, text, text, date) to authenticated;

commit;
