-- Schedule Pinball Map Edge ingest via pg_cron + pg_net (Supabase-recommended pattern).
-- Edge Function must stay deployed with its own secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, …).
-- This job only needs HTTP access with the anon key because pinballmap-ingest uses verify_jwt = false.
--
-- After this migration applies, create two Vault secrets once (SQL Editor, Dashboard → Vault):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'snh_pinballmap_ingest_supabase_url');
--   select vault.create_secret('<anon-or-publishable-key>', 'snh_pinballmap_ingest_anon_key');
-- (First argument is the secret value, second is the name; no trailing slash on the URL.)
--
-- Cron expression: every 6 hours at minute 0 (UTC). Adjust below if you need a different cadence.

create extension if not exists pg_net;

create or replace function private.snh_pinballmap_ingest_cron_invoke ()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_key text;
  v_url text;
begin
  select ds.decrypted_secret
    into v_base
    from vault.decrypted_secrets ds
   where ds.name = 'snh_pinballmap_ingest_supabase_url'
   limit 1;

  select ds.decrypted_secret
    into v_key
    from vault.decrypted_secrets ds
   where ds.name = 'snh_pinballmap_ingest_anon_key'
   limit 1;

  if v_base is null or btrim(v_base) = '' or v_key is null or btrim(v_key) = '' then
    raise warning
      'snh_pinballmap_ingest_cron_invoke: missing vault secrets snh_pinballmap_ingest_supabase_url or snh_pinballmap_ingest_anon_key; skipping HTTP invoke';
    return;
  end if;

  v_url := rtrim(v_base, '/') || '/functions/v1/pinballmap-ingest';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;

comment on function private.snh_pinballmap_ingest_cron_invoke () is
  'pg_cron worker: POST pinballmap-ingest using Vault secrets snh_pinballmap_ingest_supabase_url + snh_pinballmap_ingest_anon_key.';

revoke all on function private.snh_pinballmap_ingest_cron_invoke () from public;

do $outer$
declare
  v_jobid bigint;
begin
  select j.jobid into v_jobid from cron.job j where j.jobname = 'pinballmap-ingest-every-6h' limit 1;
  if v_jobid is not null then
    perform cron.unschedule (v_jobid);
  end if;
exception
  when undefined_table then
    null;
end
$outer$;

select
  cron.schedule (
    'pinballmap-ingest-every-6h',
    '0 */6 * * *',
    $$select private.snh_pinballmap_ingest_cron_invoke ();$$
  );
