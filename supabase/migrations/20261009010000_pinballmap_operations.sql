begin;

-- Reuse the Operations ledger. No browser access to worker functions or raw data.
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('member_signup','pinballmap_failure'));

create function public.snh_pinballmap_finish(p_run uuid, p_error text default null, p_warning text default null)
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
   for v_member in select distinct on(lower(btrim(m.email))) m.id,btrim(m.email) email
     from public.members m join public.member_roles r on r.member_id=m.id
     where r.role_slug='club_admin' and m.user_id is not null
       and btrim(coalesce(m.email,'')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     order by lower(btrim(m.email)),m.id
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

create function public.snh_pinballmap_begin(p_actor uuid default null, p_location integer default 8908)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_run uuid; v_old uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('pinballmap-ingest',0));
 if exists(select 1 from public.operations_job_runs where job='pinballmap_ingest'
   and (status='running' and started_at>now()-interval '10 minutes' or started_at>now()-interval '30 seconds')) then
   return null;
 end if;
 for v_old in select id from public.operations_job_runs where job='pinballmap_ingest' and status='running'
 loop perform public.snh_pinballmap_finish(v_old,'Completion was not recorded within ten minutes. Check Jobs before retrying.'); end loop;
 insert into public.operations_job_runs(job,result) values('pinballmap_ingest',
   jsonb_build_object('actor_user_id',p_actor,'trigger',case when p_actor is null then 'scheduled' else 'manual' end,
     'location_id',p_location,'change_count',0,'changes','[]'::jsonb,'counts','{}'::jsonb)) returning id into v_run;
 insert into public.integration_status(provider,resource_type,last_attempt_at)
 values('pinballmap','ingest',now()) on conflict(provider,resource_type) do update set last_attempt_at=excluded.last_attempt_at;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('games','import_requested',p_actor,'pinballmap_ingest',v_run::text,jsonb_build_object('location_id',p_location));
 return v_run;
end; $$;

