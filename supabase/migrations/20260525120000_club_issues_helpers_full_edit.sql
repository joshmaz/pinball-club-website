-- Restore full club_issues updates for portal helpers (title/body/game/status).
-- Inserts remain: any authenticated member; non-helpers still create as Incoming only.

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
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is null then
    raise exception 'title required' using errcode = '22023';
  end if;

  v_gid := case
    when p_fields ? 'gameId' and nullif(trim(p_fields->>'gameId'), '') is not null
      then (p_fields->>'gameId')::uuid
    else null
  end;

  if p_id is null then
    if v_gid is not null then
      perform private.snh_require_game_editable (v_gid);
    end if;

    v_status := coalesce(nullif(lower(trim(p_fields->>'status')), ''), 'open');
    if v_status not in ('open', 'in_progress', 'resolved') then
      raise exception 'invalid status' using errcode = '22023';
    end if;

    if not coalesce(public.snh_member_has_any_assigned_role (), false) then
      v_status := 'open';
    end if;

    insert into public.club_issues (
      game_id,
      title,
      body,
      status,
      created_by,
      submission_origin,
      submitted_at
    )
    values (
      v_gid,
      v_title,
      nullif(trim(p_fields->>'body'), ''),
      v_status,
      auth.uid(),
      'member_portal',
      now()
    );

    perform private.snh_audit_game (
      'insert',
      'club_issue',
      coalesce(v_gid::text, 'club'),
      '{}'::jsonb,
      jsonb_build_object ('title', v_title, 'submission_origin', 'member_portal'),
      '{}'::jsonb
    );
  else
    if not coalesce(public.snh_member_has_any_assigned_role (), false) then
      raise exception 'not authorized' using errcode = '42501';
    end if;

    select to_jsonb(i.*)
      into v_old
    from public.club_issues i
    where i.id = p_id;

    if v_old is null then
      raise exception 'issue not found' using errcode = 'P0002';
    end if;

    if v_gid is not null then
      perform private.snh_require_game_editable (v_gid);
    end if;

    update public.club_issues i
    set
      game_id = case when p_fields ? 'gameId' then v_gid else i.game_id end,
      title = v_title,
      body = case
        when p_fields ? 'body' then nullif(trim(p_fields->>'body'), '')
        else i.body
      end,
      status = case
        when p_fields ? 'status' then coalesce(nullif(lower(trim(p_fields->>'status')), ''), i.status)
        else i.status
      end
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
