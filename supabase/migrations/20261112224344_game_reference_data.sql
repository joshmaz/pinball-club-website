-- Private, versioned OPDB V2 reference archives and an exact OPDB/IPDB crosswalk.
-- A snapshot becomes current only after the complete export has been validated,
-- stored, and indexed. Failed runs leave the last successful snapshot untouched.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('game-reference-archives', 'game-reference-archives', false, 26214400, array['application/json'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.opdb_reference_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  storage_path text not null unique,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  entry_count integer not null check (entry_count > 0),
  ipdb_mapping_count integer not null check (ipdb_mapping_count >= 0),
  fetched_at timestamptz not null default now(),
  status text not null check (status in ('staging', 'succeeded', 'failed')),
  error text,
  result jsonb not null default '{}'::jsonb
);
create index opdb_reference_snapshots_latest
  on public.opdb_reference_snapshots (fetched_at desc, id desc)
  where status = 'succeeded';

create table public.opdb_reference_entries (
  snapshot_id uuid not null references public.opdb_reference_snapshots (id) on delete cascade,
  opdb_id text not null,
  opdb_group text not null,
  ipdb_id integer,
  name text not null,
  manufacture_date date,
  manufacturer text,
  primary key (snapshot_id, opdb_id),
  check (opdb_id ~ '^G[A-Za-z0-9]+(-M[A-Za-z0-9]+)?(-A[A-Za-z0-9]+)?$'),
  check (opdb_group ~ '^G[A-Za-z0-9]+$'),
  check (ipdb_id is null or ipdb_id > 0)
);
create index opdb_reference_entries_id_ipdb
  on public.opdb_reference_entries (opdb_id, ipdb_id)
  where ipdb_id is not null;
create index opdb_reference_entries_group_ipdb
  on public.opdb_reference_entries (snapshot_id, opdb_group, ipdb_id)
  where ipdb_id is not null;

alter table public.opdb_reference_snapshots enable row level security;
alter table public.opdb_reference_entries enable row level security;
revoke all on public.opdb_reference_snapshots, public.opdb_reference_entries from public, anon, authenticated;
grant all on public.opdb_reference_snapshots, public.opdb_reference_entries to service_role;

-- These policies are defaults; Operations still stores overrides only.
create or replace function private.snh_cache_defaults() returns table(provider text, policy text, ttl_seconds integer)
language sql immutable set search_path = '' as $$ values
 ('matchplay','search',1800), ('matchplay','event',7200), ('matchplay','standings',120),
 ('matchplay','completed',86400), ('ifpa','event',21600), ('ifpa','rankings',21600),
 ('ifpa','results',21600), ('pinballmap','data',43200), ('kineticist','game',86400),
 ('matchplay','force_refresh_minimum',30), ('ifpa','force_refresh_minimum',30),
 ('pinballmap','force_refresh_minimum',30)
$$;
revoke all on function private.snh_cache_defaults() from public;
insert into public.external_api_cache_policies (provider, policy, ttl_seconds)
values ('kineticist', 'game', 86400)
on conflict (provider, policy) do nothing;
delete from public.external_api_cache_policies p using private.snh_cache_defaults() d
 where p.provider = d.provider and p.policy = d.policy and p.ttl_seconds = d.ttl_seconds;

-- Snapshot promotion and job completion must commit together. This routine is
-- executable only by the Edge Function's service role.
create function public.snh_opdb_reference_sync_promote(p_snapshot_id uuid, p_run_id uuid, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.opdb_reference_snapshots
     set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb)
   where id = p_snapshot_id and status = 'staging';
  if not found then raise exception 'OPDB snapshot is not awaiting promotion'; end if;
  update public.operations_job_runs
     set status = 'succeeded', finished_at = now(), result = coalesce(p_result, '{}'::jsonb)
   where id = p_run_id and job = 'opdb_reference_sync' and status = 'running';
  if not found then raise exception 'OPDB job run is not active'; end if;
end;
$$;
revoke all on function public.snh_opdb_reference_sync_promote(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.snh_opdb_reference_sync_promote(uuid, uuid, jsonb) to service_role;

-- Do not let a wedged worker permanently block the next scheduled refresh.
create unique index operations_job_runs_one_opdb_reference_sync
  on public.operations_job_runs (job)
  where job = 'opdb_reference_sync' and status = 'running';

-- Weekly UTC refresh. Vault names follow the existing Pinball Map scheduler setup;
-- the dedicated function secret is an additional required Vault secret.
create or replace function private.snh_opdb_reference_sync_cron_invoke()
returns void
language plpgsql security definer set search_path = '' as $$
declare v_base text; v_key text; v_secret text;
begin
  select decrypted_secret into v_base from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_supabase_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets
   where name = 'snh_pinballmap_ingest_anon_key' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets
   where name = 'snh_opdb_reference_sync_scheduler_secret' limit 1;

  if nullif(btrim(v_base), '') is null or nullif(btrim(v_key), '') is null
     or nullif(btrim(v_secret), '') is null then
    insert into public.operations_job_runs (job, status, finished_at, error)
    values ('opdb_reference_sync', 'failed', now(),
      'Scheduler configuration is missing. Set the project URL/key and snh_opdb_reference_sync_scheduler_secret in Vault.');
    insert into public.integration_status (provider, resource_type, last_attempt_at, last_error_at, last_error)
    values ('opdb', 'archive', now(), now(), 'Missing scheduler Vault configuration. See game reference-data deployment instructions.')
    on conflict (provider, resource_type) do update set
      last_attempt_at = excluded.last_attempt_at,
      last_error_at = excluded.last_error_at,
      last_error = excluded.last_error;
    return;
  end if;

  perform net.http_post(
    url := rtrim(v_base, '/') || '/functions/v1/opdb-reference-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key,
      'Authorization', 'Bearer ' || v_key, 'x-opdb-reference-sync-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;
revoke all on function private.snh_opdb_reference_sync_cron_invoke() from public, anon, authenticated;

do $outer$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'snh-opdb-reference-sync-weekly' limit 1;
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
exception when undefined_table then null;
end
$outer$;
select cron.schedule('snh-opdb-reference-sync-weekly', '0 9 * * 0',
  'select private.snh_opdb_reference_sync_cron_invoke();');
