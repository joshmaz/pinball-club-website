-- Private, versioned IPDB JSON snapshots and normalized records for shared AI evidence.
-- The last validated snapshot remains active until a complete replacement is indexed.

create table public.ipdb_reference_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  storage_path text not null unique,
  etag text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  entry_count integer not null check (entry_count > 0),
  source_refreshed_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  status text not null check (status in ('staging', 'succeeded', 'failed')),
  error text,
  result jsonb not null default '{}'::jsonb
);
create index ipdb_reference_snapshots_latest
  on public.ipdb_reference_snapshots (fetched_at desc, id desc)
  where status = 'succeeded';

create table public.ipdb_reference_entries (
  snapshot_id uuid not null references public.ipdb_reference_snapshots (id) on delete cascade,
  ipdb_id integer not null check (ipdb_id > 0),
  title text not null,
  players smallint check (players between 1 and 16),
  additional_details text not null default '',
  manufacturer text,
  manufacturer_short_name text,
  manufacturer_id integer,
  machine_type text,
  type_short_name text,
  date_of_manufacture date,
  theme text,
  notable_features text,
  design_by text,
  art_by text,
  notes text,
  photos_in text,
  image_files jsonb not null default '[]'::jsonb check (jsonb_typeof(image_files) = 'array'),
  primary key (snapshot_id, ipdb_id)
);
create index ipdb_reference_entries_title
  on public.ipdb_reference_entries (snapshot_id, lower(title));

alter table public.ipdb_reference_snapshots enable row level security;
alter table public.ipdb_reference_entries enable row level security;
revoke all on public.ipdb_reference_snapshots, public.ipdb_reference_entries from public, anon, authenticated;
grant all on public.ipdb_reference_snapshots, public.ipdb_reference_entries to service_role;

create function public.snh_ipdb_reference_sync_promote(p_snapshot_id uuid, p_run_id uuid, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.ipdb_reference_snapshots
     set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb), last_checked_at = now()
   where id = p_snapshot_id and status = 'staging';
  if not found then raise exception 'IPDB snapshot is not awaiting promotion'; end if;
  update public.operations_job_runs
     set status = 'succeeded', finished_at = now(), result = coalesce(p_result, '{}'::jsonb)
   where id = p_run_id and job = 'ipdb_reference_sync' and status = 'running';
  if not found then raise exception 'IPDB job run is not active'; end if;
end;
$$;
revoke all on function public.snh_ipdb_reference_sync_promote(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.snh_ipdb_reference_sync_promote(uuid, uuid, jsonb) to service_role;

create function public.snh_ipdb_reference_sync_unchanged(p_snapshot_id uuid, p_run_id uuid, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.ipdb_reference_snapshots set last_checked_at = now()
   where id = p_snapshot_id and status = 'succeeded';
  if not found then raise exception 'Current IPDB snapshot is unavailable'; end if;
  update public.operations_job_runs
     set status = 'succeeded', finished_at = now(), result = coalesce(p_result, '{}'::jsonb)
   where id = p_run_id and job = 'ipdb_reference_sync' and status = 'running';
  if not found then raise exception 'IPDB job run is not active'; end if;
end;
$$;
revoke all on function public.snh_ipdb_reference_sync_unchanged(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.snh_ipdb_reference_sync_unchanged(uuid, uuid, jsonb) to service_role;

create unique index operations_job_runs_one_ipdb_reference_sync
  on public.operations_job_runs (job)
  where job = 'ipdb_reference_sync' and status = 'running';

create or replace function private.snh_ipdb_reference_sync_cron_invoke()
returns void
language plpgsql security definer set search_path = '' as $$
declare v_base text; v_key text; v_secret text;
begin
  select decrypted_secret into v_base from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_supabase_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_anon_key' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets
   where name = 'snh_ipdb_reference_sync_scheduler_secret' limit 1;

  if nullif(btrim(v_base), '') is null or nullif(btrim(v_key), '') is null
     or nullif(btrim(v_secret), '') is null then
    insert into public.operations_job_runs (job, status, finished_at, error)
    values ('ipdb_reference_sync', 'failed', now(),
      'Scheduler configuration is missing. Set the project URL/key and snh_ipdb_reference_sync_scheduler_secret in Vault.');
    insert into public.integration_status (provider, resource_type, last_attempt_at, last_error_at, last_error)
    values ('ipdb', 'archive', now(), now(), 'Missing scheduler Vault configuration. See game reference-data deployment instructions.')
    on conflict (provider, resource_type) do update set
      last_attempt_at = excluded.last_attempt_at,
      last_error_at = excluded.last_error_at,
      last_error = excluded.last_error;
    return;
  end if;

  perform net.http_post(
    url := rtrim(v_base, '/') || '/functions/v1/ipdb-reference-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key,
      'Authorization', 'Bearer ' || v_key, 'x-ipdb-reference-sync-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;
revoke all on function private.snh_ipdb_reference_sync_cron_invoke() from public, anon, authenticated;

do $outer$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'snh-ipdb-reference-sync-monthly' limit 1;
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
exception when undefined_table then null;
end
$outer$;
select cron.schedule('snh-ipdb-reference-sync-monthly', '0 10 1 * *',
  'select private.snh_ipdb_reference_sync_cron_invoke();');
