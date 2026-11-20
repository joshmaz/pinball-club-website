-- Restore queued message text in the Operations preview after the onboarding
-- migration redefined this RPC without the body column.
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
        (status='failed' and delivery_deadline_at>now() and provider_id is null and lease_id is null) can_retry
      from public.notification_outbox
      where (p_status is null or status=p_status)
        and (p_before is null or (created_at,id)<(p_before,p_before_id))
      order by created_at desc,id desc
      limit 50
    ) n
  );
end;
$$;

commit;
