-- Expand member admin directory payload to include profile name fields and Stern Insider username.
create or replace function public.snh_list_members_for_admin()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  payload json;
begin
  if not coalesce(public.snh_member_can_manage_roles(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(json_agg(row_json order by email_sort), '[]'::json)
  into payload
  from (
    select
      json_build_object(
        'member_id', m.id,
        'email', coalesce(m.email, ''),
        'first_name', coalesce(m.first_name, ''),
        'last_name', coalesce(m.last_name, ''),
        'display_name', coalesce(m.display_name, ''),
        'stern_insider_username', coalesce(m.stern_insider_username, ''),
        'role_slugs', coalesce(
          (
            select array_agg(mr.role_slug order by mr.role_slug)
            from public.member_roles mr
            where mr.member_id = m.id
          ),
          array[]::text[]
        )
      ) as row_json,
      lower(coalesce(m.email, '')) as email_sort
    from public.members m
  ) sub;

  return coalesce(payload, '[]'::json);
end;
$$;
