-- Keep the existing bigint return contract: nonnegative = removed count, -1 = failure.
-- A nested transaction rolls back deletions on failure while preserving the run record.
create or replace function public.cleanup_external_api_search_cache() returns bigint
language plpgsql security definer set search_path = '' as $$
declare removed bigint; run_id uuid;
begin
 insert into public.operations_job_runs(job) values('cache_cleanup') returning id into run_id;
 begin
   delete from public.external_api_cache where resource_type='search' and expires_at<now()-interval '7 days';
   get diagnostics removed=row_count;
   update public.operations_job_runs set status='succeeded',finished_at=now(),result=jsonb_build_object('removed',removed) where id=run_id;
   insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
   values('operations','cleanup',auth.uid(),'job',run_id::text,jsonb_build_object('removed',removed));
 exception when others then
   update public.operations_job_runs set status='failed',finished_at=now(),
     result='{"removed":0}',error='Cache cleanup failed; no entries were removed. Check database logs.' where id=run_id;
   insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
   values('operations','cleanup_failed',auth.uid(),'job',run_id::text,'{"removed":0,"status":"failed"}');
   return -1;
 end;
 return removed;
end; $$;
revoke all on function public.cleanup_external_api_search_cache() from public,anon,authenticated;
grant execute on function public.cleanup_external_api_search_cache() to service_role;
