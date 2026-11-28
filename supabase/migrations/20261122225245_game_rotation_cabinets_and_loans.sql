-- Private cabinet and loan identities. Public game and stint readers and writers
-- stay on their existing paths until cabinet reconciliation is implemented.
create table private.game_cabinets (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete restrict,
  label text not null check (btrim(label) <> ''),
  owner_party_id uuid references public.owner_parties(id) on delete set null,
  created_at timestamptz not null default now()
);

create index game_cabinets_game_id_idx on private.game_cabinets (game_id);
create index game_cabinets_owner_party_id_idx on private.game_cabinets (owner_party_id);

create table private.game_loans (
  id uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references private.game_cabinets(id) on delete restrict,
  lender_party_id uuid not null references public.owner_parties(id) on delete restrict,
  terms text,
  started_on date,
  returned_on date,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint game_loans_return_requires_closure
    check (returned_on is null or closed_at is not null),
  constraint game_loans_dates_in_order
    check (returned_on >= started_on)
);

-- The return date can be unknown even when a coordinator has confirmed closure.
create unique index game_loans_one_open_per_cabinet
  on private.game_loans (cabinet_id) where closed_at is null;
create index game_loans_cabinet_id_idx on private.game_loans (cabinet_id);
create index game_loans_lender_party_id_idx on private.game_loans (lender_party_id);

alter table private.game_cabinets enable row level security;
alter table private.game_loans enable row level security;
revoke all on private.game_cabinets, private.game_loans from public, anon, authenticated;

comment on table private.game_cabinets is
  'Persistent physical units. Multiple cabinets may reference the same public game.';
comment on table private.game_loans is
  'Lender episodes for physical cabinets. Location stints independently track placement.';
