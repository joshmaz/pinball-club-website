-- Reviewed legacy data and deployment procedure: docs/pingolf-targets.md.
-- The user approved discarding the one reviewed legacy target. Stop on new data.
begin;
lock table public.pingolf_targets, public.pingolf_sessions in access exclusive mode;
do $$
begin
  if exists (
    select 1 from public.pingolf_targets
    where id <> 'cb70ea63-d776-4785-81a0-a6e2eb51719e'::uuid
      or game_id <> '4994ffc3-30ec-4d9b-9f5c-8ff3909ca7c6'::uuid
      or description <> 'Start a Road Kings Multiball'
      or target_value is distinct from 1
  ) then
    raise exception 'Unreviewed legacy Pingolf targets. Review data before migrating.';
  end if;
end;
$$;

delete from public.pingolf_targets where id = 'cb70ea63-d776-4785-81a0-a6e2eb51719e'::uuid;

alter table public.pingolf_targets
  add column target_type text not null
    check (target_type in ('score', 'feature', 'progression', 'hybrid')),
  add column score_threshold bigint check (score_threshold > 0),
  add column is_preferred boolean not null default false,
  add column notes text,
  add constraint pingolf_target_description_nonempty check (length(trim(description)) > 0);

create unique index pingolf_targets_one_preferred_per_game
  on public.pingolf_targets(game_id) where is_preferred;

drop function public.snh_pingolf_targets_list_editor(uuid);
drop function public.snh_pingolf_target_upsert(uuid, uuid, uuid, jsonb);

create function public.snh_pingolf_targets_list_editor(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'gameId', t.game_id, 'targetType', t.target_type,
    'description', t.description, 'scoreThreshold', t.score_threshold::text,
    'isPreferred', t.is_preferred, 'notes', t.notes
  ) order by t.is_preferred desc, t.created_at, t.id)
    from public.pingolf_targets t where t.game_id = p_game_id), '[]'::jsonb);
end;
$$;
revoke all on function public.snh_pingolf_targets_list_editor(uuid) from public;
grant execute on function public.snh_pingolf_targets_list_editor(uuid) to authenticated;

