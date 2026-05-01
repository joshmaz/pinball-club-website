-- Games catalog: relational storage, public catalog view, editor/admin RPCs,
-- Pinball Map ingest entrypoint (service role), and append-only audit_log.

-- ---------------------------------------------------------------------------
-- audit_log (shared; games module uses module = 'games')
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  module text not null,
  action text not null,
  actor_user_id uuid references auth.users (id),
  entity_type text not null,
  entity_id text not null,
  old_data jsonb not null default '{}'::jsonb,
  new_data jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_id text
);

comment on table public.audit_log is 'Append-only change log; writes via SECURITY DEFINER RPCs only.';

create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);
create index if not exists audit_log_module_idx on public.audit_log (module, created_at desc);

alter table public.audit_log enable row level security;

-- No policies: only superuser/service role / table owner inserts via SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- games, game_location_stints, game_sale_listings
-- ---------------------------------------------------------------------------

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  title text not null,
  details text,
  image_filename text,
  release_date date,
  manufacture_date date,
  manufacturer text,
  manufacturer_full_name text,
  machine_type text,
  display_type text,
  player_count smallint,
  pinside_url text,
  ipdb_url text,
  kineticist_url text,
  opdb_id text,
  opdb_matched_via text,
  opdb_canonical_name text,
  map_at_club boolean not null default false,
  manual_at_club_override boolean,
  manual_at_club_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_slug_unique unique (slug)
);

comment on column public.games.map_at_club is 'Floor inference from Pinball Map ingest.';
comment on column public.games.manual_at_club_override is 'Editor override; null means use map_at_club only.';

create index if not exists games_map_at_club_idx on public.games (map_at_club);
create index if not exists games_title_lower_idx on public.games (lower(title));

create index if not exists games_effective_at_club_idx on public.games (
  (coalesce(manual_at_club_override, map_at_club))
);

create table if not exists public.game_location_stints (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  address text not null,
  pinball_map_location_id integer,
  pinball_map_machine_id integer,
  joined_club_date date,
  left_club_date date,
  date_unknown boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_location_stints_dates_ok check (
    joined_club_date is null
    or left_club_date is null
    or joined_club_date <= left_club_date
  )
);

create index if not exists game_location_stints_game_id_idx
  on public.game_location_stints (game_id);

create unique index if not exists game_location_stints_ingest_unique
  on public.game_location_stints (game_id, pinball_map_location_id, joined_club_date)
  where pinball_map_location_id is not null and joined_club_date is not null;

create table if not exists public.game_sale_listings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  status text not null,
  asking_price_cents integer,
  listed_at timestamptz,
  sold_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_sale_listings_status_chk check (
    lower(status) in ('draft', 'listed', 'pending', 'sold', 'withdrawn')
  )
);

create unique index if not exists game_sale_listings_one_open
  on public.game_sale_listings (game_id)
  where lower(status) in ('listed', 'pending');

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_games_catalog_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_games_set_updated_at on public.games;
create trigger trg_games_set_updated_at
before update on public.games
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_game_location_stints_set_updated_at on public.game_location_stints;
create trigger trg_game_location_stints_set_updated_at
before update on public.game_location_stints
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_game_sale_listings_set_updated_at on public.game_sale_listings;
create trigger trg_game_sale_listings_set_updated_at
before update on public.game_sale_listings
for each row execute function public.set_games_catalog_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers (member_roles)
-- ---------------------------------------------------------------------------

create or replace function public.snh_member_has_games_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid()
      and mr.role_slug in ('games_editor', 'games_admin', 'club_admin')
  );
$$;

revoke all on function public.snh_member_has_games_access() from public;
grant execute on function public.snh_member_has_games_access() to authenticated;


create or replace function public.snh_member_has_games_admin_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid()
      and mr.role_slug in ('games_admin', 'club_admin')
  );
$$;

revoke all on function public.snh_member_has_games_admin_access() from public;
grant execute on function public.snh_member_has_games_admin_access() to authenticated;


create schema if not exists private;

create or replace function private.snh_audit_game(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb,
  p_new jsonb,
  p_meta jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata
  ) values (
    'games',
    p_action,
    auth.uid(),
    p_entity_type,
    p_entity_id,
    coalesce(p_old, '{}'::jsonb),
    coalesce(p_new, '{}'::jsonb),
    coalesce(p_meta, '{}'::jsonb)
  );
