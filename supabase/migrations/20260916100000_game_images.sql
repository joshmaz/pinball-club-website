-- Normalized game image associations with provenance, deterministic selection,
-- legacy image_filename compatibility, and editor/service-role RPCs.

create table public.game_images (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  source_type text not null,
  source_key text not null,
  location_type text not null,
  location_value text not null,
  image_type text,
  alt_text text,
  source_url text,
  attribution_text text,
  attribution_url text,
  license_name text,
  license_url text,
  usage_status text not null default 'reference_only',
  is_primary boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_images_source_type_chk
    check (source_type in ('club', 'opdb', 'external')),
  constraint game_images_location_type_chk
    check (location_type in ('local_asset', 'remote_url')),
  constraint game_images_usage_status_chk
    check (usage_status in ('reference_only', 'approved')),
  constraint game_images_primary_approved_chk
    check (not is_primary or usage_status = 'approved'),
  constraint game_images_location_value_chk
    check (
      (location_type = 'remote_url' and location_value ~ '^https://')
      or (
        location_type = 'local_asset'
        and location_value !~ '(^/|(^|/)\.\.(/|$)|^https?://)'
      )
    ),
  constraint game_images_external_provenance_chk
    check (
      source_type = 'club'
      or (
        nullif(trim(source_url), '') is not null
        and nullif(trim(attribution_text), '') is not null
      )
    ),
  constraint game_images_source_url_chk
    check (source_url is null or source_url ~ '^https://'),
  constraint game_images_attribution_url_chk
    check (attribution_url is null or attribution_url ~ '^https://'),
  constraint game_images_license_url_chk
    check (license_url is null or license_url ~ '^https://'),
  constraint game_images_source_unique unique (game_id, source_type, source_key)
);

comment on table public.game_images is
  'Images associated with games. External records retain source and attribution metadata; reference_only rows are never public.';
comment on column public.game_images.location_value is
  'Repo-relative local asset path/filename or an HTTPS remote image URL, according to location_type.';
comment on column public.game_images.usage_status is
  'reference_only records require explicit editor approval before public display.';

create unique index game_images_one_primary_per_game
  on public.game_images (game_id)
  where is_primary;
create index game_images_game_id_idx on public.game_images (game_id);
create index game_images_opdb_source_idx
  on public.game_images (game_id, source_key)
  where source_type = 'opdb';

drop trigger if exists trg_game_images_set_updated_at on public.game_images;
create trigger trg_game_images_set_updated_at
before update on public.game_images
for each row execute function public.set_games_catalog_updated_at();

alter table public.game_images enable row level security;

grant select on public.game_images to anon, authenticated;

create policy game_images_public_approved_read
  on public.game_images
  for select
  to anon, authenticated
  using (
    usage_status = 'approved'
    or coalesce(public.snh_member_has_games_access(), false)
  );

-- Preserve every existing image_filename as an approved club image. These rows
-- are the initial primary images, so the migration does not change rendering.
insert into public.game_images (
  game_id,
  source_type,
  source_key,
  location_type,
  location_value,
  image_type,
  alt_text,
  usage_status,
  is_primary,
  metadata
)
select
  g.id,
  'club',
  'legacy:' || trim(g.image_filename),
  'local_asset',
  trim(g.image_filename),
  'game_photo',
  g.title,
  'approved',
  true,
  jsonb_build_object('migratedFrom', 'games.image_filename')
from public.games g
where nullif(trim(g.image_filename), '') is not null
on conflict (game_id, source_type, source_key) do nothing;

-- ---------------------------------------------------------------------------
-- Public catalog view. Selection order is explicit primary, then approved
-- club image, then another approved image. Legacy image_filename remains a
-- final fallback for deployments where backfill was not yet observed.
-- ---------------------------------------------------------------------------

