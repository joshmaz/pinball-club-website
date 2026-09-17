-- Normalized game images with provenance, deterministic selection, and legacy
-- games.image_filename compatibility.

create table public.game_images (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  source_type text not null check (source_type in ('club', 'opdb', 'external')),
  image_filename text,
  image_url text,
  source_record_id text,
  source_page_url text,
  image_type text,
  title text,
  attribution_text text,
  attribution_url text,
  license_name text,
  license_url text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  is_preferred boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_images_locator_chk check (
    (source_type = 'club' and nullif(trim(image_filename), '') is not null and image_url is null)
    or
    (source_type in ('opdb', 'external') and nullif(trim(image_url), '') is not null)
  ),
  constraint game_images_external_provenance_chk check (
    source_type = 'club'
    or (
      nullif(trim(attribution_text), '') is not null
      and nullif(trim(attribution_url), '') is not null
      and nullif(trim(source_page_url), '') is not null
      and image_url ~ '^https://'
      and source_page_url ~ '^https://'
      and attribution_url ~ '^https://'
    )
  )
);

comment on table public.game_images is
  'Images associated with games. External rows retain source and attribution; one row may be explicitly preferred.';
comment on column public.game_images.image_url is
  'Remote provider URL. Current OPDB integration hotlinks img.opdb.org and does not copy the asset.';
comment on column public.game_images.license_name is
  'Optional because OPDB API image payloads do not currently declare a per-image license.';

create index game_images_game_id_idx on public.game_images (game_id);
create unique index game_images_one_preferred_idx
  on public.game_images (game_id) where is_preferred and is_active;
create unique index game_images_club_filename_idx
  on public.game_images (game_id, image_filename)
  where source_type = 'club' and image_filename is not null;
create unique index game_images_source_record_idx
  on public.game_images (game_id, source_type, source_record_id);

alter table public.game_images enable row level security;
create policy game_images_public_read on public.game_images
  for select to anon, authenticated using (is_active);
grant select on public.game_images to anon, authenticated;

drop trigger if exists trg_game_images_set_updated_at on public.game_images;
create trigger trg_game_images_set_updated_at
before update on public.game_images
for each row execute function public.set_games_catalog_updated_at();

-- Existing static assets remain valid and become normalized club image rows.
insert into public.game_images (
  game_id, source_type, image_filename, title, is_preferred, metadata
)
select
  g.id, 'club', trim(g.image_filename), 'Legacy club image', true,
  jsonb_build_object('migratedFrom', 'games.image_filename')
from public.games g
where nullif(trim(g.image_filename), '') is not null
on conflict do nothing;

-- Keep old editor/deployment workflows safe: changing image_filename creates or
-- selects the matching club image. Clearing it does not delete image history.
create or replace function private.snh_sync_legacy_game_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT' or nullif(trim(new.image_filename), '') is distinct from nullif(trim(old.image_filename), ''))
     and nullif(trim(new.image_filename), '') is not null then
    update public.game_images
       set is_preferred = false
     where game_id = new.id and is_preferred;

    insert into public.game_images (
      game_id, source_type, image_filename, title, is_preferred, metadata
    ) values (
      new.id, 'club', trim(new.image_filename), 'Club image', true,
      jsonb_build_object('managedBy', 'games.image_filename')
    )
    on conflict (game_id, image_filename)
      where source_type = 'club' and image_filename is not null
    do update set is_active = true, is_preferred = true, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_games_sync_legacy_image on public.games;
create trigger trg_games_sync_legacy_image
after insert or update of image_filename on public.games
for each row execute function private.snh_sync_legacy_game_image();

