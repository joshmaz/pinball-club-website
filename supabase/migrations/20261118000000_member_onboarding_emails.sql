-- One-time account onboarding mail: one verification reminder and one welcome.
-- Supabase Auth remains the source of truth for confirmation and sign-in state.
begin;

alter table public.notification_outbox
  add column delivery_deadline_at timestamptz;

update public.notification_outbox
set delivery_deadline_at = created_at + interval '24 hours';

alter table public.notification_outbox
  alter column delivery_deadline_at set default (now() + interval '24 hours'),
  alter column delivery_deadline_at set not null;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_kind_check;

alter table public.notification_outbox
  add constraint notification_outbox_kind_check
  check (kind in ('member_signup', 'pinballmap_failure', 'pinballmap_game_changes',
                  'member_confirmation_reminder', 'member_welcome'));

-- Give delayed mail its full retry window after the scheduled due time.
create or replace function public.snh_claim_notification()
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
declare
  v_live_occupancy integer;
begin
  perform private.snh_cancel_mismatched_notification_recipients();

  update public.notification_outbox n
  set status='failed', last_error='Delivery window expired', locked_until=null, lease_id=null
  where n.status in ('pending','sending') and n.delivery_deadline_at<=now();

  update public.notification_outbox n
  set status='failed', last_error='Delivery lease expired', locked_until=null, lease_id=null
  where n.status='sending' and n.locked_until<now() and n.attempts>=3;

  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  select count(*)::integer into v_live_occupancy
  from public.notification_outbox n
  where (n.status='sent' and n.sent_at>now()-interval '24 hours')
     or (n.status='sending' and n.locked_until>now());

  if v_live_occupancy>=10 then return; end if;

  return query with next_job as (
    select n.id from public.notification_outbox n
    where (n.status='pending' and n.available_at<=now()
           or n.status='sending' and n.locked_until<now())
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

create or replace function public.snh_finish_notification(
  p_id uuid, p_lease_id uuid, p_status text,
  p_provider_id text default null, p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'failed', 'canceled') then
    raise exception 'invalid notification status' using errcode = '22023';
  end if;
  update public.notification_outbox n
  set status = case when p_status='failed' and n.attempts<3
                         and n.delivery_deadline_at>now()
                    then 'pending' else p_status end,
      available_at = case when p_status='failed'
                          then now()+make_interval(mins=>power(2,n.attempts)::int)
                          else n.available_at end,
      locked_until=null, lease_id=null,
      sent_at=case when p_status='sent' then now() else null end,
      provider_id=left(p_provider_id,200), last_error=left(p_error,500)
  where n.id=p_id and n.lease_id=p_lease_id and n.status='sending';
  return found;
end;
$$;
revoke all on function public.snh_finish_notification(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.snh_finish_notification(uuid,uuid,text,text,text) to service_role;

-- Operations retries and queue status must respect each row's delivery deadline.
create or replace function public.snh_operations_messages(
  p_status text default null, p_before timestamptz default null, p_before_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.snh_require_operations_admin();
  if (p_status is not null and p_status not in ('pending','sending','sent','failed','canceled'))
     or (p_before is null) <> (p_before_id is null) then
    raise exception 'Invalid message filter' using errcode='22023';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(n) order by created_at desc,id desc),'[]')
    from (
      select id,kind,recipient_email,subject,status,attempts,created_at,available_at,sent_at,last_error,
        (status='failed' and delivery_deadline_at>now() and provider_id is null and lease_id is null) can_retry
      from public.notification_outbox
      where (p_status is null or status=p_status)
        and (p_before is null or (created_at,id)<(p_before,p_before_id))
      order by created_at desc,id desc limit 50
    ) n
  );
end;
$$;

