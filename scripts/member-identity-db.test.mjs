import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const source = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');

test('Auth identity survives direct profile writes, legacy upserts, signup and notification delivery', async t => {
  const db = new PGlite();
  const query = async (sql, args) => (await db.query(sql, args)).rows;
  const asUser = n => db.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${uid(n)}'`);
  const trusted = () => db.exec("reset role; set request.jwt.claim.sub=''");
  const member = async n => (await query('select * from members where user_id=$1', [uid(n)]))[0];
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql as $$select current_setting('role',true)$$;
      grant usage on schema auth to authenticated;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        raw_user_meta_data jsonb default '{}',created_at timestamptz default now(),last_sign_in_at timestamptz);
      create table members(id uuid primary key default gen_random_uuid(),user_id uuid unique references auth.users,
        email text,first_name text,last_name text,display_name text,avatar_url text,
        created_at timestamp default now(),updated_at timestamp default now());
      alter table members enable row level security;
      grant select,insert,update,delete on members to anon,authenticated;
      create table memberships(id uuid default gen_random_uuid(),member_id uuid,status text,tier text,end_date date,created_at timestamptz default now());
      create table external_accounts(id uuid primary key,member_id uuid,provider_slug text,account_handle text);
      create table audit_log(module text,action text,actor_user_id uuid,entity_type text,entity_id text,metadata jsonb);
      create table operations_job_runs(id uuid primary key,job text,status text default 'running',started_at timestamptz default now(),finished_at timestamptz,error text,result jsonb default '{}');
      create table integration_status(provider text,resource_type text,last_attempt_at timestamptz,last_success_at timestamptz,last_error_at timestamptz,last_error text,latency_ms integer,primary key(provider,resource_type));
      insert into auth.users(id,email,email_confirmed_at) values
        ('${uid(101)}','admin@example.test',now()),('${uid(102)}','member@example.test',now()),
        ('${uid(103)}','unverified@example.test',null),('${uid(104)}',null,null),('${uid(105)}','first-profile@example.test',now());
      insert into members(id,user_id,email) values
        ('${uid(1)}','${uid(101)}','poisoned-recipient@example.test'),
        ('${uid(2)}','${uid(102)}','trusted-person@example.test'),
        ('${uid(3)}','${uid(103)}','unverified@example.test'),
        ('${uid(4)}','${uid(104)}','stale@example.test'),
        ('${uid(6)}',null,'offline-contact@example.test');`);
    const policies = await source('20260426110000_harden_rls_and_disable_graphql.sql');
    await db.exec(policies.slice(policies.indexOf('create policy "Members can view own member row"'), policies.indexOf('-- Rebuild external_accounts')));
    for (const name of ['20260423190000_create_member_roles.sql','20260928230000_canonical_effective_role_core.sql',
      '20260928235000_domain_helpers_use_effective_roles.sql','20260924130000_notification_foundation.sql',
      '20260925020000_queue_notifications_from_auth_signup.sql','20260928235800_notification_enqueue_authorization.sql',
      '20260921122000_audit_member_profile_changes.sql','20260925010000_fix_member_profile_audit_signup.sql',
      '20261014170000_member_directory_auth_timestamps.sql']) await db.exec(await source(name));
    await db.exec(`alter table notification_outbox drop constraint notification_outbox_kind_check;
      alter table notification_outbox add column manual_retry_allowance boolean not null default false;
      insert into member_roles(member_id,role_slug) values ('${uid(1)}','club_admin'),('${uid(4)}','membership_editor'),('${uid(6)}','membership_editor');
      create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
      insert into notification_outbox(id,event_key,kind,recipient_member_id,recipient_email,subject,body,status,locked_until,lease_id)
      values ('${uid(10)}','poisoned-pending','member_signup','${uid(1)}','poisoned-recipient@example.test','Subject','Body','pending',null,null),
        ('${uid(11)}','good-pending','member_signup','${uid(1)}',' ADMIN@example.test ','Subject','Body','pending',null,null),
        ('${uid(12)}','sent-history','member_signup','${uid(1)}','poisoned-recipient@example.test','Subject','Body','sent',null,null),
        ('${uid(13)}','active-lease','member_signup','${uid(1)}','poisoned-recipient@example.test','Subject','Body','sending',now()+interval '5 minutes','${uid(90)}'),
        ('${uid(14)}','expired-lease','member_signup','${uid(1)}','poisoned-recipient@example.test','Subject','Body','sending',now()-interval '1 minute','${uid(91)}');`);
    await asUser(101);
    let directory = (await query('select snh_list_members_for_admin() rows'))[0].rows;
    assert.equal(directory.find(r => r.member_id === uid(2)).email, 'trusted-person@example.test');
    assert.equal(directory.find(r => r.member_id === uid(2)).email_verified, true, 'Reproduce the original mismatched badge');
    await trusted();
    await db.exec(await source('20261023040000_authoritative_member_identity.sql'));

    await t.test('migration repairs linked mirrors and directory never falls back to contact email', async () => {
      assert.equal((await member(102)).email, 'member@example.test');
      assert.equal((await member(104)).email, null);
      assert.equal((await query('select email from members where id=$1',[uid(6)]))[0].email,'offline-contact@example.test');
      await asUser(101);
      directory = (await query('select snh_list_members_for_admin() rows'))[0].rows;
      assert.equal(directory.find(r => r.member_id === uid(2)).email,'member@example.test');
      assert.equal(directory.find(r => r.member_id === uid(2)).email_verified,true);
      assert.equal(directory.find(r => r.member_id === uid(3)).email_verified,false);
      for (const n of [4,6]) {
        assert.equal(directory.find(r => r.member_id === uid(n)).email,'');
        assert.equal(directory.find(r => r.member_id === uid(n)).email_verified,false);
      }
      await asUser(102);
      await assert.rejects(query('select snh_list_members_for_admin()'),e=>e.code==='42501');
      await assert.rejects(query('select * from auth.users'),e=>e.code==='42501');
    });

    await t.test('direct API writes cannot replace identity; profile updates and cached-client upserts work', async () => {
      await asUser(102);
      const before=await member(102);
      await query(`update members set email='victim@example.test',first_name='Updated',avatar_url='https://example.test/avatar',updated_at='2000-01-01' where user_id=$1`,[uid(102)]);
      let current=await member(102);
      assert.equal(current.email,'member@example.test');assert.equal(current.first_name,'Updated');
      assert.notEqual(new Date(current.updated_at).getUTCFullYear(),2000);
      for (const [field,value] of [['id',uid(999)],['user_id',uid(101)],['created_at','2000-01-01']]) {
        await assert.rejects(query(`update members set ${field}=$1 where user_id=$2`,[value,uid(102)]),e=>e.code==='42501');
      }
      assert.equal((await query('update members set email=$1 where user_id=$2 returning id',['victim@example.test',uid(101)])).length,0);
      await query(`insert into members(user_id,email,first_name,last_name,display_name,avatar_url)
        values($1,'stale-client@example.test','Legacy','Client','Name','https://example.test/photo')
        on conflict(user_id) do update set user_id=excluded.user_id,email=excluded.email,first_name=excluded.first_name,
          last_name=excluded.last_name,display_name=excluded.display_name,avatar_url=excluded.avatar_url returning *`,[uid(102)]);
      current=await member(102);
      assert.equal(current.id,before.id);assert.deepEqual(current.created_at,before.created_at);
      assert.equal(current.email,'member@example.test');assert.equal(current.first_name,'Legacy');
      await query(`insert into members(user_id,first_name) values($1,'Current client')
        on conflict(user_id) do update set first_name=excluded.first_name`,[uid(102)]);
      assert.equal((await member(102)).email,'member@example.test');
      await assert.rejects(query('insert into members(user_id,email) values($1,$2)',[uid(105),'forged@example.test']),e=>e.code==='42501');
      await asUser(105);
      await query(`insert into members(id,user_id,email,created_at) values($1,$2,'forged@example.test','2000-01-01')`,[uid(999),uid(105)]);
      current=await member(105);
      assert.notEqual(current.id,uid(999));assert.equal(current.email,'first-profile@example.test');
      assert.notEqual(new Date(current.created_at).getUTCFullYear(),2000);
    });

    await t.test('Auth signup and confirmed email changes synchronize without exposing email in audit records', async () => {
      await trusted();
      await query('insert into auth.users(id,email) values($1,$2)',[uid(106),'new-signup@example.test']);
      assert.equal((await member(106)).email,'new-signup@example.test');
      await query('update auth.users set email=$1 where id=$2',['changed@example.test',uid(102)]);
      assert.equal((await member(102)).email,'changed@example.test');
      await asUser(102);
      await query(`insert into members(user_id,email,display_name) values($1,'member@example.test','Cached after change')
        on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name`,[uid(102)]);
      assert.equal((await member(102)).email,'changed@example.test');
      await trusted();
      const audit=await query('select * from audit_log');
      assert.ok(audit.some(r=>r.metadata.changed_fields?.includes('email')));
      assert.ok(!JSON.stringify(audit).includes('@example.test'));
      for(const role of ['anon','authenticated','service_role']) {
        for(const fn of ['private.snh_canonical_member_identity()','private.snh_sync_member_auth_email()','private.snh_cancel_mismatched_notification_recipients()'])
          assert.equal((await query('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,fn]))[0].ok,false);
      }
    });

    await t.test('both notification producers use Auth; missing emails/accounts are excluded', async () => {
      // Simulate stale mirrored data: both producers must independently trust Auth.
      await db.exec("alter table members disable trigger snh_members_canonical_identity");
      await query("update members set email='untrusted-mirror@example.test' where id=$1",[uid(1)]);
      await db.exec("alter table members enable trigger snh_members_canonical_identity");
      await query('insert into auth.users(id,email) values($1,$2)',[uid(107),'after-drift@example.test']);
      const afterDrift=await query("select recipient_email from notification_outbox where body like '%after-drift@example.test%'");
      assert.deepEqual(afterDrift,[{recipient_email:'admin@example.test'}]);
      const signup=(await query("select * from notification_outbox where event_key like 'member_signup:%' and body like '%new-signup@example.test%'"));
      assert.equal(signup.length,1);assert.equal(signup[0].recipient_email,'admin@example.test');
      await query('insert into operations_job_runs(id,job) values($1,\'pinballmap_ingest\')',[uid(500)]);
      await query('select snh_pinballmap_finish($1,$2)',[uid(500),'Synthetic failure']);
      const alerts=await query("select * from notification_outbox where kind='pinballmap_failure'");
      assert.equal(alerts.length,1);assert.equal(alerts[0].recipient_email,'admin@example.test');
      assert.equal(alerts[0].recipient_member_id,uid(1));
    });

    await t.test('mismatched pending/expired jobs cancel without changing recipients, history or active leases', async () => {
      const rows=await query('select * from notification_outbox where id=any($1::uuid[])',[[10,11,12,13,14].map(uid)]);
      for(const n of [10,14]) {
        const row=rows.find(r=>r.id===uid(n));assert.equal(row.status,'canceled');
        assert.equal(row.recipient_email,'poisoned-recipient@example.test');assert.equal(row.lease_id,null);
      }
      assert.equal(rows.find(r=>r.id===uid(11)).status,'pending');
      assert.equal(rows.find(r=>r.id===uid(12)).status,'sent');
      assert.equal(rows.find(r=>r.id===uid(13)).status,'sending');
      assert.equal(rows.find(r=>r.id===uid(13)).lease_id,uid(90));
      await query('update auth.users set email=$1 where id=$2',['new-admin@example.test',uid(101)]);
      const claimed=await query('select * from snh_claim_notification()');
      assert.equal(claimed.length,0,'Old pending recipients are not redirected or delivered after an Auth email change');
      assert.equal((await query('select status from notification_outbox where id=$1',[uid(11)]))[0].status,'canceled');
      await query('update notification_outbox set locked_until=now()-interval \'1 second\' where id=$1',[uid(13)]);
      await query('select * from snh_claim_notification()');
      assert.equal((await query('select status from notification_outbox where id=$1',[uid(13)]))[0].status,'canceled');
    });
  } finally { await db.close(); }
});
