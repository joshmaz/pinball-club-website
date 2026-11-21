begin;

alter table public.members
  add column club_designation text check (club_designation in ('board', 'staff')),
  add column club_title text check (
    club_title is null or (club_designation is not null and char_length(club_title) between 1 and 80)
  );

-- The existing profile upsert is available to members. Protect the new
-- authority-bearing fields even when a client constructs its own payload.
create function private.snh_guard_club_designation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.club_designation is null and new.club_title is null then return new; end if;
    elsif (new.club_designation, new.club_title) is not distinct from (old.club_designation, old.club_title) then
      return new;
    end if;
    raise exception 'Use Member Management to change the club designation' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.snh_guard_club_designation() from public;
create trigger snh_guard_club_designation before insert or update on public.members
for each row execute function private.snh_guard_club_designation();

create function public.snh_set_club_designation(p_member_id uuid, p_designation text, p_title text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.snh_member_has_effective_role('membership_admin'), false) then
    raise exception 'Not authorized to assign Board or Staff' using errcode = '42501';
  end if;

  update public.members m
  set club_designation = p_designation,
      club_title = case when p_designation is not null then nullif(btrim(p_title), '') end
  from auth.users u
  where m.id = p_member_id and u.id = m.user_id
    and (p_designation is null or u.email_confirmed_at is not null);
  if not found then
    raise exception 'Choose an existing member with a verified email';
  end if;
end;
$$;

create table private.club_document_links (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  board_folder boolean not null default false,
  drive_url text not null check (
    char_length(drive_url) <= 2048 and
    (case when board_folder then
      drive_url ~ '^https://drive[.]google[.]com/drive/(u/[0-9]+/)?folders/[a-zA-Z0-9_-]+([/?#]|$)'
    else drive_url ~ '^https://(drive[.]google[.]com/(file/d/[a-zA-Z0-9_-]+([/?#]|$)|open[?]id=[a-zA-Z0-9_-]+([&#]|$))|docs[.]google[.]com/(document|spreadsheets|presentation|forms)/d/[a-zA-Z0-9_-]+([/?#]|$))'
    end) and drive_url !~ '[[:space:][:cntrl:]]'
    and strpos(drive_url, chr(92)) = 0
  ),
  meeting_date date check (meeting_date between date '0001-01-01' and date '9999-12-31'),
  pinned boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.members(id) on delete set null
);
create unique index club_document_board_folder on private.club_document_links (board_folder) where board_folder;
revoke all on private.club_document_links from public, anon, authenticated;

create function private.snh_club_documents_editor() returns uuid
language sql stable set search_path = '' as $$
  select m.id from public.members m join auth.users u on u.id = m.user_id
  where u.id = auth.uid() and u.email_confirmed_at is not null
    and m.club_designation in ('board', 'staff');
$$;
revoke all on function private.snh_club_documents_editor() from public;

create function public.snh_club_documents() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  editor uuid;
begin
  if not public.snh_account_exists() then
    raise exception 'Sign in to view club documents' using errcode = '42501';
  end if;
  editor := private.snh_club_documents_editor();

  return jsonb_build_object(
    'can_edit', editor is not null,
    'board_folder_url', case when editor is not null then (
      select drive_url from private.club_document_links where board_folder
    ) end,
    'roster', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', person.name, 'designation', person.designation, 'title', person.title
    ) order by person.designation, lower(person.name)), '[]'::jsonb)
      from (
        select coalesce(nullif(btrim(m.display_name), ''),
          nullif(btrim(concat_ws(' ', m.first_name, m.last_name)), ''), 'Club volunteer') as name,
          m.club_designation as designation, m.club_title as title
        from public.members m join auth.users u on u.id = m.user_id
        where m.club_designation is not null and u.email_confirmed_at is not null
      ) person),
    'links', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'title', d.title, 'url', d.drive_url, 'meeting_date', d.meeting_date, 'pinned', d.pinned
    ) order by d.pinned desc, d.meeting_date desc nulls last, lower(d.title), d.id), '[]'::jsonb)
      from private.club_document_links d where not d.board_folder)
  );
