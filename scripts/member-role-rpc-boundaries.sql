-- Run against a disposable migrated database with four members having distinct user_id values.
-- Calls the public RPCs with each persona's JWT subject; fixtures roll back.
begin;
do $$
declare
  ids uuid[];
  users uuid[];
  denied boolean;
  slug text;
begin
  select array_agg(id order by id), array_agg(user_id order by id)
    into ids, users
  from (select id, user_id from public.members where user_id is not null order by id limit 4) q;
  if array_length(ids, 1) <> 4 or (select count(distinct u) from unnest(users) u) <> 4 then
    raise exception 'Four distinct test accounts required';
  end if;
  delete from public.member_roles where member_id = any(ids);
  insert into public.member_roles(member_id, role_slug) values
    (ids[1], 'membership_editor'), (ids[2], 'membership_admin'), (ids[3], 'club_admin');

  perform set_config('request.jwt.claim.sub', users[1]::text, true);
  foreach slug in array array['membership_admin', 'club_admin'] loop
    denied := false;
    begin perform public.snh_grant_member_role(ids[1], slug);
    exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'editor granted %', slug; end if;
    insert into public.member_roles(member_id, role_slug) values (ids[4], slug) on conflict do nothing;
    denied := false;
    begin perform public.snh_revoke_member_role(ids[4], slug);
    exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'editor revoked %', slug; end if;
  end loop;
  perform public.snh_grant_member_role(ids[4], 'events_editor');
  perform public.snh_revoke_member_role(ids[4], 'events_editor');

  perform set_config('request.jwt.claim.sub', users[2]::text, true);
  denied := false;
  begin perform public.snh_grant_member_role(ids[2], 'club_admin');
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'membership admin granted club admin'; end if;
  denied := false;
  begin perform public.snh_revoke_member_role(ids[3], 'club_admin');
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'membership admin revoked club admin'; end if;
  perform public.snh_grant_member_role(ids[4], 'membership_admin');
  perform public.snh_revoke_member_role(ids[4], 'membership_admin');

  perform set_config('request.jwt.claim.sub', users[3]::text, true);
  perform public.snh_revoke_member_role(ids[3], 'club_admin');
  -- A club admin must be able to alter their own role. Restore it via a fixture role,
  -- since the RPC should correctly reject a former admin after self-revocation.
  insert into public.member_roles(member_id, role_slug) values (ids[3], 'club_admin');
  perform public.snh_grant_member_role(ids[3], 'club_admin');
  denied := false;
  begin perform public.snh_grant_member_role(ids[4], 'unlisted_role');
  exception when invalid_parameter_value then denied := true; end;
  if not denied then raise exception 'allowlist bypass'; end if;
end $$;
rollback;
