// Disposable PGlite fixture; expectations are explicit policy examples, not SQL-derived.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const canonical = ['club_admin', 'membership_admin', 'membership_editor', 'events_admin',
  'events_editor', 'photos_admin', 'photos_editor', 'games_admin', 'games_editor'];
const expected = {
  club_admin: ['club_admin', 'membership_admin', 'membership_editor', 'events_admin',
    'events_editor', 'photos_admin', 'photos_editor', 'games_admin', 'games_editor', 'website_volunteer'],
  membership_admin: ['membership_admin', 'membership_editor', 'website_volunteer'],
  membership_editor: ['membership_editor', 'website_volunteer'],
  events_admin: ['events_admin', 'events_editor', 'website_volunteer'],
  events_editor: ['events_editor', 'website_volunteer'],
  photos_admin: ['photos_admin', 'photos_editor', 'website_volunteer'],
  photos_editor: ['photos_editor', 'website_volunteer'],
  games_admin: ['games_admin', 'games_editor', 'website_volunteer'],
  games_editor: ['games_editor', 'website_volunteer'],
};
const requirements = [...canonical, 'website_volunteer', 'unknown_role', 'members_manager',
  'GAMES_EDITOR', ' games_editor ', '', null];
async function assertPolicy(userId, allowed, label) {
  await db.exec('set role authenticated');
  await query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
  for (const required of requirements) {
    const result = (await query('select public.snh_member_has_effective_role($1) ok', [required]))[0].ok;
    assert.equal(result, allowed.includes(required), `${label}: ${String(required)}`);
  }
  await db.exec('reset role');
}
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.members(id uuid primary key, user_id uuid unique);
    grant usage on schema auth to authenticated;
    grant select on public.members to authenticated;
  `);
  for (const name of [
    '20260423190000_create_member_roles.sql',
    '20260427201536_member_role_slug_allowlist.sql',
    '20260928220000_canonical_persisted_member_roles.sql',
    '20260928230000_canonical_effective_role_core.sql'
  ]) await migration(name);
  // Deliberately use different member IDs and auth user IDs.
  for (let n = 1; n <= 13; n++) {
    await query('insert into members(id,user_id) values ($1,$2)', [uid(n), uid(n + 100)]);
  }
  for (let i = 0; i < canonical.length; i++) {
    await query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(i + 1), canonical[i]]);
  }
  // Exercise the helper under authenticated, with actual own-row RLS on assignments.
  await db.exec('grant select on member_roles to authenticated');
  for (let i = 0; i < canonical.length; i++) {
    await assertPolicy(uid(i + 101), expected[canonical[i]], canonical[i]);
  }
  await assertPolicy(uid(110), [], 'member without assignments');
  await assertPolicy(uid(999), [], 'authenticated user without member');
  await assertPolicy(null, [], 'no authenticated identity');
  await assertPolicy(uid(1), [], 'member ID cannot substitute for auth user ID');

  await query(`insert into member_roles(member_id,role_slug) values
    ($1,'events_admin'),($1,'games_editor'),($1,'events_editor')`, [uid(11)]);
  await assertPolicy(uid(111), ['events_admin', 'events_editor', 'games_editor', 'website_volunteer'], 'mixed domains and redundant assignment');

  // Persisted derived/unknown identifiers remain prohibited by the literal CHECK.
  for (const slug of ['website_volunteer', 'members_manager', 'unknown_role']) {
    await assert.rejects(query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(12), slug]),
      error => error.code === '23514' && /member_roles_canonical_role/.test(error.message));
  }
  // Simulate legacy corruption only in a rolled-back fixture: the core must also
  // filter assignments independently of the storage constraint.
  await db.exec('begin; alter table member_roles drop constraint member_roles_canonical_role');
  for (const slug of ['website_volunteer', 'members_manager', 'unknown_role']) {
    await query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(12), slug]);
    await assertPolicy(uid(112), [], `invalid-only assignments including ${slug}`);
  }
  await query("insert into member_roles(member_id,role_slug) values ($1,'photos_admin')", [uid(12)]);
  await assertPolicy(uid(112), ['photos_admin', 'photos_editor', 'website_volunteer'], 'valid plus invalid assignments');
  await db.exec('rollback');
  assert.equal((await query(`select convalidated from pg_constraint
    where conname='member_roles_canonical_role'`))[0].convalidated, true);

  const properties = (await query(`select p.prosecdef, p.provolatile, p.proconfig, p.pronargs,
    has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
    has_function_privilege('anon', p.oid, 'execute') as anon_execute,
    exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid='public.snh_member_has_effective_role(text)'::regprocedure`))[0];
  assert.equal(properties.prosecdef, true);
  assert.equal(properties.provolatile, 's');
  assert.deepEqual(properties.proconfig, ['search_path=""']);
  assert.equal(properties.pronargs, 1);
  assert.equal(properties.authenticated_execute, true);
  assert.equal(properties.anon_execute, false);
  assert.equal(properties.public_execute, false);
  await db.exec('set role anon');
  await assert.rejects(query("select public.snh_member_has_effective_role('website_volunteer')"), error => error.code === '42501');
  await db.exec('reset role');
  console.log('PASS: canonical effective-role matrix, caller isolation, invalid/mixed roles, derived Volunteer, and function security.');
} finally {
  await db.close();
}
