// Run with @electric-sql/pglite installed, or PGLITE_MODULE pointing to its entrypoint.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const migration = async name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
try {
  await db.exec(`
    create schema private;
    create schema auth;
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.role() returns text language sql as $$select 'anon'::text$$;
    create table public.members (id uuid primary key, name text, created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.external_accounts (id uuid primary key, member_id uuid, provider_slug text, account_name text);
    create table public.audit_log (module text, action text, actor_user_id uuid, entity_type text, entity_id text, metadata jsonb);
  `);
  await db.exec(await migration('20260921122000_audit_member_profile_changes.sql'));
  const member = '00000000-0000-0000-0000-000000000001';
  const account = '00000000-0000-0000-0000-000000000002';
  await assert.rejects(db.exec(`insert into members (id, name) values ('${member}', 'Private Name')`), /has no field "provider_slug"/);
  assert.equal((await db.query('select * from members')).rows.length, 0);
  console.log('Reproduced original signup failure and rollback.');
  await db.exec(await migration('20260925010000_fix_member_profile_audit_signup.sql'));
  await db.exec(`
    insert into members (id, name) values ('${member}', 'Private Name');
    update members set name = 'Changed Private Name' where id = '${member}';
    update members set updated_at = now() where id = '${member}';
    insert into external_accounts values ('${account}', '${member}', 'stern', 'Private Account');
    update external_accounts set provider_slug = 'matchplay' where id = '${account}';
    delete from external_accounts where id = '${account}';
    delete from members where id = '${member}';
  `);
  const rows = (await db.query('select * from audit_log')).rows;
  assert.equal(rows.length, 6, 'Timestamp-only updates must not create audit entries');
  for (const type of ['member_profile', 'external_account']) {
    assert.deepEqual(rows.filter(r => r.entity_type === type).map(r => r.action).sort(), ['create', 'delete', 'update']);
  }
  for (const row of rows) {
    assert.equal(row.metadata.member_id, member);
    assert.equal(row.entity_id, row.entity_type === 'member_profile' ? member : account);
    assert.equal(row.metadata.auth_role, 'anon');
    assert.equal(row.actor_user_id, null);
    assert.ok(!JSON.stringify(row).includes('Private'), 'Audit metadata must not expose private values');
    assert.equal(row.metadata.provider_slug, row.entity_type === 'member_profile' ? null : row.action === 'create' ? 'stern' : 'matchplay');
  }
  assert.deepEqual(rows.find(r => r.entity_type === 'member_profile' && r.action === 'update').metadata.changed_fields, ['name']);
  assert.deepEqual(rows.find(r => r.entity_type === 'external_account' && r.action === 'update').metadata.changed_fields, ['provider_slug']);
  console.log('PASS: member and external-account create/update/delete, provider metadata, changed fields, privacy, and no-op updates.');
} finally {
  await db.close();
}
