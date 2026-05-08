-- Manual membership admin RPCs:
-- 1) set latest membership status/tier/end_date for a member
-- 2) include latest membership fields in member admin directory payload

create or replace function public.snh_set_member_membership(
  p_member_id uuid,
  p_status text,
  p_tier text,
  p_end_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_tier text;
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_member_id is null then
    raise exception 'member_id required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  v_status := lower(btrim(coalesce(p_status, '')));
  if v_status = '' then
    raise exception 'status required' using errcode = '22023';
  end if;
  if v_status not in ('active', 'past_due', 'expired', 'canceled', 'inactive') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  v_tier := btrim(coalesce(p_tier, ''));
  if v_tier = '' then
    v_tier := 'standard';
  end if;

  update public.memberships m
     set status = v_status,
         tier = v_tier,
         end_date = p_end_date
   where m.id = (
     select m2.id
     from public.memberships m2
     where m2.member_id = p_member_id
     order by m2.created_at desc, m2.id desc
     limit 1
   );

  if not found then
    insert into public.memberships (member_id, status, tier, end_date)
    values (p_member_id, v_status, v_tier, p_end_date);
  end if;
end;
$$;

revoke all on function public.snh_set_member_membership(uuid, text, text, date) from public;
grant execute on function public.snh_set_member_membership(uuid, text, text, date) to authenticated;


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
        'first_name', coalesce(m.first_name, ''),
        'last_name', coalesce(m.last_name, ''),
        'display_name', coalesce(m.display_name, ''),
        'stern_insider_username', coalesce((
          select ea.account_handle
          from public.external_accounts ea
          where ea.member_id = m.id
            and ea.provider_slug = 'stern_insider'
          limit 1
        ), ''),
        'membership_status', lm.status,
        'membership_tier', lm.tier,
        'membership_end_date', lm.end_date,
        'membership_last_updated_at', lm.created_at,
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
    left join lateral (
      select mship.status, mship.tier, mship.end_date, mship.created_at
      from public.memberships mship
      where mship.member_id = m.id
      order by mship.created_at desc, mship.id desc
      limit 1
    ) lm on true
  ) sub;

  return coalesce(payload, '[]'::json);
end;
$$;

revoke all on function public.snh_list_members_for_admin() from public;
grant execute on function public.snh_list_members_for_admin() to authenticated;
