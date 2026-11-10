begin;

create function public.snh_publishing_activity_set_position(
  p_id uuid, p_version integer, p_position integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  entry public.publishing_entries;
  previous_order jsonb;
begin
  if not public.snh_member_has_publishing_access() then
    raise exception 'Publishing access required' using errcode = '42501';
  end if;
  if p_position is null or p_position not between 0 and 999 then
    raise exception 'Display order must be a whole number from 0 to 999' using errcode = '22023';
  end if;

  select * into entry from public.publishing_entries
  where id = p_id and kind = 'activity'
  for update;
  if not found then
    raise exception 'Activity not found' using errcode = 'P0002';
  end if;
  if p_version is distinct from entry.version then
    raise exception 'Activity changed. Refresh activities and try again.' using errcode = 'PT409';
  end if;

  if coalesce((entry.draft->>'position')::integer, 0) = p_position
    and (entry.published is null or coalesce((entry.published->>'position')::integer, 0) = p_position) then
    return to_jsonb(entry);
  end if;

  previous_order := jsonb_build_object(
    'draft_position', coalesce((entry.draft->>'position')::integer, 0),
    'published_position', case when entry.published is not null then coalesce((entry.published->>'position')::integer, 0) end
  );
  update public.publishing_entries
  set draft = draft || jsonb_build_object('position', p_position),
      published = published || jsonb_build_object('position', p_position),
      version = version + 1,
      updated_at = now()
  where id = p_id
  returning * into entry;

  insert into public.audit_log(module, action, actor_user_id, entity_type, entity_id, old_data, new_data)
  values ('publishing', 'reorder', auth.uid(), 'activity', p_id::text, previous_order,
    jsonb_build_object('draft_position', p_position,
      'published_position', case when entry.published is not null then p_position end));

  return to_jsonb(entry);
end $$;

revoke all on function public.snh_publishing_activity_set_position(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.snh_publishing_activity_set_position(uuid, integer, integer) to authenticated;

commit;
