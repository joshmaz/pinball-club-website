-- Bound live notification delivery across repeated and concurrent dispatch runs.
-- Each claim reserves one slot by moving the row to sending while holding the
-- transaction-scoped advisory lock. Sent and in-flight messages count toward 10
-- per rolling 24-hour window.
begin;

create or replace function public.snh_claim_notification()
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
declare
  v_live_occupancy integer;
begin
  perform private.snh_cancel_mismatched_notification_recipients();

  update public.notification_outbox n
  set status='failed',last_error='Delivery window expired',locked_until=null,lease_id=null
  where n.status in ('pending','sending')
    and n.created_at<=now()-interval '24 hours';

  -- Exhausted leases must become visibly retryable failures instead of stuck sending rows.
  update public.notification_outbox n
  set status='failed',last_error='Delivery lease expired',locked_until=null,lease_id=null
  where n.status='sending' and n.locked_until<now() and n.attempts>=3;

  -- Serialize capacity checks and claims. The new sending row reserves a slot
  -- before another dispatcher can claim the next message.
  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  select count(*)::integer into v_live_occupancy
  from public.notification_outbox n
  where (n.status='sent' and n.sent_at>now()-interval '24 hours')
     or (n.status='sending' and n.locked_until>now());

  if v_live_occupancy >= 10 then
    return;
  end if;

  return query with next_job as (
    select n.id from public.notification_outbox n where
    (n.status='pending' and n.available_at<=now() or n.status='sending' and n.locked_until<now())
    and (n.attempts<3 or n.manual_retry_allowance)
    and n.created_at>now()-interval '24 hours'
    order by n.available_at,n.created_at limit 1 for update skip locked
  )
  update public.notification_outbox n set status='sending',attempts=n.attempts+1,
    locked_until=now()+interval '5 minutes',lease_id=gen_random_uuid(),manual_retry_allowance=false
  from next_job where n.id=next_job.id returning n.*;
end;
$$;
revoke all on function public.snh_claim_notification() from public,anon,authenticated;
grant execute on function public.snh_claim_notification() to service_role;

-- Safe operational counts only; no message content or recipient details.
create or replace function public.snh_notification_live_status()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sent integer;
  v_in_flight integer;
  v_eligible integer;
  v_waiting integer;
  v_expired integer;
begin
  select
    count(*) filter (where n.status='sent' and n.sent_at>now()-interval '24 hours')::integer,
    count(*) filter (where n.status='sending' and n.locked_until>now())::integer,
    count(*) filter (
      where (n.status='pending' and n.available_at<=now() or n.status='sending' and n.locked_until<now())
        and n.created_at>now()-interval '24 hours'
        and (n.attempts<3 or n.manual_retry_allowance)
    )::integer,
    count(*) filter (where n.status='pending' and n.available_at>now() and n.created_at>now()-interval '24 hours')::integer,
    count(*) filter (where n.status in ('pending','sending') and n.created_at<=now()-interval '24 hours')::integer
  into v_sent,v_in_flight,v_eligible,v_waiting,v_expired
  from public.notification_outbox n;

  return jsonb_build_object(
    'rolling_limit',10,
    'per_run_limit',10,
    'sent_last_24h',v_sent,
    'in_flight',v_in_flight,
    'used',v_sent+v_in_flight,
    'remaining',greatest(0,10-v_sent-v_in_flight),
    'eligible_pending',v_eligible,
    'waiting_pending',v_waiting,
    'expired_pending',v_expired
  );
end;
$$;
revoke all on function public.snh_notification_live_status() from public,anon,authenticated;
grant execute on function public.snh_notification_live_status() to service_role;

commit;
