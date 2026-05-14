-- Club issues: submission_origin (member portal vs Pinball Map vs future public games),
-- any authenticated member may INSERT; only portal helpers may UPDATE status only.

alter table public.club_issues
  add column if not exists submission_origin text not null default 'member_portal';

alter table public.club_issues
  drop constraint if exists club_issues_submission_origin_chk;

alter table public.club_issues
  add constraint club_issues_submission_origin_chk check (
    submission_origin in ('member_portal', 'pinballmap', 'public_games')
  );

comment on column public.club_issues.submission_origin is
  'Where the report originated: member_portal (signed-in member), pinballmap (ingest), public_games (reserved for anonymous public submissions).';

-- Backfill Pinball Map rows (import keys are authoritative; title pattern catches legacy rows).
update public.club_issues i
set submission_origin = 'pinballmap'
from public.club_issue_import_keys k
where k.club_issue_id = i.id
  and k.source = 'pinballmap';

update public.club_issues i
set submission_origin = 'pinballmap'
where i.submission_origin = 'member_portal'
  and i.created_by is null
  and i.title ilike 'Pinball Map:%';

-- ---------------------------------------------------------------------------
-- Pinball Map import: stamp submission_origin
-- ---------------------------------------------------------------------------

create or replace function public.snh_pinballmap_import_conditions (p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row jsonb;
  v_source_key text;
  v_comment text;
  v_machine_name text;
  v_mid int;
  v_created_at timestamptz;
  v_game_id uuid;
  v_issue_id uuid;
  v_imported int := 0;
  v_issue_title text;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'rows', '[]'::jsonb))
  loop
    v_source_key := nullif(trim(v_row->>'submissionId'), '');
    v_comment := nullif(trim(v_row->>'comment'), '');
    v_machine_name := nullif(trim(v_row->>'machineName'), '');
    v_mid := (v_row->>'machineId')::int;
    v_created_at := coalesce((v_row->>'createdAt')::timestamptz, now());

    if v_source_key is null or v_comment is null or v_machine_name is null then
      continue;
    end if;

    insert into public.club_issue_import_keys(source, source_key)
    values ('pinballmap', v_source_key)
    on conflict (source, source_key) do nothing;
    if not found then
      continue;
    end if;

    v_game_id := private.snh_pinballmap_resolve_game_for_condition(v_mid, v_machine_name, v_created_at);

    v_issue_title := 'Pinball Map: ' || left(v_machine_name, 280);

    insert into public.club_issues (
      game_id,
      title,
      body,
      status,
      created_at,
      updated_at,
      submitted_at,
      created_by,
      submission_origin
    ) values (
      v_game_id,
      v_issue_title,
      v_comment,
      'open',
      v_created_at,
      v_created_at,
      v_created_at,
      null,
      'pinballmap'
    )
    returning id into v_issue_id;

    update public.club_issue_import_keys
    set club_issue_id = v_issue_id
    where source = 'pinballmap' and source_key = v_source_key;

    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('ok', true, 'imported', v_imported);
end;
$$;

revoke all on function public.snh_pinballmap_import_conditions (jsonb) from public;
grant execute on function public.snh_pinballmap_import_conditions (jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill RPC: keep submission_origin aligned for known imports
-- ---------------------------------------------------------------------------

create or replace function public.snh_pinballmap_backfill_club_issues (p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row jsonb;
  v_source_key text;
  v_machine_name text;
  v_mid int;
  v_created_at timestamptz;
  v_game_id uuid;
  v_issue_id uuid;
  v_updated int := 0;
  v_issue_title text;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'rows', '[]'::jsonb))
  loop
    v_source_key := nullif(trim(v_row->>'submissionId'), '');
    v_machine_name := nullif(trim(v_row->>'machineName'), '');
    v_mid := (v_row->>'machineId')::int;
    v_created_at := coalesce((v_row->>'createdAt')::timestamptz, now());

    if v_source_key is null or v_machine_name is null then
      continue;
    end if;

    select k.club_issue_id
      into v_issue_id
    from public.club_issue_import_keys k
    where k.source = 'pinballmap'
      and k.source_key = v_source_key
      and k.club_issue_id is not null
    limit 1;

    if v_issue_id is null then
      continue;
    end if;

    v_game_id := private.snh_pinballmap_resolve_game_for_condition(v_mid, v_machine_name, v_created_at);
    v_issue_title := 'Pinball Map: ' || left(v_machine_name, 280);

    update public.club_issues i
    set
      title = v_issue_title,
      game_id = v_game_id,
      submitted_at = v_created_at,
      submission_origin = 'pinballmap',
      updated_at = now()
    where i.id = v_issue_id;

    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('ok', true, 'updated', v_updated);
end;
$$;

revoke all on function public.snh_pinballmap_backfill_club_issues (jsonb) from public;
grant execute on function public.snh_pinballmap_backfill_club_issues (jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Game picker: any authenticated member (for add-note form)
-- ---------------------------------------------------------------------------

create or replace function public.snh_club_issues_game_options (p_include_game_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
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

-- ---------------------------------------------------------------------------
-- List RPC: submission provenance label for UI
-- ---------------------------------------------------------------------------

create or replace function public.snh_club_issues_list ()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'gameId', i.game_id,
          'gameTitle', g.title,
          'gameSlug', g.slug,
          'title', i.title,
          'body', i.body,
          'status', i.status,
          'submissionOrigin', i.submission_origin,
          'submittedByLabel',
            case i.submission_origin
              when 'pinballmap' then 'Pinball Map'
              when 'public_games' then 'Public games page'
              else coalesce(
                nullif(trim(m.display_name), ''),
                nullif(trim(concat_ws(' ', nullif(trim(m.first_name), ''), nullif(trim(m.last_name), ''))), ''),
                'Member'
              )
            end,
          'submittedAt', to_char(i.submitted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'createdAt', to_char(i.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'updatedAt', to_char(i.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
        order by i.submitted_at desc
      )
      from public.club_issues i
      left join public.games g on g.id = i.game_id
      left join public.members m on m.user_id = i.created_by
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_club_issues_list () from public;
grant execute on function public.snh_club_issues_list () to authenticated;

-- ---------------------------------------------------------------------------
-- Upsert: INSERT any authenticated member; UPDATE status only for helpers
-- ---------------------------------------------------------------------------

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

  if p_id is null then
    v_title := nullif(trim(p_fields->>'title'), '');
    if v_title is null then
      raise exception 'title required' using errcode = '22023';
    end if;

    v_gid := case when p_fields ? 'gameId' and nullif(trim(p_fields->>'gameId'), '') is not null
      then (p_fields->>'gameId')::uuid else null end;

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

    if not (p_fields ? 'status') then
      raise exception 'status required for updates' using errcode = '22023';
    end if;

    v_status := coalesce(nullif(lower(trim(p_fields->>'status')), ''), (v_old->>'status'));
    if v_status not in ('open', 'in_progress', 'resolved') then
      raise exception 'invalid status' using errcode = '22023';
    end if;

    update public.club_issues i
    set status = v_status
    where i.id = p_id;

    perform private.snh_audit_game (
      'update',
      'club_issue',
      p_id::text,
      v_old,
      jsonb_build_object ('status', v_status),
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.snh_club_issues_upsert (uuid, jsonb) from public;
grant execute on function public.snh_club_issues_upsert (uuid, jsonb) to authenticated;
