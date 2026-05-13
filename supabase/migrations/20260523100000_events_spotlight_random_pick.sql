-- When multiple albums have include_in_highlights, pick one at random per call.

create or replace function public.snh_public_events_spotlight_album()
returns jsonb
language sql
volatile
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
        ) as row_json
      from public.photo_albums alb
      left join public.events ev on ev.id = alb.event_id
      where alb.published = true
        and alb.include_in_highlights = true
    ) sub
    order by random()
    limit 1
  );
$$;

comment on function public.snh_public_events_spotlight_album() is
  'One published album flagged include_in_highlights, chosen at random when several qualify.';
