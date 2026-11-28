begin;

-- Tentative plans are deliberately independent of catalog presence and loan history.
create table private.game_rotation_plans (
  id uuid primary key default gen_random_uuid(),
  incoming_cabinet_id uuid references private.game_cabinets(id) on delete restrict,
  outgoing_cabinet_id uuid references private.game_cabinets(id) on delete restrict,
  arrival_on date,
  departure_on date,
  note text check (char_length(note) <= 4000),
  created_at timestamptz not null default now(),
  canceled_at timestamptz,
  check (incoming_cabinet_id is not null or outgoing_cabinet_id is not null),
  check (incoming_cabinet_id <> outgoing_cabinet_id),
  check (incoming_cabinet_id is not null or arrival_on is null),
  check (outgoing_cabinet_id is not null or departure_on is null)
);
create unique index game_rotation_one_planned_arrival
  on private.game_rotation_plans (incoming_cabinet_id) where canceled_at is null;
create unique index game_rotation_one_planned_departure
  on private.game_rotation_plans (outgoing_cabinet_id) where canceled_at is null;
alter table private.game_rotation_plans enable row level security;
revoke all on private.game_rotation_plans from public, anon, authenticated;

create function private.snh_require_game_coordinator()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.snh_account_exists()
    or not public.snh_member_has_effective_role('game_coordinator') then
    raise exception 'Game Coordinator access is required' using errcode = '42501';
  end if;
end;
$$;

create function public.snh_rotation_workspace()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.snh_game_rotation_can_read() then
    raise exception 'Game Rotation access is required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cabinets', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'title', g.title)
                       order by g.title, c.label, c.id)
      from private.game_cabinets c join public.games g on g.id = c.game_id
    ), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.canceled_at nulls first, p.created_at desc, p.id)
      from private.game_rotation_plans p
    ), '[]'::jsonb)
  );
end;
$$;

create function public.snh_register_game_cabinet(p_game_id uuid, p_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.snh_require_game_coordinator();
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120
    or not exists (select 1 from public.games where id = p_game_id and deleted_at is null) then
    raise exception 'Choose a catalog game and enter a cabinet label' using errcode = '22023';
  end if;

  -- Serialize registration for a title so retries cannot create a duplicate label.
  perform 1 from public.games where id = p_game_id and deleted_at is null for update;
  if not found then raise exception 'Catalog game is unavailable' using errcode = '22023'; end if;
  select id into v_id from private.game_cabinets
  where game_id = p_game_id and lower(btrim(label)) = lower(btrim(p_label))
  order by created_at, id limit 1;
  if found then return v_id; end if;

  insert into private.game_cabinets(game_id, label) values (p_game_id, btrim(p_label)) returning id into v_id;
  insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id)
  values ('games', 'create', auth.uid(), 'game_cabinet', v_id::text);
  return v_id;
end;
$$;

create function public.snh_save_rotation_plan(
  p_id uuid, p_incoming uuid, p_outgoing uuid, p_arrival date, p_departure date, p_note text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.snh_require_game_coordinator();
  if p_id is null then
    insert into private.game_rotation_plans(incoming_cabinet_id, outgoing_cabinet_id, arrival_on, departure_on, note)
    values (p_incoming, p_outgoing, p_arrival, p_departure, p_note) returning id into v_id;
  else
    update private.game_rotation_plans
    set incoming_cabinet_id = p_incoming, outgoing_cabinet_id = p_outgoing,
        arrival_on = p_arrival, departure_on = p_departure, note = p_note
    where id = p_id and canceled_at is null returning id into v_id;
    if not found then raise exception 'Rotation plan is unavailable' using errcode = '22023'; end if;
  end if;
  insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id)
  values ('games', case when p_id is null then 'create' else 'update' end, auth.uid(), 'game_rotation_plan', v_id::text);
  return v_id;
end;
$$;

create function public.snh_cancel_rotation_plan(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.snh_require_game_coordinator();
  update private.game_rotation_plans set canceled_at = now()
  where id = p_id and canceled_at is null;
  if found then
    insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id)
    values ('games', 'cancel', auth.uid(), 'game_rotation_plan', p_id::text);
  end if;
end;
$$;

revoke all on function private.snh_require_game_coordinator() from public, anon, authenticated;
revoke all on function public.snh_rotation_workspace(), public.snh_register_game_cabinet(uuid, text),
  public.snh_save_rotation_plan(uuid, uuid, uuid, date, date, text), public.snh_cancel_rotation_plan(uuid)
  from public, anon, authenticated;
grant execute on function public.snh_rotation_workspace(), public.snh_register_game_cabinet(uuid, text),
  public.snh_save_rotation_plan(uuid, uuid, uuid, date, date, text), public.snh_cancel_rotation_plan(uuid)
  to authenticated;

commit;
