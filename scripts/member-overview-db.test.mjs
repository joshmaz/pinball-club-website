import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const read = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
test('overview counts accounts using verification, latest membership and canonical volunteer eligibility', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role authenticated; create role anon; create role service_role;
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
      create table auth.users(id uuid primary key, email_confirmed_at timestamptz);
      create table members(id uuid primary key, user_id uuid);
      create table memberships(id int primary key, member_id uuid, status text, end_date date, created_at timestamptz);
      create table member_roles(member_id uuid, role_slug text);
      create function public.snh_member_can_manage_roles() returns boolean language sql as $$
        select coalesce(current_setting('test.authorized',true),'') = 'yes' $$;`);
    const canonical = await read('20260928235800_notification_enqueue_authorization.sql');
    await db.exec(canonical.slice(canonical.indexOf('create function private.snh_member_has_effective_role'), canonical.indexOf('-- Preserve the public signature')));
    const allowlist = await read('20260427201536_member_role_slug_allowlist.sql');
    await db.exec(allowlist.slice(0, allowlist.indexOf('revoke all')));
    const helper = await read('20260928220000_canonical_persisted_member_roles.sql');
    await db.exec(helper.slice(helper.indexOf('create or replace function public.snh_member_has_any_assigned_role'), helper.indexOf('revoke all')));
    await db.exec(await read('20261008233000_member_admin_overview.sql'));
    await db.exec(await read('20261009003000_member_overview_ignore_legacy_end_date.sql'));
    for (let n = 1; n <= 7; n++) {
      await db.query('insert into auth.users values ($1,$2)', [id(n), n === 1 ? null : '2026-01-01']);
      if (n !== 7) await db.query('insert into members values ($1,$1)', [id(n)]);
    }
    await db.query(`insert into memberships values
      (1,$1,'active',null,'2025-01-01'), (2,$1,'inactive',null,'2026-01-01'),
      (3,$2,'active',current_date-1,'2026-01-01'),
      (4,$3,'active',current_date,'2026-01-01'),
      (5,$4,'active',null,'2026-01-01'), (6,$4,'expired',null,'2026-01-01'),
      (7,$5,'active',null,'2026-01-01')`, [id(2),id(3),id(4),id(5),id(6)]);
    await db.query(`insert into member_roles values ($1,'games_editor'),($1,'events_admin'),($2,'club_admin'),($3,'unknown_role')`, [id(2),id(4),id(3)]);
    await assert.rejects(db.query('select snh_get_member_admin_stats()'), e => e.code === '42501');
    for (const n of [2,3,4]) {
      await db.query("select set_config('test.user',$1,false)", [id(n)]);
      const eligibility = (await db.query("select snh_member_has_any_assigned_role() as notes_issues, private.snh_member_has_effective_role($1,'website_volunteer') as overview", [id(n)])).rows[0];
      assert.equal(eligibility.notes_issues, eligibility.overview);
    }
    await db.exec("set test.authorized = 'yes'");
    const stats = (await db.query('select snh_get_member_admin_stats() as stats')).rows[0].stats;
    assert.deepEqual(stats, {account_count:7, full_access_count:3, basic_count:3, volunteer_count:2});
    const metadata = (await db.query(`select prosecdef, has_function_privilege('authenticated',oid,'execute') as allowed,
      has_function_privilege('anon',oid,'execute') as anonymous from pg_proc where proname='snh_get_member_admin_stats'`)).rows[0];
    assert.deepEqual(metadata, {prosecdef:true, allowed:true, anonymous:false});
  } finally { await db.close(); }
});
