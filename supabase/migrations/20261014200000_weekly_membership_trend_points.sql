begin;
-- Keep daily collection and all historical snapshots. The one-year view samples
-- the last observed day of each Monday-Sunday week, with monthly axis divisions.
create or replace function public.snh_get_membership_trends() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.snh_member_can_manage_roles(),false) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(s) order by snapshot_date) from (
    select distinct on(date_trunc('week',snapshot_date::timestamp)) *
    from private.membership_daily_snapshots
    where snapshot_date >= (date_trunc('month',now() at time zone 'America/New_York')-interval '11 months')::date
      and snapshot_date <= (now() at time zone 'America/New_York')::date
    order by date_trunc('week',snapshot_date::timestamp),snapshot_date desc
  ) s),'[]');
end; $$;
revoke all on function public.snh_get_membership_trends() from public,anon;
grant execute on function public.snh_get_membership_trends() to authenticated;
commit;
