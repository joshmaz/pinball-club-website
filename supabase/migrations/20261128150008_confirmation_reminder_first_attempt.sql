begin;

create or replace function private.snh_enqueue_member_confirmation_reminder(
  p_user_id uuid, p_member_id uuid, p_email text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_due_at timestamptz := coalesce(p_created_at, now()) + interval '24 hours';
begin
  if nullif(trim(p_email), '') is null then return; end if;
  insert into public.notification_outbox
    (event_key, kind, recipient_member_id, recipient_email, subject, body,
     template_variables, available_at, delivery_deadline_at)
  values (
    'member_confirmation_reminder:' || p_user_id::text,
    'member_confirmation_reminder', p_member_id, trim(p_email),
    'Finish confirming your SNH Pinball Club account',
    'Your SNH Pinball Club website account still needs email confirmation.' || E'\n\n' ||
    'Use the confirmation link in your signup email. If you cannot find that message or its link expired, go to the sign-in page and choose Resend Confirmation Email. After confirming, sign in with your email and password. If you have forgotten your password, use Forgot Password after confirming.' || E'\n\n' ||
    'If you already confirmed your address, you can ignore this reminder.',
    '{}'::jsonb, v_due_at, 'infinity'::timestamptz
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function private.snh_enqueue_member_confirmation_reminder(uuid, uuid, text, timestamptz) from public, anon, authenticated;

-- Preserve sent, canceled, failed, and already-attempted deliveries.
update public.notification_outbox
set delivery_deadline_at = 'infinity'::timestamptz
where kind = 'member_confirmation_reminder'
  and status = 'pending'
  and attempts = 0
  and delivery_deadline_at <> 'infinity'::timestamptz;

commit;
