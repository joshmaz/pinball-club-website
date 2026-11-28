begin;

-- The dispatcher also runs this before checking capacity. Active leases can
-- still record their outcome, even when the delivery deadline has passed.
create function public.snh_expire_notification_jobs() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox n
  set status='failed',
      last_error=case when n.attempts=0 then 'Notification relevance window expired'
                      else 'Delivery retry window expired' end,
      locked_until=null, lease_id=null
  where (n.status='pending' or n.status='sending' and n.locked_until<=now())
    and n.delivery_deadline_at<=now();

  update public.notification_outbox n
  set status='failed', last_error='Delivery lease expired', locked_until=null, lease_id=null
  where n.status='sending' and n.locked_until<=now() and n.attempts>=3;
end;
$$;
revoke all on function public.snh_expire_notification_jobs() from public, anon, authenticated;
grant execute on function public.snh_expire_notification_jobs() to service_role;

create or replace function public.snh_claim_notification()
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
declare
  v_live_occupancy integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  perform public.snh_expire_notification_jobs();

  select count(*)::integer into v_live_occupancy
  from public.notification_outbox n
  where (n.status='sent' and n.sent_at>now()-interval '24 hours')
     or (n.status='sending' and n.locked_until>now());

  if v_live_occupancy>=private.snh_notification_rolling_limit() then return; end if;

  perform private.snh_cancel_mismatched_notification_recipients();

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
      delivery_deadline_at=case when n.attempts=0
        then least(n.delivery_deadline_at, now()+interval '24 hours')
        else n.delivery_deadline_at end,
      locked_until=now()+interval '5 minutes', lease_id=gen_random_uuid(),
      manual_retry_allowance=false
  from next_job where n.id=next_job.id returning n.*;
end;
$$;
revoke all on function public.snh_claim_notification() from public,anon,authenticated;
grant execute on function public.snh_claim_notification() to service_role;

commit;
