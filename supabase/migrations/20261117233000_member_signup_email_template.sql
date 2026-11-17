-- Store the values required by the Resend-hosted signup notice.
-- NULL is retained for older queue rows, which the dispatcher sends as plain text.
alter table public.notification_outbox
  add column template_variables jsonb,
  add constraint notification_outbox_template_variables_object
    check (template_variables is null or jsonb_typeof(template_variables) = 'object');

-- New signup notices use a stable Resend template alias and keep a plain-text
-- snapshot for queue review and legacy fallback.
create or replace function private.snh_enqueue_member_signup(p_member public.members)
returns void language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
declare v_name text;
declare v_email text;
begin
  v_name := coalesce(
    nullif(trim(concat_ws(' ', p_member.first_name, p_member.last_name)), ''),
    nullif(trim(p_member.display_name), ''),
    'Not provided'
  );
  v_email := coalesce(nullif(trim(p_member.email), ''), 'Not provided');

  for v_recipient in
    select distinct on (lower(trim(m.email))) m.id, trim(m.email) as email
    from public.members m
    where private.snh_member_has_effective_role(m.id, 'membership_editor')
      and m.user_id is distinct from p_member.user_id
      and trim(coalesce(m.email, '')) ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
    order by lower(trim(m.email)), m.id
  loop
    insert into public.notification_outbox
      (event_key, kind, recipient_member_id, recipient_email, subject, body, template_variables)
    values (
      'member_signup:' || p_member.id::text || ':' || v_recipient.id::text,
      'member_signup', v_recipient.id, v_recipient.email,
      'New SNHPC website account created',
      'A new profile was created for the SNH Pinball Club website.' || E'\\n\\n' ||
      'You are receiving this informational notice because your website role includes membership-management access and is eligible for new-account notifications.' || E'\\n\\n' ||
      'Name: ' || v_name || E'\\n' ||
      'Email: ' || v_email || E'\\n\\n' ||
      'No action is needed. This is a website-account notice only; it does not confirm or change paid membership status.',
      jsonb_build_object('NEW_USER_NAME', v_name, 'NEW_USER_EMAIL', v_email)
    ) on conflict (event_key) do nothing;
  end loop;
end;
$$;
revoke all on function private.snh_enqueue_member_signup(public.members) from public, anon, authenticated;
