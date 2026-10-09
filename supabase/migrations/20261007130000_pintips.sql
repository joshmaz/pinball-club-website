begin;

-- Imported content has no write path from game editors or visitors.
create table public.pintips (
 tip_id bigint primary key check (tip_id > 0),
 opdb_group text not null check (opdb_group ~ '^G[a-zA-Z0-9]+$'),
 category text not null check (category ~ '^[a-z][a-z0-9_]{0,49}$'),
 text text not null check (length(btrim(text)) > 0 and length(text) <= 20000),
 vote_total integer not null,
 -- Preserve upstream's timezone-free timestamps without inventing a timezone.
 source_created_at timestamp not null,
 source_updated_at timestamp not null
);
create index pintips_opdb_group on public.pintips(opdb_group);
alter table public.pintips enable row level security;
revoke all on public.pintips from public, anon, authenticated;
grant select, insert, update, delete on public.pintips to service_role;

create function private.snh_opdb_group(p_id text) returns text
language sql immutable set search_path = '' as $$
 select case when p_id ~ '^G[a-zA-Z0-9]+(-M[a-zA-Z0-9]+(-A[a-zA-Z0-9]+)?)?$'
   then split_part(p_id, '-', 1) end;
$$;
revoke all on function private.snh_opdb_group(text) from public, anon, authenticated;

-- Match against the current catalog at read time, including subsequent OPDB corrections.
-- A group tip applies to machines and aliases in that group; no title-based fallback.
create function public.snh_public_game_tips(p_game_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',t.tip_id,'text',t.text,
   'category',t.category,'opdbGroup',t.opdb_group) order by t.vote_total desc,t.tip_id),'[]'::jsonb)
 from public.games g join public.pintips t on t.opdb_group=private.snh_opdb_group(g.opdb_id)
 where g.id=p_game_id and g.deleted_at is null;
$$;
revoke all on function public.snh_public_game_tips(uuid) from public;
grant execute on function public.snh_public_game_tips(uuid) to anon, authenticated;

create function public.snh_pintips_begin(p_actor uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('pintips-import',0));
 if exists(select 1 from public.operations_job_runs where job='pintips_import'
   and (status='running' and started_at>now()-interval '5 minutes'
     or started_at>now()-interval '30 seconds')) then return null; end if;
 update public.operations_job_runs set status='failed',finished_at=now(),
   error='Refresh worker did not finish within five minutes. Retry and check Edge Function logs.'
 where job='pintips_import' and status='running';
 insert into public.operations_job_runs(job) values('pintips_import') returning id into v_run;
 insert into public.integration_status(provider,resource_type,last_attempt_at)
 values('pintips','export',now()) on conflict(provider,resource_type)
 do update set last_attempt_at=excluded.last_attempt_at;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('games','import_requested',p_actor,'pintips_import',v_run::text,'{}');
 return v_run;
end; $$;

-- Full-snapshot reconciliation and successful status commit together. No partial batches.
create function public.snh_pintips_finish(p_run uuid,p_tips jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_started timestamptz; v_result jsonb; v_added integer; v_changed integer; v_removed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('pintips-import',0));
 select started_at into v_started from public.operations_job_runs
 where id=p_run and job='pintips_import' and status='running' and started_at>now()-interval '5 minutes' for update;
 if not found then raise exception 'Refresh lease expired; retry'; end if;
 if jsonb_typeof(p_tips) is distinct from 'array' or jsonb_array_length(p_tips) not between 1 and 100000 then
   raise exception 'Invalid PinTips snapshot'; end if;
 -- A constrained staging table also rejects invalid rows or duplicate IDs at the DB boundary.
 create temporary table pintips_stage (like public.pintips including all) on commit drop;
 insert into pintips_stage select * from jsonb_populate_recordset(null::public.pintips,p_tips);
 select count(*) into v_added from pintips_stage s where not exists(select 1 from public.pintips t where t.tip_id=s.tip_id);
 select count(*) into v_changed from pintips_stage s join public.pintips t using(tip_id) where to_jsonb(s)<>to_jsonb(t);
 select count(*) into v_removed from public.pintips t where not exists(select 1 from pintips_stage s where s.tip_id=t.tip_id);
 insert into public.pintips select * from pintips_stage
 on conflict(tip_id) do update set opdb_group=excluded.opdb_group,category=excluded.category,
 text=excluded.text,vote_total=excluded.vote_total,source_created_at=excluded.source_created_at,source_updated_at=excluded.source_updated_at;
 delete from public.pintips t where not exists(select 1 from pintips_stage s where s.tip_id=t.tip_id);
 select jsonb_build_object('tips',jsonb_array_length(p_tips),'added',v_added,'changed',v_changed,'removed',v_removed,
   'matched_games',count(*) filter(where exists(select 1 from public.pintips t where t.opdb_group=private.snh_opdb_group(g.opdb_id))),
   'missing_opdb_games',count(*) filter(where g.opdb_id is null or btrim(g.opdb_id)=''),
   'invalid_opdb_games',count(*) filter(where nullif(btrim(g.opdb_id),'') is not null and private.snh_opdb_group(g.opdb_id) is null),
   'games_without_tips',count(*) filter(where private.snh_opdb_group(g.opdb_id) is not null and not exists(select 1 from public.pintips t where t.opdb_group=private.snh_opdb_group(g.opdb_id))),
   'unmatched_tip_groups',(select count(distinct t.opdb_group) from public.pintips t where not exists(
      select 1 from public.games g2 where g2.deleted_at is null and private.snh_opdb_group(g2.opdb_id)=t.opdb_group)))
 into v_result from public.games g where g.deleted_at is null;
 update public.operations_job_runs set status='succeeded',finished_at=now(),result=v_result where id=p_run;
 update public.integration_status set last_success_at=now(),last_error=null,
 latency_ms=greatest(0,(extract(epoch from (clock_timestamp()-v_started))*1000)::integer)
 where provider='pintips' and resource_type='export';
 return v_result;
end; $$;

create function public.snh_pintips_fail(p_run uuid,p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('pintips-import',0));
 update public.operations_job_runs set status='failed',finished_at=now(),error=left(p_error,1000)
 where id=p_run and job='pintips_import' and status='running';
 if found then
   update public.integration_status set last_error_at=now(),last_error=left(p_error,1000)
   where provider='pintips' and resource_type='export';
 end if;
end; $$;
revoke all on function public.snh_pintips_begin(uuid),public.snh_pintips_finish(uuid,jsonb),public.snh_pintips_fail(uuid,text) from public,anon,authenticated;
grant execute on function public.snh_pintips_begin(uuid),public.snh_pintips_finish(uuid,jsonb),public.snh_pintips_fail(uuid,text) to service_role;
commit;
