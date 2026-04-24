-- RPCs for the member portal "Members" admin panel: aggregate stats, directory, grant/revoke roles.
-- Callers must hold club_admin or members_manager on their own member_roles row.
-- SECURITY DEFINER: runs with function owner privileges; each entrypoint re-checks auth.uid().

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
      and mr.role_slug in ('club_admin', 'members_manager')
  );
$$;

revoke all on function public.snh_member_can_manage_roles() from public;
grant execute on function public.snh_member_can_manage_roles() to authenticated;


create or replace function public.snh_get_member_admin_stats()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return json_build_object(
    'member_count', (select count(*)::int from public.members),
    'membership_count', (select count(*)::int from public.memberships),
    'active_membership_count', (
      select count(*)::int
      from public.memberships
      where lower(trim(coalesce(status, ''))) = 'active'
    ),
    'member_roles_count', (select count(*)::int from public.member_roles)
  );
end;
$$;

revoke all on function public.snh_get_member_admin_stats() from public;
grant execute on function public.snh_get_member_admin_stats() to authenticated;


create or replace function public.snh_list_members_for_admin()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  payload json;
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(json_agg(row_json order by email_sort), '[]'::json)
  into payload
  from (
    select
      json_build_object(
        'member_id', m.id,
        'email', coalesce(m.email, ''),
        'display_name', coalesce(m.display_name, ''),
        'role_slugs', coalesce(
          (
            select array_agg(mr.role_slug order by mr.role_slug)
            from public.member_roles mr
            where mr.member_id = m.id
          ),
          array[]::text[]
        )
      ) as row_json,
      lower(coalesce(m.email, '')) as email_sort
    from public.members m
  ) sub;

  return coalesce(payload, '[]'::json);
end;
$$;

revoke all on function public.snh_list_members_for_admin() from public;
grant execute on function public.snh_list_members_for_admin() to authenticated;


create or replace function public.snh_grant_member_role(p_member_id uuid, p_role_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_member_id is null then
    raise exception 'member_id required' using errcode = '22023';
  end if;

  if p_role_slug is null or btrim(p_role_slug) = '' or btrim(p_role_slug) !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'invalid role_slug' using errcode = '22023';
  end if;

  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_roles (member_id, role_slug)
  values (p_member_id, btrim(p_role_slug))
  on conflict (member_id, role_slug) do nothing;
end;
$$;

revoke all on function public.snh_grant_member_role(uuid, text) from public;
grant execute on function public.snh_grant_member_role(uuid, text) to authenticated;


create or replace function public.snh_revoke_member_role(p_member_id uuid, p_role_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_member_id is null then
    raise exception 'member_id required' using errcode = '22023';
  end if;

  if p_role_slug is null or btrim(p_role_slug) = '' or btrim(p_role_slug) !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'invalid role_slug' using errcode = '22023';
  end if;

  delete from public.member_roles
  where member_id = p_member_id
    and role_slug = btrim(p_role_slug);
end;
$$;

revoke all on function public.snh_revoke_member_role(uuid, text) from public;
grant execute on function public.snh_revoke_member_role(uuid, text) to authenticated;
