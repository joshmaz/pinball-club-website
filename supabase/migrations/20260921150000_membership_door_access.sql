-- Preserve historical membership rows and fields while narrowing new manual changes.
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
  update public.memberships m set status = p_status, tier = 'standard', end_date = null
  where m.id = (select m2.id from public.memberships m2 where m2.member_id = p_member_id
                order by m2.created_at desc, m2.id desc limit 1);
  if not found then
    insert into public.memberships (member_id, status, tier, end_date)
    values (p_member_id, p_status, 'standard', null);
  end if;
end;
$$;

-- Protect the final club administrator even from cascading member deletion.
create or replace function public.snh_protect_club_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role_slug <> 'club_admin' then return old; end if;
  perform pg_advisory_xact_lock(hashtext('snh_club_admin_guard'));
  if auth.uid() is not null and exists (
    select 1 from public.members where id = old.member_id and user_id = auth.uid()
  ) then
    raise exception 'cannot remove your own Club Admin role' using errcode = '42501';
  end if;
  if (select count(*) from public.member_roles where role_slug = 'club_admin') <= 1 then
    raise exception 'cannot remove the last Club Admin' using errcode = '42501';
  end if;
  return old;
end;
$$;
drop trigger if exists snh_protect_club_admin_delete on public.member_roles;
create trigger snh_protect_club_admin_delete before delete on public.member_roles
for each row execute function public.snh_protect_club_admin();
drop trigger if exists snh_protect_club_admin_update on public.member_roles;
create trigger snh_protect_club_admin_update before update of role_slug, member_id on public.member_roles
for each row when (old.role_slug = 'club_admin') execute function public.snh_protect_club_admin();

-- Only SECURITY DEFINER functions can read or change the code. No table grants or RLS policies.
create table if not exists public.snh_door_secret (
  singleton boolean primary key default true check (singleton),
  code text not null check (length(btrim(code)) between 1 and 100),
  updated_at timestamptz not null default now()
);
alter table public.snh_door_secret enable row level security;
revoke all on public.snh_door_secret from public, anon, authenticated;

create or replace function public.snh_get_door_code()
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_code text;
begin
  if not exists (
    select 1 from public.members m
    join lateral (
      select status from public.memberships ms where ms.member_id = m.id
      order by ms.created_at desc, ms.id desc limit 1
    ) ms on true
    where m.user_id = auth.uid() and ms.status = 'active'
  ) then
    raise exception 'door access requires Full Access Membership' using errcode = '42501';
  end if;
  select code into v_code from public.snh_door_secret where singleton = true;
  return v_code;
end;
$$;
revoke all on function public.snh_get_door_code() from public;
grant execute on function public.snh_get_door_code() to authenticated;

create or replace function public.snh_set_door_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.members m join public.member_roles r on r.member_id = m.id
    where m.user_id = auth.uid() and r.role_slug = 'club_admin'
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_code is null or length(btrim(p_code)) not between 1 and 100 then
    raise exception 'code must be 1 to 100 characters' using errcode = '22023';
  end if;
  insert into public.snh_door_secret(singleton,code,updated_at) values (true,btrim(p_code),now())
  on conflict (singleton) do update set code = excluded.code, updated_at = now();
end;
$$;
revoke all on function public.snh_set_door_code(text) from public;
grant execute on function public.snh_set_door_code(text) to authenticated;
