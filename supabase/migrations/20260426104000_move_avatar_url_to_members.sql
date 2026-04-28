-- Store avatar_url directly on public.members and backfill from auth metadata.
alter table if exists public.members
  add column if not exists avatar_url text;

update public.members m
set avatar_url = nullif(trim(coalesce(u.raw_user_meta_data ->> 'avatar_url', '')), '')
from auth.users u
where u.id = m.user_id
  and coalesce(trim(m.avatar_url), '') = ''
  and coalesce(trim(u.raw_user_meta_data ->> 'avatar_url'), '') <> '';
