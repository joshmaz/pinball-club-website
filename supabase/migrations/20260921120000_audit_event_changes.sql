-- Audit every event mutation, including editor actions and service-role imports.
-- The trigger runs in the same transaction as the event write: a failed audit
-- insert rolls the event change back as well.

create or replace function private.snh_audit_event_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_before jsonb;
  v_after jsonb;
  v_key text;
  v_action text;
  v_event_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_before := to_jsonb(old) - 'created_at' - 'updated_at';
    v_event_id := old.id;
  end if;
  if tg_op <> 'DELETE' then
    v_after := to_jsonb(new) - 'created_at' - 'updated_at';
    v_event_id := new.id;
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_before) loop
      if v_before->v_key is distinct from v_after->v_key then
        v_old := v_old || jsonb_build_object(v_key, v_before->v_key);
        v_new := v_new || jsonb_build_object(v_key, v_after->v_key);
      end if;
    end loop;
    -- The updated_at trigger can run even when no event field changed.
    if v_old = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when v_old ? 'published' and v_new->>'published' = 'true' then 'publish'
      when v_old ? 'published' and v_new->>'published' = 'false' then 'unpublish'
      else 'update'
    end;
  elsif tg_op = 'INSERT' then
    v_new := v_after;
    v_action := 'create';
  else
    v_old := v_before;
    v_action := 'delete';
  end if;

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id,
    old_data, new_data, metadata
  ) values (
    'events', v_action, auth.uid(), 'event', v_event_id::text,
    v_old, v_new,
    jsonb_build_object(
      'auth_role', auth.role(),
      'event_source', case when tg_op = 'DELETE' then old.source else new.source end
    )
  );

  return null;
end;
$$;

revoke all on function private.snh_audit_event_change() from public;

drop trigger if exists trg_events_audit_change on public.events;
create trigger trg_events_audit_change
after insert or update or delete on public.events
for each row execute function private.snh_audit_event_change();
