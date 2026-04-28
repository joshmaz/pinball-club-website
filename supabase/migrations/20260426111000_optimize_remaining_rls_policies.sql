-- Optimize remaining RLS policies to use initplan-friendly auth lookup.

drop policy if exists "Members can read own member_roles" on public.member_roles;
create policy "Members can read own member_roles"
  on public.member_roles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.members m
      where m.id = member_roles.member_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "Members can view own memberships" on public.memberships;
create policy "Members can view own memberships"
  on public.memberships
  for select
  to public
  using (
    exists (
      select 1
      from public.members m
      where m.id = memberships.member_id
        and m.user_id = (select auth.uid())
    )
  );
