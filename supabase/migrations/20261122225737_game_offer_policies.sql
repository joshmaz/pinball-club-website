begin;

alter table public.member_roles
  drop constraint member_roles_canonical_role,
  add constraint member_roles_canonical_role check (role_slug in (
    'club_admin', 'membership_editor', 'membership_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
    'games_editor', 'games_admin', 'publishing_editor', 'publishing_admin', 'game_coordinator'
  ));

create or replace function public.snh_is_assignable_member_role(p_role_slug text)
returns boolean language sql stable set search_path = public as $$
  select coalesce(btrim(lower(p_role_slug)), '') = any (array[
    'club_admin', 'membership_editor', 'membership_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin',
    'games_editor', 'games_admin', 'publishing_editor', 'publishing_admin', 'game_coordinator'
  ]::text[]);
$$;
revoke all on function public.snh_is_assignable_member_role(text) from public;
grant execute on function public.snh_is_assignable_member_role(text) to authenticated;

-- The public caller-scoped helper delegates to this existing private predicate.
-- Update that one hierarchy so Auth, notifications, and volunteer statistics
-- recognize the new assignments consistently.
create or replace function private.snh_member_has_effective_role(p_member_id uuid, p_required_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive role_catalog(role_slug, inherited_by) as (
    values
      ('club_admin'::text, null::text),
      ('membership_admin', 'club_admin'),
      ('membership_editor', 'membership_admin'),
      ('events_admin', 'club_admin'),
      ('events_editor', 'events_admin'),
      ('photos_admin', 'club_admin'),
      ('photos_editor', 'photos_admin'),
      ('games_admin', 'club_admin'),
      ('games_editor', 'games_admin'),
      ('publishing_admin', 'club_admin'),
      ('publishing_editor', 'publishing_admin'),
      ('game_coordinator', 'club_admin')
  ), effective_roles(role_slug) as (
    select catalog.role_slug
    from public.members m
    join public.member_roles assignment on assignment.member_id=m.id
    join role_catalog catalog on catalog.role_slug=assignment.role_slug
    where m.id=p_member_id
    union
    select catalog.role_slug from effective_roles superior
    join role_catalog catalog on catalog.inherited_by=superior.role_slug
  )
  select exists (
    select 1 from effective_roles effective
    where effective.role_slug=p_required_role or p_required_role='website_volunteer'
  );
$$;
revoke all on function private.snh_member_has_effective_role(uuid,text)
  from public,anon,authenticated,service_role;


-- Live Auth eligibility is independent of dues and domain roles.
create function public.snh_game_offer_eligible()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and u.deleted_at is null and not u.is_anonymous
      and (u.banned_until is null or u.banned_until <= now())
  );
$$;

create function private.snh_game_rotation_can_read()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.snh_account_exists() and (
    public.snh_member_has_effective_role('game_coordinator') or exists (
      select 1 from public.members
      where user_id = auth.uid() and club_designation = 'board'
    )
  );
$$;

