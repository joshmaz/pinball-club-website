-- Stable self-service read endpoint for external account links shown on members.html profile.
create or replace function public.snh_get_my_external_accounts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  payload json;
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(
    json_agg(
      json_build_object(
        'provider_slug', ea.provider_slug,
        'account_handle', coalesce(ea.account_handle, ''),
        'account_url', coalesce(ea.account_url, '')
      )
      order by ea.provider_slug
    ),
    '[]'::json
  )
  into payload
  from public.external_accounts ea
  join public.members m on m.id = ea.member_id
  where m.user_id = auth.uid();

  return coalesce(payload, '[]'::json);
end;
$$;

revoke all on function public.snh_get_my_external_accounts() from public;
grant execute on function public.snh_get_my_external_accounts() to authenticated;
