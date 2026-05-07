-- Explicit submission time for club issues (Pinball Map submission or portal create).

alter table public.club_issues
  add column if not exists submitted_at timestamptz;

update public.club_issues
set submitted_at = created_at
where submitted_at is null;

alter table public.club_issues
  alter column submitted_at set default now(),
  alter column submitted_at set not null;

comment on column public.club_issues.submitted_at is
  'When the issue was originally reported (Pinball Map submission time for imports; portal create time for manual issues).';

-- ---------------------------------------------------------------------------
-- Pinball Map import: set submitted_at from API createdAt
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
      game_id, title, body, status, created_at, updated_at, submitted_at, created_by
    ) values (
      v_game_id,
      v_issue_title,
      v_comment,
      'open',
      v_created_at,
      v_created_at,
      v_created_at,
      null
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
-- Backfill RPC: also refresh submitted_at from Pinball Map createdAt
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
-- List RPC: submittedAt + updatedAt for UI
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
          'submittedAt', to_char(i.submitted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'createdAt', to_char(i.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'updatedAt', to_char(i.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
        order by i.submitted_at desc
      )
      from public.club_issues i
      left join public.games g on g.id = i.game_id
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_club_issues_list () from public;
grant execute on function public.snh_club_issues_list () to authenticated;
