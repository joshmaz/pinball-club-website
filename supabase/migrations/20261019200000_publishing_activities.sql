begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('publishing-private','publishing-private',false,8388608,array['image/webp']),
 ('publishing-public','publishing-public',true,8388608,array['image/webp']);
-- No browser object policies: all writes and private reads go through the authenticated media worker.
create table public.publishing_images(
 id uuid primary key default gen_random_uuid(), title text not null check(length(title) between 1 and 120),
 alt text not null check(length(alt) between 1 and 300),
 state text not null default 'pending' check(state in ('pending','ready','deleting','deleted')),
 created_at timestamptz not null default now(), protected_until timestamptz not null default now()
);
alter table public.publishing_images enable row level security;
revoke all on public.publishing_images from public,anon,authenticated;

create function public.snh_publishing_images() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc),'[]'::jsonb) from public.publishing_images i where state<>'deleted');
end $$;
create function public.snh_publishing_image_write(p_action text,p_id uuid default null,p_title text default null,p_alt text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.publishing_images;
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('publishing-media'));
 if p_action='reserve' then
  if length(trim(coalesce(p_title,''))) not between 1 and 120 or length(trim(coalesce(p_alt,''))) not between 1 and 300 then raise exception 'Enter an image title and description' using errcode='22023'; end if;
  insert into public.publishing_images(title,alt) values(trim(p_title),trim(p_alt)) returning * into v;
 else
  select * into v from public.publishing_images where id=p_id for update;
  if not found then raise exception 'Image not found' using errcode='P0002'; end if;
  if p_action='finish' then
   if v.state<>'pending' or not exists(select 1 from storage.objects where bucket_id='publishing-private' and name=v.id::text||'/web.webp')
     or not exists(select 1 from storage.objects where bucket_id='publishing-private' and name=v.id::text||'/thumb.webp') then raise exception 'Image upload is incomplete'; end if;
   update public.publishing_images set state='ready' where id=p_id returning * into v;
  elsif p_action in ('remove','removed') then
   if not public.snh_member_has_publishing_admin_access() then raise exception 'Publishing Admin required' using errcode='42501'; end if;
   if exists(select 1 from public.publishing_entries where kind='activity' and (draft->>'image_id'=p_id::text or published->>'image_id'=p_id::text)) then raise exception 'Image is used by an activity draft or publication'; end if;
   if v.protected_until>now() then raise exception 'Image publication is in progress. Try cleanup later'; end if;
   if v.created_at>now()-interval '10 minutes' then raise exception 'Wait ten minutes after upload before deleting an unused image'; end if;
   if p_action='removed' and (v.state<>'deleting' or exists(select 1 from storage.objects where bucket_id in ('publishing-private','publishing-public') and name in (p_id::text||'/web.webp',p_id::text||'/thumb.webp'))) then raise exception 'Storage cleanup is incomplete'; end if;
   update public.publishing_images set state=case when p_action='remove' then 'deleting' else 'deleted' end where id=p_id returning * into v;
  else raise exception 'Unknown image action' using errcode='22023'; end if;
 end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,metadata)
 values('publishing','image_'||p_action,auth.uid(),'publishing_image',v.id::text,jsonb_build_object('title',v.title));
 return to_jsonb(v);
end $$;

create function public.snh_publishing_activities() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(e) order by e.updated_at desc,e.id),'[]'::jsonb) from public.publishing_entries e where kind='activity');
end $$;
create function public.snh_publishing_activity_write(p_action text,p_id uuid default null,p_version integer default null,p_values jsonb default null)
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
 values('publishing',case when p_id is null then 'create' else p_action end,auth.uid(),'activity',v.id::text,old_value,case when p_action='delete' then null else to_jsonb(v) end);
 return case when p_action='delete' then jsonb_build_object('id',p_id,'deleted',true) else to_jsonb(v) end;
end $$;
create function public.snh_public_activities() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id)||published order by (published->>'position')::integer,id),'[]'::jsonb)
 from (select id,published from public.publishing_entries where kind='activity' and not archived and published is not null
 and (published->>'starts_at')::timestamptz<=now() and ((published->>'ends_at') is null or (published->>'ends_at')::timestamptz>now())
 order by (published->>'position')::integer,id limit 6) active;
$$;
revoke all on function public.snh_publishing_images(),public.snh_publishing_image_write(text,uuid,text,text),public.snh_publishing_activities(),public.snh_publishing_activity_write(text,uuid,integer,jsonb),public.snh_public_activities() from public,anon,authenticated;
grant execute on function public.snh_publishing_images(),public.snh_publishing_image_write(text,uuid,text,text),public.snh_publishing_activities(),public.snh_publishing_activity_write(text,uuid,integer,jsonb) to authenticated;
grant execute on function public.snh_public_activities() to anon,authenticated;
commit;