create or replace view public.games_catalog_v1
with (security_invoker = true)
as
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
      'primaryImage', coalesce(
        pi.image_obj,
        case when nullif(trim(ge.image_filename), '') is not null then
          jsonb_build_object(
            'url', 'assets/images/machines/' || trim(ge.image_filename),
            'sourceType', 'club',
            'locationType', 'local_asset',
            'altText', ge.title,
            'isLegacyFallback', true
          )
        end
      ),
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
left join stint_json sj on sj.game_id = ge.id
left join lateral (
  select jsonb_strip_nulls(
    jsonb_build_object(
      'id', i.id,
      'url', case
        when i.location_type = 'local_asset' and i.location_value like 'assets/%' then i.location_value
        when i.location_type = 'local_asset' then 'assets/images/machines/' || i.location_value
        else i.location_value
      end,
      'sourceType', i.source_type,
      'locationType', i.location_type,
      'imageType', i.image_type,
      'altText', i.alt_text,
      'attributionText', i.attribution_text,
      'attributionUrl', i.attribution_url,
      'sourceUrl', i.source_url,
      'licenseName', i.license_name,
      'licenseUrl', i.license_url
    )
  ) as image_obj
  from public.game_images i
  where i.game_id = ge.id
    and i.usage_status = 'approved'
  order by
    i.is_primary desc,
    case when i.source_type = 'club' then 0 else 1 end,
    i.created_at,
    i.id
  limit 1
) pi on true;

comment on view public.games_catalog_v1 is
  'Public games catalog JSON rows; primaryImage is selected from approved normalized associations with legacy fallback.';

grant select on public.games_catalog_v1 to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Editor payload with all image associations, including reference-only OPDB
-- records that are intentionally hidden from public clients.
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
              'images', (
                select coalesce(
                  jsonb_agg(
                    jsonb_strip_nulls(
                      jsonb_build_object(
                        'id', i.id,
                        'sourceType', i.source_type,
                        'sourceKey', i.source_key,
                        'locationType', i.location_type,
                        'locationValue', i.location_value,
                        'displayUrl', case
                          when i.location_type = 'local_asset' and i.location_value like 'assets/%' then i.location_value
                          when i.location_type = 'local_asset' then 'assets/images/machines/' || i.location_value
                          else i.location_value
                        end,
                        'imageType', i.image_type,
                        'altText', i.alt_text,
                        'sourceUrl', i.source_url,
                        'attributionText', i.attribution_text,
                        'attributionUrl', i.attribution_url,
                        'licenseName', i.license_name,
                        'licenseUrl', i.license_url,
                        'usageStatus', i.usage_status,
                        'isPrimary', i.is_primary,
                        'metadata', i.metadata
                      )
                    )
                    order by i.is_primary desc,
                      case when i.source_type = 'club' then 0 else 1 end,
                      i.created_at,
                      i.id
                  ),
                  '[]'::jsonb
                )
                from public.game_images i
                where i.game_id = g.id
              ),
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
              'partyId', g.party_id,
              'partyRelationshipPublic', g.party_relationship_public,
              'hideOwnerPublic', g.hide_owner_public,
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
  ) into v_payload;

  return v_payload;
end;
$$;

revoke all on function public.snh_games_editor_load() from public;
grant execute on function public.snh_games_editor_load() to authenticated;

-- ---------------------------------------------------------------------------
-- Image editor RPC. Club assets are approved by definition. External images
-- default to reference_only and require both source URL and attribution.
-- ---------------------------------------------------------------------------

