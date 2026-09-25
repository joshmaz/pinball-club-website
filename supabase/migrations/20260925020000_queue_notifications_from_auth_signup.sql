-- Auth creates the member before auth.uid() exists. Queue explicitly from that
-- trusted creation path; keep signed-in profile inserts supported as well.
create or replace function private.snh_enqueue_member_signup(p_member public.members)
returns void language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
begin
  for v_recipient in
    select distinct on (lower(trim(m.email))) m.id, trim(m.email) as email
    from public.members m
    join public.member_roles r on r.member_id = m.id
    where r.role_slug in ('membership_editor', 'membership_admin', 'club_admin')
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

create or replace function private.snh_queue_member_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and new.user_id = auth.uid() then
    perform private.snh_enqueue_member_signup(new);
  end if;
  return new;
end;
$$;
revoke all on function private.snh_queue_member_signup() from public, anon, authenticated;

-- Preserve the deployed account-to-member mapping. This also covers accounts
-- created through Auth administration; direct member imports remain silent.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_member public.members;
begin
  insert into public.members (user_id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  ) returning * into v_member;
  perform private.snh_enqueue_member_signup(v_member);
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
