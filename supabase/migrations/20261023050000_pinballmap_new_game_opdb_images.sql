begin;

-- Called only for a row inserted by this catalog transaction. Existing catalog
-- games (including slug conflicts and matching OPDB IDs) keep their curation.
create function private.snh_pinballmap_new_game_images(p_game_id uuid, p_opdb_id text, p_images jsonb)
returns integer language plpgsql set search_path = '' as $$
declare v_row jsonb; v_count integer := 0; v_primary uuid;
begin
 if nullif(btrim(p_opdb_id),'') is null or jsonb_typeof(p_images) is distinct from 'array' then return 0; end if;
 for v_row in select value from jsonb_array_elements(p_images) loop
   if nullif(btrim(v_row->>'sourceKey'),'') is null
      or coalesce(v_row->>'imageUrl','') !~ '^https://'
      or coalesce(v_row->>'sourceUrl','') !~ '^https://' then continue; end if;
   insert into public.game_images(game_id,source_type,source_key,location_type,location_value,
     image_type,alt_text,source_url,attribution_text,attribution_url,license_name,license_url,usage_status,metadata)
   values(p_game_id,'opdb',btrim(v_row->>'sourceKey'),'remote_url',v_row->>'imageUrl',
     nullif(btrim(v_row->>'imageType'),''),nullif(btrim(v_row->>'altText'),''),v_row->>'sourceUrl',
     'Open Pinball Database (OPDB)',v_row->>'sourceUrl',nullif(btrim(v_row->>'licenseName'),''),
     nullif(btrim(v_row->>'licenseUrl'),''),'approved',coalesce(v_row->'metadata','{}'::jsonb)
       ||jsonb_build_object('opdbId',p_opdb_id,'autoApprovedVia','pinballmap_new_game'))
   on conflict(game_id,source_type,source_key) do nothing;
   if found then v_count := v_count+1; end if;
 end loop;
 -- Normalize an explicitly supplied legacy default; the public catalog prefers
 -- normalized approved rows over its legacy filename fallback.
 if v_count>0 then
   insert into public.game_images(game_id,source_type,source_key,location_type,location_value,
     usage_status,is_primary,metadata)
   select g.id,'club','legacy:'||btrim(g.image_filename),'local_asset',btrim(g.image_filename),
     'approved',true,jsonb_build_object('migratedFrom','games.image_filename')
   from public.games g where g.id=p_game_id and nullif(btrim(g.image_filename),'') is not null
     and not exists(select 1 from public.game_images i where i.game_id=p_game_id and i.is_primary)
   on conflict(game_id,source_type,source_key) do nothing;
 end if;
 -- Prefer a playfield even when OPDB labels a backglass as its primary image.
 -- An explicitly supplied legacy/default photo always retains priority.
 if not exists(select 1 from public.games where id=p_game_id and nullif(btrim(image_filename),'') is not null)
    and not exists(select 1 from public.game_images where game_id=p_game_id and is_primary) then
   select id into v_primary from public.game_images
   where game_id=p_game_id and source_type='opdb' and usage_status='approved'
   order by case when lower(image_type)='playfield' then 0 else 1 end,
     case when metadata->'opdbPrimary'='true'::jsonb then 0 else 1 end, source_key,id limit 1;
   if v_primary is not null then update public.game_images set is_primary=true where id=v_primary; end if;
 end if;
 if v_count>0 then
   perform private.snh_audit_game('import','game_images_opdb',p_game_id::text,'{}'::jsonb,
     jsonb_build_object('opdbId',p_opdb_id,'imageCount',v_count,'primaryImageId',v_primary),
     jsonb_build_object('usageStatus','approved','autoApprovedVia','pinballmap_new_game'));
 end if;
 return v_count;
end; $$;
revoke all on function private.snh_pinballmap_new_game_images(uuid,text,jsonb) from public,anon,authenticated,service_role;

