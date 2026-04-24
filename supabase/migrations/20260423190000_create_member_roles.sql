-- member_roles: RBAC role slugs per club member (references public.members).
-- Apply in Supabase: SQL Editor (paste) or `supabase db push` / linked project migrations.
--
-- RLS: authenticated users may SELECT only rows tied to their own members.user_id.
-- Writes: use the service role in SQL Editor, a migration, or a future Edge Function —
--         there is no INSERT/UPDATE/DELETE policy for authenticated clients.
--
-- Depends on: public.members(id, user_id, …). The SELECT policy subquery requires that
-- members either has no RLS or allows each user to read their own row (typical).

create table if not exists public.member_roles (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  role_slug text not null,
  granted_at timestamptz not null default now(),
  constraint member_roles_member_role_unique unique (member_id, role_slug),
  constraint member_roles_slug_format check (role_slug ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.member_roles is 'Role slugs for portal RBAC; match slugs to members.html data-rbac-roles.';

create index if not exists member_roles_member_id_idx on public.member_roles (member_id);

alter table public.member_roles enable row level security;

create policy "Members can read own member_roles"
  on public.member_roles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.members m
      where m.id = member_roles.member_id
        and m.user_id = auth.uid()
    )
  );

-- Example grant (run in SQL Editor as a privileged role; replace email):
-- insert into public.member_roles (member_id, role_slug)
-- select m.id, 'club_admin'
-- from public.members m
-- where m.email = 'you@example.com'
-- limit 1
-- on conflict (member_id, role_slug) do nothing;
