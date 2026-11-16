-- Store the Match Play format associated with a club event.
-- This is optional for manually created events and public when present.
alter table public.events
  add column if not exists matchplay_format text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_matchplay_format_length_check'
  ) then
    alter table public.events
      add constraint events_matchplay_format_length_check
      check (matchplay_format is null or length(matchplay_format) <= 120);
  end if;
end $$;
