-- Forward-only authentication change. Preserve the existing six-hour cron job.
-- Provision matching values out of band, never in this migration:
-- Vault: snh_pinballmap_ingest_scheduler_secret
-- Edge secret: PINBALLMAP_INGEST_SCHEDULER_SECRET
-- The public key is retained only as an API gateway header, never as authorization.
begin;

create or replace function private.snh_pinballmap_ingest_cron_invoke ()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_key text;
  v_scheduler_secret text;
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

  select ds.decrypted_secret
    into v_scheduler_secret
    from vault.decrypted_secrets ds
   where ds.name = 'snh_pinballmap_ingest_scheduler_secret'
   limit 1;

  if v_base is null or btrim(v_base) = '' or v_key is null or btrim(v_key) = ''
     or v_scheduler_secret is null or btrim(v_scheduler_secret) = '' then
    raise warning
      'snh_pinballmap_ingest_cron_invoke: missing vault secrets snh_pinballmap_ingest_supabase_url or snh_pinballmap_ingest_anon_key or snh_pinballmap_ingest_scheduler_secret; skipping HTTP invoke';
    return;
  end if;

  v_url := rtrim(v_base, '/') || '/functions/v1/pinballmap-ingest';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-pinballmap-scheduler-secret', v_scheduler_secret,
      'apikey', v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;

comment on function private.snh_pinballmap_ingest_cron_invoke () is
  'pg_cron worker: POST pinballmap-ingest using Vault secrets snh_pinballmap_ingest_supabase_url + snh_pinballmap_ingest_scheduler_secret; anon key is transport-only.';

revoke all on function private.snh_pinballmap_ingest_cron_invoke () from public, anon, authenticated;


commit;
