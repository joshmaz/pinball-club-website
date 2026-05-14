-- Linter 0011: immutable search_path on trigger helpers.

create or replace function public.set_events_updated_at ()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.set_games_catalog_updated_at ()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Linter 0014 (extension_in_public / pg_net): hosted Supabase rejects
--   ALTER EXTENSION pg_net SET SCHEMA ... (SQLSTATE 0A000: not supported).
-- If the dashboard still shows pg_net under public, treat it as a known platform
-- limitation until Supabase documents a supported relocation.
