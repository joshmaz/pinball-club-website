-- Keep the sensitive Operations queue RPC out of the anonymous PostgREST surface.
begin;

revoke execute on function public.snh_operations_messages(text, timestamptz, uuid) from public, anon;
grant execute on function public.snh_operations_messages(text, timestamptz, uuid) to authenticated, service_role;

commit;
