-- Optional ends are deliberately not backfilled. Publication remains independent.
alter table public.events
  add column ends_at timestamptz,
  add column lifecycle_status text not null default 'scheduled',
  add column previous_schedule jsonb,
  add column reschedule_note text;

alter table public.events
  add constraint events_lifecycle_status_check check (lifecycle_status in ('scheduled', 'canceled', 'postponed')),
  add constraint events_end_check check (ends_at is null or
    (not all_day and starts_at is not null and (time_known is true or (time_known is null and (starts_at at time zone 'UTC')::time <> time '00:00:00')) and ends_at > starts_at)),
  add constraint events_previous_schedule_check check (previous_schedule is null or jsonb_typeof(previous_schedule) = 'object'),
  add constraint events_reschedule_note_check check (reschedule_note is null or length(reschedule_note) <= 1000);

comment on column public.events.previous_schedule is 'Single previous schedule recorded only by explicit reschedule action; not an edit history.';
notify pgrst, 'reload schema';
