begin;
-- Reuse the existing pg_cron + pg_net + Vault convention and project URL/key.
create function private.snh_pintips_cron_invoke() returns void
language plpgsql security definer set search_path = '' as $$
declare v_base text; v_key text; v_secret text;
begin
 select decrypted_secret into v_base from vault.decrypted_secrets where name='snh_pinballmap_ingest_supabase_url' limit 1;
 select decrypted_secret into v_key from vault.decrypted_secrets where name='snh_pinballmap_ingest_anon_key' limit 1;
 select decrypted_secret into v_secret from vault.decrypted_secrets where name='snh_pintips_import_scheduler_secret' limit 1;
 if nullif(btrim(v_base),'') is null or nullif(btrim(v_key),'') is null or nullif(btrim(v_secret),'') is null then
   insert into public.operations_job_runs(job,status,finished_at,error)
   values('pintips_import','failed',now(),'Scheduler configuration missing. Set the project URL/key and snh_pintips_import_scheduler_secret in Vault.');
   insert into public.integration_status(provider,resource_type,last_attempt_at,last_error_at,last_error)
   values('pintips','export',now(),now(),'Missing scheduler Vault configuration. See PinTips deployment instructions.')
   on conflict(provider,resource_type) do update set last_attempt_at=excluded.last_attempt_at,last_error_at=excluded.last_error_at,last_error=excluded.last_error;
   return;
 end if;
 perform net.http_post(url:=rtrim(v_base,'/')||'/functions/v1/pintips-import',
   headers:=jsonb_build_object('Content-Type','application/json','apikey',v_key,'x-pintips-scheduler-secret',v_secret),
   body:='{}'::jsonb,timeout_milliseconds:=120000);
end; $$;
revoke all on function private.snh_pintips_cron_invoke() from public,anon,authenticated;
-- Named jobs are updated by cron.schedule on repeat provisioning. UTC, after the daily export.
select cron.schedule('snh-pintips-import-daily','20 7 * * *','select private.snh_pintips_cron_invoke();');
commit;