create or replace function public.snh_game_images_upsert(
  p_id uuid,
  p_game_id uuid,
  p_fields jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_old jsonb;
  v_source_type text;
  v_source_key text;
  v_location_type text;
  v_location_value text;
  v_usage_status text;
  v_make_primary boolean;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);

  if p_id is not null then
    select to_jsonb(i.*) into v_old
    from public.game_images i
    where i.id = p_id and i.game_id = p_game_id;
    if v_old is null then
      raise exception 'game image not found' using errcode = 'P0002';
    end if;
  else
    v_old := '{}'::jsonb;
  end if;

  v_source_type := coalesce(nullif(trim(p_fields->>'sourceType'), ''), v_old->>'source_type');
  v_location_type := coalesce(nullif(trim(p_fields->>'locationType'), ''), v_old->>'location_type');
  v_location_value := coalesce(nullif(trim(p_fields->>'locationValue'), ''), v_old->>'location_value');
  v_source_key := coalesce(
    nullif(trim(p_fields->>'sourceKey'), ''),
    v_old->>'source_key',
    v_source_type || ':' || md5(v_location_value)
  );
  v_usage_status := coalesce(
    nullif(trim(p_fields->>'usageStatus'), ''),
    v_old->>'usage_status',
    case when v_source_type = 'club' then 'approved' else 'reference_only' end
  );
  v_make_primary := coalesce((p_fields->>'makePrimary')::boolean, false);

  if v_source_type not in ('club', 'opdb', 'external') then
    raise exception 'invalid sourceType' using errcode = '22023';
  end if;
  if v_location_type not in ('local_asset', 'remote_url') then
    raise exception 'invalid locationType' using errcode = '22023';
  end if;
  if nullif(trim(v_location_value), '') is null then
    raise exception 'locationValue required' using errcode = '22023';
  end if;
  if v_usage_status not in ('reference_only', 'approved') then
    raise exception 'invalid usageStatus' using errcode = '22023';
  end if;
  if v_source_type <> 'club' and (
    nullif(trim(coalesce(p_fields->>'sourceUrl', v_old->>'source_url')), '') is null
    or nullif(trim(coalesce(p_fields->>'attributionText', v_old->>'attribution_text')), '') is null
  ) then
    raise exception 'external images require sourceUrl and attributionText' using errcode = '22023';
  end if;
  if v_make_primary and v_usage_status <> 'approved' then
    raise exception 'reference-only image cannot be primary' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.game_images (
      game_id, source_type, source_key, location_type, location_value,
      image_type, alt_text, source_url, attribution_text, attribution_url,
      license_name, license_url, usage_status, metadata
    ) values (
      p_game_id, v_source_type, v_source_key, v_location_type, v_location_value,
      nullif(trim(p_fields->>'imageType'), ''),
      nullif(trim(p_fields->>'altText'), ''),
      nullif(trim(p_fields->>'sourceUrl'), ''),
      nullif(trim(p_fields->>'attributionText'), ''),
      nullif(trim(p_fields->>'attributionUrl'), ''),
      nullif(trim(p_fields->>'licenseName'), ''),
      nullif(trim(p_fields->>'licenseUrl'), ''),
      v_usage_status,
      coalesce(p_fields->'metadata', '{}'::jsonb)
    )
    returning id into v_id;
  else
    update public.game_images i
    set
      source_type = v_source_type,
      source_key = v_source_key,
      location_type = v_location_type,
      location_value = v_location_value,
      image_type = case when p_fields ? 'imageType' then nullif(trim(p_fields->>'imageType'), '') else i.image_type end,
      alt_text = case when p_fields ? 'altText' then nullif(trim(p_fields->>'altText'), '') else i.alt_text end,
      source_url = case when p_fields ? 'sourceUrl' then nullif(trim(p_fields->>'sourceUrl'), '') else i.source_url end,
      attribution_text = case when p_fields ? 'attributionText' then nullif(trim(p_fields->>'attributionText'), '') else i.attribution_text end,
      attribution_url = case when p_fields ? 'attributionUrl' then nullif(trim(p_fields->>'attributionUrl'), '') else i.attribution_url end,
      license_name = case when p_fields ? 'licenseName' then nullif(trim(p_fields->>'licenseName'), '') else i.license_name end,
      license_url = case when p_fields ? 'licenseUrl' then nullif(trim(p_fields->>'licenseUrl'), '') else i.license_url end,
      usage_status = v_usage_status,
      is_primary = case when v_usage_status = 'reference_only' then false else i.is_primary end,
      metadata = case when p_fields ? 'metadata' then coalesce(p_fields->'metadata', '{}'::jsonb) else i.metadata end
    where i.id = p_id and i.game_id = p_game_id
    returning id into v_id;
  end if;

  if v_make_primary or (
    v_source_type = 'club'
    and v_usage_status = 'approved'
    and not exists (select 1 from public.game_images x where x.game_id = p_game_id and x.is_primary)
  ) then
    update public.game_images set is_primary = false where game_id = p_game_id and id <> v_id and is_primary;
    update public.game_images set is_primary = true where id = v_id;
  end if;

  -- Keep JSON export and legacy clients useful when a repo-hosted club image is selected.
  if v_source_type = 'club' and v_location_type = 'local_asset'
     and (select is_primary from public.game_images where id = v_id) then
    update public.games
    set image_filename = regexp_replace(v_location_value, '^assets/images/machines/', '')
    where id = p_game_id;
  end if;

  perform private.snh_audit_game(
    case when p_id is null then 'insert' else 'update' end,
    'game_image',
    v_id::text,
    v_old,
    (select to_jsonb(i.*) from public.game_images i where i.id = v_id),
    jsonb_build_object('gameId', p_game_id)
  );

  return v_id;
