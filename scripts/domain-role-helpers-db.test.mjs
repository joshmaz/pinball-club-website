// Compare real legacy helpers and consumers with the forward-migrated wrappers.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const read = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const migration = async name => db.exec(await read(name));
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const helpers = ['snh_member_can_manage_roles', 'snh_member_has_games_access',
  'snh_member_has_games_admin_access', 'snh_member_has_photos_access', 'snh_member_has_photos_admin_access'];
// Explicit expected matrix: Membership Editor, Games Editor/Admin, Photos Editor/Admin.
const cases = [
  ['membership_editor', [true, false, false, false, false]],
  ['membership_admin', [true, false, false, false, false]],
  ['events_editor', [false, false, false, false, false]],
  ['events_admin', [false, false, false, false, false]],
  ['games_editor', [false, true, false, false, false]],
  ['games_admin', [false, true, true, false, false]],
  ['photos_editor', [false, false, false, true, false]],
  ['photos_admin', [false, false, false, true, true]],
  ['club_admin', [true, true, true, true, true]],
  ['no role', [false, false, false, false, false]],
  ['no member', [false, false, false, false, false]],
  ['no identity', [false, false, false, false, false]],
];
function functionWithGrants(source, name, signature) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  const grant = `grant execute on function public.${name}(${signature}) to authenticated;`;
  const end = source.indexOf(grant, start);
  assert.ok(start >= 0 && end > start, `fixture could not locate ${name}`);
  return source.slice(start, end + grant.length);
}
function policy(source, name) {
  const start = source.indexOf(`create policy ${name}\n`);
  const end = source.indexOf(';', start);
  assert.ok(start >= 0 && end > start, `fixture could not locate ${name}`);
  return source.slice(start, end + 1);
}
async function securitySnapshot() {
  return query(`select oid, proname, proowner, prosecdef, provolatile, proconfig, proacl::text,
    has_function_privilege('authenticated', oid, 'execute') as authenticated_execute,
    has_function_privilege('anon', oid, 'execute') as anon_execute
    from pg_proc where pronamespace='public'::regnamespace and proname=any($1::text[])
    order by proname`, [helpers]);
}
async function exercise() {
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const [label, expected] = cases[i];
    // Recreate a disposable album as the owner before each RPC attempt.
    await query("insert into photo_albums(id,published) values ($1,false) on conflict (id) do nothing", [uid(200)]);
    await db.exec('set role authenticated');
    await query("select set_config('request.jwt.claim.sub',$1,false)", [label === 'no identity' ? '' : uid(101 + i)]);
    const actual = [];
    for (const helper of helpers) actual.push((await query(`select public.${helper}() ok`))[0].ok);
    assert.deepEqual(actual, expected, label);
    // Real SELECT policies; unauthorized callers must see no private rows.
    const photos = (await query('select count(*)::int n from photo_albums'))[0].n;
    const games = (await query('select count(*)::int n from game_images'))[0].n;
    assert.equal(photos, expected[3] ? 1 : 0, `${label}: Photos RLS`);
    assert.equal(games, expected[1] ? 1 : 0, `${label}: Games RLS`);
    const remove = () => query('select public.snh_photo_album_delete($1) result', [uid(200)]);
    if (expected[4]) assert.equal((await remove())[0].result.ok, true);
    else await assert.rejects(remove(), error => error.code === '42501');
    await db.exec('reset role');
    assert.equal((await query('select count(*)::int n from photo_albums'))[0].n, expected[4] ? 0 : 1);
    results.push({ actual, photos, games, deleteAllowed: expected[4] });
  }
  return results;
}
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema private;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create table members(id uuid primary key,user_id uuid unique);
    create table photo_albums(id uuid primary key,published boolean);
    create table photo_assets(id uuid primary key,album_id uuid references photo_albums on delete cascade);
    create table game_images(id uuid primary key,usage_status text);
    -- Audit plumbing is unrelated to the role boundary under test.
    create function private.snh_audit_photo(text,text,text,jsonb,jsonb,jsonb)
      returns void language plpgsql as $$ begin return; end $$;
    alter table photo_albums enable row level security;
    alter table game_images enable row level security;
    grant select on members,photo_albums,game_images to authenticated;
    grant usage on schema auth to authenticated;
    insert into game_images values ('${uid(201)}','reference_only');
  `);
  await migration('20260423190000_create_member_roles.sql');
  await db.exec('grant select on member_roles to authenticated');
  await migration('20260427202201_membership_role_manager_access.sql');
  const games = await read('20260501103000_games_catalog.sql');
  const photos = await read('20260512100000_photos_foundation.sql');
  for (const name of helpers.slice(1, 3)) await db.exec(functionWithGrants(games, name, ''));
  for (const name of helpers.slice(3)) await db.exec(functionWithGrants(photos, name, ''));
  await db.exec(policy(photos, 'photo_albums_editors_read'));
  await db.exec(policy(await read('20260916100000_game_images.sql'), 'game_images_public_approved_read'));
  await db.exec(functionWithGrants(await read('20260512120000_photos_rpcs.sql'), 'snh_photo_album_delete', 'uuid'));
  for (let i = 0; i < 10; i++) {
    await query('insert into members values ($1,$2)', [uid(i + 1), uid(i + 101)]);
    if (i < 9) await query('insert into member_roles(member_id,role_slug) values ($1,$2)', [uid(i + 1), cases[i][0]]);
  }
  const beforeSecurity = await securitySnapshot();
  const before = await exercise();
  await migration('20260928230000_canonical_effective_role_core.sql');
  await migration('20260928235000_domain_helpers_use_effective_roles.sql');
  assert.deepEqual(await securitySnapshot(), beforeSecurity, 'identity, ownership, security settings and ACLs preserved');
  for (const row of beforeSecurity) {
    assert.equal(row.prosecdef, true);
    assert.equal(row.provolatile, 's');
    assert.deepEqual(row.proconfig, ['search_path=public']);
    assert.equal(row.authenticated_execute, true);
    assert.equal(row.anon_execute, false);
  }
  assert.deepEqual(await exercise(), before, 'real helper and consumer behavior unchanged');
  console.log('PASS: five-helper equivalence matrix, security/ACL preservation, Photos RPC and Photos/Games RLS.');
} finally {
  await db.close();
}
