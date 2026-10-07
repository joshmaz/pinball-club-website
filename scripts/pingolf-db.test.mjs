import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const readMigration = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const migration = await readMigration('20260928180000_pingolf_game_targets.sql');
const old = await readMigration('20260507143000_extended_game_data.sql');
const catalog = await readMigration('20260501103000_games_catalog.sql');
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const legacyGame = '4994ffc3-30ec-4d9b-9f5c-8ff3909ca7c6';
const legacyTarget = 'cb70ea63-d776-4785-81a0-a6e2eb51719e';

async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema private;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    create table members(id uuid primary key, user_id uuid);
    create table member_roles(member_id uuid, role_slug text);
    create table auth.users(id uuid primary key);
    create table events(id uuid primary key);
    create table games(id uuid primary key, slug text, title text, deleted_at timestamptz,
      hide_owner_public boolean default false, party_id uuid, party_relationship_public text);
    create table owner_parties(id uuid primary key, display_name text, visibility_public boolean);
    create table game_high_scores(id uuid, game_id uuid, score bigint, player_label text, achieved_on date, notes text, sort_order int);
    create table game_custom_mods(id uuid, game_id uuid, title text, description text, reference_url text, sort_order int);
    create table game_sale_listings(game_id uuid, status text, asking_price_cents int, notes text, updated_at timestamptz);
    create table audit_log(action text, entity_type text, entity_id text, old_data jsonb, new_data jsonb, metadata jsonb);
    create function private.snh_audit_game(text,text,text,jsonb,jsonb,jsonb) returns void language sql as
      $$insert into audit_log values($1,$2,$3,$4,$5,$6)$$;
    create function public.set_games_catalog_updated_at() returns trigger language plpgsql as
      $$begin new.updated_at = now(); return new; end;$$;
    insert into games(id,slug,title) values ('${legacyGame}','road-kings','Road Kings'),('${uid(10)}','test','Test');
    insert into members values ('${uid(1)}','${uid(1)}'),('${uid(2)}','${uid(2)}'),('${uid(3)}','${uid(3)}');
    insert into member_roles values ('${uid(1)}','games_editor'),('${uid(2)}','games_admin'),('${uid(3)}','club_admin');
  `);
  await db.exec(catalog.slice(catalog.indexOf('create or replace function public.snh_member_has_games_access()'), catalog.indexOf('create schema if not exists private;')));
  await db.exec(await readMigration('20260928230000_canonical_effective_role_core.sql'));
  await db.exec(await readMigration('20260928235000_domain_helpers_use_effective_roles.sql'));
  await db.exec(old.slice(old.indexOf('create table if not exists public.pingolf_sessions'), old.indexOf('create table if not exists public.game_custom_mods')));
  await db.exec(old.slice(old.indexOf('create or replace function private.snh_require_game_editable'), old.indexOf('--', old.indexOf('revoke all on function private.snh_require_game_editable'))));
  await db.exec(old.slice(old.indexOf('create or replace function public.snh_pingolf_sessions_list_editor'), old.indexOf('-- game_custom_mods RPCs')));
  await db.exec(`alter table pingolf_targets enable row level security;
    grant select,insert,update,delete on pingolf_targets to authenticated,anon;
    create trigger trg_pingolf_targets_set_updated_at before update on pingolf_targets
      for each row execute function set_games_catalog_updated_at();
    insert into events values ('${uid(30)}');
    insert into pingolf_sessions(id,title,event_id,is_featured) values ('${uid(20)}','Legacy','${uid(30)}',true);
    insert into pingolf_targets(id,session_id,game_id,description,target_value)
      values('${legacyTarget}','${uid(20)}','${legacyGame}','Start a Road Kings Multiball',1);`);
  return db;
}

test('migration refuses unreviewed legacy targets and rolls back safely', async () => {
  const db = await fixture();
  try {
    await db.exec(`insert into pingolf_targets(session_id,game_id,description) values('${uid(20)}','${legacyGame}','New target')`);
    await assert.rejects(db.exec(migration), /Unreviewed legacy/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from pingolf_targets')).rows[0].n, 2);
  } finally { await db.close(); }
});

test('game targets: migration, limits, preferences, validation, audit, authorization and public data', async () => {
  const db = await fixture();
  const value = async (sql, params) => (await db.query(sql, params)).rows[0]?.value;
  const upsert = (id, fields, game = legacyGame) => value('select snh_pingolf_target_upsert($1,$2,$3) value', [id, game, JSON.stringify(fields)]);
  const list = () => value('select snh_pingolf_targets_list_editor($1) value', [legacyGame]);
  const asUser = async (n, role = 'authenticated') => db.exec(`reset role; set role ${role}; set request.jwt.claim.sub='${uid(n)}'`);
  try {
    await db.exec(migration);
    assert.equal(await value("select to_regclass('public.pingolf_sessions') value"), null);
    assert.equal(await value('select count(*)::int value from pingolf_targets'), 0);
    assert.equal(await value('select count(*)::int value from events'), 1, 'session removal preserves event');
    await db.exec(`delete from events where id='${uid(30)}'`);
    for (const n of [1, 2, 3]) {
      await asUser(n);
      assert.deepEqual(await list(), []);
    }
    await asUser(1);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await upsert(null, {targetType: 'feature', description: `Target ${i}`, isPreferred: i === 0}));
    assert.equal((await list()).length, 10);
    await assert.rejects(upsert(null, {targetType:'score',description:'Eleventh'}), /at most 10/);
    await upsert(ids[1], {description:'Big score',targetType:'hybrid',scoreThreshold:'9223372036854775807',notes:'Internal only',isPreferred:true});
    let targets = await list();
    assert.equal(targets[0].id, ids[1]);
    assert.equal(targets[0].scoreThreshold, '9223372036854775807');
    assert.equal(targets.filter(t => t.isPreferred).length, 1);
    await db.exec('reset role');
    const audits = (await db.query('select * from audit_log')).rows;
    assert.equal(audits[0].entity_id, ids[0]);
    const cleared = audits.find(a => a.entity_id === ids[0] && a.action === 'update');
    assert.equal(cleared.old_data.is_preferred, true);
    assert.equal(cleared.new_data.is_preferred, false);
    await assert.rejects(db.exec(`update pingolf_targets set is_preferred=true where id='${ids[0]}'`), /unique/);
    await asUser(1);
    for (const fields of [{targetType:'invalid'}, {targetType:null}, {description:'   '}, {scoreThreshold:'-1'}, {scoreThreshold:'1.5'}, {scoreThreshold:'0'}, {scoreThreshold:'9223372036854775808'}, {isPreferred:null}]) {
      await assert.rejects(upsert(ids[0], fields));
    }
    await assert.rejects(upsert(ids[0], {description:'wrong game'}, uid(10)), /target not found/);
    await assert.rejects(upsert(null, {targetType:'score',description:'missing game'}, uid(99)), /game not found/);
    await upsert(ids[1], {isPreferred:false});
    assert.equal((await list()).filter(t => t.isPreferred).length, 0);
    await upsert(ids[2], {isPreferred:true});
    await assert.rejects(value('select snh_pingolf_target_delete($1) value', [ids[2]]), /not authorized/);
    await asUser(2);
    await value('select snh_pingolf_target_delete($1) value', [ids[2]]);
    assert.equal((await list()).filter(t => t.isPreferred).length, 0);
    await asUser(0, 'anon');
    const info = await value('select snh_public_game_more_info($1) value', [legacyGame]);
    assert.equal(info.pingolfTargets.length, 9);
    assert.ok(!JSON.stringify(info).includes('Internal only'));
    assert.deepEqual(info.customMods, []);
    assert.deepEqual(info.highScores, []);
    for (const role of ['anon', 'authenticated']) {
      await asUser(0, role);
      await assert.rejects(upsert(ids[0], {description:'Unauthorized'}), /permission denied|not authorized/);
      await assert.rejects(list(), /permission denied|not authorized/);
      await assert.rejects(value('select snh_pingolf_target_delete($1) value', [ids[0]]), /permission denied|not authorized/);
      assert.equal(await value('select count(*)::int value from pingolf_targets'), 0, 'RLS hides direct reads');
      await assert.rejects(db.exec(`insert into pingolf_targets(game_id,target_type,description) values('${legacyGame}','feature','Bypass')`), /row-level security/);
    }
    await db.exec(`reset role; update games set deleted_at=now() where id='${legacyGame}'`);
    await asUser(1);
    await assert.rejects(upsert(ids[0], {description:'Deleted game'}), /game not found or deleted/);
    await asUser(2);
    await assert.rejects(value('select snh_pingolf_target_delete($1) value', [ids[0]]), /game not found or deleted/);
    await asUser(0, 'anon');
    assert.equal(await value('select snh_public_game_more_info($1) value', [legacyGame]), null);
    await db.exec(`reset role; update games set deleted_at=null where id='${legacyGame}'`);
    await asUser(1);
    assert.equal((await list()).length, 9, 'restoration retains targets');
    await db.exec(`reset role; delete from games where id='${legacyGame}'`);
    assert.equal(await value('select count(*)::int value from pingolf_targets'), 0, 'physical deletion cascades');
  } finally { await db.close(); }
});
