-- Shared lightweight publishing: edits remain private until explicitly published.
begin;
create table public.publishing_entries (
 id uuid primary key default gen_random_uuid(),
 kind text not null default 'announcement' check (kind in ('announcement','activity')),
 version integer not null default 1,
 draft jsonb not null,
 published jsonb,
 published_at timestamptz,
 archived boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.publishing_entries enable row level security;
revoke all on public.publishing_entries from public, anon, authenticated;
comment on table public.publishing_entries is 'Private drafts and independent published snapshots. Access only through restricted Publishing RPCs.';

create function public.snh_publishing_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not public.snh_member_has_publishing_access() then
  raise exception 'Publishing access required' using errcode='42501';
 end if;
 return (select coalesce(jsonb_agg(to_jsonb(e) order by e.updated_at desc,e.id), '[]'::jsonb)
 from public.publishing_entries e where kind='announcement');
end $$;

-- One RPC serializes writes and rejects stale editor versions.
create function public.snh_publishing_write(
 p_action text, p_id uuid default null, p_version integer default null,
 p_title text default null, p_body text default null, p_url text default null,
 p_starts_at timestamptz default null, p_ends_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 v public.publishing_entries; v_before jsonb; v_after jsonb; v_draft jsonb;
begin
 if not public.snh_member_has_publishing_access() then
  raise exception 'Publishing access required' using errcode='42501';
 end if;
 if p_action is null or p_action not in ('save','publish','withdraw','archive','restore','delete') then
  raise exception 'Unknown publishing action' using errcode='22023';
 end if;
 if p_id is not null then
  select * into v from public.publishing_entries where id=p_id and kind='announcement' for update;
  if not found then raise exception 'Announcement not found' using errcode='P0002'; end if;
  if p_version is distinct from v.version then
   raise exception 'This announcement changed. Reload it before saving.' using errcode='40001';
  end if;
  v_before := to_jsonb(v);
 elsif p_action <> 'save' or p_version is not null then
  raise exception 'Save a draft first' using errcode='22023';
 end if;
 if p_action='save' then
  if p_title is null or length(trim(p_title)) not between 1 and 120
   or p_body is null or length(trim(p_body)) not between 1 and 2000
   or length(coalesce(p_url,''))>2000
   or (nullif(trim(p_url),'') is not null and trim(p_url) !~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')
   or (p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at)
   or (p_starts_at is not null and not isfinite(p_starts_at))
   or (p_ends_at is not null and not isfinite(p_ends_at)) then
   raise exception 'Check title, text, web link, and publication dates' using errcode='22023';
  end if;
  v_draft := jsonb_build_object('title',trim(p_title),'body',trim(p_body),
   'url',nullif(trim(p_url),''),'starts_at',p_starts_at,'ends_at',p_ends_at);
  if p_id is null then
   insert into public.publishing_entries(draft) values(v_draft) returning * into v;
  elsif v.draft=v_draft then return to_jsonb(v);
  else update public.publishing_entries set draft=v_draft,version=version+1,updated_at=now()
   where id=p_id returning * into v;
  end if;
 elsif p_action='delete' then
  if not public.snh_member_has_publishing_admin_access() then
   raise exception 'Publishing Admin required for permanent deletion' using errcode='42501';
  end if;
  if not v.archived or v.published is not null then
   raise exception 'Withdraw and archive before permanent deletion' using errcode='22023';
  end if;
  delete from public.publishing_entries where id=p_id;
  v_after := '{}'::jsonb;
 else
  if p_action='publish' then
   if v.archived then raise exception 'Restore before publishing' using errcode='22023'; end if;
   if (v.draft->>'ends_at')::timestamptz <= coalesce((v.draft->>'starts_at')::timestamptz,now()) then
    raise exception 'Publication end must follow its start' using errcode='22023';
   end if;
   v_draft := v.draft || jsonb_build_object('starts_at',coalesce((v.draft->>'starts_at')::timestamptz,now()));
   update public.publishing_entries set published=v_draft,published_at=now(),version=version+1,updated_at=now()
    where id=p_id returning * into v;
  elsif p_action='withdraw' then
   if v.published is null then return to_jsonb(v); end if;
   update public.publishing_entries set published=null,published_at=null,version=version+1,updated_at=now()
    where id=p_id returning * into v;
  else
   if v.archived=(p_action='archive') then return to_jsonb(v); end if;
   update public.publishing_entries set archived=(p_action='archive'),version=version+1,updated_at=now()
    where id=p_id returning * into v;
  end if;
 end if;
 if p_action<>'delete' then v_after:=to_jsonb(v); end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data,metadata)
 values('publishing',case when p_id is null then 'create' else p_action end,auth.uid(),'announcement',v.id::text,
 coalesce(v_before,'{}'::jsonb) || case when v_before is null then '{}'::jsonb else jsonb_build_object('title',v_before->'draft'->>'title') end,
 v_after || case when p_action='delete' then '{}'::jsonb else jsonb_build_object('title',v.draft->>'title') end,jsonb_build_object('title',v.draft->>'title'));
 return case when p_action='delete' then jsonb_build_object('id',p_id,'deleted',true) else to_jsonb(v) end;
end $$;

-- Public projection never exposes drafts, actor identity, or future publications.
create function public.snh_public_announcements(p_history boolean default false, p_limit integer default 20,
 p_before_start timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if p_history is null or p_limit is null or p_limit not between 1 and 50
  or (p_before_start is null)<>(p_before_id is null) then
  raise exception 'Invalid announcement request' using errcode='22023';
 end if;
 return (select coalesce(jsonb_agg(to_jsonb(page) order by starts_at desc,id desc),'[]'::jsonb) from (
 select e.id,e.published->>'title' title,e.published->>'body' body,e.published->>'url' url,
 (e.published->>'starts_at')::timestamptz starts_at,(e.published->>'ends_at')::timestamptz ends_at,e.published_at
 from public.publishing_entries e
 where e.kind='announcement' and e.published is not null
 and (e.published->>'starts_at')::timestamptz<=now()
 and (p_history or (not e.archived and ((e.published->>'ends_at') is null or (e.published->>'ends_at')::timestamptz>now())))
 and (p_before_start is null or ((e.published->>'starts_at')::timestamptz,e.id)<(p_before_start,p_before_id))
 order by (e.published->>'starts_at')::timestamptz desc,e.id desc limit p_limit
 ) page);
end $$;
revoke all on function public.snh_publishing_list() from public,anon,authenticated;
revoke all on function public.snh_publishing_write(text,uuid,integer,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.snh_public_announcements(boolean,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.snh_publishing_list() to authenticated;
grant execute on function public.snh_publishing_write(text,uuid,integer,text,text,text,timestamptz,timestamptz) to authenticated;
grant execute on function public.snh_public_announcements(boolean,integer,timestamptz,uuid) to anon,authenticated;
commit;
