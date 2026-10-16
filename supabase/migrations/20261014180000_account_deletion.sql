begin;
-- Preserve club contributions; only attribution follows the removed login.
alter table public.audit_log drop constraint audit_log_actor_user_id_fkey,
  add constraint audit_log_actor_user_id_fkey foreign key(actor_user_id) references auth.users(id) on delete set null;
alter table public.games drop constraint games_deleted_by_fkey,
  add constraint games_deleted_by_fkey foreign key(deleted_by) references auth.users(id) on delete set null;
alter table public.game_high_scores drop constraint game_high_scores_created_by_fkey,
  add constraint game_high_scores_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;
alter table public.game_custom_mods drop constraint game_custom_mods_created_by_fkey,
  add constraint game_custom_mods_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;
alter table public.club_issues drop constraint club_issues_created_by_fkey,
  add constraint club_issues_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;

-- Short-lived random receipts let a browser check a lost response after self-deletion.
-- No email/name/password is retained here. Not exposed as a REST table.
create table private.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  target_id uuid not null,
  reason text not null check(length(reason) between 1 and 250),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  active boolean not null default false
);
revoke all on private.account_deletion_requests from public,anon,authenticated,service_role;
create unique index account_deletion_active on private.account_deletion_requests(target_id) where active;
create index account_deletion_target on private.account_deletion_requests(target_id,created_at desc);

