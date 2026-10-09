import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeExport } from '../supabase/functions/pintips-import/provider.mjs';
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const raw = (tipId, opdbId = 'Gabc', text = 'Original') => ({ tipId, opdbId, text, category:'general',voteTotal:1,createdAt:'2026-01-01 00:00:00',updatedAt:'2026-01-01 00:00:00' });

test('PinTips snapshot lifecycle, exact OPDB matching, privileges and rollback', async () => {
 const db = new PGlite();
 const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
 const exec = sql => db.exec(sql);
 try {
  await exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema private;
    create table games(id uuid primary key,opdb_id text,deleted_at timestamptz,details text);
    create table operations_job_runs(id uuid primary key default gen_random_uuid(),job text,started_at timestamptz default now(),finished_at timestamptz,status text default 'running',result jsonb default '{}',error text);
    create table integration_status(provider text,resource_type text,last_attempt_at timestamptz,last_success_at timestamptz,last_error_at timestamptz,last_error text,latency_ms integer,primary key(provider,resource_type));
    create table audit_log(module text,action text,actor_user_id uuid,entity_type text,entity_id text,new_data jsonb);
    insert into games values
    ('${uid(1)}','Gabc',null,'Club note'),('${uid(2)}','Gabc-Mone',null,'Club note'),
    ('${uid(3)}','Gabc-Mone-Atwo',null,'Club note'),('${uid(4)}','Gabcd-Mone',null,'Club note'),
    ('${uid(5)}','Gabc-Mone',now(),'Club note'),('${uid(6)}',null,null,'Club note'),
    ('${uid(7)}','Gabc-garbage',null,'Club note');`);
  await exec(await readFile(new URL('../supabase/migrations/20261007130000_pintips.sql',import.meta.url),'utf8'));
  for (const role of ['anon','authenticated']) {
    await exec(`set role ${role}`);
    assert.deepEqual((await q('select snh_public_game_tips($1) tips',[uid(1)]))[0].tips,[]);
    for (const sql of ['select * from pintips','delete from pintips','select snh_pintips_begin()',
      `select snh_pintips_finish('${uid(1)}','[]')`,`select snh_pintips_fail('${uid(1)}','fake')`]) {
      await assert.rejects(q(sql),/permission denied/);
    }
    await exec('reset role');
  }
  const begin = async () => {
    await exec("update operations_job_runs set started_at=now()-interval '1 minute' where status<>'running'; set role service_role");
    const id=(await q('select snh_pintips_begin($1) id',[uid(99)]))[0].id;
    await exec('reset role'); return id;
  };
  const finish = async (id, rows) => {
    await exec('set role service_role');
    try { return (await q('select snh_pintips_finish($1,$2) result',[id,JSON.stringify(rows)]))[0].result; }
    finally { await exec('reset role'); }
  };
  let id=await begin(); assert.ok(id);
  await exec('set role service_role');
  assert.equal((await q('select snh_pintips_begin() id'))[0].id,null,'concurrent refresh cannot start');
  await exec('reset role');
  let result=await finish(id,normalizeExport([raw(1),raw(2,'Gother')]));
  assert.equal(result.matched_games,3); assert.equal(result.added,2);
  assert.equal(result.missing_opdb_games,1); assert.equal(result.invalid_opdb_games,1);
  assert.equal(result.games_without_tips,1); assert.equal(result.unmatched_tip_groups,1);
  for (const role of ['anon','authenticated']) {
    await exec(`set role ${role}`);
    for (const n of [1,2,3]) assert.equal((await q('select snh_public_game_tips($1) tips',[uid(n)]))[0].tips[0].text,'Original');
    for (const n of [4,5,6,7,8]) assert.deepEqual((await q('select snh_public_game_tips($1) tips',[uid(n)]))[0].tips,[]);
    await exec('reset role');
  }
  result=await finish(await begin(),normalizeExport([raw(1),raw(2,'Gother')]));
  assert.equal(result.added,0); assert.equal(result.changed,0); assert.equal(result.removed,0);
  result=await finish(await begin(),normalizeExport([raw(1,'Gabc','Changed')]));
  assert.equal(result.changed,1); assert.equal(result.removed,1);
  assert.equal((await q('select count(*)::int n from pintips'))[0].n,1);
  const success=(await q("select last_success_at from integration_status where provider='pintips'"))[0].last_success_at;
  id=await begin();
  for (const rows of [[],[...normalizeExport([raw(3)]),...normalizeExport([raw(3)])],
    [{...normalizeExport([raw(3)])[0],text:''}]]) await assert.rejects(finish(id,rows));
  assert.equal((await q('select text from pintips'))[0].text,'Changed','invalid snapshot cannot delete successful data');
  await exec('set role service_role');
  await q('select snh_pintips_fail($1,$2)',[id,'Download failed. Retry.']);
  await exec('reset role');
  assert.deepEqual((await q("select last_success_at from integration_status where provider='pintips'"))[0].last_success_at,success);
  assert.equal((await q('select status from operations_job_runs where id=$1',[id]))[0].status,'failed');
  // A commit error after reconciliation must roll back rows and status together.
  id=await begin();
  await exec("alter table operations_job_runs add constraint reject_success check(status<>'succeeded') not valid");
  await assert.rejects(finish(id,normalizeExport([raw(10,'Gother')])));
  assert.equal((await q('select text from pintips'))[0].text,'Changed');
  await exec('alter table operations_job_runs drop constraint reject_success');
  await exec("update operations_job_runs set started_at=now()-interval '6 minutes' where status='running'");
  const newer=await begin(); assert.ok(newer);
  await assert.rejects(finish(id,normalizeExport([raw(10)])),/lease expired/);
  await finish(newer,normalizeExport([raw(1)]));
  assert.ok((await q('select details from games')).every(r=>r.details==='Club note'));
  await exec(`update games set opdb_id='Gother-Mx' where id='${uid(1)}'`);
  assert.deepEqual((await q('select snh_public_game_tips($1) tips',[uid(1)]))[0].tips,[],'catalog correction takes effect without reimport');
  // Execute the scheduler migration against local stand-ins for Supabase extensions.
  await exec(`create schema vault; create schema net; create schema cron;
   create table vault.decrypted_secrets(name text,decrypted_secret text);
   create table public.test_http(url text,headers jsonb,body jsonb,timeout_milliseconds integer);
   create table public.test_cron(name text,schedule text,command text);
   create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$
    begin insert into public.test_http values(url,headers,body,timeout_milliseconds); return 1; end; $$;
   create function cron.schedule(name text,schedule text,command text) returns bigint language plpgsql as $$
    begin insert into public.test_cron values(name,schedule,command); return 1; end; $$;`);
  await exec(await readFile(new URL('../supabase/migrations/20261007131000_pintips_schedule.sql',import.meta.url),'utf8'));
  assert.equal((await q('select schedule from test_cron'))[0].schedule,'20 7 * * *');
  await q('select private.snh_pintips_cron_invoke()');
  assert.equal((await q('select count(*)::int n from test_http'))[0].n,0,'missing configuration cannot dispatch');
  assert.ok((await q("select error from operations_job_runs where job='pintips_import' and error like 'Scheduler configuration%'" )).length);
  await exec(`insert into vault.decrypted_secrets values
    ('snh_pinballmap_ingest_supabase_url','https://test.supabase.co'),
    ('snh_pinballmap_ingest_anon_key','public-test-key'),
    ('snh_pintips_import_scheduler_secret','scheduler-test-secret');`);
  await q('select private.snh_pintips_cron_invoke()');
  const sent=(await q('select * from test_http'))[0];
  assert.equal(sent.url,'https://test.supabase.co/functions/v1/pintips-import');
  assert.equal(sent.headers['x-pintips-scheduler-secret'],'scheduler-test-secret');
  assert.equal(sent.headers.apikey,'public-test-key');
  for(const role of ['anon','authenticated']) {
   await exec(`set role ${role}`);
   await assert.rejects(q('select private.snh_pintips_cron_invoke()'),/permission denied/);
   await exec('reset role');
  }
 } finally { await db.close(); }
});
