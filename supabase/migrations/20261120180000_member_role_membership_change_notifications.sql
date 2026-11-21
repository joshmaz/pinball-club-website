-- Queue member-facing notices for actual website-role and Full Access state changes.
-- Messages go only to the affected member and are not backfilled.
begin;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check
  check (kind in (
    'member_signup',
    'pinballmap_failure',
    'pinballmap_game_changes',
    'club_note_created',
    'member_confirmation_reminder',
    'member_welcome',
    'member_role_granted',
    'member_role_revoked',
    'full_access_activated',
    'full_access_deactivated'
  ));

create or replace function private.snh_enqueue_member_role_change(
  p_member_id uuid,
  p_role_slug text,
  p_action text,
  p_role_row_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_role_name text;
  v_description text;
  v_access_note text;
  v_kind text;
  v_subject text;
  v_body text;
begin
  if p_action not in ('granted', 'revoked') then return; end if;

  select nullif(btrim(m.email), '')
    into v_email
    from public.members m
   where m.id = p_member_id;
  if v_email is null or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return; end if;

  v_role_name := case p_role_slug
    when 'club_admin' then 'Website Administrator'
    when 'membership_editor' then 'Membership Editor'
    when 'membership_admin' then 'Membership Admin'
    when 'events_editor' then 'Events Editor'
    when 'events_admin' then 'Events Admin'
    when 'photos_editor' then 'Photos Editor'
    when 'photos_admin' then 'Photos Admin'
    when 'games_editor' then 'Games Editor'
    when 'games_admin' then 'Games Admin'
    when 'publishing_editor' then 'Publishing Editor'
    when 'publishing_admin' then 'Publishing Admin'
    else null
  end;
  if v_role_name is null then return; end if;

  v_description := case p_role_slug
    when 'club_admin' then 'Administers the club website across all domains, including membership, events, photos, games, publishing, audit access, and website configuration.'
    when 'membership_editor' then 'Handles routine member information and membership upkeep. This role does not include authority to assign or revoke website roles.'
    when 'membership_admin' then 'Handles membership administration and may assign or revoke eligible website roles within the Membership Admin scope.'
    when 'events_editor' then 'Maintains event information, including creating, editing, publishing, and unpublishing events.'
    when 'events_admin' then 'Maintains event information and has reserved event administration capabilities, including permanent deletion.'
    when 'photos_editor' then 'Maintains photo albums and assets, including uploads, captions, metadata, publishing, and unpublishing.'
    when 'photos_admin' then 'Maintains photo albums and assets and has reserved destructive capabilities, including permanent deletion.'
    when 'games_editor' then 'Maintains the game catalog, game information and images, normal game-data tools, and Pingolf targets.'
    when 'games_admin' then 'Maintains the game catalog and has reserved game administration capabilities, including deletion, restoration, and permanent removal of images or Pingolf targets.'
    when 'publishing_editor' then 'Maintains announcements and featured activities, including drafting, previewing, publishing, scheduling, withdrawing, archiving, and ordering.'
    when 'publishing_admin' then 'Maintains announcements and featured activities and has the additional capability to permanently delete them.'
    else null
  end;
  if v_description is null then return; end if;

  v_access_note := case
    when p_role_slug = 'club_admin' then
      'Website Administrator includes effective Admin and Editor access across all website domains. It is a website role and does not make you an officer or administrator of the club organization.'
    when p_role_slug like '%_admin' then
      'Admin includes the corresponding Editor capabilities in this domain. Assigned roles are distinct from inherited access.'
    else
      'This role covers normal upkeep in its domain. Admin-only destructive actions remain restricted to Admin roles.'
  end;

  v_kind := case when p_action = 'granted' then 'member_role_granted' else 'member_role_revoked' end;
  if p_action = 'granted' then
    v_subject := 'A website role has been granted to you: ' || v_role_name;
    v_body := 'The ' || v_role_name || ' role has been granted to your SNH Pinball Club website account.';
  else
    v_subject := 'A website role has been removed from your account: ' || v_role_name;
    v_body := 'The ' || v_role_name || ' role has been removed from your SNH Pinball Club website account.' ||
      E'\n\n' || 'If you have another assigned website role, it may continue to provide access to some website tools.';
  end if;

  insert into public.notification_outbox
    (event_key, kind, recipient_member_id, recipient_email, subject, body, template_variables)
  values (
    v_kind || ':' || txid_current()::text || ':' || p_member_id::text || ':' ||
      p_role_row_id::text || ':' || p_role_slug,
    v_kind,
    p_member_id,
    v_email,
    v_subject,
    v_body || E'\n\n' || v_description || E'\n\n' || v_access_note ||
      E'\n\n' || 'Questions about this role? Contact the Webmaster at webmaster@snhpinballclub.com.',
    jsonb_build_object(
      'ROLE_NAME', v_role_name,
      'ROLE_DESCRIPTION', v_description,
      'ROLE_ACCESS_NOTE', v_access_note
    )
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function private.snh_enqueue_member_role_change(uuid, text, text, uuid)
  from public, anon, authenticated;

create or replace function private.snh_notify_member_role_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.snh_enqueue_member_role_change(new.member_id, new.role_slug, 'granted', new.id);
    return new;
  elsif tg_op = 'DELETE' then
    perform private.snh_enqueue_member_role_change(old.member_id, old.role_slug, 'revoked', old.id);
    return old;
  end if;

  if old.member_id is distinct from new.member_id or old.role_slug is distinct from new.role_slug then
    perform private.snh_enqueue_member_role_change(old.member_id, old.role_slug, 'revoked', old.id);
    perform private.snh_enqueue_member_role_change(new.member_id, new.role_slug, 'granted', new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.snh_notify_member_role_change() from public, anon, authenticated;
drop trigger if exists trg_snh_notify_member_role_change on public.member_roles;
create trigger trg_snh_notify_member_role_change
  after insert or update or delete on public.member_roles
  for each row execute function private.snh_notify_member_role_change();

create or replace function private.snh_enqueue_full_access_change(
  p_member_id uuid,
  p_active boolean,
  p_membership_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_kind text;
  v_subject text;
  v_body text;
begin
  select nullif(btrim(m.email), '')
    into v_email
    from public.members m
   where m.id = p_member_id;
  if v_email is null or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return; end if;

  if p_active then
    v_kind := 'full_access_activated';
    v_subject := 'Your SNH Pinball Club Full Access membership is active';
    v_body := 'Your Full Access membership status is now active in the club website records.' ||
      E'\n\n' || 'Full Access membership is separate from website volunteer roles.';
  else
    v_kind := 'full_access_deactivated';
    v_subject := 'Your SNH Pinball Club Full Access membership is inactive';
    v_body := 'Your Full Access membership status is now inactive in the club website records.' ||
      E'\n\n' || 'This does not delete your website account or change your separately assigned website roles.';
  end if;

  insert into public.notification_outbox
    (event_key, kind, recipient_member_id, recipient_email, subject, body, template_variables)
  values (
    v_kind || ':' || txid_current()::text || ':' || p_member_id::text || ':' || p_membership_id::text,
    v_kind,
    p_member_id,
    v_email,
    v_subject,
    v_body || E'\n\n' || 'Questions about membership? Contact support@snhpinballclub.com.',
    '{}'::jsonb
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function private.snh_enqueue_full_access_change(uuid, boolean, uuid)
  from public, anon, authenticated;

create or replace function private.snh_notify_full_access_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_active boolean := false;
  v_new_active boolean := false;
  v_member_id uuid;
  v_membership_id uuid;
begin
  if tg_op = 'INSERT' then
    v_member_id := new.member_id;
    v_membership_id := new.id;

    select prior.status = 'active' into v_old_active
      from public.memberships prior
     where prior.member_id = new.member_id and prior.id <> new.id
     order by prior.created_at desc, prior.id desc
     limit 1;
    v_old_active := coalesce(v_old_active, false);

    select current_row.status = 'active' into v_new_active
      from public.memberships current_row
     where current_row.member_id = new.member_id
     order by current_row.created_at desc, current_row.id desc
     limit 1;

  elsif tg_op = 'DELETE' then
    v_member_id := old.member_id;
    v_membership_id := old.id;

    select prior.status = 'active' into v_old_active
      from (
        select m.status, m.created_at, m.id
          from public.memberships m
         where m.member_id = old.member_id
        union all
        select old.status, old.created_at, old.id
      ) prior
     order by prior.created_at desc, prior.id desc
     limit 1;

    select current_row.status = 'active' into v_new_active
      from public.memberships current_row
     where current_row.member_id = old.member_id
     order by current_row.created_at desc, current_row.id desc
     limit 1;
    v_new_active := coalesce(v_new_active, false);

  else
    v_member_id := new.member_id;
    v_membership_id := new.id;

    if old.member_id is distinct from new.member_id then
      -- Moving a membership record can change both members' effective status.
      select prior.status = 'active' into v_old_active
        from (
          select m.status, m.created_at, m.id
            from public.memberships m
           where m.member_id = old.member_id
          union all
          select old.status, old.created_at, old.id
        ) prior
       order by prior.created_at desc, prior.id desc
       limit 1;

      select current_row.status = 'active' into v_new_active
        from public.memberships current_row
       where current_row.member_id = old.member_id
       order by current_row.created_at desc, current_row.id desc
       limit 1;
      v_new_active := coalesce(v_new_active, false);
      if v_old_active is distinct from v_new_active then
        perform private.snh_enqueue_full_access_change(old.member_id, v_new_active, old.id);
      end if;

      v_old_active := false;
      v_new_active := false;
      select prior.status = 'active' into v_old_active
        from public.memberships prior
       where prior.member_id = new.member_id and prior.id <> new.id
       order by prior.created_at desc, prior.id desc
       limit 1;
      v_old_active := coalesce(v_old_active, false);

      select current_row.status = 'active' into v_new_active
        from public.memberships current_row
       where current_row.member_id = new.member_id
       order by current_row.created_at desc, current_row.id desc
       limit 1;
      v_new_active := coalesce(v_new_active, false);
      if v_old_active is distinct from v_new_active then
        perform private.snh_enqueue_full_access_change(new.member_id, v_new_active, new.id);
      end if;
      return new;
    end if;

    select prior.status = 'active' into v_old_active
      from (
        select m.status, m.created_at, m.id
          from public.memberships m
         where m.member_id = old.member_id and m.id <> new.id
        union all
        select old.status, old.created_at, old.id
      ) prior
     order by prior.created_at desc, prior.id desc
     limit 1;
    v_old_active := coalesce(v_old_active, false);

    select current_row.status = 'active' into v_new_active
      from public.memberships current_row
     where current_row.member_id = new.member_id
     order by current_row.created_at desc, current_row.id desc
     limit 1;
    v_new_active := coalesce(v_new_active, false);
  end if;

  if v_old_active is distinct from v_new_active then
    perform private.snh_enqueue_full_access_change(v_member_id, v_new_active, v_membership_id);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.snh_notify_full_access_change() from public, anon, authenticated;
drop trigger if exists trg_snh_notify_full_access_change on public.memberships;
create trigger trg_snh_notify_full_access_change
  after insert or update or delete on public.memberships
  for each row execute function private.snh_notify_full_access_change();

commit;
