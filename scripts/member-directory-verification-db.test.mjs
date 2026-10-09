import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
test('directory exposes authoritative verification and preserves latest membership and access boundary', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email_confirmed_at timestamptz);
      create table members(id uuid primary key, user_id uuid, email text, first_name text, last_name text, display_name text);
      create table external_accounts(member_id uuid, provider_slug text, account_handle text);
      create table member_roles(member_id uuid, role_slug text);
      create table memberships(id int, member_id uuid, status text, tier text, end_date date, created_at timestamptz);
      create function snh_member_can_manage_roles() returns boolean language sql as $$ select coalesce(current_setting('test.allowed',true),'')='yes' $$;
      insert into auth.users values ('00000000-0000-0000-0000-000000000001',now()),('00000000-0000-0000-0000-000000000002',null);
      insert into members(id,user_id,email) select id,id,id::text from auth.users;
      insert into memberships values (1,'00000000-0000-0000-0000-000000000001','active','standard',current_date-1,now()),(2,'00000000-0000-0000-0000-000000000001','inactive','standard',null,now());`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261009004500_member_directory_verification.sql',import.meta.url),'utf8'));
    await assert.rejects(db.query('select snh_list_members_for_admin()'),e=>e.code==='42501');
    await db.exec("set test.allowed='yes'");
    const rows = (await db.query('select snh_list_members_for_admin() as rows')).rows[0].rows;
    assert.equal(rows[0].email_verified,true);
    assert.equal(rows[0].membership_status,'inactive');
    assert.equal(rows[1].email_verified,false);
    assert.equal(rows[1].membership_status,null);
    assert.deepEqual(rows[0].role_slugs,[]);
  } finally { await db.close(); }
});
