begin;

alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('member_signup','pinballmap_failure','pinballmap_game_changes'));

create or replace function private.snh_pinballmap_record_changes(p_run uuid,p_before jsonb,p_after jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_row record;
  v_fields jsonb;
  v_changes jsonb := '[]';
  v_counts jsonb := '{}';
  v_events jsonb := '[]';
  v_count integer := 0;
  v_kind text;
  v_was_at_club boolean;
  v_is_at_club boolean;
  v_event_action text;
begin
  for v_row in select key,value from jsonb_each(p_after) loop
    if p_before->v_row.key->'data' is not distinct from v_row.value->'data' then continue; end if;
    select coalesce(jsonb_agg(k order by k),'[]') into v_fields
    from jsonb_object_keys(v_row.value->'data') k
    where k not in ('id','game_id') and
      (p_before->v_row.key is null and v_row.value->'data'->k <> 'null'::jsonb
        or p_before->v_row.key is not null and p_before->v_row.key->'data'->k is distinct from v_row.value->'data'->k);
    v_kind := v_row.value->>'kind';
    v_counts := jsonb_set(v_counts,array[v_kind],to_jsonb(coalesce((v_counts->>v_kind)::integer,0)+1));
    v_count := v_count+1;
    if jsonb_array_length(v_changes)<100 then
      v_changes := v_changes||jsonb_build_array(jsonb_build_object('kind',v_kind,'title',v_row.value->>'title',
        'game_id',v_row.value->>'game_id','action',case when p_before->v_row.key is null then 'added' else 'changed' end,'fields',v_fields));
    end if;

    if v_kind = 'games' then
      v_was_at_club := coalesce((p_before->v_row.key->'data'->>'map_at_club')::boolean,false);
      v_is_at_club := coalesce((v_row.value->'data'->>'map_at_club')::boolean,false);
      v_event_action := null;
      if not v_was_at_club and v_is_at_club then v_event_action := 'added';
      elsif v_was_at_club and not v_is_at_club then v_event_action := 'removed';
      end if;
      if v_event_action is not null and jsonb_array_length(v_events)<100 then
        v_events := v_events||jsonb_build_array(jsonb_build_object(
          'action',v_event_action,'game_id',v_row.value->>'game_id','title',v_row.value->>'title'));
      end if;
    end if;
  end loop;

  update public.operations_job_runs set result=result||jsonb_build_object(
    'change_count',coalesce((result->>'change_count')::integer,0)+v_count,
    'counts',jsonb_build_object(
      'games',coalesce((result->'counts'->>'games')::integer,0)+coalesce((v_counts->>'games')::integer,0),
      'locations',coalesce((result->'counts'->>'locations')::integer,0)+coalesce((v_counts->>'locations')::integer,0),
      'conditions',coalesce((result->'counts'->>'conditions')::integer,0)+coalesce((v_counts->>'conditions')::integer,0),
      'images',coalesce((result->'counts'->>'images')::integer,0)+coalesce((v_counts->>'images')::integer,0)),
    'changes',(select coalesce(jsonb_agg(value),'[]') from (select value from jsonb_array_elements(coalesce(result->'changes','[]')||v_changes) limit 100) c),
    'pinballmap_events',(select coalesce(jsonb_agg(value),'[]') from (select value from jsonb_array_elements(coalesce(result->'pinballmap_events','[]')||v_events) limit 100) c))
  where id=p_run;
end; $$;

create function private.snh_pinballmap_enqueue_game_changes(p_run uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_run public.operations_job_runs;
  v_added text[];
  v_removed text[];
  v_recipient record;
  v_body text;
begin
  select * into v_run from public.operations_job_runs
    where id=p_run and job='pinballmap_ingest';
  if not found then return; end if;

  select coalesce(array_agg(title order by title) filter (where action='added'),'{}'::text[]),
         coalesce(array_agg(title order by title) filter (where action='removed'),'{}'::text[])
    into v_added,v_removed
  from (
    select distinct e->>'title' as title,e->>'action' as action
    from jsonb_array_elements(coalesce(v_run.result->'pinballmap_events','[]'::jsonb)) e
    where nullif(btrim(e->>'title'),'') is not null
      and e->>'action' in ('added','removed')
  ) events;

  if cardinality(v_added)=0 and cardinality(v_removed)=0 then return; end if;

  v_body :=
    'The Pinball Map import updated the games listed at the SNHPC club location.'||E'\n\n'||
    'You’re receiving this notice because your website role includes Games Editor access or higher.'||E'\n\n'||
    'Added at the club:'||E'\n'||coalesce(array_to_string(v_added,E'\n'),'None')||E'\n\n'||
    'Removed from the club:'||E'\n'||coalesce(array_to_string(v_removed,E'\n'),'None')||E'\n\n'||
    'If any games are listed under Added, review them in Games Management. Verify their metadata, add or confirm third-party links, and generate the club description. Pinball Map details are a starting point; please check them before publishing.'||E'\n\n'||
    'Removed games remain in the website’s history; this update reflects their Pinball Map club-location status.';

  for v_recipient in
    select distinct on (lower(btrim(m.email))) m.id,btrim(m.email) as email
    from public.members m
    where private.snh_member_has_effective_role(m.id,'games_editor')
      and m.user_id is not null
      and btrim(coalesce(m.email,'')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by lower(btrim(m.email)),m.id
  loop
    insert into public.notification_outbox
      (event_key,kind,recipient_member_id,recipient_email,subject,body,template_variables)
    values
      ('pinballmap_game_changes:'||p_run::text||':'||v_recipient.id::text,
       'pinballmap_game_changes',v_recipient.id,v_recipient.email,
       'Pinball Map game list updated',v_body,
       jsonb_build_object('ADDED_GAMES',to_jsonb(v_added),'REMOVED_GAMES',to_jsonb(v_removed)))
    on conflict(event_key) do nothing;
  end loop;
end; $$;

create function private.snh_pinballmap_game_changes_after_finish()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status='running' and new.status in ('succeeded','failed') then
    perform private.snh_pinballmap_enqueue_game_changes(new.id);
  end if;
  return new;
end; $$;

drop trigger if exists trg_pinballmap_game_changes_after_finish on public.operations_job_runs;
create trigger trg_pinballmap_game_changes_after_finish
  after update of status on public.operations_job_runs
  for each row
  when (new.job='pinballmap_ingest' and old.status='running' and new.status in ('succeeded','failed'))
  execute function private.snh_pinballmap_game_changes_after_finish();

revoke all on function private.snh_pinballmap_record_changes(uuid,jsonb,jsonb),
  private.snh_pinballmap_enqueue_game_changes(uuid),private.snh_pinballmap_game_changes_after_finish()
  from public,anon,authenticated,service_role;

commit;