create or replace function public.snh_operations_retry(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare old_value public.notification_outbox;
begin
  perform private.snh_require_operations_admin();
  select * into old_value from public.notification_outbox where id=p_id for update;
  if not found or old_value.status<>'failed' or old_value.delivery_deadline_at<=now()
     or old_value.provider_id is not null or old_value.lease_id is not null then
    raise exception 'Message is no longer eligible for safe retry' using errcode='22023';
  end if;
  update public.notification_outbox
    set status='pending',available_at=now(),manual_retry_allowance=true
    where id=p_id;
  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
  values('operations','retry',auth.uid(),'notification',p_id::text,
    jsonb_build_object('status',old_value.status,'attempts',old_value.attempts),
    jsonb_build_object('status','pending'));
end;
$$;

create or replace function private.snh_enqueue_member_confirmation_reminder(
  p_user_id uuid, p_member_id uuid, p_email text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_due_at timestamptz := coalesce(p_created_at, now()) + interval '24 hours';
begin
  if nullif(trim(p_email), '') is null then return; end if;
  insert into public.notification_outbox
    (event_key, kind, recipient_member_id, recipient_email, subject, body,
     template_variables, available_at, delivery_deadline_at)
  values (
    'member_confirmation_reminder:' || p_user_id::text,
    'member_confirmation_reminder', p_member_id, trim(p_email),
    'Finish confirming your SNH Pinball Club account',
    'Your SNH Pinball Club website account still needs email confirmation.' || E'\n\n' ||
    'Use the confirmation link in your signup email. If you cannot find that message or its link expired, go to the sign-in page and choose Resend Confirmation Email. After confirming, sign in with your email and password. If you have forgotten your password, use Forgot Password after confirming.' || E'\n\n' ||
    'If you already confirmed your address, you can ignore this reminder.',
    '{}'::jsonb, v_due_at, v_due_at + interval '24 hours'
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function private.snh_enqueue_member_confirmation_reminder(uuid, uuid, text, timestamptz) from public, anon, authenticated;

create or replace function private.snh_enqueue_member_welcome(p_user_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_member_id uuid;
  v_email text;
begin
  select m.id, u.email
    into v_member_id, v_email
    from auth.users u
    join public.members m on m.user_id = u.id
   where u.id = p_user_id and u.email_confirmed_at is not null
   limit 1;
  if v_member_id is null or nullif(trim(v_email), '') is null then return; end if;

  insert into public.notification_outbox
    (event_key, kind, recipient_member_id, recipient_email, subject, body, template_variables)
  values (
    'member_welcome:' || p_user_id::text,
    'member_welcome', v_member_id, trim(v_email),
    'Welcome to SNH Pinball Club online',
    'Thanks for signing up, and welcome to SNH Pinball Club online!' || E'\n\n' ||
    'Whether you are brand new to the club or have been active with us for years and are just now joining online, we are glad you are here.' || E'\n\n' ||
    'Browse the club’s games and ten years of event history, keep an eye on upcoming events, and come join us when something fits your calendar.' || E'\n\n' ||
    'If you are a paying member, you have full access to the club—come by anytime. If you have questions, contact us at support@snhpinballclub.com.',
    '{}'::jsonb
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function private.snh_enqueue_member_welcome(uuid) from public, anon, authenticated;

-- Preserve the rolling live-send cap and safe status summary while using per-message deadlines.
create or replace function public.snh_notification_live_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sent integer; v_in_flight integer; v_eligible integer; v_waiting integer; v_expired integer;
begin
  select
    count(*) filter(where n.status='sent' and n.sent_at>now()-interval '24 hours')::integer,
    count(*) filter(where n.status='sending' and n.locked_until>now())::integer,
    count(*) filter(
      where (n.status='pending' and n.available_at<=now() or n.status='sending' and n.locked_until<now())
        and n.delivery_deadline_at>now() and (n.attempts<3 or n.manual_retry_allowance)
    )::integer,
    count(*) filter(where n.status='pending' and n.available_at>now() and n.delivery_deadline_at>now())::integer,
    count(*) filter(where n.status in ('pending','sending') and n.delivery_deadline_at<=now())::integer
  into v_sent,v_in_flight,v_eligible,v_waiting,v_expired
  from public.notification_outbox n;

  return jsonb_build_object(
    'rolling_limit',10,'per_run_limit',10,'sent_last_24h',v_sent,
    'in_flight',v_in_flight,'used',v_sent+v_in_flight,
    'remaining',greatest(0,10-v_sent-v_in_flight),
    'eligible_pending',v_eligible,'waiting_pending',v_waiting,'expired_pending',v_expired
  );
end;
$$;
revoke all on function public.snh_notification_live_status() from public,anon,authenticated;
grant execute on function public.snh_notification_live_status() to service_role;

-- The account-created hook also queues the existing role-based volunteer alert.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_member public.members;
begin
  insert into public.members (user_id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email))
  returning * into v_member;
  perform private.snh_enqueue_member_signup(v_member);
  if new.email_confirmed_at is null then
    perform private.snh_enqueue_member_confirmation_reminder(
      new.id, v_member.id, new.email, new.created_at
    );
  end if;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create or replace function private.snh_queue_welcome_after_first_signin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.last_sign_in_at is null
     and new.last_sign_in_at is not null
     and new.email_confirmed_at is not null then
    perform private.snh_enqueue_member_welcome(new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.snh_queue_welcome_after_first_signin() from public, anon, authenticated;
drop trigger if exists trg_snh_queue_welcome_after_first_signin on auth.users;
create trigger trg_snh_queue_welcome_after_first_signin
  after update of last_sign_in_at on auth.users
  for each row execute function private.snh_queue_welcome_after_first_signin();

-- Run the guarded dispatcher hourly. Missing Vault setup skips invocation.
create or replace function private.snh_notification_dispatch_cron_invoke()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_base text;
  v_key text;
  v_secret text;
begin
  select decrypted_secret into v_base from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_supabase_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_anon_key' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets
   where name = 'snh_notification_dispatch_scheduler_secret' limit 1;

  if nullif(btrim(v_base), '') is null
     or nullif(btrim(v_key), '') is null
     or nullif(btrim(v_secret), '') is null then
    raise warning 'Notification dispatcher schedule skipped: configure project URL, anon key, and snh_notification_dispatch_scheduler_secret in Vault';
    return;
  end if;

  perform net.http_post(
    url := rtrim(v_base, '/') || '/functions/v1/notification-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_key,
      'x-notification-secret', v_secret,
      'x-notification-scheduled', 'true'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;
revoke all on function private.snh_notification_dispatch_cron_invoke() from public, anon, authenticated;
select cron.schedule('notification-dispatch-hourly', '*/10 * * * *',
  'select private.snh_notification_dispatch_cron_invoke();');

commit;
