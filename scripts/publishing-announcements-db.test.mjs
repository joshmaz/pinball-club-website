// Exercise the forward migration against the deployed authorization chain.
// All accounts are disposable; no network or hosted database is used.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const oldRoles = ['club_admin', 'membership_editor', 'membership_admin', 'events_editor',
  'events_admin', 'photos_editor', 'photos_admin', 'games_editor', 'games_admin'];
const roles = [...oldRoles, 'publishing_editor', 'publishing_admin'];
const actor = async n => {
  await db.exec('reset role; set role authenticated');
  await query("select set_config('request.jwt.claim.sub',$1,false)", [uid(100 + n)]);
};
const grant = (n, role) => query('select public.snh_grant_member_role($1,$2)', [uid(n), role]);
const revoke = (n, role) => query('select public.snh_revoke_member_role($1,$2)', [uid(n), role]);
const denied = error => error.code === '42501';
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_user::text $$;
    create table public.members(id uuid primary key,user_id uuid,email text,display_name text,
      first_name text,last_name text,stern_insider_username text);
    create table public.memberships(id uuid primary key default gen_random_uuid(),member_id uuid,
      status text,tier text,end_date date,created_at timestamptz default now());
    create table public.external_accounts(member_id uuid,provider_slug text,account_handle text);
    create table public.audit_log(id uuid primary key default gen_random_uuid(),module text,action text,
      actor_user_id uuid,entity_type text,entity_id text,old_data jsonb,new_data jsonb,metadata jsonb);
    grant usage on schema auth to authenticated;
    grant select on public.members to authenticated;
    alter table public.members enable row level security;
    create policy own_member on public.members for select to authenticated using(user_id=auth.uid());`);
  for (const name of [
    '20260423190000_create_member_roles.sql',
    '20260423203000_member_admin_rpcs.sql',
    '20260427201536_member_role_slug_allowlist.sql',
    '20260427202201_membership_role_manager_access.sql',
    '20260508153118_manual_membership_admin_rpcs.sql',
    '20260921140000_member_role_scope.sql',
    '20260921150000_membership_door_access.sql',
    '20260928200000_membership_role_delegation.sql',
    '20260928220000_canonical_persisted_member_roles.sql',
    '20260928230000_canonical_effective_role_core.sql',
    '20260928235000_domain_helpers_use_effective_roles.sql',
    '20260928235800_notification_enqueue_authorization.sql',
    '20260921121000_audit_member_admin_changes.sql',
    '20261016120000_require_verified_access_grants.sql'
  ]) await migration(name);
  for (let n = 1; n <= 14; n++) {
    await query('insert into auth.users values ($1,$2)', [uid(100+n), n === 14 ? null : new Date()]);
    await query('insert into public.members(id,user_id) values ($1,$2)', [uid(n),uid(100+n)]);
  }
  for (let i=0;i<oldRoles.length;i++) {
    await query('insert into public.member_roles(member_id,role_slug) values ($1,$2)',[uid(i+1),oldRoles[i]]);
  }

  await migration('20261017180000_publishing_role_domain.sql');
  await migration('20261017200000_publishing_announcements.sql');
  await actor(1);await grant(10,'publishing_editor');await grant(11,'publishing_admin');
  const write=async(action,entry=null,values={})=>(await query(`select public.snh_publishing_write($1,$2,$3,$4,$5,$6,$7,$8) result`,
    [action,entry?.id||null,entry?.version||null,values.title??null,values.body??null,values.url??null,values.start??null,values.end??null]))[0].result;
  const feed=async(history=false,limit=20,start=null,id=null)=>(await query('select public.snh_public_announcements($1,$2,$3,$4) result',[history,limit,start,id]))[0].result;
  for(const n of [2,3,4,5,6,7,8,9,12,999]) {
    await actor(n);await assert.rejects(write('save',null,{title:'Denied',body:'Denied'}),denied);
    await assert.rejects(query('select public.snh_publishing_list()'),denied);
  }
  await actor(10);
  const values={title:'Club news <script>',body:'Plain text\nSecond line',url:'https://example.com/news'};
  let entry=await write('save',null,values);
  assert.equal((await feed()).length,0,'draft must be private');
  await assert.rejects(query('select * from public.publishing_entries'),denied);
  await assert.rejects(query('update public.publishing_entries set published=draft'),denied);
  for(const bad of [{title:''},{body:''},{url:'javascript:alert(1)'},{url:'https://example.com/ a'},{title:'x'.repeat(121)},{start:'2030-01-02',end:'2030-01-01'}]) {
    await assert.rejects(write('save',entry,{...values,...bad}),e=>e.code==='22023');
  }
  entry=await write('publish',entry); assert.equal((await feed())[0].title,values.title);
  const live=await feed(); assert.deepEqual(Object.keys(live[0]).sort(),['id','title','body','url','starts_at','ends_at','published_at'].sort());
  const stale=entry;
  entry=await write('save',entry,{...values,title:'Private revision'});
  assert.equal((await feed())[0].title,values.title,'saved revision must not leak');
  await assert.rejects(write('publish',stale),e=>e.code==='40001');
  entry=await write('publish',entry);assert.equal((await feed())[0].title,'Private revision');
  entry=await write('archive',entry);assert.equal((await feed()).length,0);assert.equal((await feed(true)).length,1);
  entry=await write('restore',entry);assert.equal((await feed()).length,1);
  entry=await write('withdraw',entry);assert.equal((await feed(true)).length,0);
  entry=await write('archive',entry);
  await assert.rejects(write('delete',entry),denied);
  await actor(11); await write('delete',entry);
  assert.equal((await query('select public.snh_publishing_list() result'))[0].result.length,0);
  await actor(10);
  let future=await write('save',null,{...values,start:'2099-01-01',end:'2099-01-02'});future=await write('publish',future);
  assert.equal((await feed(true)).length,0,'future snapshot must stay private');
  let expired=await write('save',null,{...values,start:'2020-01-01',end:'2020-01-02'});expired=await write('publish',expired);
  assert.equal((await feed()).length,0);assert.equal((await feed(true)).length,1,'expired retained in history');
  let immediate=await write('save',null,{...values,end:'2020-01-01'});
  await assert.rejects(write('publish',immediate),e=>e.code==='22023');
  let second=await write('save',null,{...values,start:'2021-01-01'});second=await write('publish',second);
  const firstPage=await feed(true,1);assert.equal(firstPage[0].id,second.id);
  assert.equal((await feed(true,1,firstPage[0].starts_at,firstPage[0].id))[0].id,expired.id);
  await db.exec('reset role;set role anon');
  assert.equal((await feed()).length,1);await assert.rejects(query('select public.snh_publishing_list()'),denied);
  await assert.rejects(write('save',null,values),denied);await assert.rejects(query('select * from public.publishing_entries'),denied);
  await db.exec('reset role');
  const logs=await query("select * from public.audit_log where module='publishing'");
  assert.ok(logs.length>=12);assert.ok(logs.every(x=>[uid(110),uid(111)].includes(x.actor_user_id)));
  assert.equal(logs.filter(x=>x.action==='delete').length,1);
  assert.equal(logs.filter(x=>x.entity_id===entry.id).length,9,'only successful mutations audited; stale and denied writes leave no entry');
  assert.equal((await query('select count(*)::int n from public.memberships'))[0].n,0);
  console.log('PASS: draft isolation, publication, scheduling, expiry, history pagination, concurrency, RLS, role boundaries and transactional audit.');
} finally {await db.close();}
