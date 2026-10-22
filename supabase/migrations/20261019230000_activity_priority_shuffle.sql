-- Preserve priority groups; shuffle ties before selecting the six homepage cards.
begin;
create or replace function public.snh_public_activities() returns jsonb
language sql volatile security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id)||published order by priority,shuffle),'[]'::jsonb)
 from (
  select id,published,(published->>'position')::integer as priority,random() as shuffle
  from public.publishing_entries
  where kind='activity' and not archived and published is not null
   and (published->>'starts_at')::timestamptz<=now()
   and ((published->>'ends_at') is null or (published->>'ends_at')::timestamptz>now())
  order by priority,shuffle limit 6
 ) active;
$$;
commit;
