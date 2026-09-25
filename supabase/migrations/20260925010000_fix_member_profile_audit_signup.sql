-- Fix signup failures when the shared audit trigger runs on members.
-- SQL expressions resolve OLD/NEW fields even inside an unselected CASE arm;
-- members has no provider_slug column. Read the existing JSON snapshots instead.

-- Track self-service member profile and external-account changes without
-- copying personal/contact values into the shared audit log.

create or replace function private.snh_audit_member_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_changed_fields text[] := array[]::text[];
  v_key text;
  v_member_id uuid;
  v_entity_id uuid;
  v_entity_type text;
  v_action text;
begin
  if tg_op <> 'INSERT' then
    v_before := to_jsonb(old) - 'id' - 'created_at' - 'updated_at';
  end if;
  if tg_op <> 'DELETE' then
    v_after := to_jsonb(new) - 'id' - 'created_at' - 'updated_at';
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_before) loop
      if v_before->v_key is distinct from v_after->v_key then
        v_changed_fields := array_append(v_changed_fields, v_key);
      end if;
    end loop;
    if cardinality(v_changed_fields) = 0 then
      return null;
    end if;
    v_action := 'update';
  elsif tg_op = 'INSERT' then
    v_action := 'create';
  else
    v_action := 'delete';
  end if;

  if tg_table_name = 'members' then
    v_entity_type := 'member_profile';
    if tg_op = 'DELETE' then
      v_member_id := old.id;
      v_entity_id := old.id;
    else
      v_member_id := new.id;
      v_entity_id := new.id;
    end if;
  elsif tg_table_name = 'external_accounts' then
    v_entity_type := 'external_account';
    if tg_op = 'DELETE' then
      v_member_id := old.member_id;
      v_entity_id := old.id;
    else
      v_member_id := new.member_id;
      v_entity_id := new.id;
    end if;
  else
    raise exception 'unexpected audit table: %', tg_table_name;
  end if;

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id,
    metadata
  ) values (
    'members', v_action, auth.uid(), v_entity_type, v_entity_id::text,
    jsonb_build_object(
      'member_id', v_member_id,
      'auth_role', auth.role(),
      'changed_fields', to_jsonb(v_changed_fields),
      'provider_slug', case
        when tg_table_name = 'external_accounts' and tg_op = 'DELETE' then v_before->>'provider_slug'
        when tg_table_name = 'external_accounts' then v_after->>'provider_slug'
        else null
      end
    )
  );

  return null;
end;
$$;

revoke all on function private.snh_audit_member_profile_change() from public;

