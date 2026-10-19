-- Match deployed audit_log NOT NULL before/after records.
begin;
create or replace function public.snh_publishing_activity_write(p_action text,p_id uuid default null,p_version integer default null,p_values jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.publishing_entries; old_value jsonb; d jsonb; image public.publishing_images; image_id uuid; start_at timestamptz; end_at timestamptz; ordinal integer; x integer; y integer;
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('publishing-media'));
 if p_action is null or p_action not in ('save','prepare_image','publish','withdraw','archive','restore','delete') then raise exception 'Unknown activity action' using errcode='22023'; end if;
 if p_id is not null then
  select * into v from public.publishing_entries where id=p_id and kind='activity' for update;
  if not found then raise exception 'Activity not found' using errcode='P0002'; end if;
  if p_version is distinct from v.version then raise exception 'Activity changed. Return to the list and reopen it.' using errcode='40001'; end if;
  old_value:=to_jsonb(v);
 elsif p_action<>'save' or p_version is not null then raise exception 'Save a draft first'; end if;
 if p_action='prepare_image' then
  if v.archived then raise exception 'Restore before publishing'; end if;
  image_id:=(v.draft->>'image_id')::uuid;
  if image_id is not null then
   update public.publishing_images set protected_until=now()+interval '10 minutes' where id=image_id and state='ready';
   if not found then raise exception 'Image is unavailable'; end if;
  end if;
  return to_jsonb(v);
 end if;
 if p_action='save' then
  start_at:=nullif(p_values->>'starts_at','')::timestamptz;end_at:=nullif(p_values->>'ends_at','')::timestamptz;
  ordinal:=coalesce((p_values->>'position')::integer,0);x:=coalesce((p_values->>'focus_x')::integer,50);y:=coalesce((p_values->>'focus_y')::integer,50);
  image_id:=nullif(p_values->>'image_id','')::uuid;
  if length(trim(coalesce(p_values->>'title',''))) not between 1 and 120 or length(trim(coalesce(p_values->>'body',''))) not between 1 and 1000
   or length(coalesce(p_values->>'url',''))>2000 or (nullif(trim(p_values->>'url'),'') is not null and trim(p_values->>'url') !~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')
   or (start_at is not null and not isfinite(start_at)) or (end_at is not null and not isfinite(end_at))
   or (start_at is not null and end_at<=start_at) or ordinal not between 0 and 999 or x not between 0 and 100 or y not between 0 and 100
   or coalesce(p_values->>'fit','cover') not in ('cover','contain') then raise exception 'Check activity fields and dates' using errcode='22023'; end if;
  if image_id is not null then
   select * into image from public.publishing_images where id=image_id and state='ready';
   if not found then raise exception 'Choose an uploaded library image'; end if;
   if length(trim(coalesce(p_values->>'image_alt',''))) not between 1 and 300 then raise exception 'Describe the activity image'; end if;
  end if;
  d:=jsonb_build_object('title',trim(p_values->>'title'),'body',trim(p_values->>'body'),'url',nullif(trim(p_values->>'url'),''),
   'starts_at',start_at,'ends_at',end_at,'position',ordinal,'image_id',image_id,'image_alt',case when image_id is not null then trim(p_values->>'image_alt') end,
   'fit',coalesce(p_values->>'fit','cover'),'focus_x',x,'focus_y',y);
  if p_id is null then insert into public.publishing_entries(kind,draft) values('activity',d) returning * into v;
  else update public.publishing_entries set draft=d,version=version+1,updated_at=now() where id=p_id returning * into v; end if;
 elsif p_action='publish' then
  if v.archived then raise exception 'Restore before publishing'; end if;
  d:=v.draft||jsonb_build_object('starts_at',coalesce((v.draft->>'starts_at')::timestamptz,now()));
  if (d->>'ends_at')::timestamptz<=(d->>'starts_at')::timestamptz then raise exception 'End must follow start'; end if;
  image_id:=(d->>'image_id')::uuid;
  if image_id is not null and (not exists(select 1 from public.publishing_images where id=image_id and state='ready') or not exists(select 1 from storage.objects where bucket_id='publishing-public' and name=image_id::text||'/web.webp')) then raise exception 'Publish through the image service to prepare its image'; end if;
  update public.publishing_entries set published=d,published_at=now(),version=version+1,updated_at=now() where id=p_id returning * into v;
 elsif p_action='withdraw' then update public.publishing_entries set published=null,published_at=null,version=version+1,updated_at=now() where id=p_id returning * into v;
 elsif p_action='delete' then
  if not public.snh_member_has_publishing_admin_access() then raise exception 'Publishing Admin required' using errcode='42501'; end if;
  if not v.archived or v.published is not null then raise exception 'Withdraw and archive before deletion'; end if;
  delete from public.publishing_entries where id=p_id;
 else update public.publishing_entries set archived=(p_action='archive'),version=version+1,updated_at=now() where id=p_id returning * into v;
 end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
 values('publishing',case when p_id is null then 'create' else p_action end,auth.uid(),'activity',v.id::text,coalesce(old_value,'{}'::jsonb),case when p_action='delete' then '{}'::jsonb else to_jsonb(v) end);
 return case when p_action='delete' then jsonb_build_object('id',p_id,'deleted',true) else to_jsonb(v) end;
end $$;
commit;
