-- Remove legacy blanket deny policy that can suppress rows for authenticated users.
drop policy if exists "No access to events" on public.events;
