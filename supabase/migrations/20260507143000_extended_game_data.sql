-- Phase 3 extended game data: high scores, Pingolf, custom mods, club issues,
-- public lazy-read RPC, and catalog JSON id/slug for More Info lookups.

-- ---------------------------------------------------------------------------
-- Catalog view: add stable id + slug inside game JSON (export + DB listing)
-- ---------------------------------------------------------------------------

create or replace view public.games_catalog_v1 as
with games_effective as (
  select
    g.*,
    (coalesce(g.manual_at_club_override, g.map_at_club))::boolean as effective_at_club
  from public.games g
  where g.deleted_at is null
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
      'id', ge.id,
      'slug', ge.slug,
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

comment on view public.games_catalog_v1 is 'Public games catalog JSON rows for snhpc.org (v1); game JSON includes id/slug for More Info RPC.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.game_high_scores (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  score bigint not null,
  player_label text not null default '',
  achieved_on date not null,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

create index if not exists game_high_scores_game_id_idx on public.game_high_scores (game_id);

create table if not exists public.pingolf_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  event_id uuid references public.events (id),
  starts_on date,
  ends_on date,
  is_featured boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pingolf_sessions_one_featured_idx
  on public.pingolf_sessions ((true))
  where is_featured;

create table if not exists public.pingolf_targets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.pingolf_sessions (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  description text not null,
  target_value integer,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pingolf_targets_session_id_idx on public.pingolf_targets (session_id);
create index if not exists pingolf_targets_game_id_idx on public.pingolf_targets (game_id);

create table if not exists public.game_custom_mods (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  title text not null,
  description text,
  reference_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

create index if not exists game_custom_mods_game_id_idx on public.game_custom_mods (game_id);

create table if not exists public.club_issues (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references public.games (id) on delete set null,
  title text not null,
  body text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  constraint club_issues_status_chk check (
    lower(status) in ('open', 'in_progress', 'resolved')
  )
);

create index if not exists club_issues_created_at_idx on public.club_issues (created_at desc);
create index if not exists club_issues_game_id_idx on public.club_issues (game_id);

drop trigger if exists trg_pingolf_sessions_set_updated_at on public.pingolf_sessions;
create trigger trg_pingolf_sessions_set_updated_at
before update on public.pingolf_sessions
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_pingolf_targets_set_updated_at on public.pingolf_targets;
create trigger trg_pingolf_targets_set_updated_at
before update on public.pingolf_targets
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_game_custom_mods_set_updated_at on public.game_custom_mods;
create trigger trg_game_custom_mods_set_updated_at
before update on public.game_custom_mods
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_club_issues_set_updated_at on public.club_issues;
create trigger trg_club_issues_set_updated_at
before update on public.club_issues
for each row execute function public.set_games_catalog_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.game_high_scores enable row level security;
alter table public.pingolf_sessions enable row level security;
alter table public.pingolf_targets enable row level security;
alter table public.game_custom_mods enable row level security;
alter table public.club_issues enable row level security;

drop policy if exists club_issues_authenticated_select on public.club_issues;
create policy club_issues_authenticated_select
  on public.club_issues
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Helper: ensure game exists and not soft-deleted (editor writes)
-- ---------------------------------------------------------------------------

create or replace function private.snh_require_game_editable(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.games g
    where g.id = p_game_id and g.deleted_at is null
  ) then
    raise exception 'game not found or deleted' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function private.snh_require_game_editable(uuid) from public;

-- ---------------------------------------------------------------------------
-- game_high_scores RPCs
-- ---------------------------------------------------------------------------

create or replace function public.snh_game_high_scores_list(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', h.id,
          'score', h.score,
          'playerLabel', h.player_label,
          'achievedOn', to_char(h.achieved_on, 'YYYY-MM-DD'),
          'notes', h.notes,
          'sortOrder', h.sort_order
        )
        order by h.sort_order, h.achieved_on desc, h.score desc
      )
      from public.game_high_scores h
      where h.game_id = p_game_id
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_game_high_scores_list(uuid) from public;
grant execute on function public.snh_game_high_scores_list(uuid) to authenticated;

create or replace function public.snh_game_high_scores_upsert(
  p_id uuid,
  p_game_id uuid,
  p_fields jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score bigint;
  v_label text;
  v_on date;
  v_notes text;
  v_sort int;
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform private.snh_require_game_editable(p_game_id);

  v_score := (p_fields->>'score')::bigint;
  if v_score is null then
    raise exception 'score required' using errcode = '22023';
  end if;

  v_label := coalesce(nullif(trim(p_fields->>'playerLabel'), ''), '');
  v_notes := nullif(trim(p_fields->>'notes'), '');
  v_sort := coalesce((p_fields->>'sortOrder')::integer, 0);

  if nullif(trim(p_fields->>'achievedOn'), '') is not null then
    v_on := (p_fields->>'achievedOn')::date;
  else
    raise exception 'achievedOn required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.game_high_scores (
      game_id, score, player_label, achieved_on, notes, sort_order, created_by
    )
    values (
      p_game_id, v_score, v_label, v_on, v_notes, v_sort, auth.uid()
    );
    perform private.snh_audit_game(
      'insert',
      'game_high_score',
      p_game_id::text,
      '{}'::jsonb,
      jsonb_build_object('score', v_score, 'playerLabel', v_label, 'achievedOn', p_fields->>'achievedOn'),
      '{}'::jsonb
    );
  else
    select to_jsonb(h.*) into v_old from public.game_high_scores h where h.id = p_id and h.game_id = p_game_id;
    if v_old is null then
      raise exception 'score row not found' using errcode = 'P0002';
    end if;

    update public.game_high_scores h
    set
      score = v_score,
      player_label = v_label,
      achieved_on = v_on,
      notes = v_notes,
      sort_order = v_sort
    where h.id = p_id and h.game_id = p_game_id;

    perform private.snh_audit_game(
      'update',
      'game_high_score',
      p_id::text,
      v_old,
      jsonb_build_object('score', v_score, 'playerLabel', v_label, 'achievedOn', p_fields->>'achievedOn'),
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_game_high_scores_upsert(uuid, uuid, jsonb) from public;
grant execute on function public.snh_game_high_scores_upsert(uuid, uuid, jsonb) to authenticated;

create or replace function public.snh_game_high_scores_delete(p_id uuid)
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

  select to_jsonb(h.*) into v_old from public.game_high_scores h where h.id = p_id;
  if v_old is null then
    return;
  end if;

  delete from public.game_high_scores h where h.id = p_id;

  perform private.snh_audit_game(
    'delete',
    'game_high_score',
    p_id::text,
    v_old,
    '{}'::jsonb,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_game_high_scores_delete(uuid) from public;
grant execute on function public.snh_game_high_scores_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Pingolf RPCs
-- ---------------------------------------------------------------------------

create or replace function public.snh_pingolf_sessions_list_editor()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'title', s.title,
          'eventId', s.event_id,
          'startsOn', to_char(s.starts_on, 'YYYY-MM-DD'),
          'endsOn', to_char(s.ends_on, 'YYYY-MM-DD'),
          'isFeatured', s.is_featured,
          'notes', s.notes
        )
        order by s.is_featured desc, s.starts_on desc nulls last, s.created_at desc
      )
      from public.pingolf_sessions s
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_pingolf_sessions_list_editor() from public;
grant execute on function public.snh_pingolf_sessions_list_editor() to authenticated;

create or replace function public.snh_pingolf_session_upsert(p_id uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id uuid;
  v_feat boolean;
  v_feat_set boolean;
begin
  if not coalesce(public.snh_member_has_games_admin_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_feat_set := p_fields ? 'isFeatured';
  v_feat := case when v_feat_set then coalesce((p_fields->>'isFeatured')::boolean, false) else false end;

  if v_feat_set and v_feat then
    update public.pingolf_sessions set is_featured = false where is_featured;
  end if;

  if p_id is null then
    insert into public.pingolf_sessions (
      title, event_id, starts_on, ends_on, is_featured, notes
    )
    values (
      nullif(trim(p_fields->>'title'), ''),
      nullif(p_fields->>'eventId', '')::uuid,
      case when nullif(trim(p_fields->>'startsOn'), '') is null then null else (p_fields->>'startsOn')::date end,
      case when nullif(trim(p_fields->>'endsOn'), '') is null then null else (p_fields->>'endsOn')::date end,
      case when v_feat_set then v_feat else false end,
      nullif(trim(p_fields->>'notes'), '')
    )
    returning id into v_new_id;

    perform private.snh_audit_game(
      'insert',
      'pingolf_session',
      v_new_id::text,
      '{}'::jsonb,
      p_fields,
      '{}'::jsonb
    );
    return v_new_id;
  else
    update public.pingolf_sessions s
    set
      title = coalesce(nullif(trim(p_fields->>'title'), ''), s.title),
      event_id = case when p_fields ? 'eventId' then nullif(p_fields->>'eventId', '')::uuid else s.event_id end,
      starts_on = case when p_fields ? 'startsOn' then case when nullif(trim(p_fields->>'startsOn'), '') is null then null else (p_fields->>'startsOn')::date end else s.starts_on end,
      ends_on = case when p_fields ? 'endsOn' then case when nullif(trim(p_fields->>'endsOn'), '') is null then null else (p_fields->>'endsOn')::date end else s.ends_on end,
      is_featured = case when v_feat_set then v_feat else s.is_featured end,
      notes = case when p_fields ? 'notes' then nullif(trim(p_fields->>'notes'), '') else s.notes end
    where s.id = p_id;

    perform private.snh_audit_game(
      'update',
      'pingolf_session',
      p_id::text,
      '{}'::jsonb,
      p_fields,
      '{}'::jsonb
    );
    return p_id;
  end if;
end;
$$;

revoke all on function public.snh_pingolf_session_upsert(uuid, jsonb) from public;
grant execute on function public.snh_pingolf_session_upsert(uuid, jsonb) to authenticated;

create or replace function public.snh_pingolf_targets_list_editor(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'sessionId', t.session_id,
          'gameId', t.game_id,
          'description', t.description,
          'targetValue', t.target_value,
          'sortOrder', t.sort_order
        )
        order by t.sort_order, t.description
      )
      from public.pingolf_targets t
      where t.session_id = p_session_id
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_pingolf_targets_list_editor(uuid) from public;
grant execute on function public.snh_pingolf_targets_list_editor(uuid) to authenticated;

create or replace function public.snh_pingolf_target_upsert(p_id uuid, p_session_id uuid, p_game_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desc text;
  v_val int;
  v_sort int;
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform private.snh_require_game_editable(p_game_id);

  if not exists (select 1 from public.pingolf_sessions s where s.id = p_session_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  v_desc := nullif(trim(p_fields->>'description'), '');
  if v_desc is null then
    raise exception 'description required' using errcode = '22023';
  end if;

  v_val := case when p_fields ? 'targetValue' and nullif(trim(p_fields->>'targetValue'), '') is not null
    then (p_fields->>'targetValue')::integer else null end;
  v_sort := coalesce((p_fields->>'sortOrder')::integer, 0);

  if p_id is null then
    insert into public.pingolf_targets (
      session_id, game_id, description, target_value, sort_order
    )
    values (p_session_id, p_game_id, v_desc, v_val, v_sort);

    perform private.snh_audit_game(
      'insert',
      'pingolf_target',
      p_game_id::text,
      '{}'::jsonb,
      jsonb_build_object('sessionId', p_session_id, 'description', v_desc),
      '{}'::jsonb
    );
  else
    select to_jsonb(t.*) into v_old
    from public.pingolf_targets t
    where t.id = p_id and t.session_id = p_session_id and t.game_id = p_game_id;

    if v_old is null then
      raise exception 'target not found' using errcode = 'P0002';
    end if;

    update public.pingolf_targets t
    set description = v_desc, target_value = v_val, sort_order = v_sort
    where t.id = p_id;

    perform private.snh_audit_game(
      'update',
      'pingolf_target',
      p_id::text,
      v_old,
      jsonb_build_object('description', v_desc),
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_pingolf_target_upsert(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.snh_pingolf_target_upsert(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.snh_pingolf_target_delete(p_id uuid)
returns void
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

  select to_jsonb(t.*) into v_old from public.pingolf_targets t where t.id = p_id;
  if v_old is null then
    return;
  end if;

  delete from public.pingolf_targets t where t.id = p_id;

  perform private.snh_audit_game(
    'delete',
    'pingolf_target',
    p_id::text,
    v_old,
    '{}'::jsonb,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_pingolf_target_delete(uuid) from public;
grant execute on function public.snh_pingolf_target_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- game_custom_mods RPCs
-- ---------------------------------------------------------------------------

create or replace function public.snh_game_custom_mods_list(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'title', m.title,
          'description', m.description,
          'referenceUrl', m.reference_url,
          'sortOrder', m.sort_order
        )
        order by m.sort_order, m.title
      )
      from public.game_custom_mods m
      where m.game_id = p_game_id
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_game_custom_mods_list(uuid) from public;
grant execute on function public.snh_game_custom_mods_list(uuid) to authenticated;

create or replace function public.snh_game_custom_mods_upsert(p_id uuid, p_game_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform private.snh_require_game_editable(p_game_id);

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is null then
    raise exception 'title required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.game_custom_mods (
      game_id, title, description, reference_url, sort_order, created_by
    )
    values (
      p_game_id,
      v_title,
      nullif(trim(p_fields->>'description'), ''),
      nullif(trim(p_fields->>'referenceUrl'), ''),
      coalesce((p_fields->>'sortOrder')::integer, 0),
      auth.uid()
    );

    perform private.snh_audit_game(
      'insert',
      'game_custom_mod',
      p_game_id::text,
      '{}'::jsonb,
      jsonb_build_object('title', v_title),
      '{}'::jsonb
    );
  else
    select to_jsonb(m.*) into v_old from public.game_custom_mods m where m.id = p_id and m.game_id = p_game_id;
    if v_old is null then
      raise exception 'mod not found' using errcode = 'P0002';
    end if;

    update public.game_custom_mods m
    set
      title = v_title,
      description = case when p_fields ? 'description' then nullif(trim(p_fields->>'description'), '') else m.description end,
      reference_url = case when p_fields ? 'referenceUrl' then nullif(trim(p_fields->>'referenceUrl'), '') else m.reference_url end,
      sort_order = coalesce((p_fields->>'sortOrder')::integer, m.sort_order)
    where m.id = p_id;

    perform private.snh_audit_game(
      'update',
      'game_custom_mod',
      p_id::text,
      v_old,
      jsonb_build_object('title', v_title),
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_game_custom_mods_upsert(uuid, uuid, jsonb) from public;
grant execute on function public.snh_game_custom_mods_upsert(uuid, uuid, jsonb) to authenticated;

create or replace function public.snh_game_custom_mods_delete(p_id uuid)
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

  select to_jsonb(m.*) into v_old from public.game_custom_mods m where m.id = p_id;
  if v_old is null then
    return;
  end if;

  delete from public.game_custom_mods m where m.id = p_id;

  perform private.snh_audit_game(
    'delete',
    'game_custom_mod',
    p_id::text,
    v_old,
    '{}'::jsonb,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_game_custom_mods_delete(uuid) from public;
grant execute on function public.snh_game_custom_mods_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- club_issues RPCs (authenticated members read; games_editor+ writes)
-- ---------------------------------------------------------------------------

create or replace function public.snh_club_issues_list()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'gameId', i.game_id,
          'title', i.title,
          'body', i.body,
          'status', i.status,
          'createdAt', to_char(i.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
        order by i.created_at desc
      )
      from public.club_issues i
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_club_issues_list() from public;
grant execute on function public.snh_club_issues_list() to authenticated;

create or replace function public.snh_club_issues_upsert(p_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_old jsonb;
  v_gid uuid;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is null then
    raise exception 'title required' using errcode = '22023';
  end if;

  v_gid := case when p_fields ? 'gameId' and nullif(trim(p_fields->>'gameId'), '') is not null
    then (p_fields->>'gameId')::uuid else null end;

  if v_gid is not null then
    perform private.snh_require_game_editable(v_gid);
  end if;

  if p_id is null then
    insert into public.club_issues (game_id, title, body, status, created_by)
    values (
      v_gid,
      v_title,
      nullif(trim(p_fields->>'body'), ''),
      coalesce(nullif(lower(trim(p_fields->>'status')), ''), 'open'),
      auth.uid()
    );

    perform private.snh_audit_game(
      'insert',
      'club_issue',
      coalesce(v_gid::text, 'club'),
      '{}'::jsonb,
      jsonb_build_object('title', v_title),
      '{}'::jsonb
    );
  else
    select to_jsonb(i.*) into v_old from public.club_issues i where i.id = p_id;
    if v_old is null then
      raise exception 'issue not found' using errcode = 'P0002';
    end if;

    update public.club_issues i
    set
      game_id = case when p_fields ? 'gameId' then v_gid else i.game_id end,
      title = v_title,
      body = case when p_fields ? 'body' then nullif(trim(p_fields->>'body'), '') else i.body end,
      status = case when p_fields ? 'status' then coalesce(nullif(lower(trim(p_fields->>'status')), ''), i.status) else i.status end
    where i.id = p_id;

    perform private.snh_audit_game(
      'update',
      'club_issue',
      p_id::text,
      v_old,
      p_fields,
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_club_issues_upsert(uuid, jsonb) from public;
grant execute on function public.snh_club_issues_upsert(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Public lazy read: More Info modal (anon + authenticated)
-- ---------------------------------------------------------------------------

create or replace function public.snh_public_game_more_info(p_game_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_title text;
  v_high jsonb;
  v_pingolf jsonb;
  v_mods jsonb;
  v_sale jsonb;
  v_feat uuid;
  v_notes text;
  v_sale_status text;
  v_sale_cents integer;
  v_sale_notes text;
begin
  if p_game_id is null then
    return null;
  end if;

  select g.slug, g.title into v_slug, v_title
  from public.games g
  where g.id = p_game_id and g.deleted_at is null;

  if v_slug is null then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'score', h.score,
        'playerLabel', h.player_label,
        'achievedOn', to_char(h.achieved_on, 'YYYY-MM-DD'),
        'notes', h.notes,
        'sortOrder', h.sort_order
      )
      order by h.sort_order, h.achieved_on desc, h.score desc
    ),
    '[]'::jsonb
  )
  into v_high
  from public.game_high_scores h
  where h.game_id = p_game_id;

  select s.id into v_feat
  from public.pingolf_sessions s
  where s.is_featured
  limit 1;

  if v_feat is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'description', t.description,
          'targetValue', t.target_value,
          'sortOrder', t.sort_order
        )
        order by t.sort_order, t.description
      ),
      '[]'::jsonb
    )
    into v_pingolf
    from public.pingolf_targets t
    where t.session_id = v_feat and t.game_id = p_game_id;
  else
    v_pingolf := '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'title', m.title,
        'description', m.description,
        'referenceUrl', m.reference_url,
        'sortOrder', m.sort_order
      )
      order by m.sort_order, m.title
    ),
    '[]'::jsonb
  )
  into v_mods
  from public.game_custom_mods m
  where m.game_id = p_game_id;

  select l.status, l.asking_price_cents, l.notes
  into v_sale_status, v_sale_cents, v_sale_notes
  from public.game_sale_listings l
  where l.game_id = p_game_id
    and lower(l.status) in ('listed', 'pending')
  order by l.updated_at desc
  limit 1;

  if v_sale_status is null then
    v_sale := null;
  else
    v_notes := v_sale_notes;
    if v_notes is not null and length(v_notes) > 280 then
      v_notes := left(v_notes, 277) || '...';
    end if;
    v_sale := jsonb_strip_nulls(
      jsonb_build_object(
        'status', v_sale_status,
        'askingPriceCents', v_sale_cents,
        'notes', v_notes
      )
    );
  end if;

  return jsonb_strip_nulls(
    jsonb_build_object(
      'gameId', p_game_id,
      'slug', v_slug,
      'title', v_title,
      'highScores', v_high,
      'pingolfTargets', v_pingolf,
      'customMods', v_mods,
      'saleListingPublic', v_sale,
      'partySummaries', '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.snh_public_game_more_info(uuid) from public;
grant execute on function public.snh_public_game_more_info(uuid) to anon, authenticated;
