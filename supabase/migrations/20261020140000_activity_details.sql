-- Rich Activities preserve draft/public separation and the existing media workflow.
begin;
create function private.snh_activity_content(p jsonb, legacy boolean default false) returns jsonb
language plpgsql immutable set search_path='' as $$
declare links jsonb; item jsonb; dest text; target text; summary text; details text;
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid Activity content' using errcode='22023'; end if;
 summary:=trim(coalesce(p->>'body',''));details:=coalesce(p->>'details','');
 if legacy then
  links:=case when nullif(trim(p->>'url'),'') is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('url',trim(p->>'url'),'label','Find out more')) end;
  dest:=case when jsonb_array_length(links)>0 then 'external' else 'internal' end;
  target:=links->0->>'url';
  if length(summary)>240 then details:=p->>'body';summary:=left(summary,237)||'…'; end if;
 else
  links:=coalesce(p->'links','[]'::jsonb);dest:=coalesce(p->>'destination','internal');target:=nullif(p->>'destination_url','');
 end if;
 if jsonb_typeof(links) is distinct from 'array' then raise exception 'Links must be a list' using errcode='22023'; end if;
 if jsonb_array_length(links)>5 or length(summary) not between 1 and 240 or length(details)>5000 or dest not in ('internal','external') then raise exception 'Use a summary up to 240 characters, details up to 5,000, and at most five links' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(links) loop
  if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'url') is distinct from 'string'
   or length(item->>'url')>2000 or (item->>'url') !~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
   or (item ? 'label' and jsonb_typeof(item->'label') is distinct from 'string') or length(coalesce(item->>'label',''))>200
  then raise exception 'Each link needs an HTTP(S) URL up to 2,000 characters and a label up to 200' using errcode='22023'; end if;
 end loop;
 if dest='external' and (target is null or not exists(select 1 from jsonb_array_elements(links) l where l->>'url'=target)) then raise exception 'Select a current link as the card destination' using errcode='22023'; end if;
 return (p-'url')||jsonb_build_object('body',summary,'details',details,'links',links,'destination',dest,'destination_url',case when dest='external' then target end)
  ||case when legacy and length(trim(p->>'body'))>240 then jsonb_build_object('summary_needs_review',true) else '{}'::jsonb end;
end $$;
revoke all on function private.snh_activity_content(jsonb,boolean) from public,anon,authenticated;
-- Convert each snapshot independently. Bump versions to invalidate editors opened before migration.
update public.publishing_entries set
 draft=private.snh_activity_content(draft,true),
 published=case when published is not null then private.snh_activity_content(published,true) end,
 version=version+1
where kind='activity';
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
  if p_version is distinct from v.version then raise exception 'Activity changed. Return to the list and reopen it.' using errcode='PT409'; end if;
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
  p_values:=private.snh_activity_content(p_values,false);
  start_at:=nullif(p_values->>'starts_at','')::timestamptz;end_at:=nullif(p_values->>'ends_at','')::timestamptz;
  ordinal:=coalesce((p_values->>'position')::integer,0);x:=coalesce((p_values->>'focus_x')::integer,50);y:=coalesce((p_values->>'focus_y')::integer,50);
  image_id:=nullif(p_values->>'image_id','')::uuid;
  if length(trim(coalesce(p_values->>'title',''))) not between 1 and 120 or length(trim(coalesce(p_values->>'body',''))) not between 1 and 240
   or (start_at is not null and not isfinite(start_at)) or (end_at is not null and not isfinite(end_at))
   or (start_at is not null and end_at<=start_at) or ordinal not between 0 and 999 or x not between 0 and 100 or y not between 0 and 100
   or coalesce(p_values->>'fit','cover') not in ('cover','contain') then raise exception 'Check activity fields and dates' using errcode='22023'; end if;
  if image_id is not null then
   select * into image from public.publishing_images where id=image_id and state='ready';
   if not found then raise exception 'Choose an uploaded library image'; end if;
   if length(trim(coalesce(p_values->>'image_alt',''))) not between 1 and 300 then raise exception 'Describe the activity image'; end if;
  end if;
  d:=jsonb_build_object('title',trim(p_values->>'title'),'body',trim(p_values->>'body'),
   'details',p_values->>'details','links',p_values->'links','destination',p_values->>'destination','destination_url',p_values->>'destination_url',
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

create function public.snh_public_activity(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'ended',coalesce((published->>'ends_at')::timestamptz<=now(),false))||published
 from public.publishing_entries
 where id=p_id and kind='activity' and published is not null and (published->>'starts_at')::timestamptz<=now();
$$;
revoke all on function public.snh_public_activity(uuid) from public;
grant execute on function public.snh_public_activity(uuid) to anon,authenticated;
commit;
