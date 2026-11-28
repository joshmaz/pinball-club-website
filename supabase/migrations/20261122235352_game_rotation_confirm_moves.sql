begin;

-- Verified cabinet placements are kept apart from title-level Pinball Map
-- observations until the catalog reconciliation path can distinguish them.
create table private.game_cabinet_placements (
  id uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references private.game_cabinets(id) on delete restrict,
  loan_id uuid references private.game_loans(id) on delete restrict,
  location text not null check (char_length(btrim(location)) between 1 and 160),
  arrived_on date,
  departed_on date,
  arrival_confirmed_at timestamptz not null default now(),
  departure_confirmed_at timestamptz,
  check (departed_on is null or departure_confirmed_at is not null),
  check (arrived_on <= departed_on)
);
create unique index game_cabinet_one_open_placement
  on private.game_cabinet_placements(cabinet_id) where departure_confirmed_at is null;
create index game_cabinet_placements_cabinet_id_idx on private.game_cabinet_placements(cabinet_id);
alter table private.game_cabinet_placements enable row level security;
revoke all on private.game_cabinet_placements from public, anon, authenticated;

alter table private.game_rotation_plans
  add column arrival_placement_id uuid references private.game_cabinet_placements(id) on delete restrict,
  add column departure_placement_id uuid references private.game_cabinet_placements(id) on delete restrict,
  add check (arrival_placement_id is null or incoming_cabinet_id is not null),
  add check (departure_placement_id is null or outgoing_cabinet_id is not null);
drop index private.game_rotation_one_planned_arrival;
drop index private.game_rotation_one_planned_departure;
create unique index game_rotation_one_planned_arrival
  on private.game_rotation_plans(incoming_cabinet_id)
  where canceled_at is null and arrival_placement_id is null;
create unique index game_rotation_one_planned_departure
  on private.game_rotation_plans(outgoing_cabinet_id)
  where canceled_at is null and departure_placement_id is null;

create function private.snh_protect_confirmed_plan_sides()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.arrival_placement_id is not null and
      (new.incoming_cabinet_id, new.arrival_on, new.arrival_placement_id)
      is distinct from (old.incoming_cabinet_id, old.arrival_on, old.arrival_placement_id))
    or (old.departure_placement_id is not null and
      (new.outgoing_cabinet_id, new.departure_on, new.departure_placement_id)
      is distinct from (old.outgoing_cabinet_id, old.departure_on, old.departure_placement_id)) then
    raise exception 'A confirmed plan side cannot be edited' using errcode = '22023';
  end if;
  if new.canceled_at is distinct from old.canceled_at
    and (old.incoming_cabinet_id is null or old.arrival_placement_id is not null)
    and (old.outgoing_cabinet_id is null or old.departure_placement_id is not null) then
    raise exception 'A completed plan cannot be canceled' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.snh_protect_confirmed_plan_sides() from public, anon, authenticated;
create trigger snh_protect_confirmed_plan_sides before update on private.game_rotation_plans
  for each row execute function private.snh_protect_confirmed_plan_sides();

