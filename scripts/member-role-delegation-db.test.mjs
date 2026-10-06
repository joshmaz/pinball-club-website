// Focused fixture using the same standalone PGlite pattern as other database tests.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const query = async sql => (await db.query(sql)).rows;
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table members(id uuid primary key, user_id uuid, email text, display_name text,
      first_name text, last_name text, stern_insider_username text);
    create table memberships(id uuid primary key default gen_random_uuid(), member_id uuid,
      status text, tier text, end_date date, created_at timestamptz default now());
    create table external_accounts(member_id uuid, provider_slug text, account_handle text);
    grant usage on schema auth to authenticated;
    grant select on members to authenticated;
  `);
  for (const name of [
    '20260423190000_create_member_roles.sql',
    '20260423203000_member_admin_rpcs.sql',
    '20260427201536_member_role_slug_allowlist.sql',
    '20260427202201_membership_role_manager_access.sql',
    '20260508153118_manual_membership_admin_rpcs.sql',
    '20260921140000_member_role_scope.sql',
    '20260921150000_membership_door_access.sql',
    '20260928200000_membership_role_delegation.sql',
    '20260928220000_canonical_persisted_member_roles.sql'
  ]) await migration(name);
  for (let n = 1; n <= 4; n++) {
    await db.query('insert into members(id,user_id) values ($1,$1)', [uid(n)]);
  }
  await db.exec(await readFile(new URL('./member-role-rpc-boundaries.sql', import.meta.url), 'utf8'));
  // The SQL matrix rolls its fixtures back. Exercise real client-role restrictions separately.
  await db.exec(`insert into member_roles(member_id,role_slug) values
    ('${uid(1)}','membership_editor'),('${uid(2)}','membership_admin'),('${uid(3)}','club_admin');
    grant select, insert, update, delete on member_roles to authenticated;
    set role authenticated; set request.jwt.claim.sub='${uid(1)}';`);
  assert.equal((await query('select snh_member_can_manage_roles() ok'))[0].ok, true);
  await query(`select snh_set_member_membership('${uid(4)}','active','standard',null)`);
  assert.equal((await query('select snh_get_member_admin_stats() stats'))[0].stats.active_membership_count, 1);
  assert.equal((await query('select snh_list_members_for_admin() members'))[0].members.length, 4);
  await assert.rejects(query(`select snh_grant_member_role('${uid(1)}','membership_admin')`), /not authorized/);
  await assert.rejects(query(`insert into member_roles(member_id,role_slug) values ('${uid(1)}','club_admin')`), /row-level security/);
  assert.equal((await query(`delete from member_roles where member_id='${uid(1)}' returning *`)).length, 0);
  assert.equal((await query(`update member_roles set role_slug='club_admin' where member_id='${uid(1)}' returning *`)).length, 0);
  await db.exec(`set request.jwt.claim.sub='${uid(2)}'`);
  await assert.rejects(query(`select snh_grant_member_role('${uid(2)}',' CLUB_ADMIN ')`), /not authorized/);
  await assert.rejects(query(`select snh_grant_member_role('${uid(4)}','membership_admin')`), /not authorized/);
  await query(`select snh_grant_member_role('${uid(4)}',' EVENTS_EDITOR ')`);
  await query(`select snh_grant_member_role('${uid(4)}','events_editor')`);
  await query(`select snh_revoke_member_role('${uid(4)}','events_editor')`);
  await db.exec(`set request.jwt.claim.sub='${uid(4)}'`);
  await assert.rejects(query(`select snh_grant_member_role('${uid(4)}','events_editor')`), /not authorized/);
  await db.exec(`reset role; set request.jwt.claim.sub=''`);
  // No actor: isolate the last-administrator trigger from its self-removal check.
  await assert.rejects(query(`delete from member_roles where role_slug='club_admin'`), /last Club Admin/);
  assert.equal((await query("select count(*)::int n from member_roles where role_slug='club_admin'"))[0].n, 1);
  console.log('PASS: delegation matrix, invalid targets, membership upkeep, client RLS, and administrator guards.');
} finally {
  await db.close();
}
