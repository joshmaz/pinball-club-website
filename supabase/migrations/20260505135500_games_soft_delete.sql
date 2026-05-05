-- Games catalog follow-up: soft-delete + restore support.

alter table public.games
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users (id),
  add column if not exists delete_note text;

comment on column public.games.deleted_at is 'Soft-delete marker; non-null rows are excluded from public catalog view.';
comment on column public.games.deleted_by is 'Auth user id that performed soft-delete.';
comment on column public.games.delete_note is 'Optional operator note captured when soft-deleting a game.';

create index if not exists games_deleted_at_idx on public.games (deleted_at);

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

create or replace function public.snh_games_soft_delete(
  p_game_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_note text;
begin
  if not coalesce(public.snh_member_has_games_admin_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(g.*) into v_old from public.games g where g.id = p_game_id;
  if v_old is null then
    raise exception 'game not found' using errcode = 'P0002';
  end if;
  if v_old->>'deleted_at' is not null then
    return;
  end if;

  v_note := nullif(trim(p_note), '');

  update public.games
  set
    deleted_at = now(),
    deleted_by = auth.uid(),
    delete_note = v_note
  where id = p_game_id;

  perform private.snh_audit_game(
    'soft_delete',
    'game',
    p_game_id::text,
    v_old,
    (select to_jsonb(g.*) from public.games g where g.id = p_game_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_soft_delete(uuid, text) from public;
grant execute on function public.snh_games_soft_delete(uuid, text) to authenticated;

create or replace function public.snh_games_restore(p_game_id uuid)
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

  select to_jsonb(g.*) into v_old from public.games g where g.id = p_game_id;
  if v_old is null then
    raise exception 'game not found' using errcode = 'P0002';
  end if;
  if v_old->>'deleted_at' is null then
    return;
  end if;

  update public.games
  set
    deleted_at = null,
    deleted_by = null,
    delete_note = null
  where id = p_game_id;

  perform private.snh_audit_game(
    'restore',
    'game',
    p_game_id::text,
    v_old,
    (select to_jsonb(g.*) from public.games g where g.id = p_game_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_restore(uuid) from public;
grant execute on function public.snh_games_restore(uuid) to authenticated;

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
        select jsonb_agg(r.obj order by r.is_deleted, r.title_sort)
        from (
          select
            lower(trim(g.title)) as title_sort,
            (g.deleted_at is not null) as is_deleted,
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
              'deletedAt', to_char(g.deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'deletedBy', g.deleted_by,
              'deleteNote', g.delete_note,
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
