-- Import Pinball Map machine-condition submissions into club_issues.
-- This runs from Edge ingest using service_role and dedupes by submission id.

create table if not exists public.club_issue_import_keys (
  id bigserial primary key,
  source text not null,
  source_key text not null,
  club_issue_id uuid references public.club_issues(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (source, source_key)
);

alter table public.club_issue_import_keys enable row level security;

create or replace function public.snh_pinballmap_import_conditions(p_payload jsonb)
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
  v_title text;
  v_mid int;
  v_created_at timestamptz;
  v_game_id uuid;
  v_issue_id uuid;
  v_imported int := 0;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'rows', '[]'::jsonb))
  loop
    v_source_key := nullif(trim(v_row->>'submissionId'), '');
    v_comment := nullif(trim(v_row->>'comment'), '');
    v_title := nullif(trim(v_row->>'machineName'), '');
    v_mid := (v_row->>'machineId')::int;
    v_created_at := coalesce((v_row->>'createdAt')::timestamptz, now());

    if v_source_key is null or v_comment is null or v_title is null then
      continue;
    end if;

    insert into public.club_issue_import_keys(source, source_key)
    values ('pinballmap', v_source_key)
    on conflict (source, source_key) do nothing;
    if not found then
      continue;
    end if;

    v_game_id := null;
    if v_mid is not null then
      select g.id into v_game_id
      from public.games g
      join public.game_location_stints s on s.game_id = g.id
      where g.deleted_at is null
        and s.pinball_map_machine_id = v_mid
      order by s.updated_at desc
      limit 1;
    end if;

    if v_game_id is null then
      select g.id into v_game_id
      from public.games g
      where g.deleted_at is null
        and lower(trim(g.title)) = lower(trim(regexp_replace(v_title, ' \(([^)]+, \d{4})\)\s*$', '')))
      limit 1;
    end if;

    insert into public.club_issues (
      game_id, title, body, status, created_at, updated_at, created_by
    ) values (
      v_game_id,
      'Pinball Map condition report',
      v_comment,
      'open',
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

revoke all on function public.snh_pinballmap_import_conditions(jsonb) from public;
grant execute on function public.snh_pinballmap_import_conditions(jsonb) to service_role;
