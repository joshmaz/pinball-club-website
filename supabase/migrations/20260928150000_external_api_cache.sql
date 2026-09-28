-- Additive foundation; do not rewrite deployed migration history.
create table public.external_api_cache (
  provider text not null,
  resource_type text not null,
  cache_key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (provider, resource_type, cache_key),
  check (expires_at >= fetched_at)
);
create index external_api_cache_search_expiry on public.external_api_cache (expires_at)
  where resource_type = 'search';

create table public.integration_status (
  provider text not null,
  resource_type text not null,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  latency_ms integer check (latency_ms >= 0),
  primary key (provider, resource_type)
);

create table public.external_api_cache_policies (
  provider text not null,
  policy text not null,
  ttl_seconds integer not null check (ttl_seconds between 1 and 604800),
  primary key (provider, policy)
);
insert into public.external_api_cache_policies values
  ('matchplay', 'search', 1800), ('matchplay', 'event', 7200),
  ('matchplay', 'standings', 120), ('matchplay', 'completed', 86400),
  ('ifpa', 'event', 21600), ('ifpa', 'rankings', 21600),
  ('ifpa', 'results', 21600), ('pinballmap', 'data', 43200);

alter table public.external_api_cache enable row level security;
alter table public.integration_status enable row level security;
alter table public.external_api_cache_policies enable row level security;
revoke all on public.external_api_cache, public.integration_status, public.external_api_cache_policies from public, anon, authenticated;
grant all on public.external_api_cache, public.integration_status, public.external_api_cache_policies to service_role;

-- Explicit, service-only maintenance; scheduling is a deployment step.
create function public.cleanup_external_api_search_cache() returns bigint
language plpgsql security definer set search_path = '' as $$
declare removed bigint;
begin
  delete from public.external_api_cache
  where resource_type = 'search' and expires_at < now() - interval '7 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.cleanup_external_api_search_cache() from public, anon, authenticated;
grant execute on function public.cleanup_external_api_search_cache() to service_role;