create function private.snh_check_account_deletion(p_actor uuid,p_target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a uuid; t uuid;
begin
  select id into a from public.members where user_id=p_actor;
  select id into t from public.members where user_id=p_target;
  if a is null or t is null then raise exception 'Account unavailable' using errcode='42501'; end if;
  if p_actor=p_target then
    if exists(select 1 from public.member_roles where member_id=t and role_slug='club_admin') then
      raise exception 'Another Website Administrator must delete this account' using errcode='42501';
    end if;
  elsif not private.snh_member_has_effective_role(a,'membership_admin') or (
    private.snh_member_has_effective_role(t,'membership_admin')
    and not private.snh_member_has_effective_role(a,'club_admin')) then
    raise exception 'Account deletion is not permitted for this member' using errcode='42501';
  end if;
  if exists(select 1 from public.member_roles where member_id=t and role_slug='club_admin')
    and (select count(*) from public.member_roles where role_slug='club_admin')<=1 then
    raise exception 'The final Website Administrator cannot be deleted' using errcode='42501';
  end if;
end; $$;
revoke all on function private.snh_check_account_deletion(uuid,uuid) from public,anon,authenticated,service_role;

create function public.snh_prepare_account_deletion(p_actor uuid,p_member_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target uuid; receipt uuid;
begin
  -- Serializes with role grants/revocations; actual Auth deletion checks again.
  lock table public.member_roles in share row exclusive mode;
  if p_member_id is null then target:=p_actor;
  else select user_id into target from public.members where id=p_member_id; end if;
  perform private.snh_check_account_deletion(p_actor,target);
  if nullif(btrim(p_reason),'') is null or length(p_reason)>250 then
    raise exception 'A reason of up to 250 characters is required' using errcode='22023';
  end if;
  insert into private.account_deletion_requests(actor_id,target_id,reason)
    values(p_actor,target,btrim(p_reason)) returning id into receipt;
  return receipt;
end; $$;

create function public.snh_account_deletion_request(p_receipt uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('actor_id',actor_id,'target_id',target_id,
    'completed',completed_at is not null or not exists(select 1 from auth.users u where u.id=target_id),
    'expires_at',created_at+interval '5 minutes')
  from private.account_deletion_requests where id=p_receipt and created_at>now()-interval '2 days';
$$;
revoke all on function public.snh_prepare_account_deletion(uuid,uuid,text),public.snh_account_deletion_request(uuid)
  from public,anon,authenticated;
grant execute on function public.snh_prepare_account_deletion(uuid,uuid,text),public.snh_account_deletion_request(uuid) to service_role;

create function public.snh_activate_account_deletion(p_receipt uuid,p_actor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r private.account_deletion_requests;
begin
  lock table public.member_roles in share row exclusive mode;
  select * into r from private.account_deletion_requests where id=p_receipt and actor_id=p_actor
    and created_at>now()-interval '5 minutes' and completed_at is null for update;
  if not found then raise exception 'Confirmation expired. Start again.' using errcode='42501'; end if;
  perform private.snh_check_account_deletion(p_actor,r.target_id);
  update private.account_deletion_requests set active=false
    where target_id=r.target_id and created_at<=now()-interval '5 minutes';
  if exists(select 1 from private.account_deletion_requests where target_id=r.target_id and active and id<>r.id) then
    raise exception 'Another confirmation is in progress. Check its status or wait five minutes.' using errcode='42501';
  end if;
  update private.account_deletion_requests set active=true where id=r.id;
  return r.target_id;
end; $$;
revoke all on function public.snh_activate_account_deletion(uuid,uuid) from public,anon,authenticated;
grant execute on function public.snh_activate_account_deletion(uuid,uuid) to service_role;

create function private.snh_guard_auth_account_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r private.account_deletion_requests; member uuid;
begin
  -- Protect the permission decision through the Auth deletion transaction.
  lock table public.member_roles in share row exclusive mode;
  select * into r from private.account_deletion_requests
    where target_id=old.id and active and completed_at is null and created_at>now()-interval '5 minutes'
    order by created_at desc limit 1 for update;
  if not found then raise exception 'Use the account deletion confirmation flow' using errcode='42501'; end if;
  perform private.snh_check_account_deletion(r.actor_id,old.id);
  -- Auth admin calls run without the caller JWT. Explicitly retain the operator,
  -- except for self-deletion where that operator is itself being removed.
  select id into member from public.members where user_id=old.id;
  update public.notification_outbox set body='Signup details removed after account deletion.',
    status=case when status in ('pending','sending') then 'canceled' else status end,
    lease_id=null,locked_until=null
    where kind='member_signup' and event_key like 'member_signup:'||member::text||':%';
  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,metadata)
    values('members','delete',case when r.actor_id<>old.id then r.actor_id end,
      'account_deletion',r.id::text,jsonb_build_object('self_service',r.actor_id=old.id,'reason',r.reason,'billing_acknowledged',true));
  update private.account_deletion_requests set completed_at=now(),active=false where id=r.id;
  return old;
end; $$;
revoke all on function private.snh_guard_auth_account_deletion() from public,anon,authenticated,service_role;
create trigger snh_account_deletion_guard before delete on auth.users
  for each row execute function private.snh_guard_auth_account_deletion();

-- A deleted user's unexpired JWT must not retain signed-in-only data access.
create function public.snh_account_exists() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users where id=auth.uid());
$$;
revoke all on function public.snh_account_exists() from public,anon;
grant execute on function public.snh_account_exists() to authenticated;
create policy current_account_required on public.club_issues as restrictive for all to authenticated
  using ((select public.snh_account_exists())) with check ((select public.snh_account_exists()));
create policy current_account_required on public.members as restrictive for all to authenticated
  using ((select public.snh_account_exists())) with check ((select public.snh_account_exists()));

-- These existing SECURITY DEFINER entrypoints bypass RLS. Keep their signatures,
-- bodies and grants; strengthen the shared explicit signed-in guard only.
do $$
declare f record; definition text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('snh_club_issues_list','snh_club_issues_upsert','snh_club_issues_game_options','snh_get_my_external_accounts') loop
    definition:=pg_get_functiondef(f.oid);
    if position('if auth.uid() is null then' in definition)=0 then
      raise exception 'Review signed-in guard for %',f.oid::regprocedure;
    end if;
    execute replace(definition,'if auth.uid() is null then','if not public.snh_account_exists() then');
  end loop;
end; $$;
select cron.schedule('snh-account-deletion-receipts-cleanup','35 10 * * *',
  'delete from private.account_deletion_requests where created_at<now()-interval ''2 days'';');
commit;
