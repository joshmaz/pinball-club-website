-- Auth owns member identity; profile fields remain self-service.
begin;

create function private.snh_canonical_member_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_existing public.members; v_email text;
begin
  -- PostgREST selects these database roles; JWT user metadata cannot change them.
  if current_setting('role', true) in ('anon', 'authenticated') then
    if auth.uid() is null or new.user_id is distinct from auth.uid() then
      raise exception 'Profile must belong to the signed-in account' using errcode='42501';
    end if;
    if tg_op = 'UPDATE' then
      if new.id is distinct from old.id or new.user_id is distinct from old.user_id
         or new.created_at is distinct from old.created_at then
        raise exception 'Account identity fields cannot be changed' using errcode='42501';
      end if;
    else
      -- BEFORE INSERT also runs for legacy INSERT ... ON CONFLICT(user_id).
      -- Preserve the existing identity on that path; never accept a supplied ID/time.
      select * into v_existing from public.members where user_id=new.user_id;
      new.id := coalesce(v_existing.id, gen_random_uuid());
      new.created_at := coalesce(v_existing.created_at, now());
    end if;
    new.updated_at := now();
  end if;

  -- Canonicalize even cached clients that still submit their old profile email.
  -- Trusted offline member imports may keep contact details, but never count as
  -- Auth identity: directory and notification functions join auth.users directly.
  if new.user_id is not null then
    select u.email into v_email from auth.users u where u.id=new.user_id;
    new.email := v_email;
  end if;
  return new;
end; $$;
revoke all on function private.snh_canonical_member_identity() from public,anon,authenticated,service_role;
create trigger snh_members_canonical_identity before insert or update on public.members
  for each row execute function private.snh_canonical_member_identity();

create function private.snh_sync_member_auth_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.members set email=new.email where user_id=new.id and email is distinct from new.email;
  return new;
end; $$;
revoke all on function private.snh_sync_member_auth_email() from public,anon,authenticated,service_role;
create trigger snh_sync_member_auth_email after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.snh_sync_member_auth_email();

-- Repair only mirrored identity data. Existing profile audit triggers retain field names,
-- never the previous or current email value. No memberships or roles are changed.
update public.members m set email=u.email from auth.users u
where u.id=m.user_id and m.email is distinct from u.email;

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
        'email_verified', coalesce(u.email_confirmed_at is not null, false),
        'email', coalesce(u.email, ''),
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
        'account_created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at,
        'role_slugs', coalesce(
          (
            select array_agg(mr.role_slug order by mr.role_slug)
            from public.member_roles mr
            where mr.member_id = m.id
          ),
          array[]::text[]
        )
      ) as row_json,
      lower(coalesce(u.email, '')) as email_sort
    from public.members m
    left join auth.users u on u.id = m.user_id
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

