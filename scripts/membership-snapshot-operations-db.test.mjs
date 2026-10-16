import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('snapshot Jobs outcomes and automated audit entries commit with captures, roll back failures and filter before pagination',async()=>{
 const db=new PGlite();try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create schema private;create schema cron;
   create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.user',true),'')::uuid$$;
   create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
   create table members(id uuid primary key,user_id uuid,email text,display_name text,first_name text,last_name text);
   create table member_roles(member_id uuid,role_slug text);
   create table memberships(id uuid primary key default gen_random_uuid(),member_id uuid,status text,created_at timestamptz default now());
   create table audit_log(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),module text,action text,actor_user_id uuid,entity_type text,entity_id text,old_data jsonb default '{}',new_data jsonb default '{}',metadata jsonb default '{}');
   create table events(id uuid,title text);create table games(id uuid,title text);create table game_images(id uuid,game_id uuid);
   create table photo_albums(id uuid,title text);create table photo_assets(id uuid,caption text,original_filename text,album_id uuid);
   create table integration_status(provider text);create table external_api_cache_policies(provider text,policy text,ttl_seconds integer);
   create table external_api_cache(resource_type text,expires_at timestamptz);create table notification_outbox(status text);
   create function private.snh_cache_defaults() returns table(provider text,policy text,ttl_seconds integer) language sql as $$select 'test','test',1$$;
   create function public.snh_member_can_manage_roles() returns boolean language sql as $$select exists(select 1 from members m join member_roles r on r.member_id=m.id where m.user_id=auth.uid() and r.role_slug='club_admin')$$;`);
  const canonical=await read('20260928235800_notification_enqueue_authorization.sql');
  await db.exec(canonical.slice(0,canonical.indexOf('-- Preserve the public signature')));
  const operations=await read('20260928160000_operations.sql');
  await db.exec(operations.slice(0,operations.indexOf('-- Code defaults')));
  await db.exec(operations.slice(operations.indexOf('create table public.operations_job_runs'),operations.indexOf('create function public.snh_operations_policy')));
  await db.exec(await read('20261014190000_membership_trends.sql'));
  await db.exec(await read('20261014200000_weekly_membership_trend_points.sql'));
  await db.exec(await read('20261014210000_membership_snapshot_operations.sql'));
  await db.query("insert into auth.users values($1,now()),($2,now());",[id(1),id(2)]);
  await db.query("insert into members(id,user_id) values($1,$1),($2,$2)",[id(1),id(2)]);
  await db.query("insert into member_roles values($1,'club_admin')",[id(1)]);
  await db.query("insert into memberships(member_id,status) values($1,'active')",[id(1)]);
  await db.exec('select private.snh_capture_membership_snapshot()');
  let runs=(await db.query('select * from operations_job_runs order by started_at,id')).rows;
  assert.equal(runs.length,1);assert.equal(runs[0].job,'membership_snapshot');assert.equal(runs[0].status,'succeeded');assert.ok(runs[0].finished_at);
  assert.equal(runs[0].result.account_count,2);assert.equal(runs[0].result.full_access_count,1);assert.equal(runs[0].result.basic_count,1);assert.equal(runs[0].result.volunteer_count,1);assert.equal(runs[0].result.already_captured,false);
  let audits=(await db.query("select * from audit_log where entity_type='membership_snapshot'")).rows;
  assert.equal(audits.length,1);assert.equal(audits[0].metadata.automated,true);assert.equal(audits[0].actor_user_id,null);assert.equal(audits[0].metadata.run_id,runs[0].id);
  assert.ok(!JSON.stringify(audits).includes('email'));
  await db.exec('select private.snh_capture_membership_snapshot()');
  assert.equal((await db.query('select count(*)::int n from private.membership_daily_snapshots')).rows[0].n,1);
  assert.equal((await db.query("select result from operations_job_runs order by started_at desc,id desc limit 1")).rows[0].result.already_captured,true);
  // A normal capture exception is retained as a failed job and automated audit,
  // with no successful count claimed and no partial daily point committed.
  await db.exec(`delete from private.membership_daily_snapshots;
    create function fail_snapshot() returns trigger language plpgsql as $$begin raise exception 'private database detail';end;$$;
    create trigger test_fail_snapshot before insert on private.membership_daily_snapshots for each row execute function fail_snapshot();
    select private.snh_capture_membership_snapshot()`);
  const failed=(await db.query("select * from operations_job_runs where status='failed'")).rows[0];assert.ok(failed);assert.ok(failed.finished_at);assert.equal('account_count' in failed.result,false);assert.ok(!failed.error.includes('private database detail'));
  assert.equal((await db.query('select count(*)::int n from private.membership_daily_snapshots')).rows[0].n,0);
  assert.equal((await db.query("select metadata->>'automated' automated from audit_log where action='snapshot_failed'")).rows[0].automated,'true');
  await db.exec('drop trigger test_fail_snapshot on private.membership_daily_snapshots');
  // Audit failure also rolls back the point and successful run outcome.
  await db.exec("alter table audit_log add constraint fail_success_audit check(action<>'snapshot') not valid;select private.snh_capture_membership_snapshot()");
  assert.equal((await db.query("select count(*)::int n from operations_job_runs where status='failed'")).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int n from private.membership_daily_snapshots')).rows[0].n,0);
  await db.exec('alter table audit_log drop constraint fail_success_audit;select private.snh_capture_membership_snapshot()');
  // Jobs reads the latest result through the existing admin-only RPC.
  await db.query("select set_config('test.user',$1,false)",[id(1)]);
  await db.exec('set role authenticated');
  const snapshot=(await db.query('select snh_operations_snapshot() s')).rows[0].s;
  assert.equal(snapshot.jobs.length,1);assert.equal(snapshot.jobs[0].status,'succeeded');assert.equal(snapshot.jobs[0].result.account_count,2);
  assert.equal((await db.query('select snh_audit_history_for_admin() a')).rows[0].a.length,0);
  const shown=(await db.query("select snh_audit_history_for_admin('members',100,null,null,true) a")).rows[0].a;
  assert.equal(shown.length,5);assert.ok(shown.every(r=>r.record_label==='Membership snapshot'));
  await db.exec('reset role');
  await db.exec(`insert into audit_log(module,action,entity_type,entity_id,created_at) values('members','update','account_deletion','human-change',now()-interval '1 day');`);
  await db.exec('set role authenticated');
  const page=(await db.query("select snh_audit_history_for_admin(null,1) a")).rows[0].a;
  assert.equal(page.length,1);assert.equal(page[0].entity_id,'human-change','automated filtering occurs before limit');
  await db.exec('reset role');
  await db.exec(`insert into audit_log(module,action,entity_type,entity_id,new_data)
    values('games','import','pinballmap_ingest','empty-import','{"updates_count":0,"creates_count":0}'),
      ('games','import','pinballmap_ingest','changed-import','{"updates_count":1,"creates_count":0}');set role authenticated`);
  const imports=(await db.query("select snh_audit_history_for_admin('games') a")).rows[0].a;
  assert.deepEqual(imports.map(r=>r.entity_id),['changed-import'],'existing no-op import filtering remains intact');
  assert.equal((await db.query("select snh_audit_history_for_admin('games',50,null,null,true) a")).rows[0].a.length,2);
  await db.exec('reset role');
  await db.query("select set_config('test.user',$1,false)",[id(2)]);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select snh_operations_snapshot()'),e=>e.code==='42501');
  await assert.rejects(db.query('select snh_audit_history_for_admin()'),e=>e.code==='42501');
  await assert.rejects(db.query('select private.snh_capture_membership_snapshot()'),e=>e.code==='42501');
  await db.exec('reset role');
 }finally{await db.close();}
});
