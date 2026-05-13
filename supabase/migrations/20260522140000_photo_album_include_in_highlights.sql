-- Album flag: published albums marked include_in_highlights feed the public Events page spotlight.
-- Picks one album when several are flagged: lowest sort_position, then title.

alter table public.photo_albums
  add column if not exists include_in_highlights boolean not null default false;

comment on column public.photo_albums.include_in_highlights is
  'When true and the album is published, it may be chosen for the public events.html photo spotlight (one album at a time).';

create index if not exists photo_albums_include_in_highlights_idx
  on public.photo_albums (include_in_highlights, sort_position)
  where include_in_highlights = true and published = true;

drop view if exists public.photo_albums_public_v1 cascade;

create view public.photo_albums_public_v1 as
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


create or replace function public.snh_photo_albums_list_editor()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_json order by sort_position, lower(title_sort)), '[]'::jsonb)
  into v_payload
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'title', alb.title,
        'description', alb.description,
        'sortPosition', alb.sort_position,
        'published', alb.published,
        'includeInHighlights', alb.include_in_highlights,
        'coverAssetId', alb.cover_asset_id,
        'eventId', alb.event_id,
        'eventTitle', ev.title,
        'eventStartsAt', ev.starts_at,
        'displayAt', alb.display_at,
        'createdAt', alb.created_at,
        'updatedAt', alb.updated_at,
        'assetCounts', jsonb_build_object(
          'total', (select count(*) from public.photo_assets a where a.album_id = alb.id),
          'pending', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'pending'),
          'uploaded', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'uploaded'),
          'published', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'published')
        )
      ) as row_json,
      alb.sort_position as sort_position,
      alb.title as title_sort
    from public.photo_albums alb
    left join public.events ev on ev.id = alb.event_id
  ) sub;

  return coalesce(v_payload, '[]'::jsonb);
end;
$$;

revoke all on function public.snh_photo_albums_list_editor() from public;
grant execute on function public.snh_photo_albums_list_editor() to authenticated;


