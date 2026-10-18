begin;
alter table public.publishing_entries add column draft_discord boolean not null default false,
 add column discord_requested boolean not null default false;
-- A single durable delivery record per announcement; content deletion retains a
-- withdrawal tombstone until its existing Discord message has been updated.
create table public.publishing_discord (
 entry_id uuid primary key, revision integer not null default 1,
 snapshot jsonb, requested boolean not null default false,
 status text not null default 'pending' check(status in ('pending','sending','shared','failed','uncertain','not_shared','skipped')),
 message_id text, channel_id text, lease_id uuid, leased_at timestamptz,
 attempts integer not null default 0, last_error text, updated_at timestamptz not null default now()
);
alter table public.publishing_discord enable row level security;
revoke all on public.publishing_discord from public,anon,authenticated;

create function private.snh_queue_publishing_discord() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_snapshot jsonb; v_requested boolean;
begin
 if tg_op='DELETE' then v_id:=old.id; v_requested:=false;
 else v_id:=new.id; v_requested:=new.discord_requested; v_snapshot:=new.published;
 end if;
 if tg_op='UPDATE' and old.published is not distinct from new.published
  and old.discord_requested=new.discord_requested then return null; end if;
 if not v_requested then v_snapshot:=null; end if;
 if v_snapshot is null and not exists(select 1 from public.publishing_discord where entry_id=v_id) then return null; end if;
 insert into public.publishing_discord(entry_id,snapshot,requested)
 values(v_id,v_snapshot,v_requested)
 on conflict(entry_id) do update set snapshot=excluded.snapshot,requested=excluded.requested,
 revision=public.publishing_discord.revision+1,
 -- Never lose an in-flight or ambiguous first POST. Its result must be reconciled.
 status=case when public.publishing_discord.status in ('sending','uncertain') then public.publishing_discord.status else 'pending' end,
 last_error=null,updated_at=now();
 return null;
end $$;
revoke all on function private.snh_queue_publishing_discord() from public,anon,authenticated;
create trigger publishing_discord_queue after insert or update or delete on public.publishing_entries
 for each row execute function private.snh_queue_publishing_discord();

-- Preserve the reviewed core write logic. Only the wrapper remains callable.
alter function public.snh_publishing_write(text,uuid,integer,text,text,text,timestamptz,timestamptz) rename to snh_publishing_write_core;
revoke all on function public.snh_publishing_write_core(text,uuid,integer,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
create function public.snh_publishing_write(
 p_action text,p_id uuid default null,p_version integer default null,
 p_title text default null,p_body text default null,p_url text default null,
 p_starts_at timestamptz default null,p_ends_at timestamptz default null,p_share_discord boolean default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v jsonb; v_changed boolean;
begin
 v:=public.snh_publishing_write_core(p_action,p_id,p_version,p_title,p_body,p_url,p_starts_at,p_ends_at);
 if p_action='save' and p_share_discord is not null then
  update public.publishing_entries set draft_discord=p_share_discord,
   version=case when version=p_version then version+1 else version end,updated_at=now()
  where id=(v->>'id')::uuid and draft_discord<>p_share_discord;
  v_changed:=found;
 elsif p_action='publish' then
  update public.publishing_entries set discord_requested=draft_discord where id=p_id;
 end if;
 if v_changed then
  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
  values('publishing','discord_preference',auth.uid(),'announcement',v->>'id',jsonb_build_object('share_to_discord',p_share_discord));
 end if;
 if p_action<>'delete' then select to_jsonb(e) into v from public.publishing_entries e where id=(v->>'id')::uuid; end if;
 return v;
end $$;
revoke all on function public.snh_publishing_write(text,uuid,integer,text,text,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.snh_publishing_write(text,uuid,integer,text,text,text,timestamptz,timestamptz,boolean) to authenticated;

create table public.publishing_discord_config(id boolean primary key default true check(id),guild_id text not null check(guild_id ~ '^[0-9]{15,25}$'),channel_id text not null check(channel_id ~ '^[0-9]{15,25}$'));
alter table public.publishing_discord_config enable row level security;
revoke all on public.publishing_discord_config from public,anon,authenticated;
grant select,insert,update on public.publishing_discord_config to service_role;


create function public.snh_publishing_discord_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('entry_id',entry_id,'status',status,'last_error',last_error,
 'message_id',message_id,'channel_id',channel_id,'guild_id',(select guild_id from public.publishing_discord_config where id),'attempts',attempts)),'[]'::jsonb) from public.publishing_discord);
