create or replace function public.snh_club_documents() returns jsonb
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
        select coalesce(
          case when strpos(m.display_name, '@') = 0 then nullif(btrim(m.display_name), '') end,
          case when strpos(concat_ws(' ', m.first_name, m.last_name), '@') = 0
            then nullif(btrim(concat_ws(' ', m.first_name, m.last_name)), '') end,
          'Club volunteer') as name,
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