-- Public catalog: explicit preferred image first; otherwise club, OPDB playfield,
-- OPDB primary, then remaining active images. imageFilename remains unchanged.
create or replace view public.games_catalog_v1
with (security_invoker = true)
as
with games_effective as (
  select g.*, coalesce(g.manual_at_club_override, g.map_at_club)::boolean as effective_at_club
  from public.games g where g.deleted_at is null
),
stint_json as (
  select s.game_id,
    jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'address', s.address,
      'pinballMapLocationId', s.pinball_map_location_id,
      'joinedClubDate', to_char(s.joined_club_date, 'YYYY-MM-DD'),
      'leftClubDate', to_char(s.left_club_date, 'YYYY-MM-DD'),
      'pinballMapMachineId', s.pinball_map_machine_id,
      'dateUnknown', (s.joined_club_date is null and s.left_club_date is null),
      'sortKeyJoined', coalesce(to_char(s.joined_club_date, 'YYYY-MM-DD'), '2016-01-01'),
      'sortKeyLeft', coalesce(to_char(s.left_club_date, 'YYYY-MM-DD'), case when ge.effective_at_club then '9999-12-31' else '2016-12-31' end)
    )) order by s.joined_club_date nulls last, s.id) as location_stints
  from public.game_location_stints s
  join games_effective ge on ge.id = s.game_id
  group by s.game_id
)
select ge.slug,
  jsonb_strip_nulls(jsonb_build_object(
    'id', ge.id, 'slug', ge.slug, 'title', ge.title, 'details', ge.details,
    'imageFilename', ge.image_filename,
    'selectedImage', selected.image,
    'releaseDate', to_char(ge.release_date, 'YYYY-MM-DD'),
    'pinsideUrl', ge.pinside_url, 'ipdbUrl', ge.ipdb_url, 'kineticistUrl', ge.kineticist_url,
    'locationStints', coalesce(sj.location_stints, '[]'::jsonb),
    'atClub', ge.effective_at_club, 'mapAtClub', ge.map_at_club,
    'manualAtClubOverride', ge.manual_at_club_override,
    'opdbId', ge.opdb_id, 'opdbMatchedVia', ge.opdb_matched_via,
    'opdbCanonicalName', ge.opdb_canonical_name,
    'manufacturer', ge.manufacturer, 'manufacturerFullName', ge.manufacturer_full_name,
    'manufactureDate', to_char(ge.manufacture_date, 'YYYY-MM-DD'),
    'type', ge.machine_type, 'display', ge.display_type, 'playerCount', ge.player_count
  )) as game
from games_effective ge
left join stint_json sj on sj.game_id = ge.id
left join lateral (
  select jsonb_strip_nulls(jsonb_build_object(
    'id', gi.id, 'sourceType', gi.source_type,
    'url', case when gi.source_type = 'club' then 'assets/images/machines/' || gi.image_filename else gi.image_url end,
    'imageFilename', gi.image_filename, 'imageType', gi.image_type, 'title', gi.title,
    'attributionText', gi.attribution_text, 'attributionUrl', gi.attribution_url,
    'licenseName', gi.license_name, 'licenseUrl', gi.license_url,
    'sourcePageUrl', gi.source_page_url, 'width', gi.width, 'height', gi.height
  )) as image
  from public.game_images gi
  where gi.game_id = ge.id and gi.is_active
  order by gi.is_preferred desc,
    case gi.source_type when 'club' then 0 when 'opdb' then 1 else 2 end,
    case when gi.image_type = 'playfield' then 0 else 1 end,
    coalesce((gi.metadata->>'providerPrimary')::boolean, false) desc,
    gi.created_at, gi.id
  limit 1
) selected on true;

grant select on public.games_catalog_v1 to anon, authenticated;

create or replace function public.snh_game_image_upsert(p_game_id uuid, p_image jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_preferred boolean := coalesce((p_image->>'isPreferred')::boolean, false);
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);
  if v_preferred then update public.game_images set is_preferred = false where game_id = p_game_id; end if;

  v_id := nullif(p_image->>'id', '')::uuid;
  if v_id is null then
    insert into public.game_images (
      game_id, source_type, image_filename, image_url, source_record_id, source_page_url,
      image_type, title, attribution_text, attribution_url, license_name, license_url,
      width, height, is_preferred
    ) values (
      p_game_id, coalesce(nullif(trim(p_image->>'sourceType'), ''), 'club'),
      nullif(trim(p_image->>'imageFilename'), ''), nullif(trim(p_image->>'url'), ''),
      nullif(trim(p_image->>'sourceRecordId'), ''), nullif(trim(p_image->>'sourcePageUrl'), ''),
      nullif(trim(p_image->>'imageType'), ''), nullif(trim(p_image->>'title'), ''),
      nullif(trim(p_image->>'attributionText'), ''), nullif(trim(p_image->>'attributionUrl'), ''),
      nullif(trim(p_image->>'licenseName'), ''), nullif(trim(p_image->>'licenseUrl'), ''),
      nullif(p_image->>'width', '')::integer, nullif(p_image->>'height', '')::integer, v_preferred
    ) returning id into v_id;
  else
    update public.game_images set
      source_type = coalesce(nullif(trim(p_image->>'sourceType'), ''), source_type),
      image_filename = case when p_image ? 'imageFilename' then nullif(trim(p_image->>'imageFilename'), '') else image_filename end,
      image_url = case when p_image ? 'url' then nullif(trim(p_image->>'url'), '') else image_url end,
      source_page_url = case when p_image ? 'sourcePageUrl' then nullif(trim(p_image->>'sourcePageUrl'), '') else source_page_url end,
      image_type = case when p_image ? 'imageType' then nullif(trim(p_image->>'imageType'), '') else image_type end,
      title = case when p_image ? 'title' then nullif(trim(p_image->>'title'), '') else title end,
      attribution_text = case when p_image ? 'attributionText' then nullif(trim(p_image->>'attributionText'), '') else attribution_text end,
      attribution_url = case when p_image ? 'attributionUrl' then nullif(trim(p_image->>'attributionUrl'), '') else attribution_url end,
      license_name = case when p_image ? 'licenseName' then nullif(trim(p_image->>'licenseName'), '') else license_name end,
      license_url = case when p_image ? 'licenseUrl' then nullif(trim(p_image->>'licenseUrl'), '') else license_url end,
      is_preferred = v_preferred, is_active = true
    where id = v_id and game_id = p_game_id;
    if not found then raise exception 'game image not found' using errcode = 'P0002'; end if;
  end if;
  if v_preferred and exists (
    select 1 from public.game_images i where i.id = v_id and i.source_type = 'club'
  ) then
    update public.games g
      set image_filename = i.image_filename
      from public.game_images i
      where g.id = p_game_id and i.id = v_id
        and g.image_filename is distinct from i.image_filename;
  end if;
  perform private.snh_audit_game('upsert', 'game_image', v_id::text, '{}'::jsonb,
    (select to_jsonb(i.*) from public.game_images i where i.id = v_id), jsonb_build_object('gameId', p_game_id));
  return v_id;
