import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const sql = text => db.exec(text);
const query = async text => (await db.query(text)).rows;
const migration = async name => sql(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
try {
 await sql(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema private;
 create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create table members(id uuid primary key,user_id uuid,email text,display_name text,first_name text,last_name text);
 create table member_roles(member_id uuid,role_slug text);
 create table audit_log(module text,action text,actor_user_id uuid,entity_type text,entity_id text,old_data jsonb,new_data jsonb);
 insert into members values('${uid(1)}','${uid(1)}','admin@example.com',null,null,null),('${uid(2)}','${uid(2)}','member@example.com',null,null,null);
 insert into member_roles values('${uid(1)}','club_admin'),('${uid(2)}','membership_admin');`);
 await migration('20260924130000_notification_foundation.sql');
 await migration('20260928150000_external_api_cache.sql');
 await sql("update external_api_cache_policies set ttl_seconds=99 where provider='matchplay' and policy='event'");
 await migration('20260928160000_operations.sql');
 assert.equal((await query('select count(*)::int n from external_api_cache_policies'))[0].n,1,'custom values survive migration');
 for (const role of ['anon','authenticated']) {
   await sql(`set role ${role}; set request.jwt.claim.sub='${uid(2)}'`);
   for (const statement of ['select snh_operations_snapshot()',"select snh_operations_policy('matchplay','event',2)",
    'select snh_operations_messages()',`select snh_operations_retry('${uid(10)}')`,'select snh_operations_cleanup()',
    'select snh_operations_dispatch_request()','select * from operations_job_runs','select * from notification_outbox',
    'select * from external_api_cache','select * from integration_status','select * from external_api_cache_policies',
    'select cleanup_external_api_search_cache()']) await assert.rejects(query(statement),/permission denied|not authorized/);
   await sql('reset role');
 }
 await sql(`set role authenticated; set request.jwt.claim.sub='${uid(1)}'`);
 let snapshot=(await query('select snh_operations_snapshot() s'))[0].s;
 assert.equal(snapshot.policies.find(p=>p.provider==='matchplay' && p.policy==='event').seconds,99);
 await query("select snh_operations_policy('matchplay','event',42)");
 await query("select snh_operations_policy('matchplay','force_refresh_minimum',60)");
 for(const statement of ["select snh_operations_policy('evil','event',1)","select snh_operations_policy('matchplay','event',0)","select snh_operations_policy('matchplay','event',604801)"])
 await assert.rejects(query(statement),/Invalid cache policy/);
 await query("select snh_operations_policy('matchplay','event',null)");
 snapshot=(await query('select snh_operations_snapshot() s'))[0].s;
 assert.equal(snapshot.policies.find(p=>p.provider==='matchplay' && p.policy==='event').seconds,7200);
 assert.equal(snapshot.policies.find(p=>p.provider==='matchplay' && p.policy==='event').overridden,false);
 await sql('reset role');
 await sql(`insert into notification_outbox(id,event_key,kind,recipient_member_id,recipient_email,subject,body,status,attempts) values
 ('${uid(10)}','test','member_signup','${uid(1)}','admin@example.com','subject','body','failed',3),
 ('${uid(11)}','old','member_signup','${uid(1)}','admin@example.com','subject','body','failed',3);
 update notification_outbox set created_at=now()-interval '24 hours' where id='${uid(11)}';
 set role authenticated;`);
 await query(`select snh_operations_retry('${uid(10)}')`);
 await assert.rejects(query(`select snh_operations_retry('${uid(10)}')`),/no longer eligible/);
 await assert.rejects(query(`select snh_operations_retry('${uid(11)}')`),/no longer eligible/);
 await sql('reset role; set role service_role');
 const claimed=(await query('select * from snh_claim_notification()'))[0];
 assert.equal(claimed.id,uid(10)); assert.equal(claimed.attempts,4); assert.equal(claimed.manual_retry_allowance,false);
 assert.equal((await query('select * from snh_claim_notification()')).length,0,'cannot double claim');
 await query(`select snh_finish_notification('${uid(10)}','${claimed.lease_id}','failed',null,'Resend HTTP 500')`);
 await sql('reset role');
 assert.equal((await query(`select status from notification_outbox where id='${uid(10)}'`))[0].status,'failed');
 await sql(`insert into external_api_cache values
 ('matchplay','search','old','{}',now()-interval '10 days',now()-interval '8 days'),
 ('matchplay','search','recent','{}',now()-interval '2 days',now()-interval '1 day'),
 ('matchplay','event','event','{}',now()-interval '10 days',now()-interval '8 days');
 set role authenticated;`);
 assert.equal((await query('select snh_operations_cleanup() n'))[0].n,1);
 await query('select snh_operations_dispatch_request()');
 snapshot=(await query('select snh_operations_snapshot() s'))[0].s;
 assert.equal(snapshot.jobs[0].status,'succeeded'); assert.equal(snapshot.cache.total,2);
 const messages=(await query('select snh_operations_messages() m'))[0].m;
 assert.equal(messages.length,2); assert.equal('body' in messages[0],false);
 await assert.rejects(query("select snh_operations_messages('invalid')"),/Invalid message filter/);
 await sql('reset role');
 const audits=await query('select * from audit_log');
 assert.equal(audits.length,6); assert.ok(audits.every(a=>a.actor_user_id===uid(1)));
 // Mutation and audit must commit together.
 await sql("alter table audit_log add constraint reject_audit check(action<>'update') not valid");
 await sql('set role authenticated');
 await assert.rejects(query("select snh_operations_policy('matchplay','event',7)"),/reject_audit/);
 snapshot=(await query('select snh_operations_snapshot() s'))[0].s;
 assert.equal(snapshot.policies.find(p=>p.provider==='matchplay' && p.policy==='event').seconds,7200);
 console.log('PASS Operations: role boundaries, override/reset, validation, transactional audit, safe retry/claim, cleanup and snapshot.');
} finally { await db.close(); }
