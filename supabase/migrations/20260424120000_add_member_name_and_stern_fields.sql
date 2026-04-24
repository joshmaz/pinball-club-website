-- Add profile fields used by the member dashboard profile forms.
alter table if exists public.members
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists stern_insider_username text;
