-- Operations: club-admin RPCs only; raw cache payloads and credentials stay private.
create function private.snh_require_operations_admin() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members m join public.member_roles r on r.member_id=m.id
    where m.user_id=auth.uid() and r.role_slug='club_admin') then
    raise exception 'not authorized' using errcode='42501';
  end if;
end; $$;
revoke all on function private.snh_require_operations_admin() from public;

-- Code defaults, versioned with adapters. The existing table now contains overrides only.
create function private.snh_cache_defaults() returns table(provider text, policy text, ttl_seconds integer)
language sql immutable set search_path = '' as $$ values
 ('matchplay','search',1800), ('matchplay','event',7200), ('matchplay','standings',120),
 ('matchplay','completed',86400), ('ifpa','event',21600), ('ifpa','rankings',21600),
 ('ifpa','results',21600), ('pinballmap','data',43200),
 ('matchplay','force_refresh_minimum',30), ('ifpa','force_refresh_minimum',30),
 ('pinballmap','force_refresh_minimum',30)
$$;
revoke all on function private.snh_cache_defaults() from public;
delete from public.external_api_cache_policies p using private.snh_cache_defaults() d
 where p.provider=d.provider and p.policy=d.policy and p.ttl_seconds=d.ttl_seconds;

create table public.operations_job_runs (
 id uuid primary key default gen_random_uuid(), job text not null,
 started_at timestamptz not null default now(), finished_at timestamptz,
 status text not null default 'running' check(status in ('running','succeeded','failed')),
 result jsonb not null default '{}', error text
);
create index operations_job_runs_latest on public.operations_job_runs(job,started_at desc);
alter table public.operations_job_runs enable row level security;
revoke all on public.operations_job_runs from public, anon, authenticated;
grant select, insert, update on public.operations_job_runs to service_role;

create function public.snh_operations_snapshot() returns jsonb
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
  'jobs', (select coalesce(jsonb_agg(to_jsonb(j)),'[]') from (
    select distinct on(job) * from public.operations_job_runs order by job,started_at desc,id desc) j)
 ) into result;
 return result;
end; $$;

create function public.snh_operations_policy(p_provider text,p_policy text,p_seconds integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare old_value jsonb;
begin
 perform private.snh_require_operations_admin();
 if not exists(select 1 from private.snh_cache_defaults() where provider=p_provider and policy=p_policy)
   or (p_seconds is not null and (p_seconds<1 or p_seconds>604800)) then
   raise exception 'Invalid cache policy' using errcode='22023';
 end if;
 -- Serialize edits and resets, including the absent-row case.
 perform pg_advisory_xact_lock(hashtextextended(p_provider||':'||p_policy,0));
 select to_jsonb(p) into old_value from public.external_api_cache_policies p where provider=p_provider and policy=p_policy;
 if p_seconds is null then
   delete from public.external_api_cache_policies where provider=p_provider and policy=p_policy;
 else
   insert into public.external_api_cache_policies values(p_provider,p_policy,p_seconds)
    on conflict(provider,policy) do update set ttl_seconds=excluded.ttl_seconds;
 end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
 values('operations',case when p_seconds is null then 'reset' else 'update' end,auth.uid(),'cache_policy',p_provider||':'||p_policy,
 coalesce(old_value,'{}'),jsonb_build_object('ttl_seconds',p_seconds,'uses_default',p_seconds is null));
end; $$;

create function public.snh_operations_messages(p_status text default null,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 perform private.snh_require_operations_admin();
 if (p_status is not null and p_status not in ('pending','sending','sent','failed','canceled'))
 or (p_before is null) <> (p_before_id is null) then raise exception 'Invalid message filter' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(n) order by created_at desc,id desc),'[]') from (
 select id,kind,recipient_email,subject,status,attempts,created_at,available_at,sent_at,last_error,
  (status='failed' and created_at>now()-interval '23 hours' and provider_id is null and lease_id is null) can_retry
 from public.notification_outbox where (p_status is null or status=p_status)
 and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 50) n);
end; $$;

-- Manual retries above the automatic attempt cap get a single explicit allowance.
alter table public.notification_outbox add column manual_retry_allowance boolean not null default false;
create or replace function public.snh_operations_retry(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare old_value public.notification_outbox;
begin
 perform private.snh_require_operations_admin();
 select * into old_value from public.notification_outbox where id=p_id for update;
 if not found or old_value.status<>'failed' or old_value.created_at<=now()-interval '23 hours'
 or old_value.provider_id is not null or old_value.lease_id is not null then
 raise exception 'Message is no longer eligible for safe retry' using errcode='22023'; end if;
 update public.notification_outbox set status='pending',available_at=now(),manual_retry_allowance=true where id=p_id;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
 values('operations','retry',auth.uid(),'notification',p_id::text,
 jsonb_build_object('status',old_value.status,'attempts',old_value.attempts),jsonb_build_object('status','pending'));
end; $$;

create or replace function public.snh_claim_notification() returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
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

-- Both scheduler and manual cleanup use this instrumented, narrowly scoped action.
create or replace function public.cleanup_external_api_search_cache() returns bigint
language plpgsql security definer set search_path = '' as $$
declare removed bigint; run_id uuid;
begin
 insert into public.operations_job_runs(job) values('cache_cleanup') returning id into run_id;
 delete from public.external_api_cache where resource_type='search' and expires_at<now()-interval '7 days';
 get diagnostics removed=row_count;
 update public.operations_job_runs set status='succeeded',finished_at=now(),result=jsonb_build_object('removed',removed) where id=run_id;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('operations','cleanup',auth.uid(),'job',run_id::text,jsonb_build_object('removed',removed));
 return removed;
end; $$;
create function public.snh_operations_cleanup() returns bigint
language plpgsql security definer set search_path = '' as $$
begin
 perform private.snh_require_operations_admin();
 perform pg_advisory_xact_lock(hashtextextended('operations:cache_cleanup',0));
 return public.cleanup_external_api_search_cache();
end; $$;

create function public.snh_operations_dispatch_request() returns void
language plpgsql security definer set search_path = '' as $$
begin
 perform private.snh_require_operations_admin();
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('operations','run_requested',auth.uid(),'job','notification_dispatch','{"job":"notification_dispatch"}');
end; $$;

revoke all on function public.snh_operations_snapshot(), public.snh_operations_policy(text,text,integer),
 public.snh_operations_messages(text,timestamptz,uuid), public.snh_operations_retry(uuid),
 public.snh_operations_cleanup(), public.snh_operations_dispatch_request() from public,anon;
grant execute on function public.snh_operations_snapshot(), public.snh_operations_policy(text,text,integer),
 public.snh_operations_messages(text,timestamptz,uuid), public.snh_operations_retry(uuid),
 public.snh_operations_cleanup(), public.snh_operations_dispatch_request() to authenticated;
