-- Add human-readable record names to the existing, club-admin-only history RPC.
-- Resolve names after pagination so joins cannot change page size or cursor order.

create or replace function public.snh_audit_history_for_admin(
  p_module text default null,
  p_limit integer default 50,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_show_automated boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not exists (
    select 1
    from public.members m
    join public.member_roles mr on mr.member_id = m.id
    where m.user_id = auth.uid() and mr.role_slug = 'club_admin'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100
     or p_show_automated is null
     or (p_before_created_at is null) <> (p_before_id is null)
     or length(coalesce(p_module, '')) > 80 then
    raise exception 'invalid audit history request' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
    to_jsonb(page) || jsonb_build_object('record_label', coalesce(
      case page.entity_type
        when 'event' then (select e.title from public.events e where e.id::text = page.entity_id)
        when 'game' then (select g.title from public.games g where g.id::text = page.entity_id)
        when 'game_images_opdb' then (select g.title from public.games g where g.id::text = page.entity_id)
        when 'game_image' then (
          select g.title from public.games g
          where g.id::text = coalesce(
            (select gi.game_id::text from public.game_images gi where gi.id::text = page.entity_id),
            page.new_data->>'game_id', page.new_data->>'gameId',
            page.old_data->>'game_id', page.metadata->>'gameId'
          )
        )
        when 'photo_album' then (select a.title from public.photo_albums a where a.id::text = page.entity_id)
        when 'photo_asset' then (
          select coalesce(nullif(a.caption, ''), nullif(a.original_filename, ''), album.title)
          from public.photo_assets a
          left join public.photo_albums album on album.id = a.album_id
          where a.id::text = page.entity_id
        )
        when 'member_profile' then (
          select coalesce(nullif(m.display_name, ''), nullif(m.email, ''))
          from public.members m where m.id::text = page.entity_id
        )
        when 'member_role' then (
          select coalesce(nullif(m.display_name, ''), nullif(m.email, ''))
          from public.members m
          where m.id::text = coalesce(page.new_data->>'member_id', page.old_data->>'member_id')
        )
        when 'membership' then (
          select coalesce(nullif(m.display_name, ''), nullif(m.email, ''))
          from public.members m
          where m.id::text = coalesce(page.new_data->>'member_id', page.old_data->>'member_id')
        )
        when 'pinballmap_ingest' then 'Pinball Map sync'
        else null
      end,
      nullif(page.new_data->>'title', ''), nullif(page.old_data->>'title', ''),
      nullif(page.new_data->>'caption', ''), nullif(page.old_data->>'caption', ''),
      nullif(page.new_data->>'original_filename', ''), nullif(page.old_data->>'original_filename', '')
    )) order by page.created_at desc, page.id desc), '[]'::jsonb)
  into v_rows
  from (
    select al.id, al.created_at, al.module, al.action,
           al.entity_type, al.entity_id, al.old_data, al.new_data, al.metadata,
           al.actor_user_id,
           coalesce(nullif(m.display_name, ''), nullif(m.email, ''),
                    al.actor_user_id::text, 'System') as actor_label
    from public.audit_log al
    left join public.members m on m.user_id = al.actor_user_id
    where (p_module is null or al.module = p_module)
      and (p_show_automated or not (
        al.module = 'games' and al.action = 'import' and al.entity_type = 'pinballmap_ingest'
        and al.new_data @> '{"updates_count": 0, "creates_count": 0}'::jsonb
      ))
      and (p_before_created_at is null
           or (al.created_at, al.id) < (p_before_created_at, p_before_id))
    order by al.created_at desc, al.id desc
    limit p_limit
  ) page;

  return v_rows;
end;
$$;

revoke all on function public.snh_audit_history_for_admin(text, integer, timestamptz, uuid, boolean) from public;
grant execute on function public.snh_audit_history_for_admin(text, integer, timestamptz, uuid, boolean) to authenticated;