-- Resolve notification identity from Auth, independently of the mirrored profile.
create or replace function private.snh_enqueue_member_signup(p_member public.members)
returns void language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
begin
  for v_recipient in
    select distinct on (lower(trim(u.email))) m.id, trim(u.email) as email
    from public.members m
    join auth.users u on u.id=m.user_id
    where private.snh_member_has_effective_role(m.id, 'membership_editor')
      and m.user_id is distinct from p_member.user_id
      and trim(coalesce(u.email, '')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by lower(trim(u.email)), m.id
  loop
    insert into public.notification_outbox
      (event_key, kind, recipient_member_id, recipient_email, subject, body)
    values (
      'member_signup:' || p_member.id::text || ':' || v_recipient.id::text,
      'member_signup', v_recipient.id, v_recipient.email,
      'New SNH Pinball Club website account',
      'A new member created a website profile.' || E'\n\n' ||
      'Name: ' || coalesce(nullif(trim(concat_ws(' ', p_member.first_name, p_member.last_name)), ''),
                              nullif(trim(p_member.display_name), ''), 'Not provided') || E'\n' ||
      'Email: ' || coalesce((select nullif(btrim(u.email), '') from auth.users u where u.id=p_member.user_id), 'Not provided') || E'\n\n' ||
      'Review the member directory in My Account. This is a website account, not a paid membership.'
    ) on conflict (event_key) do nothing;
  end loop;
end;
$$;
revoke all on function private.snh_enqueue_member_signup(public.members) from public, anon, authenticated;

create or replace function public.snh_pinballmap_finish(p_run uuid, p_error text default null, p_warning text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.operations_job_runs; v_previous public.operations_job_runs; v_member record;
begin
 perform pg_advisory_xact_lock(hashtextextended('pinballmap-ingest',0));
 select * into v_run from public.operations_job_runs where id=p_run and job='pinballmap_ingest' and status='running' for update;
 if not found then raise exception 'Import run is no longer running'; end if;
 select * into v_previous from public.operations_job_runs
 where job='pinballmap_ingest' and id<>p_run and status<>'running'
 order by started_at desc,id desc limit 1;
 update public.operations_job_runs set finished_at=clock_timestamp(),
   status=case when p_error is null then 'succeeded' else 'failed' end,
   error=left(p_error,500), result=result||jsonb_build_object('warning',left(p_warning,500)) where id=p_run;
 insert into public.integration_status(provider,resource_type,last_attempt_at,last_success_at,last_error_at,last_error,latency_ms)
 values('pinballmap','ingest',v_run.started_at,case when p_error is null then clock_timestamp() end,
   case when p_error is not null then clock_timestamp() end,left(p_error,500),
   greatest(0,(extract(epoch from (clock_timestamp()-v_run.started_at))*1000)::integer))
 on conflict(provider,resource_type) do update set
   last_attempt_at=excluded.last_attempt_at,
   last_success_at=coalesce(excluded.last_success_at,public.integration_status.last_success_at),
   last_error_at=coalesce(excluded.last_error_at,public.integration_status.last_error_at),
   last_error=excluded.last_error,latency_ms=excluded.latency_ms;
 -- One alert per failure episode. Existing dispatcher retains preview/test/live controls.
 if p_error is not null and v_previous.status is distinct from 'failed' then
   for v_member in select distinct on(lower(btrim(u.email))) m.id,btrim(u.email) email
     from public.members m join auth.users u on u.id=m.user_id
     join public.member_roles r on r.member_id=m.id
     where r.role_slug='club_admin' and m.user_id is not null
       and btrim(coalesce(u.email,'')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     order by lower(btrim(u.email)),m.id
   loop
     insert into public.notification_outbox(event_key,kind,recipient_member_id,recipient_email,subject,body)
     values('pinballmap_failure:'||p_run::text||':'||v_member.id::text,'pinballmap_failure',v_member.id,v_member.email,
       'SNHPC Pinball Map import needs attention',
       'The Pinball Map import failed. Some changes may already have been imported.'||E'\n\n'||left(p_error,500)||E'\n\n'||
       'Review Operations: https://snhpinballclub.com/members.html?panel=operations&section=jobs')
     on conflict(event_key) do nothing;
   end loop;
 end if;
end; $$;

-- Do not redirect a previously queued message to a different address, or disturb
-- sent history/active worker leases. A mismatch is visible as a canceled delivery.
create function private.snh_cancel_mismatched_notification_recipients() returns void
language sql security definer set search_path = '' as $$
  update public.notification_outbox n
  set status='canceled', last_error='Recipient no longer matches the account email',
      locked_until=null, lease_id=null
  where n.kind in ('member_signup','pinballmap_failure')
    and (n.status='pending' or n.status='sending' and n.locked_until<now())
    and not exists (
      select 1 from public.members m join auth.users u on u.id=m.user_id
      where m.id=n.recipient_member_id
        and nullif(btrim(u.email),'') is not null
        and lower(btrim(n.recipient_email))=lower(btrim(u.email))
    );
$$;
revoke all on function private.snh_cancel_mismatched_notification_recipients() from public,anon,authenticated,service_role;
select private.snh_cancel_mismatched_notification_recipients();

create or replace function public.snh_claim_notification() returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
 perform private.snh_cancel_mismatched_notification_recipients();
 update public.notification_outbox n set status='failed',last_error='Delivery window expired',locked_until=null,lease_id=null
 where n.status in ('pending','sending') and n.created_at<=now()-interval '24 hours';
 -- Exhausted leases must become visibly retryable failures instead of stuck sending rows.
 update public.notification_outbox n set status='failed',last_error='Delivery lease expired',locked_until=null,lease_id=null
 where n.status='sending' and n.locked_until<now() and n.attempts>=3;
 return query with next_job as (
 select n.id from public.notification_outbox n where
 (n.status='pending' and n.available_at<=now() or n.status='sending' and n.locked_until<now())
 and (n.attempts<3 or n.manual_retry_allowance) and n.created_at>now()-interval '24 hours'
 order by n.available_at,n.created_at limit 1 for update skip locked
 ) update public.notification_outbox n set status='sending',attempts=n.attempts+1,
 locked_until=now()+interval '5 minutes',lease_id=gen_random_uuid(),manual_retry_allowance=false
 from next_job where n.id=next_job.id returning n.*;
end; $$;
revoke all on function public.snh_claim_notification() from public,anon,authenticated;
grant execute on function public.snh_claim_notification() to service_role;

commit;
