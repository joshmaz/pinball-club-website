-- Owner parties directory + per-game link; public More Info uses display_name only.

-- ---------------------------------------------------------------------------
-- Table: canonical party / owner contact rows (many games may reference one party)
-- ---------------------------------------------------------------------------

create table if not exists public.owner_parties (
  id uuid primary key default gen_random_uuid (),
  full_name text not null,
  display_name text not null default '',
  party_kind text,
  visibility_public boolean not null default true,
  contact_email text,
  contact_phone text,
  discord_or_other text,
  contact_notes text,
  internal_notes text,
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  constraint owner_parties_party_kind_chk check (
    party_kind is null
    or lower(party_kind) in ('person', 'organization', 'club', 'operator')
  )
);

comment on table public.owner_parties is 'Canonical owner/lender/operator contacts; games reference via party_id.';

drop trigger if exists trg_owner_parties_set_updated_at on public.owner_parties;
create trigger trg_owner_parties_set_updated_at
before update on public.owner_parties
for each row execute function public.set_games_catalog_updated_at ();

alter table public.games
  add column if not exists party_id uuid references public.owner_parties (id) on delete set null,
  add column if not exists party_relationship_public text,
  add column if not exists hide_owner_public boolean not null default false;

create index if not exists games_party_id_idx on public.games (party_id);

comment on column public.games.party_id is 'Optional FK to owner_parties; contact data lives on party row.';
comment on column public.games.party_relationship_public is 'Short public label for More Info (e.g. Owner, Lender).';
comment on column public.games.hide_owner_public is 'When true, omit owner/party line from public More Info for this game.';

alter table public.owner_parties enable row level security;

-- ---------------------------------------------------------------------------
-- RPCs: owner_parties (games_editor+)
-- ---------------------------------------------------------------------------

create or replace function public.snh_owner_parties_list ()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.snh_member_has_games_access (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'fullName', p.full_name,
          'displayName', p.display_name,
          'partyKind', p.party_kind,
          'visibilityPublic', p.visibility_public,
          'contactEmail', p.contact_email,
          'contactPhone', p.contact_phone,
          'discordOrOther', p.discord_or_other,
          'contactNotes', p.contact_notes,
          'internalNotes', p.internal_notes
        )
        order by lower(p.full_name), p.id
      )
      from public.owner_parties p
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.snh_owner_parties_list () from public;
grant execute on function public.snh_owner_parties_list () to authenticated;

