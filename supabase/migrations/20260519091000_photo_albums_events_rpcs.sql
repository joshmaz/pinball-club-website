-- Photo RPC updates: album–event link, promo flags, public hero helper.
-- Depends on 20260519090000_photo_albums_events_schema.sql

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
      slug, title, description, sort_position, published, cover_asset_id, created_by,
      event_id, display_at
    ) values (
      v_slug, v_title, v_desc, v_sort, v_pub, v_cover, v_member_id,
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


create or replace function public.snh_photo_assets_list_editor(p_album_id uuid)
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

  if p_album_id is null then
    raise exception 'album_id required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row_json order by sort_position, created_sort), '[]'::jsonb)
  into v_payload
  from (
    select
      jsonb_build_object(
        'id', a.id,
        'albumId', a.album_id,
        'status', a.status,
        'visibility', a.visibility,
        'caption', a.caption,
        'altText', a.alt_text,
        'sortPosition', a.sort_position,
        'excludeFromSlideshow', a.exclude_from_slideshow,
        'promoRole', a.promo_role,
        'originalObjectKey', a.original_object_key,
        'originalContentType', a.original_content_type,
        'originalByteSize', a.original_byte_size,
        'originalContentHash', a.original_content_hash,
        'originalWidth', a.original_width,
        'originalHeight', a.original_height,
        'originalFilename', a.original_filename,
        'publishedAt', a.published_at,
        'unpublishedAt', a.unpublished_at,
        'createdAt', a.created_at,
        'updatedAt', a.updated_at,
        'variants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'variant', v.variant,
            'bucket', v.bucket,
            'objectKey', v.object_key,
            'contentType', v.content_type,
            'byteSize', v.byte_size,
            'width', v.width,
            'height', v.height,
            'contentHash', v.content_hash
          ) order by v.variant)
          from public.photo_asset_variants v
          where v.asset_id = a.id
        ), '[]'::jsonb)
      ) as row_json,
      a.sort_position as sort_position,
      a.created_at as created_sort
    from public.photo_assets a
    where a.album_id = p_album_id
  ) sub;

  return coalesce(v_payload, '[]'::jsonb);
end;
$$;

revoke all on function public.snh_photo_assets_list_editor(uuid) from public;
grant execute on function public.snh_photo_assets_list_editor(uuid) to authenticated;


create or replace function public.snh_photo_asset_set_metadata(
  p_asset_id uuid,
  p_fields jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_caption text;
  v_alt text;
  v_sort int;
  v_has_caption boolean;
  v_has_alt boolean;
  v_has_sort boolean;
  v_exclude boolean;
  v_has_exclude boolean;
  v_promo text;
  v_has_promo boolean;
  v_album_event uuid;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_asset_id is null or p_fields is null then
    raise exception 'asset_id and fields required' using errcode = '22023';
  end if;

  v_has_caption := p_fields ? 'caption';
  v_has_alt := p_fields ? 'altText';
  v_has_sort := p_fields ? 'sortPosition';
  v_has_exclude := p_fields ? 'excludeFromSlideshow';
  v_has_promo := p_fields ? 'promoRole';

  if v_has_caption then
    v_caption := nullif(btrim(coalesce(p_fields->>'caption', '')), '');
    if v_caption is not null and length(v_caption) > 1000 then
      raise exception 'caption too long' using errcode = '22023';
    end if;
  end if;

  if v_has_alt then
    v_alt := nullif(btrim(coalesce(p_fields->>'altText', '')), '');
    if v_alt is not null and length(v_alt) > 500 then
      raise exception 'altText too long' using errcode = '22023';
    end if;
  end if;

  if v_has_sort then
    v_sort := coalesce((p_fields->>'sortPosition')::int, 0);
  end if;

  if v_has_exclude then
    v_exclude := coalesce((p_fields->>'excludeFromSlideshow')::boolean, false);
  end if;

  if v_has_promo then
    if (p_fields->'promoRole' is null)
      or (jsonb_typeof(p_fields->'promoRole') = 'null')
      or (nullif(btrim(coalesce(p_fields->>'promoRole', '')), '') is null)
    then
      v_promo := null;
    else
      v_promo := lower(btrim(coalesce(p_fields->>'promoRole', '')));
      if v_promo not in ('event_hero', 'event_branding') then
        raise exception 'invalid promoRole' using errcode = '22023';
      end if;
    end if;
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  select alb.event_id into v_album_event
  from public.photo_assets a
  join public.photo_albums alb on alb.id = a.album_id
  where a.id = p_asset_id;

  if v_has_promo and v_promo = 'event_hero' then
    if v_album_event is null then
      raise exception 'event_hero requires the album to be linked to an event' using errcode = '22023';
    end if;
    update public.photo_assets a
       set promo_role = null
      from public.photo_albums alb
     where alb.id = a.album_id
       and alb.event_id = v_album_event
       and a.promo_role = 'event_hero'
       and a.id <> p_asset_id;
  end if;

  if v_has_promo and v_promo = 'event_branding' and v_album_event is null then
    raise exception 'event_branding requires the album to be linked to an event' using errcode = '22023';
  end if;

  update public.photo_assets a
     set caption = case when v_has_caption then v_caption else a.caption end,
         alt_text = case when v_has_alt then v_alt else a.alt_text end,
         sort_position = case when v_has_sort then v_sort else a.sort_position end,
         exclude_from_slideshow = case when v_has_exclude then v_exclude else a.exclude_from_slideshow end,
         promo_role = case when v_has_promo then v_promo else a.promo_role end
   where a.id = p_asset_id;

  perform private.snh_audit_photo(
    'update',
    'photo_asset',
    p_asset_id::text,
    v_old,
    (select to_jsonb(a.*) from public.photo_assets a where a.id = p_asset_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_photo_asset_set_metadata(uuid, jsonb) from public;
grant execute on function public.snh_photo_asset_set_metadata(uuid, jsonb) to authenticated;


create or replace function public.snh_public_photo_albums()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_json order by sort_position, lower(title_sort)), '[]'::jsonb)
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
      alb.title as title_sort
    from public.photo_albums alb
    left join public.events ev on ev.id = alb.event_id
    where alb.published = true
  ) sub;
