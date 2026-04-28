-- Event management foundation:
-- - standardize public.events columns used by the website/admin tools
-- - add idempotent legacy import key for JSON backfill
-- - configure RLS for public reads + role-based event management

create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid()
);

alter table public.events
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists location text,
  add column if not exists starts_at timestamptz,
  add column if not exists external_url text,
  add column if not exists source text,
  add column if not exists published boolean not null default true,
  add column if not exists is_historical boolean not null default false,
  add column if not exists legacy_import_key text,
  add column if not exists created_by uuid references public.members(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'name'
  ) then
    execute $sql$
      update public.events
      set title = nullif(trim(name::text), '')
      where (title is null or trim(title) = '')
        and nullif(trim(name::text), '') is not null
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'date'
  ) then
    execute $sql$
      update public.events
      set starts_at = case
        when nullif(trim(date::text), '') is null then null
        when trim(date::text) ~ '^\d{4}-\d{2}-\d{2}$'
          then (trim(date::text) || ' 00:00:00+00')::timestamptz
        else starts_at
      end
      where starts_at is null
        and date is not null
    $sql$;
  end if;
end $$;

update public.events
set updated_at = coalesce(updated_at, now()),
    created_at = coalesce(created_at, now())
where updated_at is null
   or created_at is null;

create unique index if not exists events_legacy_import_key_uidx
  on public.events (legacy_import_key)
  where legacy_import_key is not null;

create index if not exists events_starts_at_idx on public.events (starts_at);
create index if not exists events_published_idx on public.events (published);

create or replace function public.set_events_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_events_set_updated_at on public.events;
create trigger trg_events_set_updated_at
before update on public.events
for each row execute function public.set_events_updated_at();

alter table public.events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'events'
      and policyname = 'events_public_read_published'
  ) then
    create policy events_public_read_published
      on public.events
      for select
      to anon, authenticated
      using (published = true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'events'
      and policyname = 'events_managers_read_all'
  ) then
    create policy events_managers_read_all
      on public.events
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.members m
          join public.member_roles mr on mr.member_id = m.id
          where m.user_id = auth.uid()
            and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
        )
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'events'
      and policyname = 'events_managers_write'
  ) then
    create policy events_managers_write
      on public.events
      for all
      to authenticated
      using (
        exists (
          select 1
          from public.members m
          join public.member_roles mr on mr.member_id = m.id
          where m.user_id = auth.uid()
            and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
        )
      )
      with check (
        exists (
          select 1
          from public.members m
          join public.member_roles mr on mr.member_id = m.id
          where m.user_id = auth.uid()
            and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
        )
      );
  end if;
end $$;
