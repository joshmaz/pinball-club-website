-- Let Operations review queued text and clear staging backlog without sending it.
begin;

create or replace function public.snh_operations_messages(
  p_status text default null,
  p_before timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.snh_require_operations_admin();
  if (p_status is not null and p_status not in ('pending','sending','sent','failed','canceled'))
     or (p_before is null) <> (p_before_id is null) then
    raise exception 'Invalid message filter' using errcode='22023';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(n) order by created_at desc,id desc),'[]')
    from (
      select id,kind,recipient_email,subject,body,status,attempts,created_at,available_at,sent_at,last_error,
        (status='failed' and created_at>now()-interval '23 hours' and provider_id is null and lease_id is null) can_retry
      from public.notification_outbox
      where (p_status is null or status=p_status)
        and (p_before is null or (created_at,id)<(p_before,p_before_id))
      order by created_at desc,id desc
      limit 50
    ) n
  );
end;
$$;

create function public.snh_operations_cancel_notification(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_message public.notification_outbox;
begin
  perform private.snh_require_operations_admin();
  -- Serialize against dispatcher claims so a message cannot be canceled after
  -- it has already entered the sending state.
  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  select * into v_message
  from public.notification_outbox
  where id=p_id
  for update;
  if not found or v_message.status <> 'pending' then
    raise exception 'Only pending notifications can be canceled' using errcode='22023';
  end if;

  update public.notification_outbox
  set status='canceled', last_error='Canceled by Operations', locked_until=null, lease_id=null,
      manual_retry_allowance=false
  where id=p_id;

  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
  values('operations','cancel',auth.uid(),'notification',p_id::text,
    jsonb_build_object('kind',v_message.kind,'status',v_message.status),
    jsonb_build_object('status','canceled'));
end;
$$;

create function public.snh_operations_notification_preview_request(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $
declare
  v_message public.notification_outbox;
begin
  perform private.snh_require_operations_admin();
  select * into v_message
  from public.notification_outbox
  where id=p_id
  for key share;
  if not found or v_message.status <> 'pending' then
    raise exception 'Only pending notifications can be previewed' using errcode='22023';
  end if;

  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
  values('operations','send_notification_preview',auth.uid(),'notification',p_id::text,
    jsonb_build_object('kind',v_message.kind,'status',v_message.status),
    jsonb_build_object('destination','configured_test_inbox','status','requested'));
end;
$;

revoke all on function public.snh_operations_notification_preview_request(uuid) from public,anon;
grant execute on function public.snh_operations_notification_preview_request(uuid) to authenticated;

-- This privileged action is called only through the Operations Edge Function,
-- which verifies the club-admin session and enforces the staging project ID.
create function public.snh_operations_clear_staging_notifications(p_actor_user_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if p_actor_user_id is null then
    raise exception 'An Operations actor is required' using errcode='22023';
  end if;
  -- Match the dispatcher claim lock and cancel pending rows only. In-flight
  -- messages are left untouched.
  perform pg_catalog.pg_advisory_xact_lock(74111710::bigint);
  update public.notification_outbox
  set status='canceled', last_error='Cleared from staging queue by Operations',
      locked_until=null, lease_id=null, manual_retry_allowance=false
  where status='pending';
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
    values('operations','clear_staging_queue',p_actor_user_id,'notification_queue','staging',
      jsonb_build_object('pending_count',v_count),
      jsonb_build_object('canceled_count',v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function public.snh_operations_cancel_notification(uuid) from public,anon;
grant execute on function public.snh_operations_cancel_notification(uuid) to authenticated;
revoke all on function public.snh_operations_clear_staging_notifications(uuid) from public,anon,authenticated;
grant execute on function public.snh_operations_clear_staging_notifications(uuid) to service_role;

commit;