$$;

revoke all on function public.snh_public_photo_albums() from public;
grant execute on function public.snh_public_photo_albums() to anon, authenticated;


create or replace function public.snh_events_list_for_photo_link()
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

  select coalesce(jsonb_agg(row_json order by starts_sort desc nulls last, lower(title_sort)), '[]'::jsonb)
  into v_payload
  from (
    select
      jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'startsAt', e.starts_at
      ) as row_json,
      e.starts_at as starts_sort,
      coalesce(e.title, '') as title_sort
    from public.events e
    where coalesce(e.published, true) = true
  ) sub;

  return coalesce(v_payload, '[]'::jsonb);
end;
$$;

revoke all on function public.snh_events_list_for_photo_link() from public;
grant execute on function public.snh_events_list_for_photo_link() to authenticated;

create or replace function public.snh_public_event_promo_asset(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_asset_id uuid;
  v_album_id uuid;
  v_caption text;
  v_alt text;
  v_w int;
  v_h int;
  v_variants jsonb;
begin
  if p_event_id is null then
    return null;
  end if;

  if not exists (
    select 1 from public.events e
    where e.id = p_event_id and coalesce(e.published, true) = true
  ) then
    return null;
  end if;

  select a.id, a.album_id, a.caption, a.alt_text, a.original_width, a.original_height
  into v_asset_id, v_album_id, v_caption, v_alt, v_w, v_h
  from public.photo_assets a
  join public.photo_albums alb on alb.id = a.album_id
  where alb.event_id = p_event_id
    and alb.published = true
    and a.status = 'published'
    and a.visibility = 'public'
    and a.promo_role = 'event_hero'
  order by a.published_at asc nulls last
  limit 1;

  if not found or v_asset_id is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'variant', v.variant,
    'bucket', v.bucket,
    'objectKey', v.object_key,
    'contentType', v.content_type,
    'width', v.width,
    'height', v.height,
    'contentHash', v.content_hash
  ) order by v.variant), '[]'::jsonb)
  into v_variants
  from public.photo_asset_variants v
  where v.asset_id = v_asset_id
    and v.bucket = 'photos-public';

  return jsonb_build_object(
    'eventId', p_event_id,
    'assetId', v_asset_id,
    'albumId', v_album_id,
    'caption', v_caption,
    'altText', v_alt,
    'width', v_w,
    'height', v_h,
    'variants', v_variants
  );
end;
$$;

revoke all on function public.snh_public_event_promo_asset(uuid) from public;
grant execute on function public.snh_public_event_promo_asset(uuid) to anon, authenticated;