create or replace function public.snh_photo_album_upsert(
  p_album_id uuid,
  p_fields jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_member_id uuid;
  v_old jsonb;
  v_slug text;
  v_title text;
  v_desc text;
  v_sort int;
  v_pub boolean;
  v_include_highlights boolean;
  v_cover uuid;
  v_has_cover boolean;
  v_event_id uuid;
  v_has_event boolean;
  v_prev_event_id uuid;
  v_display_at timestamptz;
  v_has_display_at boolean;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_fields is null then
    raise exception 'fields required' using errcode = '22023';
  end if;

  v_slug := lower(btrim(coalesce(p_fields->>'slug', '')));
  if v_slug = '' or v_slug !~ '^[a-z0-9][a-z0-9_-]{0,80}$' then
    raise exception 'invalid slug (lowercase letters, digits, underscore or dash)' using errcode = '22023';
  end if;

  v_title := btrim(coalesce(p_fields->>'title', ''));
  if v_title = '' or length(v_title) > 200 then
    raise exception 'title required (1-200 characters)' using errcode = '22023';
  end if;

  v_desc := nullif(btrim(coalesce(p_fields->>'description', '')), '');
  v_sort := coalesce((p_fields->>'sortPosition')::int, 0);
  v_pub := coalesce((p_fields->>'published')::boolean, false);
  v_include_highlights := coalesce((p_fields->>'includeInHighlights')::boolean, false);
  v_has_cover := p_fields ? 'coverAssetId';
  v_cover := case
    when v_has_cover and nullif(p_fields->>'coverAssetId', '') is not null then (p_fields->>'coverAssetId')::uuid
    else null
  end;

  v_has_event := p_fields ? 'eventId';
  if v_has_event then
    if (p_fields->'eventId' is null)
      or (jsonb_typeof(p_fields->'eventId') = 'null')
      or (nullif(btrim(coalesce(p_fields->>'eventId', '')), '') is null)
    then
      v_event_id := null;
    else
      v_event_id := (p_fields->>'eventId')::uuid;
      if not exists (
        select 1 from public.events e
        where e.id = v_event_id and coalesce(e.published, true) = true
      ) then
        raise exception 'event not found or not published' using errcode = '22023';
      end if;
    end if;
  end if;

  v_has_display_at := p_fields ? 'displayAt';
  if v_has_display_at then
    if (p_fields->'displayAt' is null)
      or (jsonb_typeof(p_fields->'displayAt') = 'null')
      or (nullif(btrim(coalesce(p_fields->>'displayAt', '')), '') is null)
    then
      v_display_at := null;
    else
      v_display_at := (p_fields->>'displayAt')::timestamptz;
    end if;
  end if;

  select m.id into v_member_id from public.members m where m.user_id = auth.uid() limit 1;

  if p_album_id is null then
    insert into public.photo_albums (
      slug, title, description, sort_position, published, include_in_highlights,
      cover_asset_id, created_by,
      event_id, display_at
    ) values (
      v_slug, v_title, v_desc, v_sort, v_pub, v_include_highlights,
      v_cover, v_member_id,
      case when v_has_event then v_event_id else null end,
      case when v_has_display_at then v_display_at else null end
    )
    returning id into v_id;

    perform private.snh_audit_photo(
      'create',
      'photo_album',
      v_id::text,
      '{}'::jsonb,
      jsonb_build_object(
        'slug', v_slug,
        'title', v_title,
        'published', v_pub,
        'include_in_highlights', v_include_highlights,
        'event_id', case when v_has_event then v_event_id else null end
      ),
      '{}'::jsonb
    );
  else
    select alb.event_id into v_prev_event_id from public.photo_albums alb where alb.id = p_album_id;
    select to_jsonb(alb.*) into v_old from public.photo_albums alb where alb.id = p_album_id;
    if v_old is null then
      raise exception 'album not found' using errcode = 'P0002';
    end if;

    update public.photo_albums alb
       set slug = v_slug,
           title = v_title,
           description = v_desc,
           sort_position = v_sort,
           published = v_pub,
           include_in_highlights = v_include_highlights,
           cover_asset_id = case when v_has_cover then v_cover else alb.cover_asset_id end,
           event_id = case when v_has_event then v_event_id else alb.event_id end,
           display_at = case when v_has_display_at then v_display_at else alb.display_at end
     where alb.id = p_album_id
    returning id into v_id;

    if v_has_event and (v_prev_event_id is distinct from v_event_id) then
      update public.photo_assets a
         set promo_role = null
       where a.album_id = p_album_id and a.promo_role is not null;
    end if;

    perform private.snh_audit_photo(
      'update',
      'photo_album',
      v_id::text,
      v_old,
      (select to_jsonb(alb.*) from public.photo_albums alb where alb.id = v_id),
      '{}'::jsonb
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.snh_photo_album_upsert(uuid, jsonb) from public;
grant execute on function public.snh_photo_album_upsert(uuid, jsonb) to authenticated;


create or replace function public.snh_public_events_spotlight_album()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  (
    select row_json
    from (
      select
        jsonb_build_object(
          'id', alb.id,
          'slug', alb.slug,
          'title', alb.title,
          'description', alb.description,
          'sortPosition', alb.sort_position,
          'updatedAt', alb.updated_at,
          'eventId', alb.event_id,
          'eventStartsAt', ev.starts_at,
          'eventTitle', ev.title,
          'displayAt', alb.display_at,
          'assets', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', a.id,
              'caption', a.caption,
              'altText', a.alt_text,
              'sortPosition', a.sort_position,
              'excludeFromSlideshow', a.exclude_from_slideshow,
              'promoRole', a.promo_role,
              'width', a.original_width,
              'height', a.original_height,
              'variants', coalesce((
                select jsonb_agg(jsonb_build_object(
                  'variant', v.variant,
                  'bucket', v.bucket,
                  'objectKey', v.object_key,
                  'contentType', v.content_type,
                  'width', v.width,
                  'height', v.height,
                  'contentHash', v.content_hash
                ) order by v.variant)
                from public.photo_asset_variants v
                where v.asset_id = a.id
                  and v.bucket = 'photos-public'
              ), '[]'::jsonb)
            ) order by a.sort_position, a.created_at)
            from public.photo_assets a
            where a.album_id = alb.id
              and a.status = 'published'
              and a.visibility = 'public'
          ), '[]'::jsonb)
        ) as row_json,
        alb.sort_position as sort_position,
        coalesce(alb.title, '') as title_sort
      from public.photo_albums alb
      left join public.events ev on ev.id = alb.event_id
      where alb.published = true
        and alb.include_in_highlights = true
    ) sub
    order by sort_position, lower(title_sort)
    limit 1
  );
$$;

revoke all on function public.snh_public_events_spotlight_album() from public;
grant execute on function public.snh_public_events_spotlight_album() to anon, authenticated;

comment on function public.snh_public_events_spotlight_album() is
  'One published album flagged include_in_highlights (tie-break: sort position, title) for events.html.';
