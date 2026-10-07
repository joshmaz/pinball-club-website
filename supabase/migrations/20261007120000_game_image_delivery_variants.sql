-- Expose delivery metadata only for the already-approved selected association.
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
      'licenseUrl', i.license_url,
      'variants', i.metadata->'deliveryVariants'
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

