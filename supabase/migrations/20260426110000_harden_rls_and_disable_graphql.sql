-- Security/performance hardening:
-- 1) Disable pg_graphql (not used by this project).
-- 2) Set explicit search_path on trigger function.
-- 3) Normalize RLS policies to (select auth.uid()) pattern and remove duplicates.

drop extension if exists pg_graphql;

create or replace function public.set_external_accounts_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Remove duplicate/legacy members SELECT policy and rebuild members policies.
drop policy if exists "Users can view their own profile" on public.members;
drop policy if exists "Members can view own member row" on public.members;
drop policy if exists "Members can insert own member row" on public.members;
drop policy if exists "Members can update own member row" on public.members;

create policy "Members can view own member row"
on public.members
for select
to public
using (user_id = (select auth.uid()));

create policy "Members can insert own member row"
on public.members
for insert
to public
with check (user_id = (select auth.uid()));

create policy "Members can update own member row"
on public.members
for update
to public
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Rebuild external_accounts policies using initplan-friendly auth.uid() form.
drop policy if exists "No access to external_accounts" on public.external_accounts;
drop policy if exists "external_accounts_select_own" on public.external_accounts;
drop policy if exists "external_accounts_insert_own" on public.external_accounts;
drop policy if exists "external_accounts_update_own" on public.external_accounts;
drop policy if exists "external_accounts_delete_own" on public.external_accounts;

create policy "external_accounts_select_own"
on public.external_accounts
for select
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = (select auth.uid())
  )
);

create policy "external_accounts_insert_own"
on public.external_accounts
for insert
to authenticated
with check (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = (select auth.uid())
  )
);

create policy "external_accounts_update_own"
on public.external_accounts
for update
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = (select auth.uid())
  )
);

create policy "external_accounts_delete_own"
on public.external_accounts
for delete
to authenticated
using (
  exists (
    select 1
    from public.members m
    where m.id = external_accounts.member_id
      and m.user_id = (select auth.uid())
  )
);
