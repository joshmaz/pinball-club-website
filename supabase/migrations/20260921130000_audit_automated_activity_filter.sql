-- Replace the old signature so PostgREST has a single unambiguous RPC.
drop function public.snh_audit_history_for_admin(text, integer, timestamptz, uuid);

create function public.snh_audit_history_for_admin(
  p_module text default null,
  p_limit integer default 50,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_show_automated boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not exists (
    select 1
    from public.members m
    join public.member_roles mr on mr.member_id = m.id
    where m.user_id = auth.uid() and mr.role_slug = 'club_admin'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100
     or p_show_automated is null
     or (p_before_created_at is null) <> (p_before_id is null)
     or length(coalesce(p_module, '')) > 80 then
    raise exception 'invalid audit history request' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc, page.id desc), '[]'::jsonb)
  into v_rows
  from (
    select al.id, al.created_at, al.module, al.action,
           al.entity_type, al.entity_id, al.old_data, al.new_data, al.metadata,
           al.actor_user_id,
           coalesce(nullif(m.display_name, ''), nullif(m.email, ''),
                    al.actor_user_id::text, 'System') as actor_label
    from public.audit_log al
    left join public.members m on m.user_id = al.actor_user_id
    where (p_module is null or al.module = p_module)
      and (p_show_automated or not (
        al.module = 'games' and al.action = 'import' and al.entity_type = 'pinballmap_ingest'
        and al.new_data @> '{"updates_count": 0, "creates_count": 0}'::jsonb
      ))
      and (p_before_created_at is null
           or (al.created_at, al.id) < (p_before_created_at, p_before_id))
    order by al.created_at desc, al.id desc
    limit p_limit
  ) page;

  return v_rows;
end;
$$;

revoke all on function public.snh_audit_history_for_admin(text, integer, timestamptz, uuid, boolean) from public;
grant execute on function public.snh_audit_history_for_admin(text, integer, timestamptz, uuid, boolean) to authenticated;
