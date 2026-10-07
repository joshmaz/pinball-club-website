-- One canonical hierarchy, shared by caller authorization and trusted enqueue.
-- This internal predicate is deliberately unavailable to API callers.
create schema if not exists private;
create function private.snh_member_has_effective_role(p_member_id uuid, p_required_role text)
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
      ('games_editor', 'games_admin')
  ), effective_roles(role_slug) as (
    select catalog.role_slug
    from public.members m
    join public.member_roles assignment on assignment.member_id = m.id
    join role_catalog catalog on catalog.role_slug = assignment.role_slug
    where m.id = p_member_id
    union
    select catalog.role_slug
    from effective_roles superior
    join role_catalog catalog on catalog.inherited_by = superior.role_slug
  )
  select exists (
    select 1 from effective_roles effective
    where effective.role_slug = p_required_role
      or p_required_role = 'website_volunteer'
  );
$$;
revoke all on function private.snh_member_has_effective_role(uuid, text)
  from public, anon, authenticated, service_role;

-- Preserve the public signature and caller identity boundary.
create or replace function public.snh_member_has_effective_role(p_required_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
    where m.user_id = auth.uid()
      and private.snh_member_has_effective_role(m.id, p_required_role)
  );
$$;
revoke all on function public.snh_member_has_effective_role(text) from public, anon, authenticated;
grant execute on function public.snh_member_has_effective_role(text) to authenticated;

-- Recipient authorization occurs only at enqueue. Later role removal does not
-- invalidate an already-authorized queue record. No backfill or queue rewrite.
create or replace function private.snh_enqueue_member_signup(p_member public.members)
returns void language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
begin
  for v_recipient in
    select distinct on (lower(trim(m.email))) m.id, trim(m.email) as email
    from public.members m
    where private.snh_member_has_effective_role(m.id, 'membership_editor')
      and m.user_id is distinct from p_member.user_id
      and trim(coalesce(m.email, '')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by lower(trim(m.email)), m.id
  loop
    insert into public.notification_outbox
      (event_key, kind, recipient_member_id, recipient_email, subject, body)
    values (
      'member_signup:' || p_member.id::text || ':' || v_recipient.id::text,
      'member_signup', v_recipient.id, v_recipient.email,
      'New SNH Pinball Club website account',
      'A new member created a website profile.' || E'\n\n' ||
      'Name: ' || coalesce(nullif(trim(concat_ws(' ', p_member.first_name, p_member.last_name)), ''),
                              nullif(trim(p_member.display_name), ''), 'Not provided') || E'\n' ||
      'Email: ' || coalesce(nullif(trim(p_member.email), ''), 'Not provided') || E'\n\n' ||
      'Review the member directory in My Account. This is a website account, not a paid membership.'
    ) on conflict (event_key) do nothing;
  end loop;
end;
$$;
revoke all on function private.snh_enqueue_member_signup(public.members) from public, anon, authenticated;
