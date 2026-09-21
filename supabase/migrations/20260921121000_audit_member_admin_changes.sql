-- Record membership administration and role assignment changes. These audit
-- writes share the transaction with the business write, including service-role
-- maintenance. Profile/contact data is deliberately outside this trigger.

create or replace function private.snh_audit_member_admin_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_key text;
  v_member_id uuid;
  v_entity_id uuid;
  v_entity_type text;
  v_action text;
begin
  if tg_table_name = 'member_roles' then
    v_entity_type := 'member_role';
    if tg_op <> 'INSERT' then
      v_before := jsonb_build_object('member_id', old.member_id, 'role_slug', old.role_slug);
    end if;
    if tg_op <> 'DELETE' then
      v_after := jsonb_build_object('member_id', new.member_id, 'role_slug', new.role_slug);
    end if;
  elsif tg_table_name = 'memberships' then
    v_entity_type := 'membership';
    if tg_op <> 'INSERT' then
      v_before := jsonb_build_object('member_id', old.member_id, 'status', old.status,
        'tier', old.tier, 'end_date', old.end_date);
    end if;
    if tg_op <> 'DELETE' then
      v_after := jsonb_build_object('member_id', new.member_id, 'status', new.status,
        'tier', new.tier, 'end_date', new.end_date);
    end if;
  else
    raise exception 'unexpected audit table: %', tg_table_name;
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_before) loop
      if v_before->v_key is distinct from v_after->v_key then
        v_old := v_old || jsonb_build_object(v_key, v_before->v_key);
        v_new := v_new || jsonb_build_object(v_key, v_after->v_key);
      end if;
    end loop;
    if v_old = '{}'::jsonb then
      return null;
    end if;
    v_action := 'update';
  elsif tg_op = 'INSERT' then
    v_new := v_after;
    v_action := case when tg_table_name = 'member_roles' then 'grant' else 'create' end;
  else
    v_old := v_before;
    v_action := case when tg_table_name = 'member_roles' then 'revoke' else 'delete' end;
  end if;

  if tg_op = 'DELETE' then
    v_member_id := old.member_id;
    v_entity_id := old.id;
  else
    v_member_id := new.member_id;
    v_entity_id := new.id;
  end if;

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id,
    old_data, new_data, metadata
  ) values (
    'members', v_action, auth.uid(), v_entity_type, v_entity_id::text,
    v_old, v_new,
    jsonb_build_object('member_id', v_member_id, 'auth_role', auth.role())
  );

  return null;
end;
$$;

revoke all on function private.snh_audit_member_admin_change() from public;

drop trigger if exists trg_member_roles_audit_change on public.member_roles;
create trigger trg_member_roles_audit_change
after insert or update or delete on public.member_roles
for each row execute function private.snh_audit_member_admin_change();

drop trigger if exists trg_memberships_audit_change on public.memberships;
create trigger trg_memberships_audit_change
after insert or update or delete on public.memberships
for each row execute function private.snh_audit_member_admin_change();
