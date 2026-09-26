-- Distinguish all-day dates and confirmed start times from legacy date-only placeholders.
-- For all-day events, starts_at stores the calendar date at midnight UTC.
alter table public.events
  add column if not exists all_day boolean not null default false,
  add column if not exists time_known boolean;

comment on column public.events.all_day is
  'Calendar-only event; starts_at uses midnight UTC to preserve the date in every timezone.';
comment on column public.events.time_known is
  'True: confirmed timestamp (including midnight UTC). False: time unknown. Null: legacy precision inference.';

notify pgrst, 'reload schema';