end $$;
create function public.snh_retry_publishing_discord(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not public.snh_member_has_publishing_access() then raise exception 'Publishing access required' using errcode='42501'; end if;
 update public.publishing_discord set status='pending',last_error=null where entry_id=p_id and status='failed';
 if not found then return false; end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id) values('publishing','discord_retry',auth.uid(),'announcement',p_id::text);
 return true;
end $$;
-- Ambiguous first sends are never blindly retried. Admin copies the existing
-- message link from Discord, or confirms that no message was created.
create function public.snh_reconcile_publishing_discord(p_id uuid,p_message_id text default null,p_channel_id text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not public.snh_member_has_publishing_admin_access() then raise exception 'Publishing Admin required' using errcode='42501'; end if;
 if (p_message_id is null)<>(p_channel_id is null) or (p_message_id is not null and (p_message_id !~ '^[0-9]{15,25}$' or p_channel_id !~ '^[0-9]{15,25}$')) then raise exception 'Invalid Discord IDs' using errcode='22023'; end if;
 if p_channel_id is not null and not exists(select 1 from public.publishing_discord_config where id and channel_id=p_channel_id) then raise exception 'Message must belong to the configured channel' using errcode='22023'; end if;
 update public.publishing_discord set message_id=p_message_id,channel_id=p_channel_id,status='pending',last_error=null,lease_id=null,leased_at=null
 where entry_id=p_id and (status='uncertain' or (status='sending' and leased_at<now()-interval '5 minutes'));
 if not found then return false; end if;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('publishing','discord_reconcile',auth.uid(),'announcement',p_id::text,jsonb_build_object('message_id',p_message_id,'channel_id',p_channel_id));
 return true;
end $$;

create function public.snh_claim_publishing_discord() returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.publishing_discord;
begin
 -- A crashed worker may have posted. Require reconciliation after its lease ends.
 update public.publishing_discord set status='uncertain',last_error='Delivery interrupted. Check Discord before reconciling.'
 where status='sending' and leased_at<now()-interval '5 minutes';
 select * into v from public.publishing_discord where status='pending'
 and (snapshot is null or (snapshot->>'starts_at')::timestamptz<=now())
 order by updated_at,entry_id for update skip locked limit 1;
 if not found then return null; end if;
 if v.message_id is null and (v.snapshot is null or (v.snapshot->>'ends_at')::timestamptz<=now()) then
  update public.publishing_discord set status=case when v.snapshot is null then 'not_shared' else 'skipped' end where entry_id=v.entry_id;
  return jsonb_build_object('skip',true);
 end if;
 update public.publishing_discord set status='sending',lease_id=gen_random_uuid(),leased_at=now(),attempts=attempts+1
 where entry_id=v.entry_id returning * into v;
 insert into public.audit_log(module,action,entity_type,entity_id,new_data)
 values('publishing','discord_attempt','announcement',v.entry_id::text,jsonb_build_object('revision',v.revision,'attempt',v.attempts));
 return to_jsonb(v);
end $$;
create function public.snh_finish_publishing_discord(p_id uuid,p_lease uuid,p_revision integer,p_status text,
 p_message_id text default null,p_channel_id text default null,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.publishing_discord;
begin
 if p_status not in ('shared','failed','uncertain') or p_status is null then raise exception 'Invalid delivery status'; end if;
 select * into v from public.publishing_discord where entry_id=p_id and lease_id=p_lease and status='sending' for update;
 if not found then return false; end if;
 if p_status='shared' and (coalesce(p_message_id,v.message_id) is null or coalesce(p_channel_id,v.channel_id) is null) then raise exception 'Message identity required'; end if;
 update public.publishing_discord set status=case when p_status='shared' and revision<>p_revision then 'pending' else p_status end,
 message_id=coalesce(p_message_id,message_id),channel_id=coalesce(p_channel_id,channel_id),last_error=left(p_error,240),lease_id=null,leased_at=null,updated_at=now()
 where entry_id=p_id;
 insert into public.audit_log(module,action,entity_type,entity_id,new_data)
 values('publishing','discord_'||p_status,'announcement',p_id::text,jsonb_build_object('message_id',p_message_id,'error',left(p_error,240)));
 return true;
end $$;

-- Public detail and history expose only eligible published snapshots and an
-- already-confirmed Discord message link. No worker internals or drafts escape.
create function public.snh_public_announcement(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',e.id,'title',e.published->>'title','body',e.published->>'body','url',e.published->>'url',
 'starts_at',e.published->>'starts_at','ends_at',e.published->>'ends_at','published_at',e.published_at,
 'discord_guild_id',(select guild_id from public.publishing_discord_config where id),
 'discord_message_id',case when e.discord_requested then d.message_id end,'discord_channel_id',case when e.discord_requested then d.channel_id end)
 from public.publishing_entries e left join public.publishing_discord d on d.entry_id=e.id
 where e.id=p_id and e.kind='announcement' and e.published is not null and (e.published->>'starts_at')::timestamptz<=now();
$$;
-- Discord deep links also need the server ID. Keep it in a public config row,
-- while the credential itself exists only in server-side Edge Function secrets.
create function public.snh_public_discord_guild() returns text language sql stable security definer set search_path='' as $$ select guild_id from public.publishing_discord_config where id $$;

revoke all on function public.snh_publishing_discord_status(), public.snh_retry_publishing_discord(uuid), public.snh_reconcile_publishing_discord(uuid,text,text) from public,anon,authenticated;
grant execute on function public.snh_publishing_discord_status(), public.snh_retry_publishing_discord(uuid), public.snh_reconcile_publishing_discord(uuid,text,text) to authenticated;
revoke all on function public.snh_claim_publishing_discord(), public.snh_finish_publishing_discord(uuid,uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.snh_claim_publishing_discord(), public.snh_finish_publishing_discord(uuid,uuid,integer,text,text,text,text) to service_role;
revoke all on function public.snh_public_announcement(uuid),public.snh_public_discord_guild() from public,anon,authenticated;
grant execute on function public.snh_public_announcement(uuid),public.snh_public_discord_guild() to anon,authenticated;
create function public.snh_public_announcement_page(p_before_start timestamptz default null,p_before_id uuid default null,
 p_after_start timestamptz default null,p_after_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb;
begin
 if (p_before_start is null)<>(p_before_id is null) or (p_after_start is null)<>(p_after_id is null)
 or (p_before_start is not null and p_after_start is not null) then raise exception 'Invalid page cursor' using errcode='22023'; end if;
 select coalesce(jsonb_agg(page.data order by page.starts_at desc,page.id desc),'[]'::jsonb) into v_rows from (
 select e.id,(e.published->>'starts_at')::timestamptz starts_at, public.snh_public_announcement(e.id) data
 from public.publishing_entries e where e.kind='announcement' and e.published is not null
 and (e.published->>'starts_at')::timestamptz<=now()
 and (p_before_start is null or ((e.published->>'starts_at')::timestamptz,e.id)<(p_before_start,p_before_id))
 and (p_after_start is null or ((e.published->>'starts_at')::timestamptz,e.id)>(p_after_start,p_after_id))
 order by case when p_after_start is null then (e.published->>'starts_at')::timestamptz end desc,
 case when p_after_start is null then e.id end desc,
 case when p_after_start is not null then (e.published->>'starts_at')::timestamptz end asc,e.id asc limit 10
 ) page;
 return jsonb_build_object('entries',v_rows,
 'has_newer',exists(select 1 from public.publishing_entries e where e.kind='announcement' and e.published is not null and (e.published->>'starts_at')::timestamptz<=now()
 and ((e.published->>'starts_at')::timestamptz,e.id)>((v_rows->0->>'starts_at')::timestamptz,(v_rows->0->>'id')::uuid)),
 'has_older',exists(select 1 from public.publishing_entries e where e.kind='announcement' and e.published is not null and (e.published->>'starts_at')::timestamptz<=now()
 and ((e.published->>'starts_at')::timestamptz,e.id)<((v_rows->-1->>'starts_at')::timestamptz,(v_rows->-1->>'id')::uuid)));
end $$;
revoke all on function public.snh_public_announcement_page(timestamptz,uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.snh_public_announcement_page(timestamptz,uuid,timestamptz,uuid) to anon,authenticated;

commit;
