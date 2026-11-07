-- Slideshow activity feed: same publication window as homepage, without six-card cap.
begin;
create or replace function public.snh_slideshow_activities() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id)||published order by (published->>'position')::integer,id),'[]'::jsonb)
  from public.publishing_entries
  where kind='activity' and not archived and published is not null
    and (published->>'starts_at')::timestamptz<=now()
    and ((published->>'ends_at') is null or (published->>'ends_at')::timestamptz>now());
$$;
revoke all on function public.snh_slideshow_activities() from public,anon,authenticated;
grant execute on function public.snh_slideshow_activities() to anon,authenticated;
commit;