create table private.game_offers (
  id uuid primary key default gen_random_uuid(),
  submitter_user_id uuid references auth.users(id) on delete set null,
  game_id uuid references public.games(id) on delete set null,
  cabinet_id uuid references private.game_cabinets(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  condition text check (char_length(condition) <= 2000),
  availability text check (char_length(availability) <= 1000),
  loan_terms text check (char_length(loan_terms) <= 1000),
  transport text check (char_length(transport) <= 2000),
  coordinator_note text check (char_length(coordinator_note) <= 4000),
  published_title text check (char_length(btrim(published_title)) between 1 and 160),
  published_summary text check (char_length(published_summary) <= 1000),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text check (close_reason in ('withdrawn', 'declined', 'account_deleted')),
  preservation_required boolean not null default false,
  check ((closed_at is null) = (close_reason is null)),
  check ((published_title is null) = (published_summary is null)),
  check (published_title is null or (closed_at is null and submitter_user_id is not null))
);
create index game_offers_submitter_idx on private.game_offers (submitter_user_id);
create index game_offers_closed_idx on private.game_offers (closed_at) where not preservation_required;

create table private.game_offer_interest (
  offer_id uuid not null references private.game_offers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (offer_id, user_id)
);
create index game_offer_interest_user_idx on private.game_offer_interest (user_id);

alter table private.game_offers enable row level security;
alter table private.game_offer_interest enable row level security;
revoke all on private.game_offers, private.game_offer_interest from public, anon, authenticated;

-- The optional account link is attribution only. The independent lender party
-- remains the contact record. Keep free-form contact data out of loan terms.
alter table private.game_loans
  add column lender_user_id uuid references auth.users(id) on delete set null,
  add column return_follow_up boolean not null default false;
create index game_loans_lender_user_idx on private.game_loans (lender_user_id);

create function public.snh_save_game_offer(
  p_id uuid, p_game_id uuid, p_title text, p_condition text,
  p_availability text, p_loan_terms text, p_transport text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.snh_game_offer_eligible() then
    raise exception 'An active email-confirmed account is required' using errcode = '42501';
  end if;
  if p_game_id is not null and not exists (
    select 1 from public.games where id = p_game_id and deleted_at is null
  ) then
    raise exception 'Unknown catalog game' using errcode = '22023';
  end if;

  if p_id is null then
    insert into private.game_offers (submitter_user_id, game_id, title, condition, availability, loan_terms, transport)
    values (auth.uid(), p_game_id, btrim(p_title), p_condition, p_availability, p_loan_terms, p_transport)
    returning id into v_id;
  else
    update private.game_offers
    set game_id = p_game_id, title = btrim(p_title), condition = p_condition,
      availability = p_availability, loan_terms = p_loan_terms, transport = p_transport,
      published_title = null, published_summary = null
    where id = p_id and submitter_user_id = auth.uid() and closed_at is null
    returning id into v_id;
    if not found then
      raise exception 'Offer is unavailable' using errcode = '42501';
    end if;
  end if;
  insert into public.audit_log (module, action, actor_user_id, entity_type, entity_id)
  values ('games', case when p_id is null then 'create' else 'update' end,
    auth.uid(), 'game_offer', v_id::text);
  return v_id;
end;
$$;

create function public.snh_withdraw_game_offer(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.snh_game_offer_eligible() then
    raise exception 'An active email-confirmed account is required' using errcode = '42501';
  end if;
  update private.game_offers
  set closed_at = now(), close_reason = 'withdrawn', published_title = null, published_summary = null
  where id = p_id and submitter_user_id = auth.uid() and closed_at is null;
  if not found then raise exception 'Offer is unavailable' using errcode = '42501'; end if;
  insert into public.audit_log (module, action, actor_user_id, entity_type, entity_id)
  values ('games', 'withdraw', auth.uid(), 'game_offer', p_id::text);
end;
$$;

create function public.snh_review_game_offer(
  p_id uuid, p_action text, p_title text, p_summary text, p_note text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.snh_account_exists() or not public.snh_member_has_effective_role('game_coordinator') then
    raise exception 'Game Coordinator access is required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('publish', 'unpublish', 'decline')
    or (p_action = 'publish' and (p_title is null or p_summary is null)) then
    raise exception 'Invalid review action' using errcode = '22023';
  end if;
  update private.game_offers
  set coordinator_note = p_note,
    published_title = case when p_action = 'publish' then btrim(p_title) end,
    published_summary = case when p_action = 'publish' then p_summary end,
    closed_at = case when p_action = 'decline' then now() end,
    close_reason = case when p_action = 'decline' then 'declined' end
  where id = p_id and closed_at is null and submitter_user_id is not null;
  if not found then raise exception 'Offer is unavailable' using errcode = '42501'; end if;
  insert into public.audit_log (module, action, actor_user_id, entity_type, entity_id)
  values ('games', p_action, auth.uid(), 'game_offer', p_id::text);
end;
$$;

create function public.snh_my_game_offers()
returns table (id uuid, game_id uuid, title text, condition text, availability text,
  loan_terms text, transport text, created_at timestamptz, close_reason text, published boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, o.game_id, o.title, o.condition, o.availability, o.loan_terms,
    o.transport, o.created_at, o.close_reason, o.published_title is not null
  from private.game_offers o
  where o.submitter_user_id = auth.uid() and public.snh_game_offer_eligible()
  order by o.created_at desc, o.id;
$$;

create function public.snh_published_game_offers()
returns table (id uuid, title text, summary text, interested boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, o.published_title, o.published_summary, exists (
    select 1 from private.game_offer_interest i where i.offer_id = o.id and i.user_id = auth.uid()
  )
  from private.game_offers o
  where o.published_title is not null and public.snh_game_offer_eligible()
  order by o.created_at desc, o.id;
$$;

create function public.snh_rotation_game_offers()
returns setof jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(o) from private.game_offers o
  where private.snh_game_rotation_can_read()
  order by o.created_at desc, o.id;
$$;

create function public.snh_set_game_offer_interest(p_id uuid, p_interested boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.snh_game_offer_eligible() then
    raise exception 'An active email-confirmed account is required' using errcode = '42501';
  end if;
  if p_interested then
    -- Match account deletion's lock order before taking the offer lock.
    perform 1 from auth.users where id = auth.uid() for key share;
    if not found then raise exception 'Account is unavailable' using errcode = '42501'; end if;
    perform 1 from private.game_offers where id = p_id and published_title is not null for share;
    if not found then raise exception 'Offer is unavailable' using errcode = '42501'; end if;
    insert into private.game_offer_interest (offer_id, user_id) values (p_id, auth.uid())
      on conflict do nothing;
  else
    delete from private.game_offer_interest where offer_id = p_id and user_id = auth.uid();
  end if;
end;
$$;

revoke all on function private.snh_game_rotation_can_read() from public, anon, authenticated;
revoke all on function public.snh_game_offer_eligible(), public.snh_my_game_offers(),
  public.snh_published_game_offers(), public.snh_rotation_game_offers(),
  public.snh_save_game_offer(uuid, uuid, text, text, text, text, text),
  public.snh_review_game_offer(uuid, text, text, text, text),
  public.snh_withdraw_game_offer(uuid), public.snh_set_game_offer_interest(uuid, boolean)
from public, anon, authenticated;
grant execute on function public.snh_game_offer_eligible(), public.snh_my_game_offers(),
  public.snh_published_game_offers(), public.snh_rotation_game_offers(),
  public.snh_save_game_offer(uuid, uuid, text, text, text, text, text),
  public.snh_review_game_offer(uuid, text, text, text, text),
  public.snh_withdraw_game_offer(uuid), public.snh_set_game_offer_interest(uuid, boolean)
to authenticated;

create function private.snh_game_rotation_account_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update private.game_offers
  set submitter_user_id = null, published_title = null, published_summary = null,
    title = case when preservation_required then title else 'Offer from deleted account' end,
    condition = case when preservation_required then condition end,
    availability = case when preservation_required then availability end,
    loan_terms = case when preservation_required then loan_terms end,
    transport = case when preservation_required then transport end,
    coordinator_note = case when preservation_required then coordinator_note end,
    closed_at = coalesce(closed_at, now()), close_reason = coalesce(close_reason, 'account_deleted')
  where submitter_user_id = old.id;

  update private.game_loans
  set lender_user_id = null, return_follow_up = return_follow_up or closed_at is null,
    terms = null
  where lender_user_id = old.id;
  -- Interest is account-specific and is removed by its Auth FK.
  return old;
end;
$$;
revoke all on function private.snh_game_rotation_account_deletion() from public, anon, authenticated;
create trigger snh_game_rotation_account_deletion
  before delete on auth.users
  for each row execute function private.snh_game_rotation_account_deletion();

-- Sweep ahead of the 12-month limit so the daily run does not wait until after
-- the deadline. A database operator can record an applicable preservation hold.
select cron.schedule(
  'snh-game-offer-retention-daily', '25 3 * * *',
  $job$delete from private.game_offers
    where closed_at <= now() + interval '1 day' - interval '12 months'
      and not preservation_required$job$
);
commit;
