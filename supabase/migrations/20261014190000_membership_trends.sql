begin;
create table private.membership_daily_snapshots (
  snapshot_date date primary key,
  captured_at timestamptz not null,
  definition_version integer not null default 1,
  account_count bigint not null,
  basic_count bigint not null,
  full_access_count bigint not null,
  unverified_count bigint not null,
  volunteer_count bigint not null
);
comment on table private.membership_daily_snapshots is 'Single SNHPC installation aggregate counts, no personal identifiers. Retained indefinitely; future tenants require a scoped key.';
revoke all on private.membership_daily_snapshots from public,anon,authenticated,service_role;
create function private.snh_capture_membership_snapshot() returns void
language sql security definer set search_path = '' as $$
  with accounts as (
    select u.email_confirmed_at is not null verified,coalesce(ms.status='active',false) full_access,
      exists(select 1 from public.members m where m.user_id=u.id
        and private.snh_member_has_effective_role(m.id,'website_volunteer')) volunteer
    from auth.users u left join lateral (
      select s.status from public.memberships s join public.members m on m.id=s.member_id
      where m.user_id=u.id order by s.created_at desc,s.id desc limit 1
    ) ms on true
  )
  insert into private.membership_daily_snapshots(snapshot_date,captured_at,account_count,basic_count,full_access_count,unverified_count,volunteer_count)
    select (now() at time zone 'America/New_York')::date,now(),count(*),
      count(*) filter(where verified and not full_access),count(*) filter(where full_access),
      count(*) filter(where not verified and not full_access),count(*) filter(where volunteer)
    from accounts on conflict(snapshot_date) do nothing;
$$;
revoke all on function private.snh_capture_membership_snapshot() from public,anon,authenticated,service_role;
-- pg_cron uses UTC. Invoke at both candidate hours and gate on Eastern local time
-- so collection remains at 04:00 through DST, without changing global cron settings.
create function private.snh_membership_snapshot_tick() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if extract(hour from now() at time zone 'America/New_York')=4 then
    perform private.snh_capture_membership_snapshot();
  end if;
end; $$;
revoke all on function private.snh_membership_snapshot_tick() from public,anon,authenticated,service_role;
select cron.schedule('snh-membership-snapshot-daily','0 8,9 * * *','select private.snh_membership_snapshot_tick();');

create function public.snh_get_membership_trends() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(),false) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(s) order by snapshot_date) from (
    select distinct on(date_trunc('month',snapshot_date)) * from private.membership_daily_snapshots
    where snapshot_date >= (date_trunc('month',now() at time zone 'America/New_York')-interval '11 months')::date
    order by date_trunc('month',snapshot_date),snapshot_date desc
  ) s),'[]');
end; $$;
revoke all on function public.snh_get_membership_trends() from public,anon;
grant execute on function public.snh_get_membership_trends() to authenticated;
commit;
