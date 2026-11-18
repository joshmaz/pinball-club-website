-- Keep the notification queue kinds added by both onboarding and club-note alerts.
-- These features were merged through separate changes that each replaced the
-- same check constraint; this forward migration preserves their combined set.
begin;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_kind_check;

alter table public.notification_outbox
  add constraint notification_outbox_kind_check
  check (kind in (
    'member_signup',
    'pinballmap_failure',
    'pinballmap_game_changes',
    'club_note_created',
    'member_confirmation_reminder',
    'member_welcome'
  ));

commit;
