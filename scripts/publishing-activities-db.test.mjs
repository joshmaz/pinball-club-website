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
  await db.exec('reset role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text);');
  await migration('20261018120000_publishing_discord.sql');
  await migration('20261019200000_publishing_activities.sql');
  const activity=async(action,row=null,values=null)=>(await query('select public.snh_publishing_activity_write($1,$2,$3,$4) result',[action,row?.id||null,row?.version||null,values]))[0].result;
  const image=async(action,id=null,title=null,alt=null)=>(await query('select public.snh_publishing_image_write($1,$2,$3,$4) result',[action,id,title,alt]))[0].result;
  const feed=async()=>(await query('select public.snh_public_activities() result'))[0].result;
  const values={title:'League night',body:'Play together',url:'https://example.com/league',position:2,fit:'cover'};
  for(const n of [2,3,4,5,6,7,8,9,12,14,999]){await actor(n);await assert.rejects(activity('save',null,values),denied);await assert.rejects(image('reserve',null,'Art','Club artwork'),denied);}
  await actor(10);
  let row=await activity('save',null,values);
  assert.equal((await feed()).length,0,'draft private');
  await assert.rejects(query('select * from public.publishing_entries'),denied);
  await assert.rejects(activity('save',row,{...values,url:'javascript:bad'}));
  await assert.rejects(activity('save',row,{...values,focus_x:101}));
  const asset=await image('reserve',null,'League artwork','People playing pinball');
  await assert.rejects(image('finish',asset.id));
  await assert.rejects(activity('save',row,{...values,image_id:asset.id,image_alt:asset.alt}),'incomplete image rejected');
  await db.exec('reset role');await query("insert into storage.objects values('publishing-private',$1),('publishing-private',$2)",[asset.id+'/web.webp',asset.id+'/thumb.webp']);
  await actor(10);await image('finish',asset.id);
  row=await activity('save',row,{...values,image_id:asset.id,image_alt:asset.alt,fit:'contain'});
  await assert.rejects(activity('publish',row),'private-only image cannot be published');
  await db.exec('reset role');await query("insert into storage.objects values('publishing-public',$1)",[asset.id+'/web.webp']);
  await actor(10);let published=await activity('publish',row);
  assert.equal((await feed())[0].image_id,asset.id);assert.equal((await feed())[0].fit,'contain');
  await assert.rejects(activity('save',row,values),e=>e.code==='40001');
  row=await activity('save',published,{...values,title:'Private replacement',image_id:asset.id,image_alt:asset.alt});
  assert.equal((await feed())[0].title,'League night','draft changes preserve live snapshot');
  let other=await activity('save',null,{...values,title:'Another activity',image_id:asset.id,image_alt:asset.alt});
  await actor(11);await assert.rejects(image('remove',asset.id),'in-use image protected');
  await actor(10);row=await activity('withdraw',row);row=await activity('archive',row);assert.equal((await feed()).length,0);
  await assert.rejects(activity('delete',row),denied);
  await actor(11);await activity('delete',row);await assert.rejects(image('remove',asset.id),'other draft still references shared image');
  other=await activity('archive',other);await activity('delete',other);
  await assert.rejects(image('remove',asset.id),'in-flight safety grace');
  await db.exec('reset role');await query("update public.publishing_images set created_at=now()-interval '20 minutes' where id=$1",[asset.id]);await actor(11);
  await image('remove',asset.id);await assert.rejects(image('removed',asset.id),'failed cleanup remains retryable');
  await db.exec('reset role');await query("delete from storage.objects where name in ($1,$2)",[asset.id+'/web.webp',asset.id+'/thumb.webp']);await actor(11);await image('removed',asset.id);
  assert.equal((await query('select public.snh_publishing_images() result'))[0].result.length,0);
  await actor(10);const future=await activity('save',null,{...values,starts_at:'2099-01-01T00:00:00Z'});await activity('publish',future);assert.equal((await feed()).length,0);
  assert.equal((await query('select public.snh_publishing_discord_status() as items'))[0].items.length,0,'activities do not enqueue Discord messages');
  const ended=await activity('save',null,{...values,starts_at:'2020-01-01T00:00:00Z',ends_at:'2020-02-01T00:00:00Z'});await activity('publish',ended);assert.equal((await feed()).length,0);
  await db.exec('reset role;set role anon');await assert.rejects(query('select public.snh_publishing_images()'),denied);assert.equal((await feed()).length,0);
  await db.exec('reset role');const audit=await query("select action from public.audit_log where entity_type in ('activity','publishing_image')");assert.ok(audit.some(e=>e.action==='image_removed'));assert.ok(audit.some(e=>e.action==='publish'));
} finally {await db.close();}