end;
$$;

create function public.snh_save_club_document(
  p_id uuid, p_title text, p_url text, p_meeting_date date, p_pinned boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare
  editor uuid := private.snh_club_documents_editor();
begin
  if editor is null then
    raise exception 'Not authorized to maintain club documents' using errcode = '42501';
  end if;
  if p_id is null then
    insert into private.club_document_links (title, drive_url, meeting_date, pinned, updated_by)
    values (btrim(p_title), btrim(p_url), p_meeting_date, p_pinned, editor);
  else
    update private.club_document_links set title = btrim(p_title), drive_url = btrim(p_url),
      meeting_date = p_meeting_date, pinned = p_pinned, updated_at = now(), updated_by = editor
    where id = p_id and not board_folder;
    if not found then raise exception 'This link has already been removed'; end if;
  end if;
end;
$$;

create function public.snh_set_club_document_folder(p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  editor uuid := private.snh_club_documents_editor();
begin
  if editor is null then
    raise exception 'Not authorized to maintain club documents' using errcode = '42501';
  end if;
  if nullif(btrim(p_url), '') is null then
    delete from private.club_document_links where board_folder;
  else
    insert into private.club_document_links (title, drive_url, board_folder, updated_by)
    values ('Board folder', btrim(p_url), true, editor)
    on conflict (board_folder) where board_folder do update
      set drive_url = excluded.drive_url, updated_at = now(), updated_by = excluded.updated_by;
  end if;
end;
$$;

create function public.snh_remove_club_document(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.snh_club_documents_editor() is null then
    raise exception 'Not authorized to maintain club documents' using errcode = '42501';
  end if;
  delete from private.club_document_links where id = p_id and not board_folder;
end;
$$;

revoke all on function public.snh_set_club_designation(uuid,text,text),
  public.snh_club_documents(), public.snh_save_club_document(uuid,text,text,date,boolean),
  public.snh_remove_club_document(uuid), public.snh_set_club_document_folder(text) from public, anon;
grant execute on function public.snh_set_club_designation(uuid,text,text),
  public.snh_club_documents(), public.snh_save_club_document(uuid,text,text,date,boolean),
  public.snh_remove_club_document(uuid), public.snh_set_club_document_folder(text) to authenticated;

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
        'email_verified', coalesce(u.email_confirmed_at is not null, false),
        'email', coalesce(u.email, ''),
        'first_name', coalesce(m.first_name, ''),
        'last_name', coalesce(m.last_name, ''),
        'display_name', coalesce(m.display_name, ''),
        'club_designation', m.club_designation,
        'club_title', m.club_title,
        'stern_insider_username', coalesce((
          select ea.account_handle
          from public.external_accounts ea
          where ea.member_id = m.id
            and ea.provider_slug = 'stern_insider'
          limit 1
        ), ''),
        'membership_status', lm.status,
        'membership_tier', lm.tier,
        'membership_end_date', lm.end_date,
        'membership_last_updated_at', lm.created_at,
        'account_created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at,
        'role_slugs', coalesce(
          (
            select array_agg(mr.role_slug order by mr.role_slug)
            from public.member_roles mr
            where mr.member_id = m.id
          ),
          array[]::text[]
        )
      ) as row_json,
      lower(coalesce(u.email, '')) as email_sort
    from public.members m
    left join auth.users u on u.id = m.user_id
    left join lateral (
      select mship.status, mship.tier, mship.end_date, mship.created_at
      from public.memberships mship
      where mship.member_id = m.id
      order by mship.created_at desc, mship.id desc
      limit 1
    ) lm on true
  ) sub;

  return coalesce(payload, '[]'::json);
end;
$$;

revoke all on function public.snh_list_members_for_admin() from public;
grant execute on function public.snh_list_members_for_admin() to authenticated;

commit;
