-- Expose last Pinball Map ingest time to games editors (audit_log has no direct client read).

create or replace function public.snh_pinballmap_ingest_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last timestamptz;
  v_entity text;
  v_new jsonb;
begin
  if not public.snh_member_has_games_access() then
    raise exception 'Games catalog access required';
  end if;

  select al.created_at, al.entity_id, al.new_data
    into v_last, v_entity, v_new
    from public.audit_log al
   where al.module = 'games'
     and al.action = 'import'
     and al.entity_type = 'pinballmap_ingest'
   order by al.created_at desc
   limit 1;

  if v_last is null then
    return jsonb_build_object(
      'last_ingest_at', null,
      'location_id', null,
      'ingest_summary', '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'last_ingest_at', v_last,
    'location_id',
      case
        when v_entity is null or btrim(v_entity) = '' then null
        else (v_entity)::int
      end,
    'ingest_summary', coalesce(v_new, '{}'::jsonb)
  );
end;
$$;

comment on function public.snh_pinballmap_ingest_status() is
  'Returns last successful pinballmap_ingest audit row for games editors.';

revoke all on function public.snh_pinballmap_ingest_status() from public;
grant execute on function public.snh_pinballmap_ingest_status() to authenticated;
