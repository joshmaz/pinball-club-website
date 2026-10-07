-- Disposable migrated database only. Requires four distinct, role-free member accounts.
-- Fixtures roll back; never delete existing assignments to prepare this check.
begin;
do $$
declare
  ids uuid[];
  users uuid[];
  denied boolean;
  slug text;
  actor integer;
  allowed boolean;
  roles text[] := array['membership_editor', 'membership_admin', 'club_admin',
    'events_editor', 'events_admin', 'photos_editor', 'photos_admin', 'games_editor', 'games_admin'];
begin
  select array_agg(id order by id), array_agg(user_id order by id) into ids, users
  from (select m.id, m.user_id from public.members m where m.user_id is not null
    and not exists (select 1 from public.member_roles r where r.member_id = m.id)
    order by m.id limit 4) q;
  if coalesce(array_length(ids, 1), 0) <> 4 or (select count(distinct u) from unnest(users) u) <> 4 then
    raise exception 'Four distinct role-free test accounts required';
  end if;
  insert into public.member_roles(member_id, role_slug) values
    (ids[1], 'membership_editor'), (ids[2], 'membership_admin'), (ids[3], 'club_admin');

  for actor in 1..3 loop
    perform set_config('request.jwt.claim.sub', users[actor]::text, true);
    foreach slug in array roles loop
      allowed := actor = 3 or (actor = 2 and slug not in ('membership_admin', 'club_admin'));
      if public.snh_member_can_assign_role(slug) is distinct from allowed then
        raise exception 'helper mismatch: actor %, target %', actor, slug;
      end if;
      denied := false;
      begin perform public.snh_grant_member_role(ids[4], slug);
      exception when insufficient_privilege then denied := true; end;
      if denied = allowed then raise exception 'grant mismatch: actor %, target %', actor, slug; end if;
      -- Seed denied grant targets so revoke tests exercise an existing assignment.
      insert into public.member_roles(member_id, role_slug) values (ids[4], slug) on conflict do nothing;
      denied := false;
      begin perform public.snh_revoke_member_role(ids[4], slug);
      exception when insufficient_privilege then denied := true; end;
      if denied = allowed then raise exception 'revoke mismatch: actor %, target %', actor, slug; end if;
      if exists (select 1 from public.member_roles where member_id = ids[4] and role_slug = slug) is distinct from (not allowed) then
        raise exception 'unexpected assignment after revoke';
      end if;
      delete from public.member_roles where member_id = ids[4] and role_slug = slug;
    end loop;
  end loop;

  -- Self-removal must fail even with another administrator present.
  perform public.snh_grant_member_role(ids[4], 'club_admin');
  denied := false;
  begin perform public.snh_revoke_member_role(ids[3], 'club_admin');
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'administrator self-removal allowed'; end if;
  perform public.snh_revoke_member_role(ids[4], 'club_admin');

  foreach slug in array array['unlisted_role', 'website_volunteer', '', null] loop
    if public.snh_member_can_assign_role(slug) is distinct from false then
      raise exception 'non-assignable helper target accepted';
    end if;
    denied := false;
    begin perform public.snh_grant_member_role(ids[4], slug);
    exception when invalid_parameter_value then denied := true; end;
    if not denied then raise exception 'allowlist bypass'; end if;
    denied := false;
    begin perform public.snh_revoke_member_role(ids[4], slug);
    exception when invalid_parameter_value then denied := true; end;
    if not denied then raise exception 'revoke allowlist bypass'; end if;
  end loop;
end $$;
rollback;
