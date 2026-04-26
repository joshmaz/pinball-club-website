-- Normalize events grants + RLS policies so public events are visible.

grant select on public.events to anon, authenticated;
grant insert, update, delete on public.events to authenticated;

alter table public.events enable row level security;

drop policy if exists events_public_read_published on public.events;
drop policy if exists events_managers_read_all on public.events;
drop policy if exists events_managers_write on public.events;

create policy events_public_read_published
  on public.events
  for select
  to anon, authenticated
  using (coalesce(published, true) = true);

create policy events_managers_read_all
  on public.events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = (select auth.uid())
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    )
  );

create policy events_managers_write
  on public.events
  for all
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