create function public.snh_confirm_rotation_move(
  p_plan uuid, p_direction text, p_observed_on date, p_location text, p_expected_cabinet uuid, p_expected_placement uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_plan private.game_rotation_plans;
  v_cabinet uuid;
  v_placement uuid;
  v_loan uuid;
begin
  perform private.snh_require_game_coordinator();
  if p_direction is null or p_direction not in ('arrival', 'departure') then
    raise exception 'Choose arrival or departure' using errcode = '22023';
  end if;

  select * into v_plan from private.game_rotation_plans where id = p_plan for update;
  if not found then raise exception 'Rotation plan is unavailable' using errcode = '22023'; end if;
  if p_direction = 'arrival' then
    v_cabinet := v_plan.incoming_cabinet_id;
    v_placement := v_plan.arrival_placement_id;
  else
    v_cabinet := v_plan.outgoing_cabinet_id;
    v_placement := v_plan.departure_placement_id;
  end if;
  if v_cabinet is distinct from p_expected_cabinet then
    raise exception 'The cabinet for this plan has changed' using errcode = '22023';
  end if;
  -- A retry returns the previously confirmed placement, including after a
  -- partial swap's unfinished side was canceled.
  if v_placement is not null then return v_placement; end if;
  if v_cabinet is null or v_plan.canceled_at is not null then
    raise exception 'This move is no longer pending' using errcode = '22023';
  end if;

  perform 1 from private.game_cabinets where id = v_cabinet for update;
  if p_direction = 'arrival' then
    if p_location is null or char_length(btrim(p_location)) not between 1 and 160 then
      raise exception 'Enter the placement location' using errcode = '22023';
    end if;
    select id into v_loan from private.game_loans where cabinet_id = v_cabinet and closed_at is null;
    insert into private.game_cabinet_placements(cabinet_id, loan_id, location, arrived_on)
    values (v_cabinet, v_loan, btrim(p_location), p_observed_on) returning id into v_placement;
    update private.game_rotation_plans set arrival_placement_id = v_placement where id = p_plan;
  else
    update private.game_cabinet_placements
    set departed_on = p_observed_on, departure_confirmed_at = now()
    where id = p_expected_placement and cabinet_id = v_cabinet and departure_confirmed_at is null
    returning id into v_placement;
    if not found then
      raise exception 'The selected placement is no longer open' using errcode = '22023';
    end if;
    update private.game_rotation_plans set departure_placement_id = v_placement where id = p_plan;
  end if;

  insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id, new_data)
  values ('games', 'confirm_' || p_direction, auth.uid(), 'game_cabinet_placement', v_placement::text,
          jsonb_build_object('plan_id', p_plan, 'observed_on', p_observed_on));
  return v_placement;
end;
$$;

create function public.snh_correct_cabinet_placement(
  p_id uuid, p_location text, p_arrived_on date, p_departed_on date, p_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old private.game_cabinet_placements;
begin
  if not public.snh_account_exists() or not public.snh_member_has_effective_role('games_admin') then
    raise exception 'Games Admin access is required' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 250 then
    raise exception 'Enter a correction reason (up to 250 characters)' using errcode = '22023';
  end if;
  select * into v_old from private.game_cabinet_placements where id = p_id for update;
  if not found then raise exception 'Placement is unavailable' using errcode = '22023'; end if;
  update private.game_cabinet_placements
  set location = btrim(p_location), arrived_on = p_arrived_on, departed_on = p_departed_on
  where id = p_id;
  insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata)
  values ('games', 'correct', auth.uid(), 'game_cabinet_placement', p_id::text,
    jsonb_build_object('location', v_old.location, 'arrived_on', v_old.arrived_on, 'departed_on', v_old.departed_on),
    jsonb_build_object('location', btrim(p_location), 'arrived_on', p_arrived_on, 'departed_on', p_departed_on),
    jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- Games Admins need placement history for corrections without access to private
-- offers, loan details, or coordinator notes.
create function public.snh_cabinet_placement_history()
returns table(id uuid, cabinet_id uuid, title text, label text, location text,
  arrived_on date, departed_on date, departure_confirmed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.snh_game_rotation_can_read()
    and not (public.snh_account_exists() and public.snh_member_has_effective_role('games_admin')) then
    raise exception 'Placement history access is required' using errcode = '42501';
  end if;
  return query
  select p.id, p.cabinet_id, g.title, c.label, p.location, p.arrived_on, p.departed_on, p.departure_confirmed_at
  from private.game_cabinet_placements p
  join private.game_cabinets c on c.id = p.cabinet_id
  join public.games g on g.id = c.game_id
  order by p.departure_confirmed_at nulls first, p.arrival_confirmed_at desc, p.id;
end;
$$;

revoke all on function public.snh_confirm_rotation_move(uuid, text, date, text, uuid, uuid),
  public.snh_correct_cabinet_placement(uuid, text, date, date, text), public.snh_cabinet_placement_history()
  from public, anon, authenticated;
grant execute on function public.snh_confirm_rotation_move(uuid, text, date, text, uuid, uuid),
  public.snh_correct_cabinet_placement(uuid, text, date, date, text), public.snh_cabinet_placement_history()
  to authenticated;

commit;
