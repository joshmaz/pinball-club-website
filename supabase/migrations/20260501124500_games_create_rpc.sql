-- RPC: create game (camelCase keys in p_fields jsonb)

create or replace function public.snh_games_create(
  p_fields jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_slug text;
  v_new_id uuid;
begin
  if not coalesce(public.snh_member_has_games_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_title := nullif(trim(p_fields->>'title'), '');
  if v_title is null then
    raise exception 'title is required' using errcode = '22023';
  end if;

  v_slug := nullif(trim(p_fields->>'slug'), '');
  if v_slug is null then
    v_slug := lower(regexp_replace(v_title, '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);
  end if;
  if v_slug is null or v_slug = '' then
    raise exception 'invalid slug' using errcode = '22023';
  end if;

  insert into public.games (
    slug,
    title,
    details,
    image_filename,
    release_date,
    manufacture_date,
    manufacturer,
    manufacturer_full_name,
    machine_type,
    display_type,
    player_count,
    pinside_url,
    ipdb_url,
    kineticist_url,
    opdb_id,
    opdb_matched_via,
    opdb_canonical_name
  ) values (
    v_slug,
    v_title,
    nullif(trim(p_fields->>'details'), ''),
    case when p_fields ? 'imageFilename' then nullif(trim(p_fields->>'imageFilename'), '') else null end,
    case when p_fields ? 'releaseDate' then (p_fields->>'releaseDate')::date else null end,
    case when p_fields ? 'manufactureDate' then (p_fields->>'manufactureDate')::date else null end,
    case when p_fields ? 'manufacturer' then nullif(trim(p_fields->>'manufacturer'), '') else null end,
    case when p_fields ? 'manufacturerFullName' then nullif(trim(p_fields->>'manufacturerFullName'), '') else null end,
    case when p_fields ? 'type' then nullif(trim(p_fields->>'type'), '') else null end,
    case when p_fields ? 'display' then nullif(trim(p_fields->>'display'), '') else null end,
    case when p_fields ? 'playerCount' then (p_fields->>'playerCount')::smallint else null end,
    case when p_fields ? 'pinsideUrl' then nullif(trim(p_fields->>'pinsideUrl'), '') else null end,
    case when p_fields ? 'ipdbUrl' then nullif(trim(p_fields->>'ipdbUrl'), '') else null end,
    case when p_fields ? 'kineticistUrl' then nullif(trim(p_fields->>'kineticistUrl'), '') else null end,
    case when p_fields ? 'opdbId' then nullif(trim(p_fields->>'opdbId'), '') else null end,
    case when p_fields ? 'opdbMatchedVia' then nullif(trim(p_fields->>'opdbMatchedVia'), '') else null end,
    case when p_fields ? 'opdbCanonicalName' then nullif(trim(p_fields->>'opdbCanonicalName'), '') else null end
  )
  returning id into v_new_id;

  perform private.snh_audit_game(
    'create',
    'game',
    v_new_id::text,
    '{}'::jsonb,
    (select to_jsonb(g.*) from public.games g where g.id = v_new_id),
    '{}'::jsonb
  );

  return v_new_id;
end;
$$;

revoke all on function public.snh_games_create(jsonb) from public;
grant execute on function public.snh_games_create(jsonb) to authenticated;
