-- Transactional notification queue. Browser clients cannot read or write it.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  kind text not null check (kind in ('member_signup')),
  recipient_member_id uuid not null references public.members(id) on delete cascade,
  recipient_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'canceled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  lease_id uuid,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notification_outbox_due_idx on public.notification_outbox (available_at, created_at)
  where status in ('pending', 'sending');
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;

create or replace function private.snh_queue_member_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
begin
  -- A client creating their own first profile is a signup. Imports and
  -- administrative inserts do not trigger mail, nor do subsequent edits.
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    return new;
  end if;

  for v_recipient in
    select distinct on (lower(trim(m.email))) m.id, trim(m.email) as email
    from public.members m
    join public.member_roles r on r.member_id = m.id
    where r.role_slug in ('membership_editor', 'membership_admin', 'club_admin')
      and m.user_id is distinct from new.user_id
      and trim(coalesce(m.email, '')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by lower(trim(m.email)), m.id
  loop
    insert into public.notification_outbox
      (event_key, kind, recipient_member_id, recipient_email, subject, body)
    values (
      'member_signup:' || new.id::text || ':' || v_recipient.id::text,
      'member_signup', v_recipient.id, v_recipient.email,
      'New SNH Pinball Club website account',
      'A new member created a website profile.' || E'\n\n' ||
      'Name: ' || coalesce(nullif(trim(concat_ws(' ', new.first_name, new.last_name)), ''),
                              nullif(trim(new.display_name), ''), 'Not provided') || E'\n' ||
      'Email: ' || coalesce(nullif(trim(new.email), ''), 'Not provided') || E'\n\n' ||
      'Review the member directory in My Account. This is a website account, not a paid membership.'
    ) on conflict (event_key) do nothing;
  end loop;
  return new;
end;
$$;
revoke all on function private.snh_queue_member_signup() from public;
create trigger trg_queue_member_signup after insert on public.members
  for each row execute function private.snh_queue_member_signup();

-- One atomic claim per message. Leases allow recovery after a worker crash.
-- The 24-hour deadline also bounds retries after an ambiguous API response.
create function public.snh_claim_notification()
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox n
  set status = 'failed', last_error = 'Delivery window expired', locked_until = null, lease_id = null
  where n.status in ('pending', 'sending')
    and n.created_at <= now() - interval '24 hours';

  return query
  with next_job as (
    select n.id from public.notification_outbox n
    where (n.status = 'pending' and n.available_at <= now()
           or n.status = 'sending' and n.locked_until < now())
      and n.attempts < 3
      and n.created_at > now() - interval '24 hours'
    order by n.available_at, n.created_at
    limit 1 for update skip locked
  )
  update public.notification_outbox n
  set status = 'sending', attempts = n.attempts + 1,
      locked_until = now() + interval '5 minutes', lease_id = gen_random_uuid()
  from next_job where n.id = next_job.id returning n.*;
end;
$$;
revoke all on function public.snh_claim_notification() from public, anon, authenticated;
grant execute on function public.snh_claim_notification() to service_role;

create function public.snh_finish_notification(
  p_id uuid, p_lease_id uuid, p_status text,
  p_provider_id text default null, p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'failed', 'canceled') then
    raise exception 'invalid notification status' using errcode = '22023';
  end if;
  update public.notification_outbox n
  set status = case when p_status = 'failed' and n.attempts < 3
                         and n.created_at > now() - interval '23 hours'
                    then 'pending' else p_status end,
      available_at = case when p_status = 'failed'
                          then now() + make_interval(mins => power(2, n.attempts)::int)
                          else n.available_at end,
      locked_until = null, lease_id = null,
      sent_at = case when p_status = 'sent' then now() else null end,
      provider_id = left(p_provider_id, 200), last_error = left(p_error, 500)
  where n.id = p_id and n.lease_id = p_lease_id and n.status = 'sending';
  return found;
end;
$$;
revoke all on function public.snh_finish_notification(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.snh_finish_notification(uuid, uuid, text, text, text) to service_role;
