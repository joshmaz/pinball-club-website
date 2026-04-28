-- Use external_accounts as canonical storage for member external profile links.
-- Keeps member core table lean while allowing flexible provider growth.

create table if not exists public.external_accounts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  provider_slug text not null check (btrim(provider_slug) ~ '^[a-z][a-z0-9_]*$'),
  account_handle text not null default '',
  account_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_accounts_member_provider_unique unique (member_id, provider_slug)
);

-- Normalize legacy external_accounts shapes to this canonical schema.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'provider'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'provider_slug'
  ) then
    alter table public.external_accounts rename column provider to provider_slug;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'handle'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'account_handle'
  ) then
    alter table public.external_accounts rename column handle to account_handle;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'url'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_accounts'
      and column_name = 'account_url'
  ) then
    alter table public.external_accounts rename column url to account_url;
  end if;
end;
$$;

alter table public.external_accounts
  add column if not exists provider_slug text,
  add column if not exists account_handle text,
  add column if not exists account_url text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.external_accounts
set
  provider_slug = coalesce(nullif(lower(btrim(coalesce(provider_slug, ''))), ''), 'legacy'),
  account_handle = btrim(coalesce(account_handle, '')),
  account_url = btrim(coalesce(account_url, ''));

alter table public.external_accounts
  alter column provider_slug set not null,
  alter column account_handle set not null,
  alter column account_url set not null,
  alter column account_handle set default '',
  alter column account_url set default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'external_accounts_provider_slug_chk'
      and conrelid = 'public.external_accounts'::regclass
  ) then
    alter table public.external_accounts
      add constraint external_accounts_provider_slug_chk
      check (btrim(provider_slug) ~ '^[a-z][a-z0-9_]*$');
  end if;
end;
$$;

-- Remove duplicates before applying unique member/provider key.
delete from public.external_accounts ea
using (
  select id
  from (
    select
      id,
      row_number() over (
        partition by member_id, provider_slug
        order by updated_at desc nulls last, created_at desc nulls last, id desc
      ) as rn
    from public.external_accounts
  ) ranked
  where ranked.rn > 1
) dupes
where ea.id = dupes.id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'external_accounts_member_provider_unique'
      and conrelid = 'public.external_accounts'::regclass
  ) then
    alter table public.external_accounts
      add constraint external_accounts_member_provider_unique unique (member_id, provider_slug);
  end if;
end;
$$;

alter table public.external_accounts enable row level security;

drop policy if exists "external_accounts_select_own" on public.external_accounts;
create policy "external_accounts_select_own"
on public.external_accounts
for select
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "external_accounts_insert_own" on public.external_accounts;
create policy "external_accounts_insert_own"
on public.external_accounts
for insert
to authenticated
with check (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "external_accounts_update_own" on public.external_accounts;
create policy "external_accounts_update_own"
on public.external_accounts
for update
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "external_accounts_delete_own" on public.external_accounts;
create policy "external_accounts_delete_own"
on public.external_accounts
for delete
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = auth.uid()
  )
);

create or replace function public.set_external_accounts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_external_accounts_updated_at on public.external_accounts;
create trigger trg_external_accounts_updated_at
before update on public.external_accounts
for each row
execute function public.set_external_accounts_updated_at();

-- Backfill IFPA and Stern links from existing member/profile fields.
insert into public.external_accounts (member_id, provider_slug, account_handle, account_url)
select
  m.id,
  'stern_insider',
  btrim(m.stern_insider_username),
  ''
from public.members m
where btrim(coalesce(m.stern_insider_username, '')) <> ''
on conflict (member_id, provider_slug) do update
set
  account_handle = excluded.account_handle,
  account_url = excluded.account_url;

insert into public.external_accounts (member_id, provider_slug, account_handle, account_url)
select
  m.id,
  'ifpa',
  regexp_replace(coalesce(u.raw_user_meta_data->>'ifpa_player_id', ''), '\D', '', 'g'),
  case
    when regexp_replace(coalesce(u.raw_user_meta_data->>'ifpa_player_id', ''), '\D', '', 'g') <> ''
      then 'https://www.ifpapinball.com/player.php?p=' || regexp_replace(coalesce(u.raw_user_meta_data->>'ifpa_player_id', ''), '\D', '', 'g')
    else ''
  end
from public.members m
join auth.users u on u.id = m.user_id
where regexp_replace(coalesce(u.raw_user_meta_data->>'ifpa_player_id', ''), '\D', '', 'g') <> ''
on conflict (member_id, provider_slug) do update
set
  account_handle = excluded.account_handle,
  account_url = excluded.account_url;
