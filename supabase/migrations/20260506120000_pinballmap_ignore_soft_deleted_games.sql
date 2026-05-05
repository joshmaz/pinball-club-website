-- Pinball Map ingest: do not match or mutate soft-deleted games in the updates path.
-- Also avoid attaching create payloads to an existing soft-deleted row by slug (fallback select).

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

    select id into v_gid from public.games where slug = v_slug and deleted_at is null limit 1;
    if v_gid is null then
      select id into v_gid from public.games
      where lower(title) = lower(trim(u->>'title')) and deleted_at is null
      limit 1;
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
      select id into v_gid from public.games where slug = v_slug and deleted_at is null limit 1;
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
