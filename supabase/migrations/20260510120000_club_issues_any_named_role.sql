-- Club issues upsert: allow any member who has at least one assigned portal role
-- (member_roles row), not only games_editor / games_admin / club_admin.

create or replace function public.snh_member_has_any_assigned_role ()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid ()
  );
$$;

revoke all on function public.snh_member_has_any_assigned_role () from public;
grant execute on function public.snh_member_has_any_assigned_role () to authenticated;

comment on function public.snh_member_has_any_assigned_role () is
  'True when the signed-in user''s member row has at least one member_roles assignment.';

create or replace function public.snh_club_issues_upsert (p_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_old jsonb;
  v_gid uuid;
begin
  if not coalesce(public.snh_member_has_any_assigned_role (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is null then
    raise exception 'title required' using errcode = '22023';
  end if;

  v_gid := case when p_fields ? 'gameId' and nullif(trim(p_fields->>'gameId'), '') is not null
    then (p_fields->>'gameId')::uuid else null end;

  if v_gid is not null then
    perform private.snh_require_game_editable (v_gid);
  end if;

  if p_id is null then
    insert into public.club_issues (game_id, title, body, status, created_by)
    values (
      v_gid,
      v_title,
      nullif(trim(p_fields->>'body'), ''),
      coalesce(nullif(lower(trim(p_fields->>'status')), ''), 'open'),
      auth.uid ()
    );

    perform private.snh_audit_game (
      'insert',
      'club_issue',
      coalesce(v_gid::text, 'club'),
      '{}'::jsonb,
      jsonb_build_object ('title', v_title),
      '{}'::jsonb
    );
  else
    select to_jsonb(i.*)
      into v_old
    from public.club_issues i
    where i.id = p_id;

    if v_old is null then
      raise exception 'issue not found' using errcode = 'P0002';
    end if;

    update public.club_issues i
    set
      game_id = case when p_fields ? 'gameId' then v_gid else i.game_id end,
      title = v_title,
      body = case when p_fields ? 'body' then nullif(trim(p_fields->>'body'), '') else i.body end,
      status = case when p_fields ? 'status' then coalesce(nullif(lower(trim(p_fields->>'status')), ''), i.status) else i.status end
    where i.id = p_id;

    perform private.snh_audit_game (
      'update',
      'club_issue',
      p_id::text,
      v_old,
      p_fields,
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_club_issues_upsert (uuid, jsonb) from public;
grant execute on function public.snh_club_issues_upsert (uuid, jsonb) to authenticated;
