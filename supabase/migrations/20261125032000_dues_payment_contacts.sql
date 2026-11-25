create table private.dues_payment_contacts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
alter table private.dues_payment_contacts enable row level security;

create function public.snh_my_dues_payment_email(p_email text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  normalized text := lower(btrim(p_email));
begin
  if account_id is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if normalized = '' then
    delete from private.dues_payment_contacts where user_id = account_id;
  elsif normalized is not null then
    insert into private.dues_payment_contacts (user_id, email) values (account_id, normalized)
    on conflict (user_id) do update set email = excluded.email;
  end if;
  return (select email from private.dues_payment_contacts where user_id = account_id);
end;
$$;

create function public.snh_dues_payment_email_suggestions()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if public.snh_member_has_effective_role('membership_admin') is not true then
    raise exception 'Membership administrator access required' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_object_agg(m.id, c.email), '{}'::jsonb)
    from public.members m join private.dues_payment_contacts c on c.user_id = m.user_id);
end;
$$;

revoke all on function public.snh_my_dues_payment_email(text), public.snh_dues_payment_email_suggestions() from public, anon;
grant execute on function public.snh_my_dues_payment_email(text), public.snh_dues_payment_email_suggestions() to authenticated;
