begin;

-- Expose the same published activity cards as the homepage, without its six-card cap.
create function public.snh_public_activity_directory() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    jsonb_agg(
      published || jsonb_build_object('id', id)
      order by coalesce((published->>'position')::integer, 0), lower(published->>'title'), id
    ),
    '[]'::jsonb
  )
  from public.publishing_entries
  where kind = 'activity' and not archived and published is not null
    and (published->>'starts_at')::timestamptz <= now()
    and ((published->>'ends_at') is null or (published->>'ends_at')::timestamptz > now());
$$;

revoke all on function public.snh_public_activity_directory() from public, anon, authenticated;
grant execute on function public.snh_public_activity_directory() to anon, authenticated;

commit;
