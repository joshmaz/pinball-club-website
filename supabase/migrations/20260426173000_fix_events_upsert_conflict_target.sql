-- PostgREST upsert requires a non-partial unique/exclusion target for on_conflict inference.
-- Replace the partial unique index with a table-level UNIQUE constraint.

drop index if exists public.events_legacy_import_key_uidx;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_legacy_import_key_key'
      and conrelid = 'public.events'::regclass
  ) then
    alter table public.events
      add constraint events_legacy_import_key_key unique (legacy_import_key);
  end if;
end $$;
