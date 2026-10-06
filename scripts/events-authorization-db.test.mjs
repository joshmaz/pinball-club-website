// Real historical policies/digest, then the forward migration; no tests against UI gating.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const read = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const migration = async name => db.exec(await read(name));
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// Independent expectations: Events editor, Events admin, digest access.
const actors = [
  ['events_editor', true, false, true],
  ['events_admin', true, true, true],
  ['club_admin', true, true, true],
  ['photos_editor', false, false, true],
  ['photos_admin', false, false, true],
  ['membership_editor', false, false, false],
  ['membership_admin', false, false, false],
  ['games_editor', false, false, false],
  ['games_admin', false, false, false],
  ['no role', false, false, false],
  ['no member', false, false, false],
];
const asUser = async i => {
  await db.exec('set role authenticated');
  await query("select set_config('request.jwt.claim.sub',$1,false)", [uid(101 + i)]);
};
async function resetEvents() {
  await db.exec('reset role; delete from events');
  await query(`insert into events(id,title,published) values
    ($1,'Private',false),($2,'Public',true),($3,'Legacy public',null)`, [uid(201), uid(202), uid(203)]);
}
async function policyMetadata() {
  return query(`select oid,polname,polcmd,polpermissive,polroles::text,
    polqual is not null as has_using,polwithcheck is not null as has_check
    from pg_policy where polrelid='public.events'::regclass order by polname`);
}
async function digestMetadata() {
  return query(`select oid,proowner,prosecdef,provolatile,proconfig,proacl::text
    from pg_proc where oid='public.snh_event_photo_digest_for_editor(uuid)'::regprocedure`);
}
async function exercise(withHelpers) {
  const results = [];
  for (let i = 0; i < actors.length; i++) {
    const [label, editor, admin, digest] = actors[i];
    await resetEvents();
    await asUser(i);
    if (withHelpers) {
      assert.deepEqual((await query(`select snh_member_has_events_access() editor,
        snh_member_has_events_admin_access() admin`))[0], { editor, admin }, label);
    }
    const visible = (await query('select title from events order by title')).map(r => r.title);
    assert.deepEqual(visible, editor ? ['Legacy public', 'Private', 'Public'] : ['Legacy public', 'Public'], label);
    const insert = () => query("insert into events(id,title,published) values ($1,'New draft',false)", [uid(204)]);
    if (editor) await insert();
    else await assert.rejects(insert(), e => e.code === '42501');
    const updated = await query("update events set title='Updated' where id=$1 returning id", [uid(201)]);
    assert.equal(updated.length, editor ? 1 : 0, `${label}: private UPDATE USING`);
    // A public SELECT policy must not confer write access.
    assert.equal((await query("update events set title='Updated public' where id=$1 returning id", [uid(202)])).length,
      editor ? 1 : 0, `${label}: public row update`);
    const callDigest = () => query('select snh_event_photo_digest_for_editor($1) result', [uid(201)]);
    let payload = null;
    if (digest) {
      payload = (await callDigest())[0].result;
      assert.deepEqual(payload, { albums: [{ id: uid(301), slug: 'test', title: 'Draft album',
        published: false, displayAt: null, assetCounts: { total: 0, published: 0 } }], hero: null });
    } else await assert.rejects(callDigest(), e => e.code === '42501');
    const deleted = await query('delete from events where id=$1 returning id', [uid(201)]);
    assert.equal(deleted.length, admin ? 1 : 0, `${label}: delete`);
    assert.equal((await query('delete from events where id=$1 returning id', [uid(202)])).length,
      admin ? 1 : 0, `${label}: public row delete`);
    results.push({ visible, updated: updated.length, deleted: deleted.length, payload });
    await db.exec('reset role');
  }
  // Anonymous public access is unchanged, including the preexisting NULL rule.
  await resetEvents();
  await db.exec('set role anon');
  assert.equal((await query('select count(*)::int n from events'))[0].n, 2);
  await assert.rejects(query("insert into events values (gen_random_uuid(),'Forbidden',true)"), e => e.code === '42501');
  await db.exec('reset role');
  return results;
}
async function isolateUpdateClauses() {
  // Each test relaxes only the other clause in a rolled-back fixture. This
  // distinguishes an explicit WITH CHECK from PostgreSQL's fallback to USING.
  await resetEvents();
  await db.exec('begin; alter policy events_managers_update on events using (true)');
  await asUser(9); // no assignments; public row is SELECT-visible
  await assert.rejects(query("update events set title='Forbidden' where id=$1", [uid(202)]), e => e.code === '42501');
  await db.exec('rollback; reset role');
  await db.exec('begin; alter policy events_managers_update on events with check (true)');
  await asUser(9);
  assert.equal((await query("update events set title='Forbidden' where id=$1 returning id", [uid(202)])).length, 0);
  await db.exec('rollback; reset role');
}
try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create table members(id uuid primary key,user_id uuid unique);
    create table events(id uuid primary key,title text,published boolean);
    create table photo_albums(id uuid primary key,event_id uuid,slug text,title text,
      published boolean,display_at timestamptz,sort_position int);
    create table photo_assets(id uuid,album_id uuid,status text,visibility text,promo_role text,
      caption text,alt_text text,original_width int,original_height int,published_at timestamptz);
    create table photo_asset_variants(asset_id uuid,variant text,bucket text,object_key text,
      content_type text,width int,height int,content_hash text);
    grant select on members to authenticated;
    grant usage on schema auth to authenticated;
  `);
  await migration('20260423190000_create_member_roles.sql');
  await db.exec('grant select on member_roles to authenticated');
  await migration('20260928230000_canonical_effective_role_core.sql');
  await migration('20260928235000_domain_helpers_use_effective_roles.sql');
  await migration('20260426174500_reset_events_policies_and_grants.sql');
  await migration('20260427191015_restrict_event_delete_to_admin_roles.sql');
  await migration('20260521120000_fix_event_digest_order_by_scope.sql');
  for (let i = 0; i < 10; i++) {
    await query('insert into members values ($1,$2)', [uid(i + 1), uid(i + 101)]);
    if (i < 9) await query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(i + 1), actors[i][0]]);
  }
  await query("insert into photo_albums values ($1,$2,'test','Draft album',false,null,0)", [uid(301), uid(201)]);
  const beforePolicies = await policyMetadata();
  const beforeDigest = await digestMetadata();
  const publicPolicy = await query("select pg_get_expr(polqual,polrelid) expression from pg_policy where polname='events_public_read_published'");
  const before = await exercise(false);
  await isolateUpdateClauses();
  await migration('20260928235500_events_use_effective_roles.sql');
  assert.deepEqual(await policyMetadata(), beforePolicies);
  assert.deepEqual(await digestMetadata(), beforeDigest);
  assert.deepEqual(await query("select pg_get_expr(polqual,polrelid) expression from pg_policy where polname='events_public_read_published'"), publicPolicy);
  assert.deepEqual(await exercise(true), before);
  await isolateUpdateClauses();
  const security = await query(`select prosecdef,provolatile,proconfig,pronargs,
    has_function_privilege('authenticated',oid,'execute') as authenticated_execute,
    has_function_privilege('anon',oid,'execute') as anon_execute,
    exists(select 1 from aclexplode(proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc where proname in ('snh_member_has_events_access','snh_member_has_events_admin_access')`);
  assert.equal(security.length, 2);
  for (const row of security) assert.deepEqual(row, { prosecdef: true, provolatile: 's',
    proconfig: ['search_path=public'], pronargs: 0, authenticated_execute: true, anon_execute: false, public_execute: false });
  await db.exec("set role authenticated; set request.jwt.claim.sub=''");
  assert.deepEqual((await query('select snh_member_has_events_access() editor,snh_member_has_events_admin_access() admin'))[0], { editor: false, admin: false });
  await assert.rejects(query('select snh_event_photo_digest_for_editor($1)', [uid(201)]), e => e.code === '42501');
  await db.exec('reset role');
  console.log('PASS: Events helper security, before/after RLS and digest equivalence, and independent UPDATE clauses.');
} finally {
  await db.close();
}
