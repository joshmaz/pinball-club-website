// Disposable PGlite only. Uses the production helper and Club Issues upsert.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const hardening = '20260928220000_canonical_persisted_member_roles.sql';
const canonical = ['club_admin', 'membership_editor', 'membership_admin',
  'events_editor', 'events_admin', 'photos_editor', 'photos_admin', 'games_editor', 'games_admin'];
const invalid = ['website_volunteer', 'members_manager', 'unknown_role'];
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const assign = slug => query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(1), slug]);
const checkViolation = error => error.code === '23514' && /member_roles_canonical_role/.test(error.message);
try {
  await db.exec(`
    create role authenticated;
    create schema auth;
    create schema private;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table members(id uuid primary key, user_id uuid);
    grant usage on schema auth to authenticated;
    grant select on members to authenticated;
    create table club_issues(
      id uuid primary key default gen_random_uuid(), game_id uuid,
      title text, body text, status text, created_by uuid,
      submission_origin text, submitted_at timestamptz
    );
    -- Unrelated game validation and audit plumbing are outside this fixture.
    -- All exercised issues have no linked game.
    create function private.snh_require_game_editable(uuid) returns void
      language plpgsql as $$ begin raise exception 'unexpected game validation'; end $$;
    create function private.snh_audit_game(text,text,text,jsonb,jsonb,jsonb)
      returns void language plpgsql as $$ begin return; end $$;
  `);
  for (const name of [
    '20260423190000_create_member_roles.sql',
    '20260427201536_member_role_slug_allowlist.sql',
    '20260510120000_club_issues_any_named_role.sql',
    '20260525120000_club_issues_helpers_full_edit.sql'
  ]) await migration(name);
  await query('insert into members values ($1,$1)', [uid(1)]);

  // Existing invalid assignments must stop deployment without being rewritten.
  for (const slug of invalid) {
    await assign(slug);
    await db.exec('begin');
    await assert.rejects(migration(hardening), checkViolation);
    await db.exec('rollback');
    assert.deepEqual((await query('select role_slug from member_roles')).map(r => r.role_slug), [slug]);
    await db.exec('delete from member_roles');
  }
  await migration(hardening);
  for (const slug of canonical) await assign(slug);
  assert.deepEqual((await query('select role_slug from member_roles order by role_slug')).map(r => r.role_slug), [...canonical].sort());
  for (const slug of invalid) {
    await assert.rejects(assign(slug), checkViolation);
    await assert.rejects(query("update member_roles set role_slug=$1 where role_slug='events_editor'", [slug]), checkViolation);
  }
  assert.equal((await query(`select convalidated from pg_constraint
    where conname='member_roles_canonical_role'`))[0].convalidated, true);
  const helper = (await query(`select p.prosecdef, p.provolatile, p.proconfig,
    has_function_privilege('authenticated', p.oid, 'execute') as executable
    from pg_proc p where p.oid='public.snh_member_has_any_assigned_role()'::regprocedure`))[0];
  assert.equal(helper.prosecdef, true);
  assert.equal(helper.provolatile, 's');
  assert.deepEqual(helper.proconfig, ['search_path=public']);
  assert.equal(helper.executable, true);
  await db.exec('delete from member_roles');

  // Only this rolled-back fixture relaxes persistence to simulate legacy rows.
  // Keep the production format constraint and the hardened helper intact.
  await db.exec('begin; alter table member_roles drop constraint member_roles_canonical_role');
  const cases = [[], ...invalid.map(r => [r]), ...canonical.map(r => [r]),
    ...canonical.map(r => [...invalid, r])];
  for (const roles of cases) {
    await db.exec('reset role; delete from member_roles; delete from club_issues');
    for (const slug of roles) await assign(slug);
    await query("insert into club_issues(id,title,status) values ($1,'Original','open')", [uid(2)]);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${uid(1)}'`);
    const allowed = roles.some(r => canonical.includes(r));
    assert.equal((await query('select snh_member_has_any_assigned_role() ok'))[0].ok, allowed, JSON.stringify(roles));
    const update = () => query('select snh_club_issues_upsert($1,$2::jsonb)',
      [uid(2), JSON.stringify({ title: 'Updated', body: 'Updated body', status: 'resolved' })]);
    if (allowed) await update();
    else {
      await db.exec('savepoint denied_update');
      await assert.rejects(update(), error => error.code === '42501');
      await db.exec('rollback to savepoint denied_update; release savepoint denied_update');
    }
    for (const status of ['in_progress', 'resolved']) {
      await query('select snh_club_issues_upsert(null,$1::jsonb)',
        [JSON.stringify({ title: status, status })]);
    }
    await db.exec('reset role');
    const original = (await query('select title,status from club_issues where id=$1', [uid(2)]))[0];
    assert.deepEqual(original, allowed ? { title: 'Updated', status: 'resolved' } : { title: 'Original', status: 'open' });
    for (const row of await query('select title,status from club_issues where id<>$1', [uid(2)])) {
      assert.equal(row.status, allowed ? row.title : 'open');
    }
  }
  await db.exec('rollback');
  // The fixture must leave the validated production constraint in place.
  await assert.rejects(assign('website_volunteer'), checkViolation);
  console.log('PASS: canonical persistence, legacy-row rejection, volunteer authority, and Club Issues boundaries.');
} finally {
  await db.close();
}