-- Preserve the existing merge, metadata, stints, actor and service-role checks.
-- Approval runs only after INSERT ... RETURNING succeeds, never its conflict fallback.
create or replace function private.snh_pinballmap_catalog_core(p_payload jsonb)
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
  v_loc_eff int;
  v_st_addr text;
  v_image_count integer := 0;
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
    set
      map_at_club = coalesce((u->>'mapAtClub')::boolean, map_at_club),
      manufacturer = case
        when nullif(trim(manufacturer), '') is null
          then coalesce(nullif(trim(u->>'manufacturer'), ''), manufacturer)
        else manufacturer
      end,
      release_date = case
        when release_date is null and nullif(trim(u->>'releaseDate'), '') is not null
          then (u->>'releaseDate')::date
        else release_date
      end,
      ipdb_url = case
        when nullif(trim(ipdb_url), '') is null
          then coalesce(nullif(trim(u->>'ipdbUrl'), ''), ipdb_url)
        else ipdb_url
      end,
      opdb_id = case
        when nullif(trim(opdb_id), '') is null
          then coalesce(nullif(trim(u->>'opdbId'), ''), opdb_id)
        else opdb_id
      end,
      opdb_matched_via = case
        when nullif(trim(opdb_id), '') is null and nullif(trim(opdb_matched_via), '') is null
          then coalesce(nullif(trim(u->>'opdbMatchedVia'), ''), opdb_matched_via)
        else opdb_matched_via
      end,
      opdb_canonical_name = case
        when nullif(trim(opdb_id), '') is null and nullif(trim(opdb_canonical_name), '') is null
          then coalesce(nullif(trim(u->>'opdbCanonicalName'), ''), opdb_canonical_name)
        else opdb_canonical_name
      end
    where id = v_gid;

    v_st := u->'stint';
    if v_st is not null and jsonb_typeof(v_st) = 'object' then
      v_loc_eff := coalesce((v_st->>'pinballMapLocationId')::int, v_loc);
      v_st_addr := coalesce(nullif(trim(v_st->>'address'), ''), v_addr);

      select s.id into v_stint_id
      from public.game_location_stints s
      where s.game_id = v_gid
        and s.pinball_map_location_id = v_loc_eff
        and (
          (
            nullif(trim(v_st->>'joinedClubDate'), '') is not null
            and s.joined_club_date = (v_st->>'joinedClubDate')::date
          )
          or (
            nullif(trim(v_st->>'joinedClubDate'), '') is null
            and lower(trim(s.address)) = lower(trim(v_st_addr))
          )
        )
      order by s.joined_club_date desc nulls last, s.created_at desc
      limit 1;

      if v_stint_id is not null then
        update public.game_location_stints
        set
          address = v_st_addr,
          pinball_map_location_id = v_loc_eff,
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
          v_st_addr,
          v_loc_eff,
          (v_st->>'pinballMapMachineId')::int,
          case when nullif(trim(v_st->>'joinedClubDate'), '') is null then null else (v_st->>'joinedClubDate')::date end,
          case when nullif(trim(v_st->>'leftClubDate'), '') is null then null else (v_st->>'leftClubDate')::date end,
          false
        )
        on conflict (game_id, pinball_map_location_id, joined_club_date)
          where pinball_map_location_id is not null and joined_club_date is not null
        do update set
          address = excluded.address,
          pinball_map_machine_id = coalesce(excluded.pinball_map_machine_id, public.game_location_stints.pinball_map_machine_id),
          left_club_date = excluded.left_club_date,
          date_unknown = excluded.date_unknown;
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

    if v_gid is not null then
      v_image_count := v_image_count + private.snh_pinballmap_new_game_images(
        v_gid, nullif(trim(c->>'opdbId'), ''), c->'opdbImages');
    else
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
        )
        on conflict (game_id, pinball_map_location_id, joined_club_date)
          where pinball_map_location_id is not null and joined_club_date is not null
        do update set
          address = excluded.address,
          pinball_map_machine_id = coalesce(excluded.pinball_map_machine_id, public.game_location_stints.pinball_map_machine_id),
          left_club_date = excluded.left_club_date,
          date_unknown = excluded.date_unknown;
      end loop;
    end if;
  end loop;

  -- The Edge Function verifies manual callers before adding this actor id.
  -- Scheduled invocations omit it and retain the existing System attribution.
  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata
  ) values (
    'games', 'import', nullif(p_payload->>'manual_actor_user_id', '')::uuid,
    'pinballmap_ingest', v_loc::text, '{}'::jsonb,
    jsonb_build_object(
      'location_id', v_loc,
      'updates_count', jsonb_array_length(coalesce(p_payload->'updates', '[]'::jsonb)),
      'creates_count', jsonb_array_length(coalesce(p_payload->'creates', '[]'::jsonb)),
      'status', 'success'
    ),
    jsonb_build_object('trigger', case when p_payload ? 'manual_actor_user_id' then 'manual' else 'scheduled' end)
  );

  return jsonb_build_object('ok', true, 'newGameImages', v_image_count);
end;
$$;


revoke all on function private.snh_pinballmap_catalog_core(jsonb) from public,anon,authenticated,service_role;

-- Include atomic new-game image changes in the existing Operations counts/audit.
create or replace function private.snh_pinballmap_snapshot(p_kind text, p_payload jsonb) returns jsonb
language sql stable set search_path = '' as $$
 select coalesce(jsonb_object_agg(x.key,x.value),'{}'::jsonb) from (
   select 'games:'||g.id::text key,jsonb_build_object('kind','games','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(g)-'updated_at'-'created_at') value from public.games g where p_kind='catalog'
   union all
   select 'locations:'||s.id::text,jsonb_build_object('kind','locations','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(s)-'updated_at'-'created_at') from public.game_location_stints s join public.games g on g.id=s.game_id where p_kind='catalog'
   union all
   select 'conditions:'||i.id::text,jsonb_build_object('kind','conditions','game_id',g.id,'title',coalesce(g.title,i.title),'slug',g.slug,
     'data',to_jsonb(i)-'updated_at'-'created_at') from public.club_issues i
     join public.club_issue_import_keys k on k.club_issue_id=i.id and k.source='pinballmap'
     left join public.games g on g.id=i.game_id
     where p_kind='conditions' and k.source_key in(select r->>'submissionId' from jsonb_array_elements(coalesce(p_payload->'rows','[]')) r)
   union all
   select 'images:'||i.id::text,jsonb_build_object('kind','images','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(i)-'updated_at'-'created_at') from public.game_images i join public.games g on g.id=i.game_id
     where (p_kind='images' and g.opdb_id=p_payload->>'opdb_id')
       or (p_kind='catalog' and g.slug in (select c->>'slug' from jsonb_array_elements(coalesce(p_payload->'creates','[]')) c))
 ) x;
$$;

commit;
