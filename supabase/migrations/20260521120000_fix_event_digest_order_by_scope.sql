-- Fix: outer jsonb_agg ORDER BY referenced alb, which is not in scope (only sub is).

create or replace function public.snh_event_photo_digest_for_editor(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ok boolean;
  v_albums jsonb;
  v_hero jsonb;
begin
  if p_event_id is null then
    raise exception 'event_id required' using errcode = '22023';
  end if;

  v_ok := coalesce(public.snh_member_has_photos_access(), false)
    or exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = auth.uid()
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    );

  if not v_ok then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(row_json order by sub.sort_position, lower(sub.title_sort)),
    '[]'::jsonb
  )
  into v_albums
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'title', alb.title,
        'published', alb.published,
        'displayAt', alb.display_at,
        'assetCounts', jsonb_build_object(
          'total', (select count(*)::int from public.photo_assets a where a.album_id = alb.id),
          'published', (
            select count(*)::int from public.photo_assets a
            where a.album_id = alb.id and a.status = 'published'
          )
        )
      ) as row_json,
      alb.sort_position as sort_position,
      coalesce(alb.title, '') as title_sort
    from public.photo_albums alb
    where alb.event_id = p_event_id
  ) sub;

  select
    case
      when ha.asset_id is null then null
      else jsonb_build_object(
        'eventId', p_event_id,
        'assetId', ha.asset_id,
        'albumId', ha.album_id,
        'caption', ha.caption,
        'altText', ha.alt_text,
        'width', ha.original_width,
        'height', ha.original_height,
        'variants', coalesce(vv.variants, '[]'::jsonb)
      )
    end
  into v_hero
  from (
    select
      a.id as asset_id,
      a.album_id,
      a.caption,
      a.alt_text,
      a.original_width,
      a.original_height
    from public.photo_assets a
    join public.photo_albums alb on alb.id = a.album_id
    where alb.event_id = p_event_id
      and alb.published = true
      and a.status = 'published'
      and a.visibility = 'public'
      and a.promo_role = 'event_hero'
    order by a.published_at asc nulls last
    limit 1
  ) ha
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'variant', v.variant,
      'bucket', v.bucket,
      'objectKey', v.object_key,
      'contentType', v.content_type,
      'width', v.width,
      'height', v.height,
      'contentHash', v.content_hash
    ) order by v.variant), '[]'::jsonb) as variants
    from public.photo_asset_variants v
    where v.asset_id = ha.asset_id
      and v.bucket = 'photos-public'
  ) vv on true;

  return jsonb_build_object(
    'albums', coalesce(v_albums, '[]'::jsonb),
    'hero', v_hero
  );
end;
$$;

revoke all on function public.snh_event_photo_digest_for_editor(uuid) from public;
grant execute on function public.snh_event_photo_digest_for_editor(uuid) to authenticated;
