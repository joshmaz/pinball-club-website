begin;

-- Member profiles are normally self-service, so the canonical identity trigger
-- rejects updates to another account. Club designations are the one intentional
-- exception: the designation RPC has already required Membership Admin access.
-- Keep the exception field-scoped so no other profile or identity value can be
-- changed through that administrative path.
create or replace function private.snh_canonical_member_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_existing public.members; v_email text; v_designation_only boolean := false;
begin
  if current_setting('role', true) in ('anon', 'authenticated') then
    if tg_op = 'UPDATE' then
      v_designation_only :=
        public.snh_member_has_effective_role('membership_admin')
        and (to_jsonb(new) - array['club_designation', 'club_title'])
          is not distinct from
            (to_jsonb(old) - array['club_designation', 'club_title']);
    end if;

    if auth.uid() is null or
       (new.user_id is distinct from auth.uid() and not v_designation_only) then
      raise exception 'Profile must belong to the signed-in account' using errcode='42501';
    end if;
    if tg_op = 'UPDATE' then
      if new.id is distinct from old.id or new.user_id is distinct from old.user_id
         or new.created_at is distinct from old.created_at then
        raise exception 'Account identity fields cannot be changed' using errcode='42501';
      end if;
    else
      select * into v_existing from public.members where user_id=new.user_id;
      new.id := coalesce(v_existing.id, gen_random_uuid());
      new.created_at := coalesce(v_existing.created_at, now());
    end if;
    new.updated_at := now();
  end if;

  if new.user_id is not null then
    select u.email into v_email from auth.users u where u.id=new.user_id;
    new.email := v_email;
  end if;
  return new;
end; $$;

revoke all on function private.snh_canonical_member_identity()
  from public,anon,authenticated,service_role;

commit;