create or replace function public.snh_owner_parties_upsert (p_id uuid, p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full text;
  v_display text;
  v_kind text;
  v_vis boolean;
  v_old jsonb;
  v_new_id uuid;
begin
  if not coalesce(public.snh_member_has_games_access (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_full := nullif(trim(p_fields->>'fullName'), '');
  if v_full is null then
    raise exception 'fullName required' using errcode = '22023';
  end if;

  v_display := coalesce(nullif(trim(p_fields->>'displayName'), ''), v_full);
  v_kind := nullif(lower(trim(p_fields->>'partyKind')), '');
  if v_kind is not null and v_kind not in ('person', 'organization', 'club', 'operator') then
    raise exception 'invalid partyKind' using errcode = '22023';
  end if;

  v_vis := coalesce((p_fields->>'visibilityPublic')::boolean, true);

  if p_id is null then
    insert into public.owner_parties (
      full_name,
      display_name,
      party_kind,
      visibility_public,
      contact_email,
      contact_phone,
      discord_or_other,
      contact_notes,
      internal_notes
    )
    values (
      v_full,
      v_display,
      v_kind,
      v_vis,
      nullif(trim(p_fields->>'contactEmail'), ''),
      nullif(trim(p_fields->>'contactPhone'), ''),
      nullif(trim(p_fields->>'discordOrOther'), ''),
      nullif(trim(p_fields->>'contactNotes'), ''),
      nullif(trim(p_fields->>'internalNotes'), '')
    )
    returning id into v_new_id;

    perform private.snh_audit_game(
      'insert',
      'owner_party',
      v_new_id::text,
      '{}'::jsonb,
      jsonb_build_object('fullName', v_full, 'displayName', v_display),
      '{}'::jsonb
    );

    return v_new_id;
  end if;

  select to_jsonb(p.*)
    into v_old
  from public.owner_parties p
  where p.id = p_id;

  if v_old is null then
    raise exception 'party not found' using errcode = 'P0002';
  end if;

  update public.owner_parties p
  set
    full_name = v_full,
    display_name = case
      when p_fields ? 'displayName' then coalesce(nullif(trim(p_fields->>'displayName'), ''), v_full)
      else p.display_name
    end,
    party_kind = case when p_fields ? 'partyKind' then v_kind else p.party_kind end,
    visibility_public = case when p_fields ? 'visibilityPublic' then v_vis else p.visibility_public end,
    contact_email = case when p_fields ? 'contactEmail' then nullif(trim(p_fields->>'contactEmail'), '') else p.contact_email end,
    contact_phone = case when p_fields ? 'contactPhone' then nullif(trim(p_fields->>'contactPhone'), '') else p.contact_phone end,
    discord_or_other = case when p_fields ? 'discordOrOther' then nullif(trim(p_fields->>'discordOrOther'), '') else p.discord_or_other end,
    contact_notes = case when p_fields ? 'contactNotes' then nullif(trim(p_fields->>'contactNotes'), '') else p.contact_notes end,
    internal_notes = case when p_fields ? 'internalNotes' then nullif(trim(p_fields->>'internalNotes'), '') else p.internal_notes end
  where p.id = p_id;

  perform private.snh_audit_game(
    'update',
    'owner_party',
    p_id::text,
    v_old,
    (select to_jsonb(op.*) from public.owner_parties op where op.id = p_id),
    '{}'::jsonb
  );

  return p_id;
end;
$$;

revoke all on function public.snh_owner_parties_upsert (uuid, jsonb) from public;
grant execute on function public.snh_owner_parties_upsert (uuid, jsonb) to authenticated;

create or replace function public.snh_owner_parties_delete (p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_games_admin_access (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(p.*)
    into v_old
  from public.owner_parties p
  where p.id = p_id;

  if v_old is null then
    return;
  end if;

  delete from public.owner_parties p where p.id = p_id;

  perform private.snh_audit_game(
    'delete',
    'owner_party',
    p_id::text,
    v_old,
    '{}'::jsonb,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_owner_parties_delete (uuid) from public;
grant execute on function public.snh_owner_parties_delete (uuid) to authenticated;

create or replace function public.snh_games_set_party_link (
  p_game_id uuid,
  p_party_id uuid,
  p_party_relationship_public text,
  p_hide_owner_public boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_rel text;
begin
  if not coalesce(public.snh_member_has_games_access (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform private.snh_require_game_editable(p_game_id);

  select to_jsonb(g.*)
    into v_old
  from public.games g
  where g.id = p_game_id;

  if v_old is null then
    raise exception 'game not found' using errcode = 'P0002';
  end if;

  if p_party_id is not null and not exists (select 1 from public.owner_parties p where p.id = p_party_id) then
    raise exception 'party not found' using errcode = 'P0002';
  end if;

  v_rel := nullif(trim(p_party_relationship_public), '');

  update public.games g
  set
    party_id = p_party_id,
    party_relationship_public = v_rel,
    hide_owner_public = coalesce(p_hide_owner_public, hide_owner_public)
  where g.id = p_game_id;

  perform private.snh_audit_game(
    'update',
    'game_party_link',
    p_game_id::text,
    jsonb_build_object(
      'partyId', v_old->>'party_id',
      'partyRelationshipPublic', v_old->>'party_relationship_public',
      'hideOwnerPublic', v_old->>'hide_owner_public'
    ),
    jsonb_build_object(
      'partyId', p_party_id,
      'partyRelationshipPublic', v_rel,
      'hideOwnerPublic', coalesce(p_hide_owner_public, (v_old->>'hide_owner_public')::boolean)
    ),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_games_set_party_link (uuid, uuid, text, boolean) from public;
grant execute on function public.snh_games_set_party_link (uuid, uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Editor load: include party link fields on each game
-- ---------------------------------------------------------------------------

create or replace function public.snh_games_editor_load ()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not coalesce(public.snh_member_has_games_access (), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'games',
    coalesce(
      (
        select jsonb_agg(r.obj order by r.is_deleted, r.title_sort)
        from (
          select
            lower(trim(g.title)) as title_sort,
            (g.deleted_at is not null) as is_deleted,
            jsonb_build_object(
              'id', g.id,
              'slug', g.slug,
              'title', g.title,
              'details', g.details,
              'imageFilename', g.image_filename,
              'releaseDate', to_char(g.release_date, 'YYYY-MM-DD'),
              'manufactureDate', to_char(g.manufacture_date, 'YYYY-MM-DD'),
              'manufacturer', g.manufacturer,
              'manufacturerFullName', g.manufacturer_full_name,
              'type', g.machine_type,
              'display', g.display_type,
              'playerCount', g.player_count,
              'pinsideUrl', g.pinside_url,
              'ipdbUrl', g.ipdb_url,
              'kineticistUrl', g.kineticist_url,
              'opdbId', g.opdb_id,
              'opdbMatchedVia', g.opdb_matched_via,
              'opdbCanonicalName', g.opdb_canonical_name,
              'mapAtClub', g.map_at_club,
              'manualAtClubOverride', g.manual_at_club_override,
              'manualAtClubNote', g.manual_at_club_note,
              'deletedAt', to_char(g.deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'deletedBy', g.deleted_by,
              'deleteNote', g.delete_note,
              'partyId', g.party_id,
              'partyRelationshipPublic', g.party_relationship_public,
              'hideOwnerPublic', g.hide_owner_public,
              'locationStints', (
                select coalesce(
                  jsonb_agg(
                    jsonb_strip_nulls(
                      jsonb_build_object(
                        'id', s.id,
                        'address', s.address,
                        'pinballMapLocationId', s.pinball_map_location_id,
                        'pinballMapMachineId', s.pinball_map_machine_id,
                        'joinedClubDate', to_char(s.joined_club_date, 'YYYY-MM-DD'),
                        'leftClubDate', to_char(s.left_club_date, 'YYYY-MM-DD'),
                        'dateUnknown', s.date_unknown
                      )
                    )
                    order by s.joined_club_date nulls last, s.id
                  ),
                  '[]'::jsonb
                )
                from public.game_location_stints s
                where s.game_id = g.id
              )
            ) as obj
          from public.games g
        ) r
      ),
      '[]'::jsonb
    )
  )
  into v_payload;

  return v_payload;
end;
$$;

revoke all on function public.snh_games_editor_load () from public;
grant execute on function public.snh_games_editor_load () to authenticated;

-- ---------------------------------------------------------------------------
-- Public More Info: partySummaries (display_name + relationship only)
-- ---------------------------------------------------------------------------

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
  v_feat uuid;
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

  select s.id into v_feat
  from public.pingolf_sessions s
  where s.is_featured
  limit 1;

  if v_feat is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'description', t.description,
          'targetValue', t.target_value,
          'sortOrder', t.sort_order
        )
        order by t.sort_order, t.description
      ),
      '[]'::jsonb
    )
    into v_pingolf
    from public.pingolf_targets t
    where t.session_id = v_feat and t.game_id = p_game_id;
  else
    v_pingolf := '[]'::jsonb;
  end if;

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