end;
$$;

revoke all on function public.snh_game_images_upsert(uuid, uuid, jsonb) from public;
grant execute on function public.snh_game_images_upsert(uuid, uuid, jsonb) to authenticated;

create or replace function public.snh_game_images_set_primary(
  p_game_id uuid,
  p_image_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_image public.game_images%rowtype;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);

  select * into v_image
  from public.game_images
  where id = p_image_id and game_id = p_game_id;
  if v_image.id is null then
    raise exception 'game image not found' using errcode = 'P0002';
  end if;
  if v_image.usage_status <> 'approved' then
    raise exception 'reference-only image cannot be primary' using errcode = '22023';
  end if;

  update public.game_images set is_primary = false where game_id = p_game_id and is_primary;
  update public.game_images set is_primary = true where id = p_image_id;

  if v_image.source_type = 'club' and v_image.location_type = 'local_asset' then
    update public.games
    set image_filename = regexp_replace(v_image.location_value, '^assets/images/machines/', '')
    where id = p_game_id;
  end if;

  perform private.snh_audit_game(
    'set_primary',
    'game_image',
    p_image_id::text,
    '{}'::jsonb,
    jsonb_build_object('gameId', p_game_id, 'isPrimary', true),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_game_images_set_primary(uuid, uuid) from public;
grant execute on function public.snh_game_images_set_primary(uuid, uuid) to authenticated;

-- Service-only deterministic OPDB import. New records remain reference-only;
-- conflict updates preserve an editor's prior approval/primary decision.
create or replace function public.snh_game_images_import_opdb(
  p_opdb_id text,
  p_images jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_game_id uuid;
  v_row jsonb;
  v_count integer := 0;
  v_game_count integer;
  v_source_key text;
  v_image_url text;
  v_source_url text;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_game_id in
    select g.id
    from public.games g
    where g.opdb_id = nullif(trim(p_opdb_id), '') and g.deleted_at is null
  loop
    v_game_count := 0;
    for v_row in select * from jsonb_array_elements(coalesce(p_images, '[]'::jsonb))
    loop
      v_source_key := nullif(trim(v_row->>'sourceKey'), '');
      v_image_url := nullif(trim(v_row->>'imageUrl'), '');
      v_source_url := nullif(trim(v_row->>'sourceUrl'), '');
      if v_source_key is null or v_image_url !~ '^https://' or v_source_url !~ '^https://' then
        continue;
      end if;

      insert into public.game_images (
        game_id, source_type, source_key, location_type, location_value,
        image_type, alt_text, source_url, attribution_text, attribution_url,
        license_name, license_url, usage_status, metadata
      ) values (
        v_game_id,
        'opdb',
        v_source_key,
        'remote_url',
        v_image_url,
        nullif(trim(v_row->>'imageType'), ''),
        nullif(trim(v_row->>'altText'), ''),
        v_source_url,
        'Open Pinball Database (OPDB)',
        v_source_url,
        nullif(trim(v_row->>'licenseName'), ''),
        nullif(trim(v_row->>'licenseUrl'), ''),
        'reference_only',
        coalesce(v_row->'metadata', '{}'::jsonb) || jsonb_build_object('opdbId', trim(p_opdb_id))
      )
      on conflict (game_id, source_type, source_key) do update
      set
        location_value = excluded.location_value,
        image_type = excluded.image_type,
        alt_text = excluded.alt_text,
        source_url = excluded.source_url,
        attribution_text = excluded.attribution_text,
        attribution_url = excluded.attribution_url,
        license_name = excluded.license_name,
        license_url = excluded.license_url,
        metadata = public.game_images.metadata || excluded.metadata;

      v_count := v_count + 1;
      v_game_count := v_game_count + 1;
    end loop;

    if v_game_count > 0 then
      perform private.snh_audit_game(
        'import',
        'game_images_opdb',
        v_game_id::text,
        '{}'::jsonb,
        jsonb_build_object('opdbId', trim(p_opdb_id), 'imageCount', v_game_count),
        jsonb_build_object('usageStatus', 'reference_only')
      );
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.snh_game_images_import_opdb(text, jsonb) from public;
grant execute on function public.snh_game_images_import_opdb(text, jsonb) to service_role;
