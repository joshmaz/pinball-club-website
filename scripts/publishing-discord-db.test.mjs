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
  await db.exec('reset role');
  await migration('20261018120000_publishing_discord.sql');

  const write=async(action,entry=null,values={})=>(await query(`select public.snh_publishing_write($1,$2,$3,$4,$5,$6,$7,$8,$9) result`,
   [action,entry?.id||null,entry?.version||null,values.title??'News',values.body??'Plain text',null,values.start??null,values.end??null,values.share??null]))[0].result;
  const claim=async()=>{await db.exec('reset role;set role service_role');return (await query('select public.snh_claim_publishing_discord() result'))[0].result;};
  const finish=async(job,status='shared',message='1561436651136483001')=>(await query('select public.snh_finish_publishing_discord($1,$2,$3,$4,$5,$6,$7) ok',
   [job.entry_id,job.lease_id,job.revision,status,message,message?'1561436946780135464':null,status==='shared'?null:'Test failure']))[0].ok;
  const detail=async id=>(await query('select public.snh_public_announcement($1) result',[id]))[0].result;
  await actor(10);
  let entry=await write('save',null,{share:true});
  assert.equal(entry.draft_discord,true);assert.equal(entry.discord_requested,false);
  assert.equal(await claim(),null,'draft opt-in never sends');
  await actor(10);entry=await write('publish',entry);
  let job=await claim();assert.equal(job.snapshot.title,'News');assert.equal(job.message_id,null);
  assert.equal(await claim(),null,'concurrent workers cannot claim the same announcement');
  await actor(10);entry=await write('save',entry,{title:'Changed',share:true});entry=await write('publish',entry);
  await db.exec('reset role;set role service_role');assert.equal(await finish(job),true);
  job=await claim();assert.equal(job.message_id,'1561436651136483001');assert.equal(job.snapshot.title,'Changed','queued revision follows an in-flight send');
  await finish(job);await db.exec('reset role');
  await query("insert into public.publishing_discord_config values(true,'1473002560511021298','1561436946780135464')");
  await db.exec('set role anon');let data=await detail(entry.id);assert.equal(data.discord_message_id,'1561436651136483001');assert.equal(data.discord_guild_id,'1473002560511021298');
  assert.equal(data.draft,undefined);
  for(const sql of ['select * from public.publishing_discord','select public.snh_claim_publishing_discord()','select public.snh_publishing_discord_status()'])await assert.rejects(query(sql),denied);
  await actor(10);entry=await write('withdraw',entry);assert.equal(await detail(entry.id),null);
  job=await claim();assert.equal(job.snapshot,null);assert.equal(job.message_id,'1561436651136483001');await finish(job);
  await actor(10);let uncertain=await write('save',null,{share:true});uncertain=await write('publish',uncertain);
  job=await claim();await finish(job,'uncertain',null);
  await actor(10);await assert.rejects(query('select public.snh_reconcile_publishing_discord($1)',[uncertain.id]),denied);
  assert.equal((await query('select public.snh_retry_publishing_discord($1) ok',[uncertain.id]))[0].ok,false,'ambiguous POST must not be blindly retried');
  await actor(11);assert.equal((await query('select public.snh_reconcile_publishing_discord($1,$2,$3) ok',[uncertain.id,'1561436651136483002','1561436946780135464']))[0].ok,true);
  job=await claim();assert.equal(job.message_id,'1561436651136483002');await finish(job,'failed','1561436651136483002');
  await actor(10);assert.equal((await query('select public.snh_retry_publishing_discord($1) ok',[uncertain.id]))[0].ok,true);job=await claim();await finish(job,'shared','1561436651136483002');
  await actor(10);let future=await write('save',null,{share:true,start:'2099-01-01'});future=await write('publish',future);assert.equal(await claim(),null);
  await actor(10);let expired=await write('save',null,{share:true,start:'2020-01-01',end:'2020-01-02'});expired=await write('publish',expired);assert.equal((await claim()).skip,true);
  await actor(10);let crashed=await write('save',null,{share:true});crashed=await write('publish',crashed);job=await claim();
  await db.exec("reset role;update public.publishing_discord set leased_at=now()-interval '6 minutes' where status='sending'");
  assert.equal(await claim(),null);assert.equal(await finish(job),false,'late result cannot bypass expired lease reconciliation');
  await db.exec('reset role');assert.equal((await query('select status from public.publishing_discord where entry_id=$1',[crashed.id]))[0].status,'uncertain');
  await actor(10);
  for(let i=0;i<22;i++){let x=await write('save',null,{title:'History '+i,start:'2024-01-01T00:00:00Z'});await write('publish',x);}
  await db.exec('reset role;set role anon');
  const page=async(args=[]) => (await query('select public.snh_public_announcement_page($1,$2,$3,$4) result',[args[0]||null,args[1]||null,args[2]||null,args[3]||null]))[0].result;
  const first=await page();assert.equal(first.entries.length,10);assert.equal(first.has_newer,false);assert.equal(first.has_older,true);
  const last=first.entries.at(-1),second=await page([last.starts_at,last.id]);assert.equal(second.entries.length,10);assert.equal(new Set([...first.entries,...second.entries].map(e=>e.id)).size,20);
  const previous=await page([null,null,second.entries[0].starts_at,second.entries[0].id]);assert.deepEqual(previous.entries,first.entries,'newer navigation reverses older cursor with timestamp ties');
  assert.equal(await detail(future.id),null);
  await db.exec('reset role');assert.ok((await query("select count(*)::int n from public.audit_log where module='publishing' and action like 'discord_%'"))[0].n>5);
  console.log('PASS: Discord opt-in, private snapshots, claims, in-flight revisions, ambiguous delivery recovery, scheduling, role isolation and reversible 10-item pages.');
} finally {await db.close();}
