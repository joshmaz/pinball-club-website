-- Restrict event deletion to events_admin and club_admin.
-- events_editor retains read/create/update access only.
drop policy if exists events_managers_write on public.events;
drop policy if exists events_managers_insert on public.events;
drop policy if exists events_managers_update on public.events;
drop policy if exists events_admin_delete on public.events;

create policy events_managers_insert
  on public.events
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = (select auth.uid())
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    )
  );

create policy events_managers_update
  on public.events
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = (select auth.uid())
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    )
  )
  with check (
    exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = (select auth.uid())
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    )
  );

create policy events_admin_delete
  on public.events
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = (select auth.uid())
        and mr.role_slug in ('events_admin', 'club_admin')
    )
  );
