-- Club issues game picker: only games currently on the floor (effective at club),
-- plus optional include row when editing an issue already linked to an off-site game.

drop function if exists public.snh_club_issues_game_options ();
drop function if exists public.snh_club_issues_game_options (uuid);

create function public.snh_club_issues_game_options (p_include_game_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not coalesce(public.snh_member_has_any_assigned_role(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'title', x.title,
          'slug', x.slug
        )
        order by lower(trim(x.title))
      )
      from (
        select g.id, g.title, g.slug
          from public.games g
         where g.deleted_at is null
           and (
             coalesce(g.manual_at_club_override, g.map_at_club) is true
             or (
               p_include_game_id is not null
               and g.id = p_include_game_id
             )
           )
      ) x
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_club_issues_game_options (uuid) from public;
grant execute on function public.snh_club_issues_game_options (uuid) to authenticated;
