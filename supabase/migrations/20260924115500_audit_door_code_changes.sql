-- Record club door-code changes in the shared audit log without ever copying
-- the secret value into audit data.
create or replace function public.snh_set_door_code(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trimmed text := btrim(p_code);
  v_had_code boolean;
begin
  if not exists (
    select 1
    from public.members m
    join public.member_roles r on r.member_id = m.id
    where m.user_id = auth.uid() and r.role_slug = 'club_admin'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_code is null or length(v_trimmed) not between 1 and 100 then
    raise exception 'code must be 1 to 100 characters' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.snh_door_secret where singleton = true
  ) into v_had_code;

  insert into public.snh_door_secret(singleton, code, updated_at)
  values (true, v_trimmed, now())
  on conflict (singleton) do update
    set code = excluded.code,
        updated_at = now();

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id,
    old_data, new_data, metadata
  ) values (
    'members',
    case when v_had_code then 'update' else 'create' end,
    auth.uid(),
    'door_code',
    'club_door',
    '{}'::jsonb,
    jsonb_build_object(
      'title', 'Club door code',
      'status', 'updated'
    ),
    jsonb_build_object(
      'source', 'member_portal',
      'secret_value_logged', false
    )
  );
end;
$$;

revoke all on function public.snh_set_door_code(text) from public;
grant execute on function public.snh_set_door_code(text) to authenticated;
