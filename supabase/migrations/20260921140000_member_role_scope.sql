-- Keep the existing assignable-role allowlist; enforce the target role's scope in both write RPCs.
create or replace function public.snh_member_can_assign_role(p_role_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid()
      and (
        mr.role_slug = 'club_admin'
        or (p_role_slug <> 'club_admin' and mr.role_slug = 'membership_admin')
        or (p_role_slug not in ('club_admin', 'membership_admin') and mr.role_slug = 'membership_editor')
      )
  );
$$;
revoke all on function public.snh_member_can_assign_role(text) from public;
grant execute on function public.snh_member_can_assign_role(text) to authenticated;

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
  insert into public.member_roles (member_id, role_slug) values (p_member_id, v_slug)
  on conflict (member_id, role_slug) do nothing;
end;
$$;
revoke all on function public.snh_grant_member_role(uuid, text) from public;
grant execute on function public.snh_grant_member_role(uuid, text) to authenticated;

create or replace function public.snh_revoke_member_role(p_member_id uuid, p_role_slug text)
returns void language plpgsql security definer set search_path = public as $$
declare v_slug text := btrim(lower(coalesce(p_role_slug, '')));
begin
  if not public.snh_member_can_manage_roles() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_id is null then
    raise exception 'member_id required' using errcode = '22023';
  end if;
  if v_slug = '' or v_slug !~ '^[a-z][a-z0-9_]*$' or not public.snh_is_assignable_member_role(v_slug) then
    raise exception 'role_slug is not assignable' using errcode = '22023';
  end if;
  if not public.snh_member_can_assign_role(v_slug) then
    raise exception 'not authorized for role' using errcode = '42501';
  end if;
  delete from public.member_roles where member_id = p_member_id and role_slug = v_slug;
end;
$$;
revoke all on function public.snh_revoke_member_role(uuid, text) from public;
grant execute on function public.snh_revoke_member_role(uuid, text) to authenticated;
