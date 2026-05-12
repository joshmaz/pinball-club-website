-- Event editor: read-only digest of photo albums linked to an event + public hero.
-- Callers: events helpers OR photos helpers (same people often overlap).

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

  select coalesce(jsonb_agg(row_json order by alb.sort_position, lower(title_sort)), '[]'::jsonb)
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

  select public.snh_public_event_promo_asset(p_event_id) into v_hero;

  return jsonb_build_object(
    'albums', coalesce(v_albums, '[]'::jsonb),
    'hero', v_hero
  );
end;
$$;

revoke all on function public.snh_event_photo_digest_for_editor(uuid) from public;
grant execute on function public.snh_event_photo_digest_for_editor(uuid) to authenticated;

comment on function public.snh_event_photo_digest_for_editor(uuid) is
  'Albums with event_id = p_event_id plus snh_public_event_promo_asset payload. Events or photos role.';
