import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const read = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture() {
  const db = new PGlite();
  await db.exec(`create role authenticated; create role anon; create role service_role;
    create schema auth; create schema private; create schema cron;
    create table cron.jobs(name text,schedule text,command text);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$ begin insert into cron.jobs values($1,$2,$3);return 1;end;$$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
    create table members(id uuid primary key,user_id uuid unique references auth.users on delete cascade);
    create table memberships(id uuid primary key default gen_random_uuid(),member_id uuid references members on delete cascade,status text, tier text,end_date date,created_at timestamptz default now());
    create table member_roles(id uuid primary key default gen_random_uuid(),member_id uuid references members on delete cascade,role_slug text);
    create table external_accounts(id uuid primary key default gen_random_uuid(),member_id uuid references members on delete cascade,provider_slug text);
    create table event_attendees(member_id uuid references members on delete cascade);
    create table events(created_by uuid references members on delete set null);
    create table photo_assets(created_by uuid references members on delete set null);
    create table photo_albums(created_by uuid references members on delete set null);
    create table audit_log(id uuid primary key default gen_random_uuid(),module text,action text,actor_user_id uuid references auth.users,entity_type text,entity_id text,old_data jsonb default '{}',new_data jsonb default '{}',metadata jsonb default '{}');
    create table games(deleted_by uuid references auth.users);
    create table game_high_scores(created_by uuid references auth.users);
    create table game_custom_mods(created_by uuid references auth.users);
    create table club_issues(created_by uuid references auth.users);
    create table notification_outbox(kind text,event_key text,recipient_member_id uuid references members on delete cascade,body text,status text,lease_id uuid,locked_until timestamptz);
    create function public.snh_club_issues_list() returns jsonb language plpgsql security definer as $$ begin if auth.uid() is null then raise exception 'not authorized'; end if; return '[]'; end; $$;
    grant usage on schema public,auth to authenticated;
    grant select on public.club_issues to authenticated;
    alter table public.club_issues enable row level security;
    create policy old_signed_in on public.club_issues for select to authenticated using(true);
    create function public.snh_member_can_manage_roles() returns boolean language plpgsql as $$ begin return exists(select 1 from public.members m where user_id=auth.uid() and private.snh_member_has_effective_role(m.id,'membership_editor'));end; $$;`);
  const core = await read('20260928235800_notification_enqueue_authorization.sql');
  await db.exec(core.slice(0,core.indexOf('-- Preserve the public signature')));
  await db.exec(await read('20260921121000_audit_member_admin_changes.sql'));
  await db.exec(await read('20260921122000_audit_member_profile_changes.sql'));
  await db.exec(await read('20260925010000_fix_member_profile_audit_signup.sql'));
  const guard = await read('20260921150000_membership_door_access.sql');
  await db.exec(guard.slice(guard.indexOf('create or replace function public.snh_protect_club_admin'),guard.indexOf('-- Only SECURITY DEFINER')));
  await db.exec(await read('20261014180000_account_deletion.sql'));
  await db.exec(await read('20261014190000_membership_trends.sql'));
  await db.exec(await read('20261014200000_weekly_membership_trend_points.sql'));
  for(let n=1;n<=8;n++) {
    await db.query('insert into auth.users values($1,$2)',[id(n),n===8?null:'2026-01-01']);
    await db.query('insert into members values($1,$1)',[id(n)]);
  }
  await db.query(`insert into member_roles(member_id,role_slug) values($1,'club_admin'),($2,'club_admin'),($3,'membership_admin'),($4,'membership_editor'),($5,'games_editor')`,[id(1),id(2),id(3),id(4),id(5)]);
  return db;
}
async function prepare(db,actor,target,reason='Test administrative deletion') {
  return (await db.query('select snh_prepare_account_deletion($1,$2,$3) receipt',[id(actor),target==null?null:id(target),reason])).rows[0].receipt;
}
async function activate(db,receipt,actor) {
  return db.query('select snh_activate_account_deletion($1,$2)',[receipt,id(actor)]);
}
async function remove(db,n) { return db.query('delete from auth.users where id=$1',[id(n)]); }

