-- Public summaries are opt-in helper-written text, never redacted private reports.
begin;
alter table public.club_issues add column public_summary text
  check (public_summary is null or length(public_summary) <= 280);
comment on column public.club_issues.public_summary is
  'Optional helper-written public machine symptom summary. No personal or private information. Blank hides it.';

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
  v_public_summary text;
begin
  if not public.snh_account_exists() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_fields ? 'publicSummary' and not coalesce(public.snh_member_has_any_assigned_role(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_public_summary := nullif(trim(p_fields->>'publicSummary'), '');
  if length(v_public_summary) > 280 then
    raise exception 'public summary must be at most 280 characters' using errcode = '22023';
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
      submitted_at,
      public_summary
    )
    values (
      v_gid,
      v_title,
      nullif(trim(p_fields->>'body'), ''),
      v_status,
      auth.uid(),
      'member_portal',
      now(),
      v_public_summary
    );

    perform private.snh_audit_game (
      'insert',
      'club_issue',
      coalesce(v_gid::text, 'club'),
      '{}'::jsonb,
      jsonb_build_object ('title', v_title, 'submission_origin', 'member_portal', 'publicSummary', v_public_summary),
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
      public_summary = case when p_fields ? 'publicSummary' then v_public_summary else i.public_summary end,
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

revoke all on function public.snh_club_issues_upsert (uuid, jsonb) from public, anon;
grant execute on function public.snh_club_issues_upsert (uuid, jsonb) to authenticated;

create or replace function public.snh_club_issues_list ()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.snh_account_exists() then
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
          'publicSummary', i.public_summary,
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

revoke all on function public.snh_club_issues_list () from public, anon;
grant execute on function public.snh_club_issues_list () to authenticated;


-- A curated public projection deliberately omits private report fields and IDs.
create or replace function public.snh_public_game_issues(p_game_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'summary', i.public_summary, 'status', i.status
  ) order by i.updated_at desc, i.id), '[]'::jsonb)
  from public.club_issues i
  join public.games g on g.id = i.game_id and g.deleted_at is null
  where i.game_id = p_game_id and i.status in ('open', 'in_progress')
    and nullif(trim(i.public_summary), '') is not null;
$$;
revoke all on function public.snh_public_game_issues(uuid) from public, anon, authenticated;
grant execute on function public.snh_public_game_issues(uuid) to anon, authenticated;

-- Explicit approval applies even for editors who can read reference-only rows.
create or replace function public.snh_public_game_images(p_game_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', i.id,
    'url', case when i.location_type = 'local_asset' and i.location_value not like 'assets/%'
      then 'assets/images/machines/' || i.location_value else i.location_value end,
    'sourceType', i.source_type, 'imageType', i.image_type, 'altText', i.alt_text,
    'sourceUrl', i.source_url, 'attributionText', i.attribution_text,
    'attributionUrl', i.attribution_url, 'licenseName', i.license_name,
    'licenseUrl', i.license_url, 'variants', i.metadata->'deliveryVariants'
  )) order by i.is_primary desc, case when i.source_type = 'club' then 0 else 1 end, i.created_at, i.id), '[]'::jsonb)
  from public.game_images i
  join public.games g on g.id = i.game_id and g.deleted_at is null
  where i.game_id = p_game_id and i.usage_status = 'approved';
$$;
revoke all on function public.snh_public_game_images(uuid) from public, anon, authenticated;
grant execute on function public.snh_public_game_images(uuid) to anon, authenticated;

-- Reviewed OPDB display corrections only; machine type and descriptions stay intact.
-- Stable OPDB ID and prior display guard against overwriting later editor changes.
-- Environment-generated row IDs are resolved at application time.
do $$
declare r record; v_old jsonb;
begin
  for r in select * from (values
    ('G2Lkd-M0ope-A97xV', null, 'lcd'),
    ('G2Lkd-M0ope-A9dNy', 'Color display', 'lcd'),
    ('G5vLR-ME049', null, 'lcd'),
    ('G5vLR-MwNwy', null, 'lcd'),
    ('G5bYr-MLezO-AO3J1', null, 'lcd'),
    ('GBLLP-MW900-AOEEN', null, 'lcd'),
    ('Grj6X-MJNV1-AO209', null, 'dmd')
  ) as reviewed(opdb_id, old_display, new_display) loop
    for v_old in select to_jsonb(g.*) from public.games g
      where g.deleted_at is null and g.opdb_id = r.opdb_id
        and g.display_type is not distinct from r.old_display for update
    loop
      update public.games set display_type = r.new_display where id = (v_old->>'id')::uuid;
      perform private.snh_audit_game('update', 'game', v_old->>'id', v_old,
        jsonb_build_object('display', r.new_display), jsonb_build_object('source', 'reviewed_opdb_display_2026_10_26'));
    end loop;
  end loop;
end;
$$;

commit;