end;
$$;

revoke all on function private.snh_audit_game(text, text, text, jsonb, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.games enable row level security;
alter table public.game_location_stints enable row level security;
alter table public.game_sale_listings enable row level security;

-- Public catalog read (games + stints only; no direct sale read on table)
drop policy if exists games_public_read on public.games;
create policy games_public_read
  on public.games
  for select
  to anon, authenticated
  using (true);

drop policy if exists game_location_stints_public_read on public.game_location_stints;
create policy game_location_stints_public_read
  on public.game_location_stints
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete for anon/authenticated on base tables (RPCs only)
-- game_sale_listings: deny public reads; editors read via snh_games_get_sale_listing RPC

-- ---------------------------------------------------------------------------
-- Catalog view: one row per game, "game" jsonb matches data/games.json shape
-- ---------------------------------------------------------------------------

create or replace view public.games_catalog_v1 as
with games_effective as (
  select
    g.*,
    (coalesce(g.manual_at_club_override, g.map_at_club))::boolean as effective_at_club
  from public.games g
),
stint_rows as (
  select
    ge.id as game_id,
    s.id as stint_id,
    s.address,
    s.pinball_map_location_id,
    s.pinball_map_machine_id,
    s.joined_club_date,
    s.left_club_date,
    ge.effective_at_club,
    (s.joined_club_date is null and s.left_club_date is null) as computed_date_unknown
  from games_effective ge
  join public.game_location_stints s on s.game_id = ge.id
),
stint_json as (
  select
    o.game_id,
    jsonb_agg(o.stint_obj order by o.ord_join nulls last, o.stint_id) as location_stints
  from (
    select
      sr.game_id,
      sr.stint_id,
      sr.joined_club_date as ord_join,
      jsonb_strip_nulls(
        jsonb_build_object(
          'address', sr.address,
          'pinballMapLocationId', sr.pinball_map_location_id,
          'joinedClubDate', to_char(sr.joined_club_date, 'YYYY-MM-DD'),
          'leftClubDate', to_char(sr.left_club_date, 'YYYY-MM-DD'),
          'pinballMapMachineId', sr.pinball_map_machine_id,
          'dateUnknown', sr.computed_date_unknown,
          'sortKeyJoined', case
            when sr.computed_date_unknown then '2016-01-01'
            when sr.joined_club_date is not null then to_char(sr.joined_club_date, 'YYYY-MM-DD')
            else '2016-01-01'
          end,
          'sortKeyLeft', case
            when sr.computed_date_unknown then
              case when sr.effective_at_club then '9999-12-31' else '2016-12-31' end
            when sr.left_club_date is not null then to_char(sr.left_club_date, 'YYYY-MM-DD')
            else case when sr.effective_at_club then '9999-12-31' else '2016-12-31' end
          end
        )
      ) as stint_obj
    from stint_rows sr
  ) o
  group by o.game_id
)
select
  ge.slug,
  jsonb_strip_nulls(
    jsonb_build_object(
      'title', ge.title,
      'details', ge.details,
      'imageFilename', ge.image_filename,
      'releaseDate', to_char(ge.release_date, 'YYYY-MM-DD'),
      'pinsideUrl', ge.pinside_url,
      'ipdbUrl', ge.ipdb_url,
      'kineticistUrl', ge.kineticist_url,
      'locationStints', coalesce(sj.location_stints, '[]'::jsonb),
      'atClub', ge.effective_at_club,
      'mapAtClub', ge.map_at_club,
      'manualAtClubOverride', ge.manual_at_club_override,
      'opdbId', ge.opdb_id,
      'opdbMatchedVia', ge.opdb_matched_via,
      'opdbCanonicalName', ge.opdb_canonical_name,
      'manufacturer', ge.manufacturer,
      'manufacturerFullName', ge.manufacturer_full_name,
      'manufactureDate', to_char(ge.manufacture_date, 'YYYY-MM-DD'),
      'type', ge.machine_type,
      'display', ge.display_type,
      'playerCount', ge.player_count
    )
  ) as game
from games_effective ge
left join stint_json sj on sj.game_id = ge.id;

comment on view public.games_catalog_v1 is 'Public games catalog JSON rows for snhpc.org (v1).';

grant select on public.games_catalog_v1 to anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC: manual at-club override
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_set_manual_at_club(
  p_game_id uuid,
  p_override boolean,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(g.*) into v_old from public.games g where g.id = p_game_id;
  if v_old is null then
    raise exception 'game not found' using errcode = 'P0002';
  end if;

  update public.games
  set
    manual_at_club_override = p_override,
    manual_at_club_note = nullif(trim(p_note), '')
  where id = p_game_id;

  perform private.snh_audit_game(
    'update',
    'game',
    p_game_id::text,
    jsonb_build_object('manual_at_club_override', v_old->'manual_at_club_override', 'manual_at_club_note', v_old->'manual_at_club_note'),
    jsonb_build_object('manual_at_club_override', to_jsonb(p_override), 'manual_at_club_note', to_jsonb(nullif(trim(p_note), ''))),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_set_manual_at_club(uuid, boolean, text) from public;
grant execute on function public.snh_games_set_manual_at_club(uuid, boolean, text) to authenticated;

-- Clear override: overload with single-arg clear - use p_override null by second signature
create or replace function public.snh_games_clear_manual_at_club(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.games
  set manual_at_club_override = null, manual_at_club_note = null
  where id = p_game_id;

  perform private.snh_audit_game(
    'update',
    'game',
    p_game_id::text,
    '{}'::jsonb,
    jsonb_build_object('manual_at_club_override', 'null'::jsonb),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_clear_manual_at_club(uuid) from public;
grant execute on function public.snh_games_clear_manual_at_club(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: upsert core game fields (camelCase keys in p_fields jsonb)
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_upsert(
  p_game_id uuid,
  p_fields jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_title text;
  v_slug text;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(g.*) into v_old from public.games g where g.id = p_game_id;
  if v_old is null then
    raise exception 'game not found' using errcode = 'P0002';
  end if;

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is not null and v_title is distinct from (v_old->>'title') then
    v_slug := nullif(trim(p_fields->>'slug'), '');
    if v_slug is null then
      v_slug := lower(regexp_replace(v_title, '[^a-zA-Z0-9]+', '-', 'g'));
      v_slug := trim(both '-' from v_slug);
    end if;
    if v_slug is null or v_slug = '' then
      raise exception 'invalid slug' using errcode = '22023';
    end if;
    update public.games
    set
      title = v_title,
      slug = v_slug,
      details = coalesce(nullif(trim(p_fields->>'details'), ''), details),
      image_filename = case when p_fields ? 'imageFilename' then nullif(trim(p_fields->>'imageFilename'), '') else image_filename end,
      release_date = case when p_fields ? 'releaseDate' then (p_fields->>'releaseDate')::date else release_date end,
      manufacture_date = case when p_fields ? 'manufactureDate' then (p_fields->>'manufactureDate')::date else manufacture_date end,
      manufacturer = case when p_fields ? 'manufacturer' then nullif(trim(p_fields->>'manufacturer'), '') else manufacturer end,
      manufacturer_full_name = case when p_fields ? 'manufacturerFullName' then nullif(trim(p_fields->>'manufacturerFullName'), '') else manufacturer_full_name end,
      machine_type = case when p_fields ? 'type' then nullif(trim(p_fields->>'type'), '') else machine_type end,
      display_type = case when p_fields ? 'display' then nullif(trim(p_fields->>'display'), '') else display_type end,
      player_count = case when p_fields ? 'playerCount' then (p_fields->>'playerCount')::smallint else player_count end,
      pinside_url = case when p_fields ? 'pinsideUrl' then nullif(trim(p_fields->>'pinsideUrl'), '') else pinside_url end,
      ipdb_url = case when p_fields ? 'ipdbUrl' then nullif(trim(p_fields->>'ipdbUrl'), '') else ipdb_url end,
      kineticist_url = case when p_fields ? 'kineticistUrl' then nullif(trim(p_fields->>'kineticistUrl'), '') else kineticist_url end,
      opdb_id = case when p_fields ? 'opdbId' then nullif(trim(p_fields->>'opdbId'), '') else opdb_id end,
      opdb_matched_via = case when p_fields ? 'opdbMatchedVia' then nullif(trim(p_fields->>'opdbMatchedVia'), '') else opdb_matched_via end,
      opdb_canonical_name = case when p_fields ? 'opdbCanonicalName' then nullif(trim(p_fields->>'opdbCanonicalName'), '') else opdb_canonical_name end
    where id = p_game_id;
  else
    update public.games
    set
      details = coalesce(nullif(trim(p_fields->>'details'), ''), details),
      image_filename = case when p_fields ? 'imageFilename' then nullif(trim(p_fields->>'imageFilename'), '') else image_filename end,
      release_date = case when p_fields ? 'releaseDate' then (p_fields->>'releaseDate')::date else release_date end,
      manufacture_date = case when p_fields ? 'manufactureDate' then (p_fields->>'manufactureDate')::date else manufacture_date end,
      manufacturer = case when p_fields ? 'manufacturer' then nullif(trim(p_fields->>'manufacturer'), '') else manufacturer end,
      manufacturer_full_name = case when p_fields ? 'manufacturerFullName' then nullif(trim(p_fields->>'manufacturerFullName'), '') else manufacturer_full_name end,
      machine_type = case when p_fields ? 'type' then nullif(trim(p_fields->>'type'), '') else machine_type end,
      display_type = case when p_fields ? 'display' then nullif(trim(p_fields->>'display'), '') else display_type end,
      player_count = case when p_fields ? 'playerCount' then (p_fields->>'playerCount')::smallint else player_count end,
      pinside_url = case when p_fields ? 'pinsideUrl' then nullif(trim(p_fields->>'pinsideUrl'), '') else pinside_url end,
      ipdb_url = case when p_fields ? 'ipdbUrl' then nullif(trim(p_fields->>'ipdbUrl'), '') else ipdb_url end,
      kineticist_url = case when p_fields ? 'kineticistUrl' then nullif(trim(p_fields->>'kineticistUrl'), '') else kineticist_url end,
      opdb_id = case when p_fields ? 'opdbId' then nullif(trim(p_fields->>'opdbId'), '') else opdb_id end,
      opdb_matched_via = case when p_fields ? 'opdbMatchedVia' then nullif(trim(p_fields->>'opdbMatchedVia'), '') else opdb_matched_via end,
      opdb_canonical_name = case when p_fields ? 'opdbCanonicalName' then nullif(trim(p_fields->>'opdbCanonicalName'), '') else opdb_canonical_name end
    where id = p_game_id;
  end if;

  perform private.snh_audit_game(
    'update',
    'game',
    p_game_id::text,
    v_old,
    (select to_jsonb(g.*) from public.games g where g.id = p_game_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_upsert(uuid, jsonb) from public;
grant execute on function public.snh_games_upsert(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: upsert stint (camelCase in p_stint; optional id for update)
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_upsert_stint(
  p_game_id uuid,
  p_stint jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_loc int;
  v_join date;
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_id := (p_stint->>'id')::uuid;
  v_loc := (p_stint->>'pinballMapLocationId')::int;
  v_join := case
    when nullif(trim(p_stint->>'joinedClubDate'), '') is null then null
    else (p_stint->>'joinedClubDate')::date
  end;

  if v_id is not null then
    select to_jsonb(s) into v_old from public.game_location_stints s where s.id = v_id and s.game_id = p_game_id;
    if v_old is null then
      raise exception 'stint not found' using errcode = 'P0002';
    end if;

    update public.game_location_stints
    set
      address = coalesce(nullif(trim(p_stint->>'address'), ''), address),
      pinball_map_location_id = coalesce((p_stint->>'pinballMapLocationId')::int, pinball_map_location_id),
      pinball_map_machine_id = case when p_stint ? 'pinballMapMachineId' then (p_stint->>'pinballMapMachineId')::int else pinball_map_machine_id end,
      joined_club_date = case when p_stint ? 'joinedClubDate' then v_join else joined_club_date end,
      left_club_date = case
        when p_stint ? 'leftClubDate' and nullif(trim(p_stint->>'leftClubDate'), '') is null then null
        when p_stint ? 'leftClubDate' then (p_stint->>'leftClubDate')::date
        else left_club_date
      end,
      date_unknown = coalesce((p_stint->>'dateUnknown')::boolean, date_unknown)
    where id = v_id and game_id = p_game_id;

    perform private.snh_audit_game(
      'update',
      'game_location_stint',
      v_id::text,
      v_old,
      (select to_jsonb(s) from public.game_location_stints s where s.id = v_id),
      '{}'::jsonb
    );
    return v_id;
  end if;

  insert into public.game_location_stints (
    game_id, address, pinball_map_location_id, pinball_map_machine_id,
    joined_club_date, left_club_date, date_unknown
  )
  values (
    p_game_id,
    coalesce(nullif(trim(p_stint->>'address'), ''), 'Club location'),
    v_loc,
    (p_stint->>'pinballMapMachineId')::int,
    v_join,
    case when nullif(trim(p_stint->>'leftClubDate'), '') is null then null else (p_stint->>'leftClubDate')::date end,
    coalesce((p_stint->>'dateUnknown')::boolean, false)
  )
  returning id into v_id;

  perform private.snh_audit_game(
    'create',
    'game_location_stint',
    v_id::text,
    '{}'::jsonb,
    p_stint,
    '{}'::jsonb
  );
  return v_id;
end;
$$;

revoke all on function public.snh_games_upsert_stint(uuid, jsonb) from public;
grant execute on function public.snh_games_upsert_stint(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: delete stint (admin)
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_delete_stint(p_stint_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_admin_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(s.*) into v_old
  from public.game_location_stints s
  where s.id = p_stint_id;

  if v_old is null then
    raise exception 'stint not found' using errcode = 'P0002';
  end if;

  delete from public.game_location_stints where id = p_stint_id;

  perform private.snh_audit_game(
    'delete',
    'game_location_stint',
    p_stint_id::text,
    v_old,
    '{}'::jsonb,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_delete_stint(uuid) from public;
grant execute on function public.snh_games_delete_stint(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: sale listing
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_set_sale_listing(p_game_id uuid, p_listing jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_price int;
  v_notes text;
  v_listed timestamptz;
  v_sold timestamptz;
  v_existing uuid;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_status := lower(nullif(trim(p_listing->>'status'), ''));
  if v_status is null then
    raise exception 'status required' using errcode = '22023';
  end if;

  v_price := (p_listing->>'asking_price_cents')::int;
  v_notes := nullif(trim(p_listing->>'notes'), '');
  v_listed := (p_listing->>'listed_at')::timestamptz;
  v_sold := (p_listing->>'sold_at')::timestamptz;

  select id into v_existing
  from public.game_sale_listings
  where game_id = p_game_id
  order by created_at desc
  limit 1;

  if v_existing is not null then
    update public.game_sale_listings
    set
      status = v_status,
      asking_price_cents = v_price,
      notes = v_notes,
      listed_at = v_listed,
      sold_at = v_sold
    where id = v_existing;
  else
    insert into public.game_sale_listings (
      game_id, status, asking_price_cents, notes, listed_at, sold_at
    ) values (
      p_game_id, v_status, v_price, v_notes, v_listed, v_sold
    );
  end if;

  perform private.snh_audit_game(
    'update',
    'game_sale_listing',
    p_game_id::text,
    '{}'::jsonb,
    p_listing,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_set_sale_listing(uuid, jsonb) from public;
grant execute on function public.snh_games_set_sale_listing(uuid, jsonb) to authenticated;


create or replace function public.snh_games_get_sale_listing(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(l.*) into v_row
  from public.game_sale_listings l
  where l.game_id = p_game_id
  order by l.created_at desc
  limit 1;

  return coalesce(v_row, 'null'::jsonb);
end;
$$;

revoke all on function public.snh_games_get_sale_listing(uuid) from public;
grant execute on function public.snh_games_get_sale_listing(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: editor load (id, slug, title for list + full rows)
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_editor_load()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'games',
    coalesce(
      (
        select jsonb_agg(r.obj order by r.title_sort)
        from (
          select
            lower(trim(g.title)) as title_sort,
            jsonb_build_object(
              'id', g.id,
              'slug', g.slug,
              'title', g.title,
              'details', g.details,
              'imageFilename', g.image_filename,
              'releaseDate', to_char(g.release_date, 'YYYY-MM-DD'),
              'manufactureDate', to_char(g.manufacture_date, 'YYYY-MM-DD'),
              'manufacturer', g.manufacturer,
              'manufacturerFullName', g.manufacturer_full_name,
              'type', g.machine_type,
              'display', g.display_type,
              'playerCount', g.player_count,
              'pinsideUrl', g.pinside_url,
              'ipdbUrl', g.ipdb_url,
              'kineticistUrl', g.kineticist_url,
              'opdbId', g.opdb_id,
              'opdbMatchedVia', g.opdb_matched_via,
              'opdbCanonicalName', g.opdb_canonical_name,
              'mapAtClub', g.map_at_club,
              'manualAtClubOverride', g.manual_at_club_override,
              'manualAtClubNote', g.manual_at_club_note,
              'locationStints', (
                select coalesce(
                  jsonb_agg(
                    jsonb_strip_nulls(
                      jsonb_build_object(
                        'id', s.id,
                        'address', s.address,
                        'pinballMapLocationId', s.pinball_map_location_id,
                        'pinballMapMachineId', s.pinball_map_machine_id,
                        'joinedClubDate', to_char(s.joined_club_date, 'YYYY-MM-DD'),
                        'leftClubDate', to_char(s.left_club_date, 'YYYY-MM-DD'),
                        'dateUnknown', s.date_unknown
                      )
                    )
                    order by s.joined_club_date nulls last, s.id
                  ),
                  '[]'::jsonb
                )
                from public.game_location_stints s
                where s.game_id = g.id
              )
            ) as obj
          from public.games g
        ) r
      ),
      '[]'::jsonb
    )
  )
  into v_payload;

  return v_payload;
end;
$$;

revoke all on function public.snh_games_editor_load() from public;
grant execute on function public.snh_games_editor_load() to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Pinball Map ingest (service role) — compact patch list from Edge worker
-- p_payload: { "location_id": int, "location_address": text, "updates": [...], "creates": [...] }
-- update: { "slug": text, "title": text, "mapAtClub": bool, "stint": { camelCase stint fields } }
-- create: { "slug", "title", "details", "mapAtClub", "releaseDate", "locationStints": [ ... ] }
-- ---------------------------------------------------------------------------

create or replace function public.snh_pinballmap_upsert_from_activity(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_loc int;
  v_addr text;
  u jsonb;
  c jsonb;
  v_gid uuid;
  v_slug text;
  v_st jsonb;
  v_stint_id uuid;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  v_loc := (p_payload->>'location_id')::int;
  v_addr := nullif(trim(p_payload->>'location_address'), '');
  if v_loc is null or v_addr is null or v_addr = '' then
    raise exception 'location_id and location_address required' using errcode = '22023';
  end if;

  for u in select * from jsonb_array_elements(coalesce(p_payload->'updates', '[]'::jsonb))
  loop
    v_slug := nullif(trim(u->>'slug'), '');
    if v_slug is null then
      continue;
    end if;

    select id into v_gid from public.games where slug = v_slug limit 1;
    if v_gid is null then
      select id into v_gid from public.games where lower(title) = lower(trim(u->>'title')) limit 1;
    end if;
    if v_gid is null then
      continue;
    end if;

    update public.games
    set map_at_club = coalesce((u->>'mapAtClub')::boolean, map_at_club)
    where id = v_gid;

    v_st := u->'stint';
    if v_st is not null and jsonb_typeof(v_st) = 'object' then
      select s.id into v_stint_id
      from public.game_location_stints s
      where s.game_id = v_gid
        and s.pinball_map_location_id = v_loc
      limit 1;

      if v_stint_id is not null then
        update public.game_location_stints
        set
          address = coalesce(nullif(trim(v_st->>'address'), ''), v_addr),
          pinball_map_machine_id = case when v_st ? 'pinballMapMachineId' then (v_st->>'pinballMapMachineId')::int else pinball_map_machine_id end,
          joined_club_date = case when v_st ? 'joinedClubDate' and nullif(trim(v_st->>'joinedClubDate'), '') is not null
            then (v_st->>'joinedClubDate')::date else joined_club_date end,
          left_club_date = case
            when v_st ? 'leftClubDate' and nullif(trim(v_st->>'leftClubDate'), '') is null then null
            when v_st ? 'leftClubDate' then (v_st->>'leftClubDate')::date
            else left_club_date
          end
        where id = v_stint_id;
      else
        insert into public.game_location_stints (
          game_id, address, pinball_map_location_id, pinball_map_machine_id,
          joined_club_date, left_club_date, date_unknown
        )
        values (
          v_gid,
          coalesce(nullif(trim(v_st->>'address'), ''), v_addr),
          v_loc,
          (v_st->>'pinballMapMachineId')::int,
          case when nullif(trim(v_st->>'joinedClubDate'), '') is null then null else (v_st->>'joinedClubDate')::date end,
          case when nullif(trim(v_st->>'leftClubDate'), '') is null then null else (v_st->>'leftClubDate')::date end,
          false
        );
      end if;
    end if;
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p_payload->'creates', '[]'::jsonb))
  loop
    v_slug := nullif(trim(c->>'slug'), '');
    if v_slug is null then
      v_slug := lower(regexp_replace(nullif(trim(c->>'title'), ''), '[^a-zA-Z0-9]+', '-', 'g'));
      v_slug := trim(both '-' from v_slug);
    end if;
    if v_slug is null or v_slug = '' then
      continue;
    end if;

    insert into public.games (
      slug, title, details, image_filename, release_date, manufacture_date,
      manufacturer, manufacturer_full_name, machine_type, display_type, player_count,
      pinside_url, ipdb_url, kineticist_url, opdb_id, opdb_matched_via, opdb_canonical_name,
      map_at_club
    )
    values (
      v_slug,
      nullif(trim(c->>'title'), ''),
      nullif(trim(c->>'details'), ''),
      nullif(trim(c->>'imageFilename'), ''),
      case when nullif(trim(c->>'releaseDate'), '') is null then null else (c->>'releaseDate')::date end,
      case when nullif(trim(c->>'manufactureDate'), '') is null then null else (c->>'manufactureDate')::date end,
      nullif(trim(c->>'manufacturer'), ''),
      nullif(trim(c->>'manufacturerFullName'), ''),
      nullif(trim(c->>'type'), ''),
      nullif(trim(c->>'display'), ''),
      (c->>'playerCount')::smallint,
      nullif(trim(c->>'pinsideUrl'), ''),
      nullif(trim(c->>'ipdbUrl'), ''),
      nullif(trim(c->>'kineticistUrl'), ''),
      nullif(trim(c->>'opdbId'), ''),
      nullif(trim(c->>'opdbMatchedVia'), ''),
      nullif(trim(c->>'opdbCanonicalName'), ''),
      coalesce((c->>'mapAtClub')::boolean, false)
    )
    on conflict (slug) do nothing
    returning id into v_gid;

    if v_gid is null then
      select id into v_gid from public.games where slug = v_slug limit 1;
    end if;

    if v_gid is not null and c ? 'locationStints' then
      for v_st in select * from jsonb_array_elements(c->'locationStints')
      loop
        insert into public.game_location_stints (
          game_id, address, pinball_map_location_id, pinball_map_machine_id,
          joined_club_date, left_club_date, date_unknown
        )
        values (
          v_gid,
          coalesce(nullif(trim(v_st->>'address'), ''), v_addr),
          coalesce((v_st->>'pinballMapLocationId')::int, v_loc),
          (v_st->>'pinballMapMachineId')::int,
          case when nullif(trim(v_st->>'joinedClubDate'), '') is null then null else (v_st->>'joinedClubDate')::date end,
          case when nullif(trim(v_st->>'leftClubDate'), '') is null then null else (v_st->>'leftClubDate')::date end,
          coalesce((v_st->>'dateUnknown')::boolean, false)
        );
      end loop;
    end if;
  end loop;

  perform private.snh_audit_game(
    'import',
    'pinballmap_ingest',
    v_loc::text,
    '{}'::jsonb,
    jsonb_build_object('location_id', v_loc, 'updates_count', jsonb_array_length(coalesce(p_payload->'updates', '[]'::jsonb)), 'creates_count', jsonb_array_length(coalesce(p_payload->'creates', '[]'::jsonb))),
    '{}'::jsonb
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.snh_pinballmap_upsert_from_activity(jsonb) from public;
grant execute on function public.snh_pinballmap_upsert_from_activity(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- RPC: bulk import from legacy games.json shape (service role; idempotent)
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_import_from_json(p_json jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  g jsonb;
  v_slug text;
  v_gid uuid;
  st jsonb;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for g in select * from jsonb_array_elements(coalesce(p_json->'games', '[]'::jsonb))
  loop
    v_slug := nullif(trim(g->>'slug'), '');
    if v_slug is null then
      v_slug := lower(regexp_replace(nullif(trim(g->>'title'), ''), '[^a-zA-Z0-9]+', '-', 'g'));
      v_slug := trim(both '-' from v_slug);
    end if;
    if v_slug is null or v_slug = '' then
      continue;
    end if;

    insert into public.games (
      slug, title, details, image_filename, release_date, manufacture_date,
      manufacturer, manufacturer_full_name, machine_type, display_type, player_count,
      pinside_url, ipdb_url, kineticist_url, opdb_id, opdb_matched_via, opdb_canonical_name,
      map_at_club, manual_at_club_override, manual_at_club_note
    )
    values (
      v_slug,
      nullif(trim(g->>'title'), ''),
      nullif(trim(g->>'details'), ''),
      nullif(trim(g->>'imageFilename'), ''),
      case when nullif(trim(g->>'releaseDate'), '') is null then null else (g->>'releaseDate')::date end,
      case when nullif(trim(g->>'manufactureDate'), '') is null then null else (g->>'manufactureDate')::date end,
      nullif(trim(g->>'manufacturer'), ''),
      nullif(trim(g->>'manufacturerFullName'), ''),
      nullif(trim(g->>'type'), ''),
      nullif(trim(g->>'display'), ''),
      (g->>'playerCount')::smallint,
      nullif(trim(g->>'pinsideUrl'), ''),
      nullif(trim(g->>'ipdbUrl'), ''),
      nullif(trim(g->>'kineticistUrl'), ''),
      nullif(trim(g->>'opdbId'), ''),
      nullif(trim(g->>'opdbMatchedVia'), ''),
      nullif(trim(g->>'opdbCanonicalName'), ''),
      coalesce((g->>'mapAtClub')::boolean, (g->>'atClub')::boolean, false),
      case when g ? 'manualAtClubOverride' and jsonb_typeof(g->'manualAtClubOverride') = 'boolean'
        then (g->>'manualAtClubOverride')::boolean
        else null
      end,
      nullif(trim(g->>'manualAtClubNote'), '')
    )
    on conflict (slug) do update set
      title = excluded.title,
      details = excluded.details,
      image_filename = excluded.image_filename,
      release_date = excluded.release_date,
      manufacture_date = excluded.manufacture_date,
      manufacturer = excluded.manufacturer,
      manufacturer_full_name = excluded.manufacturer_full_name,
      machine_type = excluded.machine_type,
      display_type = excluded.display_type,
      player_count = excluded.player_count,
      pinside_url = excluded.pinside_url,
      ipdb_url = excluded.ipdb_url,
      kineticist_url = excluded.kineticist_url,
      opdb_id = excluded.opdb_id,
      opdb_matched_via = excluded.opdb_matched_via,
      opdb_canonical_name = excluded.opdb_canonical_name,
      map_at_club = excluded.map_at_club,
      manual_at_club_override = excluded.manual_at_club_override,
      manual_at_club_note = excluded.manual_at_club_note
    returning id into v_gid;

    if v_gid is null then
      select id into v_gid from public.games where slug = v_slug limit 1;
    end if;

    delete from public.game_location_stints where game_id = v_gid;

    for st in select * from jsonb_array_elements(coalesce(g->'locationStints', '[]'::jsonb))
    loop
      insert into public.game_location_stints (
        game_id, address, pinball_map_location_id, pinball_map_machine_id,
        joined_club_date, left_club_date, date_unknown
      )
      values (
        v_gid,
        coalesce(nullif(trim(st->>'address'), ''), 'Club location'),
        (st->>'pinballMapLocationId')::int,
        (st->>'pinballMapMachineId')::int,
        case when nullif(trim(st->>'joinedClubDate'), '') is null then null else (st->>'joinedClubDate')::date end,
        case when nullif(trim(st->>'leftClubDate'), '') is null then null else (st->>'leftClubDate')::date end,
        coalesce((st->>'dateUnknown')::boolean, false)
      );
    end loop;
  end loop;

  perform private.snh_audit_game(
    'import',
    'games_catalog',
    'bulk',
    '{}'::jsonb,
    jsonb_build_object('games_count', jsonb_array_length(coalesce(p_json->'games', '[]'::jsonb))),
    '{}'::jsonb
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.snh_games_import_from_json(jsonb) from public;
grant execute on function public.snh_games_import_from_json(jsonb) to service_role;

