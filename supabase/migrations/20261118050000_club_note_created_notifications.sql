begin;

alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('member_signup','pinballmap_failure','pinballmap_game_changes','club_note_created'));

create or replace function private.snh_enqueue_club_note_notification(
  p_event_key text,
  p_source_label text,
  p_notes jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_recipient record;
  v_body text;
  v_count integer;
begin
  if nullif(btrim(p_event_key),'') is null
    or jsonb_typeof(p_notes) is distinct from 'array'
    or jsonb_array_length(p_notes)=0 then
    return;
  end if;

  v_count := jsonb_array_length(p_notes);
  select
    'A new ' || case when v_count=1 then 'Note was' else v_count::text || ' Notes were' end ||
    ' added to the SNHPC website.' || E'\n\n' ||
    'Source: ' || coalesce(nullif(btrim(p_source_label),''),'Website') || E'\n\n' ||
    string_agg(
      coalesce(nullif(btrim(n.value->>'title'),''),'Untitled Note') || E'\n' ||
      'Game: ' || coalesce(nullif(btrim(n.value->>'game_title'),''),'Club or facility') || E'\n' ||
      'Details: ' || coalesce(nullif(btrim(n.value->>'body'),''),'No details provided') || E'\n' ||
      'Submitted by: ' || coalesce(nullif(btrim(n.value->>'submitted_by'),''),'Not provided') || E'\n' ||
      'Status: ' || coalesce(nullif(btrim(n.value->>'status'),''),'Open') || E'\n' ||
      'Submitted: ' || coalesce(nullif(btrim(n.value->>'submitted_at'),''),'Not provided'),
      E'\n\n' order by n.ordinality
    )
  into v_body
  from jsonb_array_elements(p_notes) with ordinality n(value, ordinality);

  for v_recipient in
    select distinct on (lower(btrim(m.email))) m.id,btrim(m.email) as email
    from public.members m
    where private.snh_member_has_effective_role(m.id,'website_volunteer')
      and m.user_id is not null
      and btrim(coalesce(m.email,'')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by lower(btrim(m.email)),m.id
  loop
    insert into public.notification_outbox
      (event_key,kind,recipient_member_id,recipient_email,subject,body,template_variables)
    values (
      p_event_key || ':' || v_recipient.id::text,
      'club_note_created',v_recipient.id,v_recipient.email,
      'New SNHPC Notes',v_body,
      jsonb_build_object('SOURCE_LABEL',coalesce(nullif(btrim(p_source_label),''),'Website'),'NOTES',p_notes)
    )
    on conflict (event_key) do nothing;
  end loop;
end;
$$;
revoke all on function private.snh_enqueue_club_note_notification(text,text,jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.snh_club_issue_note_created_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_note jsonb;
  v_source text;
begin
  -- Pinball Map inserts are grouped once per import by the importer below.
  if new.submission_origin='pinballmap' then return new; end if;

  select jsonb_build_object(
    'title',new.title,
    'body',coalesce(new.body,''),
    'game_title',coalesce(g.title,'Club or facility'),
    'submitted_by',coalesce(
      nullif(btrim(m.display_name),''),
      nullif(btrim(concat_ws(' ',nullif(btrim(m.first_name),''),nullif(btrim(m.last_name),''))),''),
      'Member'
    ),
    'status',case new.status when 'in_progress' then 'In progress' when 'resolved' then 'Resolved' else 'Open' end,
    'submitted_at',to_char(new.submitted_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI"Z"')
  )
  into v_note
  from (select 1) seed
  left join public.games g on g.id=new.game_id
  left join public.members m on m.user_id=new.created_by;

  v_source := case new.submission_origin
    when 'public_games' then 'Public games page'
    else 'Member website'
  end;
  perform private.snh_enqueue_club_note_notification(
    'club_note_created:' || new.id::text,v_source,jsonb_build_array(v_note)
  );
  return new;
end;
$$;
revoke all on function private.snh_club_issue_note_created_after_insert()
  from public,anon,authenticated,service_role;

drop trigger if exists trg_club_issue_note_created_after_insert on public.club_issues;
create trigger trg_club_issue_note_created_after_insert
  after insert on public.club_issues
  for each row execute function private.snh_club_issue_note_created_after_insert();

-- Keep the idempotent Pinball Map Note import in one transaction, and enqueue
-- one grouped notice for only the Notes newly inserted during this import run.
create or replace function public.snh_pinballmap_import_conditions(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row jsonb;
  v_source_key text;
  v_comment text;
  v_machine_name text;
  v_mid int;
  v_created_at timestamptz;
  v_game_id uuid;
  v_issue_id uuid;
  v_imported int := 0;
  v_issue_title text;
  v_game_title text;
  v_notes jsonb := '[]'::jsonb;
  v_event_suffix text;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'rows', '[]'::jsonb))
  loop
    v_source_key := nullif(trim(v_row->>'submissionId'), '');
    v_comment := nullif(trim(v_row->>'comment'), '');
    v_machine_name := nullif(trim(v_row->>'machineName'), '');
    v_mid := (v_row->>'machineId')::int;
    v_created_at := coalesce((v_row->>'createdAt')::timestamptz, now());

    if v_source_key is null or v_comment is null or v_machine_name is null then
      continue;
    end if;

    insert into public.club_issue_import_keys(source, source_key)
    values ('pinballmap', v_source_key)
    on conflict (source, source_key) do nothing;
    if not found then
      continue;
    end if;

    v_game_id := private.snh_pinballmap_resolve_game_for_condition(v_mid, v_machine_name, v_created_at);
    v_issue_title := 'Pinball Map: ' || left(v_machine_name, 280);

    insert into public.club_issues (
      game_id,title,body,status,created_at,updated_at,submitted_at,created_by,submission_origin
    ) values (
      v_game_id,v_issue_title,v_comment,'open',v_created_at,v_created_at,v_created_at,null,'pinballmap'
    )
    returning id into v_issue_id;

    update public.club_issue_import_keys
    set club_issue_id = v_issue_id
    where source='pinballmap' and source_key=v_source_key;

    select g.title into v_game_title from public.games g where g.id=v_game_id;
    v_notes := v_notes || jsonb_build_array(jsonb_build_object(
      'title',v_issue_title,
      'body',v_comment,
      'game_title',coalesce(v_game_title,v_machine_name),
      'submitted_by','Pinball Map',
      'status','Open',
      'submitted_at',to_char(v_created_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI"Z"')
    ));
    v_imported := v_imported + 1;
  end loop;

  if v_imported > 0 then
    v_event_suffix := coalesce(nullif(btrim(p_payload->>'run_id'),''),gen_random_uuid()::text);
    perform private.snh_enqueue_club_note_notification(
      'pinballmap_notes_import:' || v_event_suffix,'Pinball Map',v_notes
    );
  end if;

  return jsonb_build_object('ok', true, 'imported', v_imported);
end;
$$;

revoke all on function public.snh_pinballmap_import_conditions(jsonb) from public;
grant execute on function public.snh_pinballmap_import_conditions(jsonb) to service_role;

commit;
