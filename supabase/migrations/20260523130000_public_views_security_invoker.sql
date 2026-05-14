-- Supabase database linter 0010: public read views should use security_invoker
-- so underlying RLS is evaluated as the querying user, not the view owner.

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

grant select on public.games_catalog_v1 to anon, authenticated;


create or replace view public.photo_albums_public_v1
with (security_invoker = true)
as
select
  alb.id,
  alb.slug,
  alb.title,
  alb.description,
  alb.sort_position,
  alb.cover_asset_id,
  alb.event_id,
  alb.display_at,
  alb.include_in_highlights,
  alb.created_at,
  alb.updated_at
from public.photo_albums alb
where alb.published = true;

comment on view public.photo_albums_public_v1 is
  'Stable public surface for published albums; no scope columns leaked.';

grant select on public.photo_albums_public_v1 to anon, authenticated;


create or replace view public.photo_assets_public_v1
with (security_invoker = true)
as
select
  a.id,
  a.album_id,
  a.caption,
  a.alt_text,
  a.sort_position,
  a.original_width,
  a.original_height,
  a.published_at,
  a.exclude_from_slideshow,
  a.promo_role
from public.photo_assets a
join public.photo_albums alb on alb.id = a.album_id
where a.status = 'published'
  and a.visibility = 'public'
  and alb.published = true;

comment on view public.photo_assets_public_v1 is
  'Stable public surface for published photo assets; pair with photo_asset_variants_public_v1 for URLs.';

grant select on public.photo_assets_public_v1 to anon, authenticated;


create or replace view public.photo_asset_variants_public_v1
with (security_invoker = true)
as
select
  v.id,
  v.asset_id,
  v.variant,
  v.bucket,
  v.object_key,
  v.content_type,
  v.width,
  v.height,
  v.content_hash
from public.photo_asset_variants v
join public.photo_assets a on a.id = v.asset_id
join public.photo_albums alb on alb.id = a.album_id
where v.bucket = 'photos-public'
  and a.status = 'published'
  and a.visibility = 'public'
  and alb.published = true;

comment on view public.photo_asset_variants_public_v1 is
  'Stable public surface for derivative URLs; only photos-public variants of published assets.';

grant select on public.photo_asset_variants_public_v1 to anon, authenticated;
