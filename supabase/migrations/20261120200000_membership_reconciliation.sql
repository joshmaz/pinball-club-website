create table private.dues_payers (
  email text primary key,
  member_id uuid references public.members(id) on delete cascade,
  roster_name text,
  last_received date,
  coverage_through date,
  review_enabled boolean not null default false,
  check (member_id is not null or roster_name is not null)
);

create table private.dues_review (
  payer_email text primary key,
  note text not null,
  updated_at timestamptz not null default now()
);

create table private.dues_receipts (
  payer_email text not null references private.dues_payers(email) on delete cascade,
  received timestamp not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  primary key (payer_email, received)
);
create index dues_receipts_received on private.dues_receipts(received);

revoke all on private.dues_payers, private.dues_review, private.dues_receipts from public, anon, authenticated;
alter table private.dues_payers enable row level security;
alter table private.dues_review enable row level security;
alter table private.dues_receipts enable row level security;

create function public.snh_reconcile_dues(
  p_action text,
  p_email text default null,
  p_dates timestamp[] default '{}',
  p_member uuid default null,
  p_name text default null,
  p_note text default null,
  p_coverage date default null,
  p_review_enabled boolean default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  payer text := lower(btrim(p_email));
  saved private.dues_payers;
  receipts jsonb;
  added integer;
begin
  if not public.snh_member_has_effective_role('membership_admin') then
    raise exception 'Membership administrator access required' using errcode = '42501';
  end if;

  if p_action = 'load' then
    return jsonb_build_object(
      'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id,
        'name', coalesce(nullif(m.display_name, ''), nullif(concat_ws(' ', m.first_name, m.last_name), ''), u.email, 'Unnamed member'),
        'verifiedEmail', case when u.email_confirmed_at is not null then lower(btrim(u.email)) end
      )), '[]') from public.members m left join auth.users u on u.id = m.user_id),
      'payers', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from private.dues_payers p),
      'holds', (select coalesce(jsonb_object_agg(payer_email, note), '{}') from private.dues_review),
      'receipts', (select coalesce(jsonb_object_agg(payer_email, dates), '{}') from (
        select payer_email, jsonb_agg(received order by received) dates
        from private.dues_receipts group by payer_email
      ) r)
    );
  end if;

  if payer is null or length(payer) > 254 or payer !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'A valid payer email is required';
  end if;

  -- Serialize imports and retention so two operators cannot bypass the cap or overwrite a link.
  perform pg_catalog.pg_advisory_xact_lock(73618021);
  select * into saved from private.dues_payers where email = payer;

  if p_action = 'hold' then
    if nullif(btrim(p_note), '') is null or length(p_note) > 500 then
      raise exception 'Enter a review note of 1 to 500 characters';
    end if;
    if not exists (select 1 from private.dues_review where payer_email = payer)
       and (select count(*) from private.dues_review) >= 2000 then
      raise exception 'Review queue limit reached. Resolve existing notes first.';
    end if;
    insert into private.dues_review(payer_email, note) values (payer, btrim(p_note))
    on conflict (payer_email) do update set note = excluded.note, updated_at = now();
    return '{}'::jsonb;
  end if;

  if p_action = 'review_setting' then
    if p_coverage > current_date then
      raise exception 'Enter a coverage date on or before today';
    end if;
    update private.dues_payers
      set coverage_through = p_coverage, review_enabled = coalesce(p_review_enabled, false)
      where email = payer;
    return '{}'::jsonb;
  end if;

  if p_action = 'relink' then
    if saved.email is null or p_member is null then
      raise exception 'Choose an existing payer and website member';
    end if;
    update private.dues_payers set member_id = p_member, roster_name = null,
      review_enabled = false, coverage_through = null where email = payer;
    return '{}'::jsonb;
  end if;

  if p_action <> 'apply' or p_action is null then
    raise exception 'Unknown reconciliation action';
  end if;
  if coalesce(cardinality(p_dates), 0) not between 1 and 1000
    or exists (select from unnest(p_dates) d where d is null or not isfinite(d)
      or d::date > current_date or d::date < (current_date - interval '13 months')::date) then
    raise exception 'Payment dates must be within the last 13 months';
  end if;
  if saved.member_id is not null and saved.member_id is distinct from p_member then
    raise exception 'This payer is already linked. Refresh the review before continuing.';
  end if;
  if p_member is null and (nullif(btrim(coalesce(saved.roster_name, p_name)), '') is null or length(p_name) > 150) then
    raise exception 'Select a member or enter the name of the person who needs an account';
  end if;
  if saved.email is null and (select count(*) from private.dues_payers) >= 2000 then
    raise exception 'Payer limit reached';
  end if;

  insert into private.dues_payers(email, member_id, roster_name, last_received, review_enabled)
  values (payer, p_member, case when p_member is null then btrim(p_name) end,
    (select max(d)::date from unnest(p_dates) d), coalesce(p_review_enabled, false))
  on conflict (email) do update set member_id = coalesce(dues_payers.member_id, excluded.member_id),
    roster_name = case when excluded.member_id is null then dues_payers.roster_name end,
    last_received = greatest(dues_payers.last_received, excluded.last_received),
    review_enabled = coalesce(p_review_enabled, dues_payers.review_enabled);

  insert into private.dues_receipts(payer_email, received, approved_by)
  select payer, d, auth.uid() from unnest(p_dates) d
  on conflict do nothing;
  get diagnostics added = row_count;

  if (select count(*) from private.dues_receipts) > 30000 then
    raise exception 'Payment history limit reached. Ask an administrator to check retention.';
  end if;
  delete from private.dues_review where payer_email = payer;
  select jsonb_agg(received order by received) into receipts from private.dues_receipts where payer_email = payer;
  return jsonb_build_object('added', added, 'receipts', receipts);
end;
$$;

revoke all on function public.snh_reconcile_dues(text,text,timestamp[],uuid,text,text,date,boolean) from public, anon, authenticated;
grant execute on function public.snh_reconcile_dues(text,text,timestamp[],uuid,text,text,date,boolean) to authenticated;

select cron.schedule('snh-dues-reconciliation-retention', '25 9 1 * *', $retention$
  begin;
  select pg_catalog.pg_advisory_xact_lock(73618021);
  delete from private.dues_receipts where received < (current_date - interval '13 months')::date;
  delete from private.dues_review where updated_at < now() - interval '13 months';
  commit;
$retention$);