test('deletion cascades account records, clears attribution, redacts signup copies and records operator',async()=>{
  const db=await fixture();try {
    await db.query("insert into memberships(member_id,status) values($1,'active');",[id(5)]);
    await db.query("insert into external_accounts(member_id,provider_slug) values($1,'matchplay')",[id(5)]);
    for(const table of ['event_attendees','events','photo_assets','photo_albums','games','game_high_scores','game_custom_mods','club_issues']) await db.query(`insert into ${table} values($1)`,[id(5)]);
    await db.query("insert into notification_outbox values('member_signup',$1,$2,'Name and email','pending',null,null),('member_signup','other',$3,'Recipient copy','pending',null,null)",['member_signup:'+id(5)+':'+id(1),id(1),id(5)]);
    await db.query("insert into audit_log(module,action,actor_user_id,entity_type,entity_id) values('games','update',$1,'game','x')",[id(5)]);
    const receipt=await prepare(db,3,5);await activate(db,receipt,3);
    const retryReceipt=await prepare(db,3,5);
    await remove(db,5);
    assert.equal((await db.query('select snh_account_deletion_request($1) r',[retryReceipt])).rows[0].r.completed,true);
    for(const table of ['members','memberships','member_roles','external_accounts','event_attendees']) {
      const col=table==='members'?'id':'member_id';assert.equal((await db.query(`select count(*)::int n from ${table} where ${col}=$1`,[id(5)])).rows[0].n,0);
    }
    for(const table of ['events','photo_assets','photo_albums','games','game_high_scores','game_custom_mods','club_issues']) {
      const col=table==='games'?'deleted_by':'created_by';assert.equal((await db.query(`select ${col} from ${table}`)).rows[0][col],null);
    }
    const mail=(await db.query('select * from notification_outbox')).rows;assert.equal(mail.length,1);assert.equal(mail[0].status,'canceled');assert.equal(mail[0].body,'Signup details removed after account deletion.');
    const audit=(await db.query("select * from audit_log where entity_type='account_deletion'")).rows[0];assert.equal(audit.actor_user_id,id(3));assert.equal(audit.metadata.reason,'Test administrative deletion');
    assert.equal((await db.query('select snh_account_deletion_request($1) r',[receipt])).rows[0].r.completed,true);
  }finally{await db.close();}
});

test('permission matrix, privileged self deletion, last admin, role changes and expired/forged receipts',async()=>{
 const db=await fixture();try {
   for(const [actor,target,allowed] of [[4,6,false],[3,6,true],[3,5,true],[3,3,true],[3,1,false],[3,2,false],[3,7,true],[1,3,true],[1,2,true],[1,null,false],[2,2,false],[5,null,true],[6,null,true],[4,null,true]]) {
     if(allowed) assert.ok(await prepare(db,actor,target));else await assert.rejects(prepare(db,actor,target),e=>e.code==='42501');
   }
   await assert.rejects(remove(db,6),e=>e.code==='42501');
   const r=await prepare(db,3,6);
   await assert.rejects(activate(db,r,4),e=>e.code==='42501');
   await activate(db,r,3);
   const r2=await prepare(db,3,6);await assert.rejects(activate(db,r2,3),e=>e.code==='42501');
   await db.query("insert into member_roles(member_id,role_slug) values($1,'membership_admin')",[id(6)]);
   await assert.rejects(remove(db,6),e=>e.code==='42501');
   await db.query("delete from member_roles where member_id=$1",[id(6)]);
   await db.query("delete from member_roles where member_id=$1",[id(3)]);
   await assert.rejects(remove(db,6),e=>e.code==='42501');
   await db.query("update private.account_deletion_requests set created_at=now()-interval '6 minutes' where id=$1",[r]);
   await assert.rejects(activate(db,r,3),e=>e.code==='42501');
   await db.query("delete from member_roles where member_id=$1",[id(2)]);
   await assert.rejects(prepare(db,2,1),e=>e.code==='42501');
   const rp=await prepare(db,1,7);await activate(db,rp,1);
   // Last-admin check remains authoritative even if roles changed after prepare.
   await db.query("insert into member_roles(member_id,role_slug) values($1,'club_admin')",[id(7)]);
   await db.query("delete from member_roles where member_id=$1",[id(1)]);
   await assert.rejects(remove(db,7),e=>e.code==='42501');
 }finally{await db.close();}
});

