-- Gallery mode and atomic custom album ordering. Preserve existing order.
begin;
create table private.photo_gallery_order (
 singleton boolean primary key default true check(singleton),
 mode text not null default 'custom' check(mode in ('custom','newest')),
 revision bigint not null default 0
);
insert into private.photo_gallery_order(singleton) values(true);
revoke all on private.photo_gallery_order from public,anon,authenticated;
create function public.snh_photo_album_order_settings()
returns jsonb language sql stable security definer set search_path=public
as $$ select jsonb_build_object('mode',mode,'revision',revision) from private.photo_gallery_order $$;
revoke all on function public.snh_photo_album_order_settings() from public;
grant execute on function public.snh_photo_album_order_settings() to anon,authenticated;
create function private.snh_photo_new_album_order()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
 perform 1 from private.photo_gallery_order for update;
 select coalesce(min(sort_position),1)-1 into new.sort_position from public.photo_albums;
 return new;
end $$;
revoke all on function private.snh_photo_new_album_order() from public;
create trigger photo_album_new_order before insert on public.photo_albums
for each row execute function private.snh_photo_new_album_order();
create function private.snh_photo_order_revision()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
 if TG_OP='UPDATE' and new.sort_position is not distinct from old.sort_position then return null; end if;
 update private.photo_gallery_order set revision=revision+1;
 return null;
end $$;
revoke all on function private.snh_photo_order_revision() from public;
create trigger photo_album_order_revision after insert or delete or update of sort_position on public.photo_albums
for each row execute function private.snh_photo_order_revision();
create function public.snh_photo_album_order_save(p_mode text,p_album_ids uuid[],p_revision bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$ declare v_settings private.photo_gallery_order%rowtype; v_count int;
begin
 if not coalesce(public.snh_member_has_photos_access(),false) then
  raise exception 'not authorized' using errcode='42501';
 end if;
 if p_mode is null or p_mode not in ('custom','newest') then
  raise exception 'invalid album ordering mode' using errcode='22023';
 end if;
 -- Lock the table first to match album CRUD lock order and serialize concurrent edits.
 lock table public.photo_albums in share row exclusive mode;
 select * into v_settings from private.photo_gallery_order for update;
 if p_revision is distinct from v_settings.revision then
  raise exception 'Album order changed. Cancel and reopen the sorter to load the latest albums.' using errcode='40001';
 end if;
 if p_mode='custom' then
  select count(*) into v_count from public.photo_albums;
  if p_album_ids is null or cardinality(p_album_ids)<>v_count
   or (select count(distinct id) from unnest(p_album_ids) id)<>v_count
   or exists(select 1 from unnest(p_album_ids) requested(id) where requested.id is null or not exists(select 1 from public.photo_albums a where a.id=requested.id)) then
   raise exception 'Custom order must contain every album exactly once.' using errcode='22023';
  end if;
  update public.photo_albums a set sort_position=s.position::int
   from unnest(p_album_ids) with ordinality s(id,position) where a.id=s.id;
 end if;
 update private.photo_gallery_order set mode=p_mode,revision=revision+1;
 perform private.snh_audit_photo('reorder','photo_gallery','club',jsonb_build_object('mode',v_settings.mode),jsonb_build_object('mode',p_mode,'albumIds',p_album_ids),'{}'::jsonb);
 return public.snh_photo_album_order_settings();
end $$;
revoke all on function public.snh_photo_album_order_save(text,uuid[],bigint) from public;
grant execute on function public.snh_photo_album_order_save(text,uuid[],bigint) to authenticated;

create or replace function public.snh_public_photo_albums()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_json order by case when ordering_mode='newest' then album_date end desc nulls last, case when ordering_mode='custom' then sort_position end, lower(title_sort), album_id_sort), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'coverAssetId', alb.cover_asset_id,
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
      alb.title as title_sort, alb.id as album_id_sort, settings.mode as ordering_mode, coalesce(alb.display_at,ev.starts_at,alb.created_at) as album_date
    from public.photo_albums alb
    left join public.events ev on ev.id = alb.event_id
    cross join private.photo_gallery_order settings
    where alb.published = true
  ) sub;
$$;

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

  select coalesce(jsonb_agg(row_json order by case when ordering_mode='newest' then album_date end desc nulls last, case when ordering_mode='custom' then sort_position end, lower(title_sort), album_id_sort), '[]'::jsonb)
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
      alb.title as title_sort, alb.id as album_id_sort, settings.mode as ordering_mode, coalesce(alb.display_at,ev.starts_at,alb.created_at) as album_date
    from public.photo_albums alb
    left join public.events ev on ev.id = alb.event_id
    cross join private.photo_gallery_order settings
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
  v_sort := coalesce((p_fields->>'sortPosition')::int,(select sort_position from public.photo_albums where id=p_album_id),0);
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
commit;
