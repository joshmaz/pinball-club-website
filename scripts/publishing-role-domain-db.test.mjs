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
  const assignments = await query('select * from public.member_roles order by member_id');
  await migration('20261017180000_publishing_role_domain.sql');
  assert.deepEqual(await query('select * from public.member_roles order by member_id'), assignments,
    'migration must not assign, revoke, or rewrite roles');

  await actor(1);
  await grant(10,'publishing_editor');
  await grant(11,'publishing_admin');
  const expectedPublishing = {
    club_admin:[true,true], publishing_editor:[true,false], publishing_admin:[true,true]
  };
  for (let i=0;i<roles.length;i++) {
    await actor(i+1);
    const role=roles[i], [manage,admin]=expectedPublishing[role] || [false,false];
    assert.deepEqual((await query(`select public.snh_member_has_publishing_access() manage,
      public.snh_member_has_publishing_admin_access() admin`))[0], {manage,admin},role);
    assert.equal((await query("select public.snh_member_has_effective_role('website_volunteer') ok"))[0].ok,true,role);
    assert.equal((await query('select public.snh_member_has_any_assigned_role() ok'))[0].ok,true,role);
    const canDelegate=['club_admin','membership_admin'].includes(role);
    for (const target of ['publishing_editor','publishing_admin']) {
      assert.equal((await query('select public.snh_member_can_assign_role($1) ok',[target]))[0].ok,canDelegate,role);
      if (!canDelegate) await assert.rejects(grant(13,target),denied,role+' may not delegate');
    }
    if (role.startsWith('publishing_')) {
      for (const domain of ['membership_editor','events_editor','photos_editor','games_editor','club_admin']) {
        assert.equal((await query('select public.snh_member_has_effective_role($1) ok',[domain]))[0].ok,false,
          role+' must not acquire '+domain);
      }
      await assert.rejects(query('select public.snh_set_member_membership($1,$2,$3,null)',
        [uid(13),'active','standard']),denied);
    }
  }
  for (const n of [12,999,0]) {
    await actor(n);
    assert.deepEqual((await query(`select public.snh_member_has_publishing_access() manage,
      public.snh_member_has_publishing_admin_access() admin`))[0],{manage:false,admin:false});
  }
  await actor(1);
  await query("select set_config('request.jwt.claim.sub',$1,false)",[uid(1)]);
  assert.equal((await query('select public.snh_member_has_publishing_access() ok'))[0].ok,false,
    'member UUID must not substitute for Auth UUID');
  await actor(3); // Membership Admin delegates both Publishing levels.
  for (const role of ['publishing_editor','publishing_admin']) {
    await grant(13,' '+role.toUpperCase()+' ');
    await grant(13,role);
    await assert.rejects(grant(14,role),e=>denied(e) && /must verify its email/.test(e.message));
    await revoke(13,role);
  }
  await assert.rejects(grant(13,'club_admin'),denied);
  await assert.rejects(grant(13,'membership_admin'),denied);
  await db.exec('reset role');
  const audit=await query(`select action,actor_user_id,new_data,old_data from public.audit_log
    where metadata->>'member_id'=$1 order by action,coalesce(new_data->>'role_slug',old_data->>'role_slug')`,[uid(13)]);
  assert.equal(audit.length,4,'duplicate or denied grants must not create business-change audit entries');
  assert.deepEqual(audit.map(r=>r.action),['grant','grant','revoke','revoke']);
  assert.ok(audit.every(r=>r.actor_user_id===uid(103)),'audit must preserve the actual delegating Auth actor');
  assert.equal((await query('select count(*)::int n from public.memberships'))[0].n,0);
  for (const role of ['website_volunteer','publishing_owner','PUBLISHING_EDITOR']) {
    await assert.rejects(query('insert into public.member_roles(member_id,role_slug) values ($1,$2)',[uid(12),role]),
      e=>e.code==='23514');
  }
  assert.equal((await query(`select convalidated from pg_constraint where conname='member_roles_canonical_role'`))[0].convalidated,true);
  await actor(10);
  for (const requirement of [' publishing_editor ','PUBLISHING_EDITOR','publishing_owner',null]) {
    assert.equal((await query('select public.snh_member_has_effective_role($1) ok',[requirement]))[0].ok,false);
  }
  await assert.rejects(query("select private.snh_member_has_effective_role($1,'club_admin')",[uid(1)]),denied);
  await db.exec('reset role');
  for (const helper of ['snh_member_has_publishing_access','snh_member_has_publishing_admin_access']) {
    const metadata=(await query(`select p.prosecdef,p.provolatile,p.proconfig,
      has_function_privilege('authenticated',p.oid,'execute') allowed,
      has_function_privilege('anon',p.oid,'execute') anonymous
      from pg_proc p where p.oid=$1::regprocedure`,['public.'+helper+'()']))[0];
    assert.deepEqual(metadata,{prosecdef:true,provolatile:'s',proconfig:['search_path=""'],allowed:true,anonymous:false});
  }
  await db.exec('set role anon');
  await assert.rejects(query('select public.snh_member_has_publishing_access()'),denied);
  await assert.rejects(query('select public.snh_member_has_publishing_admin_access()'),denied);
  await db.exec('reset role');
  console.log('PASS: Publishing domain inheritance, isolation, delegation, verified grants, audit, Basic membership, and function boundaries.');
} finally { await db.close(); }