-- Transaction-local snapshots count committed changes, excluding timestamp-only updates.
-- Only names and changed field names are stored in the run, never old/new values.
create function private.snh_pinballmap_snapshot(p_kind text, p_payload jsonb) returns jsonb
language sql stable set search_path = '' as $$
 select coalesce(jsonb_object_agg(x.key,x.value),'{}'::jsonb) from (
   select 'games:'||g.id::text key,jsonb_build_object('kind','games','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(g)-'updated_at'-'created_at') value from public.games g where p_kind='catalog'
   union all
   select 'locations:'||s.id::text,jsonb_build_object('kind','locations','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(s)-'updated_at'-'created_at') from public.game_location_stints s join public.games g on g.id=s.game_id where p_kind='catalog'
   union all
   select 'conditions:'||i.id::text,jsonb_build_object('kind','conditions','game_id',g.id,'title',coalesce(g.title,i.title),'slug',g.slug,
     'data',to_jsonb(i)-'updated_at'-'created_at') from public.club_issues i
     join public.club_issue_import_keys k on k.club_issue_id=i.id and k.source='pinballmap'
     left join public.games g on g.id=i.game_id
     where p_kind='conditions' and k.source_key in(select r->>'submissionId' from jsonb_array_elements(coalesce(p_payload->'rows','[]')) r)
   union all
   select 'images:'||i.id::text,jsonb_build_object('kind','images','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(i)-'updated_at'-'created_at') from public.game_images i join public.games g on g.id=i.game_id
     where p_kind='images' and g.opdb_id=p_payload->>'opdb_id'
 ) x;
$$;

create function private.snh_pinballmap_record_changes(p_run uuid,p_before jsonb,p_after jsonb)
returns void language plpgsql set search_path = '' as $$
declare v_row record; v_fields jsonb; v_changes jsonb:='[]'; v_counts jsonb:='{}'; v_count integer:=0; v_kind text;
begin
 for v_row in select key,value from jsonb_each(p_after) loop
   if p_before->v_row.key->'data' is not distinct from v_row.value->'data' then continue; end if;
   select coalesce(jsonb_agg(k order by k),'[]') into v_fields from jsonb_object_keys(v_row.value->'data') k
     where k not in ('id','game_id') and
       (p_before->v_row.key is null and v_row.value->'data'->k <> 'null'::jsonb
         or p_before->v_row.key is not null and p_before->v_row.key->'data'->k is distinct from v_row.value->'data'->k);
   v_kind:=v_row.value->>'kind';
   v_counts:=jsonb_set(v_counts,array[v_kind],to_jsonb(coalesce((v_counts->>v_kind)::integer,0)+1));
   v_count:=v_count+1;
   if jsonb_array_length(v_changes)<100 then
     v_changes:=v_changes||jsonb_build_array(jsonb_build_object('kind',v_kind,'title',v_row.value->>'title',
       'game_id',v_row.value->>'game_id','action',case when p_before->v_row.key is null then 'added' else 'changed' end,'fields',v_fields));
   end if;
 end loop;
 update public.operations_job_runs set result=result||jsonb_build_object(
   'change_count',coalesce((result->>'change_count')::integer,0)+v_count,
   'counts',jsonb_build_object(
     'games',coalesce((result->'counts'->>'games')::integer,0)+coalesce((v_counts->>'games')::integer,0),
     'locations',coalesce((result->'counts'->>'locations')::integer,0)+coalesce((v_counts->>'locations')::integer,0),
     'conditions',coalesce((result->'counts'->>'conditions')::integer,0)+coalesce((v_counts->>'conditions')::integer,0),
     'images',coalesce((result->'counts'->>'images')::integer,0)+coalesce((v_counts->>'images')::integer,0)),
   'changes',(select coalesce(jsonb_agg(value),'[]') from (select value from jsonb_array_elements(coalesce(result->'changes','[]')||v_changes) limit 100) c))
 where id=p_run;
end; $$;

-- Preserve the existing merge implementations and their authorization checks.
alter function public.snh_pinballmap_upsert_from_activity(jsonb) set schema private;
alter function private.snh_pinballmap_upsert_from_activity(jsonb) rename to snh_pinballmap_catalog_core;
alter function public.snh_pinballmap_import_conditions(jsonb) set schema private;
alter function private.snh_pinballmap_import_conditions(jsonb) rename to snh_pinballmap_conditions_core;
revoke all on function private.snh_pinballmap_catalog_core(jsonb),private.snh_pinballmap_conditions_core(jsonb) from public,anon,authenticated,service_role;

create function private.snh_pinballmap_apply(p_run uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_before jsonb; v_result jsonb;
begin
 if p_run is not null then
   perform 1 from public.operations_job_runs where id=p_run and job='pinballmap_ingest' and status='running' for update;
   if not found then raise exception 'Import run is no longer running'; end if;
   v_before:=private.snh_pinballmap_snapshot(p_kind,p_payload);
 end if;
 if p_kind='catalog' then v_result:=private.snh_pinballmap_catalog_core(p_payload);
 elsif p_kind='conditions' then v_result:=private.snh_pinballmap_conditions_core(p_payload);
 elsif p_kind='images' then v_result:=to_jsonb(public.snh_game_images_import_opdb(p_payload->>'opdb_id',p_payload->'images'));
 else raise exception 'Invalid import stage'; end if;
 if p_run is not null then perform private.snh_pinballmap_record_changes(p_run,v_before,private.snh_pinballmap_snapshot(p_kind,p_payload)); end if;
 return v_result;
end; $$;
create function public.snh_pinballmap_upsert_from_activity(p_payload jsonb) returns jsonb
language sql security definer set search_path = '' as $$
 select private.snh_pinballmap_apply(nullif(p_payload->>'run_id','')::uuid,'catalog',p_payload);
$$;
create function public.snh_pinballmap_import_conditions(p_payload jsonb) returns jsonb
language sql security definer set search_path = '' as $$
 select private.snh_pinballmap_apply(nullif(p_payload->>'run_id','')::uuid,'conditions',p_payload);
$$;
create function public.snh_pinballmap_import_images(p_run uuid,p_opdb_id text,p_images jsonb) returns jsonb
language sql security definer set search_path = '' as $$
 select private.snh_pinballmap_apply(p_run,'images',jsonb_build_object('opdb_id',p_opdb_id,'images',p_images));
$$;

create function public.snh_operations_pinballmap() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_schedule jsonb; v_result jsonb;
begin
 perform private.snh_require_operations_admin();
 begin
   execute $q$select jsonb_build_object('enabled',active,'cron',schedule,
     'cadence',case when schedule='0 */6 * * *' then 'Every six hours (UTC)' else schedule end)
     from cron.job where jobname='pinballmap-ingest-every-6h' order by jobid desc limit 1$q$ into v_schedule;
 exception when undefined_table or invalid_schema_name then v_schedule:=null; end;
 select jsonb_build_object('schedule',v_schedule,'observed_at',now(),
   'runs',(select coalesce(jsonb_agg(x.run order by x.started_at desc,x.id desc),'[]') from (
     select j.id,j.started_at,to_jsonb(j)||jsonb_build_object('actor',coalesce(nullif(btrim(m.display_name),''),
       nullif(btrim(concat_ws(' ',m.first_name,m.last_name)),''),m.email,'Former account')) run
     from public.operations_job_runs j left join public.members m on m.user_id=nullif(j.result->>'actor_user_id','')::uuid
     where j.job='pinballmap_ingest' order by j.started_at desc,j.id desc limit 10) x),
   'last_success',(select to_jsonb(j) from public.operations_job_runs j where j.job='pinballmap_ingest' and status='succeeded' order by started_at desc,id desc limit 1),
   'last_manual',(select to_jsonb(j)||jsonb_build_object('actor',coalesce(nullif(btrim(m.display_name),''),m.email,'Former account'))
     from public.operations_job_runs j left join public.members m on m.user_id=nullif(j.result->>'actor_user_id','')::uuid
     where j.job='pinballmap_ingest' and j.result->>'trigger'='manual' order by j.started_at desc,j.id desc limit 1),
   'last_change',(select to_jsonb(j) from public.operations_job_runs j where j.job='pinballmap_ingest' and (j.result->>'change_count')::integer>0 order by started_at desc,id desc limit 1)) into v_result;
 return v_result;
end; $$;

create or replace function private.snh_pinballmap_ingest_cron_invoke() returns void
language plpgsql security definer set search_path = '' as $$
declare v_base text; v_key text; v_secret text; v_run uuid;
begin
 select decrypted_secret into v_base from vault.decrypted_secrets where name='snh_pinballmap_ingest_supabase_url' limit 1;
 select decrypted_secret into v_key from vault.decrypted_secrets where name='snh_pinballmap_ingest_anon_key' limit 1;
 select decrypted_secret into v_secret from vault.decrypted_secrets where name='snh_pinballmap_ingest_scheduler_secret' limit 1;
 if nullif(btrim(v_base),'') is null or nullif(btrim(v_key),'') is null or nullif(btrim(v_secret),'') is null then
   v_run:=public.snh_pinballmap_begin();
   if v_run is not null then perform public.snh_pinballmap_finish(v_run,'Scheduled invocation skipped: required Vault configuration is missing.'); end if;
   return;
 end if;
 perform net.http_post(url:=rtrim(v_base,'/')||'/functions/v1/pinballmap-ingest',
   headers:=jsonb_build_object('Content-Type','application/json','apikey',v_key,'x-pinballmap-scheduler-secret',v_secret),
   body:='{}'::jsonb,timeout_milliseconds:=300000);
 -- Queuing HTTP is not an import success. The authenticated worker records the run.
end; $$;

revoke all on function private.snh_pinballmap_snapshot(text,jsonb),private.snh_pinballmap_record_changes(uuid,jsonb,jsonb),
 private.snh_pinballmap_apply(uuid,text,jsonb),private.snh_pinballmap_ingest_cron_invoke() from public,anon,authenticated,service_role;
revoke all on function public.snh_pinballmap_begin(uuid,integer),public.snh_pinballmap_finish(uuid,text,text),
 public.snh_pinballmap_upsert_from_activity(jsonb),public.snh_pinballmap_import_conditions(jsonb),
 public.snh_pinballmap_import_images(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.snh_pinballmap_begin(uuid,integer),public.snh_pinballmap_finish(uuid,text,text),
 public.snh_pinballmap_upsert_from_activity(jsonb),public.snh_pinballmap_import_conditions(jsonb),
 public.snh_pinballmap_import_images(uuid,text,jsonb) to service_role;
revoke all on function public.snh_operations_pinballmap() from public,anon;
grant execute on function public.snh_operations_pinballmap() to authenticated;
commit;