test('a failed cascade rolls back receipt, cleanup and audit; self deletion has no dangling actor',async()=>{
 const db=await fixture();try {
   const receipt=await prepare(db,6,null);await activate(db,receipt,6);
   await db.exec('create table unexpected_dependency(user_id uuid references auth.users)');
   await db.query('insert into unexpected_dependency values($1)',[id(6)]);
   await assert.rejects(remove(db,6),e=>e.code==='23503');
   assert.equal((await db.query('select snh_account_deletion_request($1) r',[receipt])).rows[0].r.completed,false);
   await db.exec('delete from unexpected_dependency');await remove(db,6);
   const audit=(await db.query("select * from audit_log where entity_type='account_deletion'")).rows;
   assert.equal(audit.length,1);assert.equal(audit[0].actor_user_id,null);assert.equal(audit[0].metadata.self_service,true);
   await db.query("select set_config('test.user',$1,false)",[id(6)]);
   assert.equal((await db.query('select snh_account_exists() allowed')).rows[0].allowed,false);
   await assert.rejects(db.query('select snh_club_issues_list()'));
   await db.exec('set role authenticated');assert.deepEqual((await db.query('select * from club_issues')).rows,[]);await db.exec('reset role');
 }finally{await db.close();}
});

test('snapshots count accounts once, ignore legacy end dates, persist after deletion, and restrict access',async()=>{
 const db=await fixture();try {
   await db.query("insert into memberships(member_id,status,end_date) values($1,'active','2000-01-01'),($2,'active',null)",[id(5),id(8)]);
   await db.query("insert into member_roles(member_id,role_slug) values($1,'events_admin')",[id(5)]);
   await db.exec('select private.snh_capture_membership_snapshot();select private.snh_capture_membership_snapshot()');
   const before=(await db.query('select * from private.membership_daily_snapshots')).rows;
   assert.equal(before.length,1);assert.equal(before[0].account_count,8);assert.equal(before[0].full_access_count,2);assert.equal(before[0].basic_count,6);assert.equal(before[0].unverified_count,0);assert.equal(before[0].volunteer_count,5);
   const r=await prepare(db,6,null);await activate(db,r,6);await remove(db,6);
   assert.deepEqual((await db.query('select * from private.membership_daily_snapshots')).rows,before);
   await db.query("select set_config('test.user',$1,false)",[id(4)]);
   assert.equal((await db.query('select snh_get_membership_trends() r')).rows[0].r.length,1);
   await db.query("select set_config('test.user',$1,false)",[id(7)]);await assert.rejects(db.query('select snh_get_membership_trends()'),e=>e.code==='42501');
   await db.query("select set_config('test.user',$1,false)",[id(4)]);
   // Last observed day per Monday-Sunday week, with an unfilled week gap.
   // Old daily history remains stored outside the twelve-month display window.
   await db.exec(`delete from private.membership_daily_snapshots;
     insert into private.membership_daily_snapshots
     select (date_trunc('week',now() at time zone 'America/New_York')-interval '3 weeks')::date,now(),1,10,8,1,1,1
     union all select (date_trunc('week',now() at time zone 'America/New_York')-interval '1 week')::date,now(),1,20,15,4,1,2
     union all select (date_trunc('week',now() at time zone 'America/New_York')-interval '1 day')::date,now(),1,22,16,5,1,3
     union all select (now() at time zone 'America/New_York')::date,now(),1,23,17,5,1,3
     union all select (date_trunc('month',now() at time zone 'America/New_York')-interval '12 months')::date,now(),1,5,3,1,1,1`);
   const weekly=(await db.query('select snh_get_membership_trends() r')).rows[0].r;
   assert.deepEqual(weekly.map(r=>r.account_count),[10,22,23]);
   assert.equal((await db.query('select count(*)::int n from private.membership_daily_snapshots')).rows[0].n,5);
   const hours=(await db.query(`select extract(hour from timestamptz '2026-07-01 08:00:00+00' at time zone 'America/New_York')::int summer,
     extract(hour from timestamptz '2026-12-01 09:00:00+00' at time zone 'America/New_York')::int winter`)).rows[0];
   assert.deepEqual(hours,{summer:4,winter:4});
   const jobs=(await db.query("select * from cron.jobs where name='snh-membership-snapshot-daily'")).rows;assert.equal(jobs[0].schedule,'0 8,9 * * *');
   const permissions=(await db.query(`select has_function_privilege('authenticated','snh_prepare_account_deletion(uuid,uuid,text)','execute') prep,
     has_function_privilege('anon','snh_get_membership_trends()','execute') anon,
     has_function_privilege('authenticated','snh_get_membership_trends()','execute') membership,
     has_function_privilege('service_role','snh_activate_account_deletion(uuid,uuid)','execute') service`)).rows[0];
   assert.deepEqual(permissions,{prep:false,anon:false,membership:true,service:true});
 }finally{await db.close();}
});
