-- PostgREST requires an explicit WHERE clause for UPDATE statements.
create or replace function public.snh_observe_notification_backlog() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_state private.notification_backlog_state;
  v_status jsonb;
  v_backlogged boolean;
  v_depth integer;
begin
  select * into strict v_state from private.notification_backlog_state where singleton for update;
  v_status := public.snh_notification_live_status();
  v_backlogged := v_status->>'backlog_status' <> 'clear';
  v_depth := (v_status->>'pending_count')::integer;
  if v_backlogged and not v_state.active then
    update private.notification_backlog_state
    set active=true, last_detected_at=clock_timestamp(), peak_depth=v_depth where singleton;
  elsif v_backlogged and v_depth>v_state.peak_depth then
    update private.notification_backlog_state set peak_depth=v_depth where singleton;
  elsif not v_backlogged and v_state.active then
    update private.notification_backlog_state set active=false, last_cleared_at=clock_timestamp() where singleton;
  end if;
end;
$$;
