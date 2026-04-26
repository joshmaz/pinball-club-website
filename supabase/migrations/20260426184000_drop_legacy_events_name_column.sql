-- Remove legacy column no longer used by app code.
alter table if exists public.events
  drop column if exists name;