create function public.snh_pingolf_target_upsert(p_id uuid, p_game_id uuid, p_fields jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.pingolf_targets;
  v_new public.pingolf_targets;
  v_previous public.pingolf_targets;
  v_type text;
  v_description text;
  v_score bigint;
  v_preferred boolean;
  v_notes text;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Serialize all target mutations for this game, including limit and preference changes.
  perform 1 from public.games where id = p_game_id for update;
  perform private.snh_require_game_editable(p_game_id);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'target fields required' using errcode = '22023';
  end if;
  if p_id is not null then
    select * into v_old from public.pingolf_targets where id = p_id and game_id = p_game_id;
    if not found then
      raise exception 'target not found' using errcode = 'P0002';
    end if;
  elsif (select count(*) from public.pingolf_targets where game_id = p_game_id) >= 10 then
    raise exception 'A game may have at most 10 Pingolf targets' using errcode = '22023';
  end if;
  v_type := case when p_fields ? 'targetType' then p_fields->>'targetType' else v_old.target_type end;
  v_description := trim(case when p_fields ? 'description' then p_fields->>'description' else v_old.description end);
  if v_type is null or v_type not in ('score', 'feature', 'progression', 'hybrid') then
    raise exception 'invalid target type' using errcode = '22023';
  end if;
  if coalesce(v_description, '') = '' then
    raise exception 'description required' using errcode = '22023';
  end if;
  if p_fields ? 'scoreThreshold' and p_fields->>'scoreThreshold' is not null
     and (p_fields->>'scoreThreshold') !~ '^[0-9]+$' then
    raise exception 'score threshold must be a positive whole number' using errcode = '22023';
  end if;
  v_score := case when p_fields ? 'scoreThreshold' then (p_fields->>'scoreThreshold')::bigint else v_old.score_threshold end;
  if v_score <= 0 then
    raise exception 'score threshold must be positive' using errcode = '22023';
  end if;
  if p_fields ? 'isPreferred' and jsonb_typeof(p_fields->'isPreferred') <> 'boolean' then
    raise exception 'preferred must be boolean' using errcode = '22023';
  end if;
  v_preferred := case when p_fields ? 'isPreferred' then (p_fields->>'isPreferred')::boolean else coalesce(v_old.is_preferred, false) end;
  v_notes := case when p_fields ? 'notes' then nullif(trim(p_fields->>'notes'), '') else v_old.notes end;
  if v_preferred then
    for v_previous in select * from public.pingolf_targets
      where game_id = p_game_id and is_preferred and id is distinct from p_id
    loop
      update public.pingolf_targets set is_preferred = false where id = v_previous.id returning * into v_new;
      perform private.snh_audit_game('update', 'pingolf_target', v_previous.id::text,
        to_jsonb(v_previous), to_jsonb(v_new), jsonb_build_object('reason', 'preferred target changed'));
    end loop;
  end if;
  if p_id is null then
    insert into public.pingolf_targets(game_id, target_type, description, score_threshold, is_preferred, notes)
      values (p_game_id, v_type, v_description, v_score, v_preferred, v_notes) returning * into v_new;
  else
    update public.pingolf_targets set target_type = v_type, description = v_description,
      score_threshold = v_score, is_preferred = v_preferred, notes = v_notes
      where id = p_id returning * into v_new;
  end if;
  perform private.snh_audit_game(case when p_id is null then 'insert' else 'update' end,
    'pingolf_target', v_new.id::text, case when p_id is null then '{}'::jsonb else to_jsonb(v_old) end,
    to_jsonb(v_new), '{}'::jsonb);
  return v_new.id;
end;
$$;
revoke all on function public.snh_pingolf_target_upsert(uuid, uuid, jsonb) from public;
grant execute on function public.snh_pingolf_target_upsert(uuid, uuid, jsonb) to authenticated;

create or replace function public.snh_pingolf_target_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_game_id uuid;
  v_old public.pingolf_targets;
begin
  if not coalesce(public.snh_member_has_games_admin_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select game_id into v_game_id from public.pingolf_targets where id = p_id;
  if not found then return; end if;
  perform 1 from public.games where id = v_game_id for update;
  perform private.snh_require_game_editable(v_game_id);
  delete from public.pingolf_targets where id = p_id returning * into v_old;
  if not found then return; end if;
  perform private.snh_audit_game('delete', 'pingolf_target', p_id::text, to_jsonb(v_old), '{}'::jsonb, '{}'::jsonb);
end;
$$;
revoke all on function public.snh_pingolf_target_delete(uuid) from public;
grant execute on function public.snh_pingolf_target_delete(uuid) to authenticated;

create or replace function public.snh_public_game_more_info (p_game_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_title text;
  v_hide_owner boolean;
  v_party_id uuid;
  v_rel text;
  v_disp text;
  v_vis boolean;
  v_high jsonb;
  v_pingolf jsonb;
  v_mods jsonb;
  v_sale jsonb;
  v_party_summaries jsonb;
  v_notes text;
  v_sale_status text;
  v_sale_cents integer;
  v_sale_notes text;
  v_line text;
begin
  if p_game_id is null then
    return null;
  end if;

  select
    g.slug,
    g.title,
    g.hide_owner_public,
    g.party_id,
    g.party_relationship_public
    into v_slug, v_title, v_hide_owner, v_party_id, v_rel
  from public.games g
  where g.id = p_game_id and g.deleted_at is null;

  if v_slug is null then
    return null;
  end if;

  v_party_summaries := '[]'::jsonb;

  if not v_hide_owner and v_party_id is not null then
    select p.display_name, p.visibility_public
      into v_disp, v_vis
    from public.owner_parties p
    where p.id = v_party_id;

    if coalesce(v_vis, false) and v_disp is not null and trim(v_disp) <> '' then
      v_line := trim(
        both ' · '
        from concat_ws(
          ' · ',
          nullif(trim(v_rel), ''),
          trim(v_disp)
        )
      );
      if v_line <> '' then
        v_party_summaries := jsonb_build_array(v_line);
      end if;
    end if;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'score', h.score,
        'playerLabel', h.player_label,
        'achievedOn', to_char(h.achieved_on, 'YYYY-MM-DD'),
        'notes', h.notes,
        'sortOrder', h.sort_order
      )
      order by h.sort_order, h.achieved_on desc, h.score desc
    ),
    '[]'::jsonb
  )
  into v_high
  from public.game_high_scores h
  where h.game_id = p_game_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'targetType', t.target_type, 'description', t.description,
    'scoreThreshold', t.score_threshold::text, 'isPreferred', t.is_preferred
  ) order by t.is_preferred desc, t.created_at, t.id), '[]'::jsonb)
  into v_pingolf from public.pingolf_targets t where t.game_id = p_game_id;


  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'title', m.title,
        'description', m.description,
        'referenceUrl', m.reference_url,
        'sortOrder', m.sort_order
      )
      order by m.sort_order, m.title
    ),
    '[]'::jsonb
  )
  into v_mods
  from public.game_custom_mods m
  where m.game_id = p_game_id;

  select l.status, l.asking_price_cents, l.notes
    into v_sale_status, v_sale_cents, v_sale_notes
  from public.game_sale_listings l
  where l.game_id = p_game_id
    and lower(l.status) in ('listed', 'pending')
  order by l.updated_at desc
  limit 1;

  if v_sale_status is null then
    v_sale := null;
  else
    v_notes := v_sale_notes;
    if v_notes is not null and length(v_notes) > 280 then
      v_notes := left(v_notes, 277) || '...';
    end if;
    v_sale := jsonb_strip_nulls(
      jsonb_build_object(
        'status', v_sale_status,
        'askingPriceCents', v_sale_cents,
        'notes', v_notes
      )
    );
  end if;

  return jsonb_strip_nulls(
    jsonb_build_object(
      'gameId', p_game_id,
      'slug', v_slug,
      'title', v_title,
      'highScores', v_high,
      'pingolfTargets', v_pingolf,
      'customMods', v_mods,
      'saleListingPublic', v_sale,
      'partySummaries', v_party_summaries
    )
  );
end;
$$;

revoke all on function public.snh_public_game_more_info (uuid) from public;
grant execute on function public.snh_public_game_more_info (uuid) to anon, authenticated;

-- All readers and writers now use the game relationship.
drop function public.snh_pingolf_sessions_list_editor();
drop function public.snh_pingolf_session_upsert(uuid, jsonb);
alter table public.pingolf_targets drop column session_id, drop column target_value, drop column sort_order;
drop table public.pingolf_sessions;
commit;
