-- Keep role assignment rules aligned with members UI role definitions.
-- This constrains member admin RPC grants to known role slugs.

create or replace function public.snh_is_assignable_member_role(p_role_slug text)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(btrim(lower(p_role_slug)), '') = any (
    array[
      'club_admin',
      'membership_editor',
      'membership_admin',
      'events_editor',
      'events_admin',
      'games_editor',
      'games_admin'
    ]::text[]
  );
$$;

revoke all on function public.snh_is_assignable_member_role(text) from public;
grant execute on function public.snh_is_assignable_member_role(text) to authenticated;

create or replace function public.snh_grant_member_role(p_member_id uuid, p_role_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_member_id is null then
    raise exception 'member_id required' using errcode = '22023';
  end if;

  v_slug := btrim(lower(coalesce(p_role_slug, '')));
  if v_slug = '' or v_slug !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'invalid role_slug' using errcode = '22023';
  end if;
  if not public.snh_is_assignable_member_role(v_slug) then
    raise exception 'role_slug is not assignable' using errcode = '22023';
  end if;

  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_roles (member_id, role_slug)
  values (p_member_id, v_slug)
  on conflict (member_id, role_slug) do nothing;
end;
$$;

revoke all on function public.snh_grant_member_role(uuid, text) from public;
grant execute on function public.snh_grant_member_role(uuid, text) to authenticated;
