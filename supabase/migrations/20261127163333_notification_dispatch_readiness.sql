begin;

create function private.snh_notification_rolling_limit() returns integer
language sql immutable set search_path = '' as $$ select 100 $$;
revoke all on function private.snh_notification_rolling_limit() from public, anon, authenticated;

create or replace function public.snh_claim_notification()
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
declare
  v_live_occupancy integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  select count(*)::integer into v_live_occupancy
  from public.notification_outbox n
  where (n.status='sent' and n.sent_at>now()-interval '24 hours')
     or (n.status='sending' and n.locked_until>now());

  if v_live_occupancy>=private.snh_notification_rolling_limit() then return; end if;

  perform private.snh_cancel_mismatched_notification_recipients();

  update public.notification_outbox n
  set status='failed', last_error='Delivery window expired', locked_until=null, lease_id=null
  where (n.status='pending' or n.status='sending' and n.locked_until<=now())
    and n.delivery_deadline_at<=now();

  update public.notification_outbox n
  set status='failed', last_error='Delivery lease expired', locked_until=null, lease_id=null
  where n.status='sending' and n.locked_until<=now() and n.attempts>=3;

  return query with next_job as (
    select n.id from public.notification_outbox n
    where (n.status='pending' and n.available_at<=now()
           or n.status='sending' and n.locked_until<=now())
      and (n.attempts<3 or n.manual_retry_allowance)
      and n.delivery_deadline_at>now()
    order by n.available_at,n.created_at limit 1 for update skip locked
  )
  update public.notification_outbox n
  set status='sending', attempts=n.attempts+1,
      locked_until=now()+interval '5 minutes', lease_id=gen_random_uuid(),
      manual_retry_allowance=false
  from next_job where n.id=next_job.id returning n.*;
end;
$$;
revoke all on function public.snh_claim_notification() from public,anon,authenticated;
grant execute on function public.snh_claim_notification() to service_role;

create or replace function public.snh_notification_live_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sent integer; v_in_flight integer; v_eligible integer; v_waiting integer; v_expired integer;
  v_pending integer; v_oldest_pending timestamptz; v_oldest_due timestamptz;
  v_limit integer := private.snh_notification_rolling_limit();
begin
  with queue as (
    select n.*,
      (n.status='pending' and n.available_at<=now() or n.status='sending' and n.locked_until<=now())
      and n.delivery_deadline_at>now() and (n.attempts<3 or n.manual_retry_allowance) as eligible
    from public.notification_outbox n
  )
  select
    count(*) filter(where n.status='sent' and n.sent_at>now()-interval '24 hours')::integer,
    count(*) filter(where n.status='sending' and n.locked_until>now())::integer,
    count(*) filter(where n.eligible)::integer,
    count(*) filter(where n.status='pending' and n.available_at>now() and n.delivery_deadline_at>now())::integer,
    count(*) filter(where n.status in ('pending','sending') and n.delivery_deadline_at<=now())::integer,
    count(*) filter(where n.status='pending')::integer,
    min(n.created_at) filter(where n.status='pending'),
    min(n.available_at) filter(where n.eligible)
  into v_sent,v_in_flight,v_eligible,v_waiting,v_expired,v_pending,v_oldest_pending,v_oldest_due
  from queue n;

  return jsonb_build_object(
    'rolling_limit',v_limit,'per_run_limit',10,'sent_last_24h',v_sent,
    'in_flight',v_in_flight,'used',v_sent+v_in_flight,
    'remaining',greatest(0,v_limit-v_sent-v_in_flight),
    'eligible_pending',v_eligible,'waiting_pending',v_waiting,'expired_pending',v_expired,
    'pending_count',v_pending,
    'oldest_pending_age_seconds',floor(extract(epoch from now()-v_oldest_pending)),
    'backlog_status',case
      when v_eligible>0 and v_sent>=v_limit then 'daily_limit'
      when v_oldest_due<=now()-interval '30 minutes' then 'delayed'
      else 'clear'
    end
  );
end;
$$;
revoke all on function public.snh_notification_live_status() from public,anon,authenticated;
grant execute on function public.snh_notification_live_status() to service_role;

-- Retain just the latest incident and both transition timestamps.
create table private.notification_backlog_state (
  singleton boolean primary key default true check (singleton),
  active boolean not null default false,
  last_detected_at timestamptz,
  last_cleared_at timestamptz,
  peak_depth integer
);
alter table private.notification_backlog_state enable row level security;
revoke all on private.notification_backlog_state from public, anon, authenticated, service_role;
insert into private.notification_backlog_state default values;

create index operations_notification_last_success_idx on public.operations_job_runs (finished_at desc)
where job='notification_dispatch' and status='succeeded' and finished_at is not null;

create function public.snh_observe_notification_backlog() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_state private.notification_backlog_state;
  v_status jsonb;
  v_backlogged boolean;
  v_depth integer;
begin
  select * into strict v_state from private.notification_backlog_state for update;
  v_status := public.snh_notification_live_status();
  v_backlogged := v_status->>'backlog_status' <> 'clear';
  v_depth := (v_status->>'pending_count')::integer;
  if v_backlogged and not v_state.active then
    update private.notification_backlog_state
    set active=true, last_detected_at=clock_timestamp(), peak_depth=v_depth;
  elsif v_backlogged and v_depth>v_state.peak_depth then
    update private.notification_backlog_state set peak_depth=v_depth;
  elsif not v_backlogged and v_state.active then
    update private.notification_backlog_state set active=false, last_cleared_at=clock_timestamp();
  end if;
end;
$$;
revoke all on function public.snh_observe_notification_backlog() from public, anon, authenticated;
grant execute on function public.snh_observe_notification_backlog() to service_role;

create or replace function public.snh_operations_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
 perform private.snh_require_operations_admin();
 select jsonb_build_object(
  'integrations', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.integration_status s),
  'policies', (select jsonb_agg(jsonb_build_object('provider',d.provider,'policy',d.policy,
    'default_seconds',d.ttl_seconds,'seconds',coalesce(p.ttl_seconds,d.ttl_seconds),'overridden',p.provider is not null)
    order by d.provider,d.policy) from private.snh_cache_defaults() d left join public.external_api_cache_policies p using(provider,policy)),
  'cache', (select jsonb_build_object('total',count(*),'expired',count(*) filter(where expires_at<=now()),
    'cleanup_eligible',count(*) filter(where resource_type='search' and expires_at<now()-interval '7 days')) from public.external_api_cache),
  'messages', (select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.notification_outbox group by status) counts),
  'notification_health', public.snh_notification_live_status() || (
    select jsonb_build_object(
      'last_successful_run_at', latest.finished_at,
      'last_successful_run_mode', latest.mode,
      'dispatcher_stale', latest.finished_at is null or latest.finished_at<=now()-interval '30 minutes',
      'last_backlog_detected_at', state.last_detected_at,
      'last_backlog_cleared_at', state.last_cleared_at,
      'peak_backlog_depth', state.peak_depth
    )
    from private.notification_backlog_state state
    left join lateral (
      select run.finished_at, run.result->>'mode' as mode
      from public.operations_job_runs run
      where run.job='notification_dispatch' and run.status='succeeded' and run.finished_at is not null
      order by run.finished_at desc limit 1
    ) latest on true
  ),
  'jobs', (select coalesce(jsonb_agg(to_jsonb(j)),'[]') from (
    select distinct on(job) * from public.operations_job_runs order by job,started_at desc,id desc) j)
 ) into result;
 return result;
end; $$;

commit;