end;
$$;

revoke all on function public.snh_game_image_upsert(uuid, jsonb) from public;
grant execute on function public.snh_game_image_upsert(uuid, jsonb) to authenticated;

create or replace function public.snh_game_image_archive(p_game_id uuid, p_image_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);
  update public.game_images set is_active = false, is_preferred = false
    where id = p_image_id and game_id = p_game_id;
  if not found then raise exception 'game image not found' using errcode = 'P0002'; end if;
  update public.games g set image_filename = null
    where g.id = p_game_id
      and exists (
        select 1 from public.game_images i
        where i.id = p_image_id and i.source_type = 'club' and i.image_filename = g.image_filename
      );
end;
$$;

revoke all on function public.snh_game_image_archive(uuid, uuid) from public;
grant execute on function public.snh_game_image_archive(uuid, uuid) to authenticated;

-- Editor payload includes all active associations; public catalog exposes only selectedImage.
create or replace function public.snh_games_editor_load()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('games', coalesce((select jsonb_agg(obj order by is_deleted, title_sort) from (
    select lower(trim(g.title)) title_sort, (g.deleted_at is not null) is_deleted,
      jsonb_build_object(
        'id', g.id, 'slug', g.slug, 'title', g.title, 'details', g.details,
        'imageFilename', g.image_filename, 'releaseDate', to_char(g.release_date, 'YYYY-MM-DD'),
        'manufactureDate', to_char(g.manufacture_date, 'YYYY-MM-DD'), 'manufacturer', g.manufacturer,
        'manufacturerFullName', g.manufacturer_full_name, 'type', g.machine_type, 'display', g.display_type,
        'playerCount', g.player_count, 'pinsideUrl', g.pinside_url, 'ipdbUrl', g.ipdb_url,
        'kineticistUrl', g.kineticist_url, 'opdbId', g.opdb_id, 'opdbMatchedVia', g.opdb_matched_via,
        'opdbCanonicalName', g.opdb_canonical_name, 'mapAtClub', g.map_at_club,
        'manualAtClubOverride', g.manual_at_club_override, 'manualAtClubNote', g.manual_at_club_note,
        'deletedAt', to_char(g.deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'deletedBy', g.deleted_by, 'deleteNote', g.delete_note, 'partyId', g.party_id,
        'partyRelationshipPublic', g.party_relationship_public, 'hideOwnerPublic', g.hide_owner_public,
        'images', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id', i.id, 'sourceType', i.source_type, 'imageFilename', i.image_filename, 'url', i.image_url,
          'sourceRecordId', i.source_record_id, 'sourcePageUrl', i.source_page_url, 'imageType', i.image_type,
          'title', i.title, 'attributionText', i.attribution_text, 'attributionUrl', i.attribution_url,
          'licenseName', i.license_name, 'licenseUrl', i.license_url, 'width', i.width, 'height', i.height,
          'isPreferred', i.is_preferred
        )) order by i.is_preferred desc, i.created_at, i.id) from public.game_images i where i.game_id = g.id and i.is_active), '[]'::jsonb),
        'locationStints', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id', s.id, 'address', s.address, 'pinballMapLocationId', s.pinball_map_location_id,
          'pinballMapMachineId', s.pinball_map_machine_id, 'joinedClubDate', to_char(s.joined_club_date, 'YYYY-MM-DD'),
          'leftClubDate', to_char(s.left_club_date, 'YYYY-MM-DD'), 'dateUnknown', s.date_unknown
        )) order by s.joined_club_date nulls last, s.id) from public.game_location_stints s where s.game_id = g.id), '[]'::jsonb)
      ) obj
    from public.games g
  ) rows), '[]'::jsonb));
end;
$$;

revoke all on function public.snh_games_editor_load() from public;
grant execute on function public.snh_games_editor_load() to authenticated;
