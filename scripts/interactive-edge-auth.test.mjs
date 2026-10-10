import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { createHash, timingSafeEqual } from 'node:crypto';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, '')
  .replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const auth = new Function('createHash', 'timingSafeEqual',
  transpile(await read('supabase/functions/pinballmap-ingest/auth.ts')) + '\nreturn {authorizeIngest,ingestMethodResponse};')
  (createHash, timingSafeEqual);
const names = ['opdb-image-sync', 'matchplay-event-review', 'pinballmap-ingest'];
const sources = Object.fromEntries(await Promise.all(names.map(async name =>
  [name, transpile(await read(`supabase/functions/${name}/index.ts`))])));
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const secret = 'test-scheduler-only';
const marker = 'SENSITIVE_SLICE_4B_MARKER';
const diagnostic = `Unexpected auth failure: https://user:${marker}@private.invalid/token`;

function fixture(name, db, options = {}) {
  let handler;
  const calls = [], clients = [];
  const helper = name === 'matchplay-event-review' ? 'snh_member_has_events_access' : 'snh_member_has_games_access';
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key', PINBALLMAP_INGEST_SCHEDULER_SECRET: secret,
    PINBALLMAP_API_TOKEN: 'map-token', MATCHPLAY_API_TOKEN: 'match-token', ...options.env };
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers);
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('Authorization'), 'Bearer caller-jwt');
      assert.equal(headers.get('apikey'), 'public-key');
      return options.invalidJwt ? Response.json({ message: 'Invalid JWT' }, { status: 401 }) : Response.json({ id: uid(101) });
    }
    if (url.pathname === '/rest/v1/rpc/' + helper) {
      assert.equal(headers.get('Authorization'), 'Bearer caller-jwt');
      assert.equal(headers.get('apikey'), 'public-key');
      assert.deepEqual(JSON.parse(init.body || '{}'), {});
      if (options.rpcError) return Response.json({ message: diagnostic }, { status: 500 });
      if (options.transportThrows) throw new Error(diagnostic);
      if ('rpcValue' in options) return Response.json(options.rpcValue);
      await db.exec(`set role authenticated; set request.jwt.claim.sub='${uid(101)}'`);
      try {
        return Response.json((await db.query(`select public.${helper}() allowed`)).rows[0].allowed);
      } finally { await db.exec('reset role'); }
    }
    // Every other fetch is protected work, and requires prior authorization.
    if (url.hostname === 'pinballmap.com') return Response.json({ user_submissions: [], machines: [] });
    assert.equal(headers.get('Authorization'), 'Bearer service-key');
    if (url.pathname === '/rest/v1/games') return Response.json(name === 'opdb-image-sync' ? { id: uid(20), opdb_id: 'G-test' } : []);
    if (url.pathname === '/rest/v1/game_location_stints') return Response.json([]);
    if (url.pathname === '/rest/v1/rpc/snh_pinballmap_begin') return Response.json(uid(500));
    if (url.pathname === '/rest/v1/rpc/snh_pinballmap_finish') return Response.json(null);
    if (url.pathname === '/rest/v1/rpc/snh_pinballmap_upsert_from_activity') return Response.json({ ok: true });
    throw new Error(`Unexpected protected request: ${url}`);
  };
  new Function('Deno', 'createClient', 'fetch', 'importOpdbImages', 'createMatchplayCache',
    'rankEventCandidates', 'tournamentIdFromInput', 'authorizeIngest', 'ingestMethodResponse',
    'buildPinballRpcPayload', 'buildPinballConditionPayload', sources[name])(
    { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    (url, key, opts) => {
      clients.push(key);
      const client = createClient(url, key, { ...opts, global: { ...opts?.global, fetch: fakeFetch } });
      if (key === 'public-key' && options.authThrows) client.auth.getUser = async () => { throw new Error(diagnostic); };
      if (key === 'public-key' && options.rpcThrows) client.rpc = async () => { throw new Error(diagnostic); };
      return client;
    }, fakeFetch,
    async (_client, ids) => { calls.push({ path: 'opdb-import', ids }); return { requested: 1, imported: 1 }; },
    () => {
      calls.push({ path: 'matchplay-cache' });
      return async path => { calls.push({ path: 'matchplay-provider', requested: path });
        return { payload: { data: [{ tournamentId: 42, name: 'Test tournament', status: 'completed' }], links: {} }, cache: null }; };
    }, () => [], () => '42', auth.authorizeIngest, auth.ingestMethodResponse,
    () => ({ location_id: 8908, updates: [], creates: [] }), () => ({ rows: [] }),
  );
  return { calls, clients, request: (headers = { Authorization: 'Bearer caller-jwt' }, method = 'POST', body) => handler(new Request('https://edge.test', {
    method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? (name === 'matchplay-event-review'
      ? { mode: 'discover', scope: 'owner', value: '7' } : { gameId: uid(20), manual_actor_user_id: 'forged' })) } : {}),
  })) };
}
function noProtectedWork(f) {
  assert.ok(f.clients.every(key => key === 'public-key'));
  assert.ok(f.calls.every(c => c.path === '/auth/v1/user' || /^\/rest\/v1\/rpc\/snh_member_has_/.test(c.path)));
}

test('interactive Edge authorization delegates to real canonical SQL', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table members(id uuid primary key,user_id uuid);
      create table member_roles(member_id uuid,role_slug text);
      insert into members values('${uid(1)}','${uid(101)}');`);
    for (const file of ['20260928230000_canonical_effective_role_core.sql', '20260928235000_domain_helpers_use_effective_roles.sql']) {
      await db.exec(await read('supabase/migrations/' + file));
    }
    // Load the actual Events helpers; this fixture does not need Events policies/digest tables.
    const events = await read('supabase/migrations/20260928235500_events_use_effective_roles.sql');
    await db.exec(events.slice(0, events.indexOf('-- ALTER preserves')));
    for (const name of names) {
      const eventsDomain = name === 'matchplay-event-review';
      const matrix = eventsDomain
        ? [['events_editor', true], ['events_admin', true], ['club_admin', true], ['games_admin', false], ['photos_admin', false], ['membership_admin', false], [null, false]]
        : [['games_editor', true], ['games_admin', true], ['club_admin', true], ['events_admin', false], ['photos_admin', false], ['membership_admin', false], [null, false]];
      for (const [role, allowed] of matrix) await t.test(`${name}: ${role || 'no role'}`, async () => {
        await db.exec('delete from member_roles');
        if (role) await db.query('insert into member_roles values ($1,$2)', [uid(1), role]);
        const f = fixture(name, db);
        const response = await f.request();
        assert.equal(response.status, allowed ? 200 : 403);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        if (!allowed) { noProtectedWork(f); return; }
        const body = await response.json();
        assert.deepEqual(f.calls.slice(0, 2).map(c => c.path), ['/auth/v1/user', '/rest/v1/rpc/' +
          (eventsDomain ? 'snh_member_has_events_access' : 'snh_member_has_games_access')]);
        assert.deepEqual(f.clients, ['public-key', 'service-key']);
        if (name === 'opdb-image-sync') {
          assert.deepEqual(body, { ok: true, requested: 1, imported: 1 });
          assert.deepEqual(f.calls.find(c => c.path === 'opdb-import').ids, ['G-test']);
        } else if (eventsDomain) {
          assert.equal(body.tournaments[0].id, '42');
          assert.equal(body.tournaments[0].title, 'Test tournament');
          assert.equal(f.calls.find(c => c.path === 'matchplay-provider').requested, 'tournaments?owner=7&page=1');
        } else {
          assert.equal(body.ok, true);
          const payload = JSON.parse(f.calls.find(c => c.path.endsWith('snh_pinballmap_upsert_from_activity')).init.body).p_payload;
          assert.equal(payload.manual_actor_user_id, uid(101));
        }
      });
      for (const options of [{ rpcValue: false }, { rpcValue: null }, { rpcValue: 'true' }, { rpcValue: 1 },
        { rpcValue: [] }, { rpcValue: {} }, { rpcError: true }, { transportThrows: true }, { rpcThrows: true }, { authThrows: true }]) {
        await t.test(`${name}: fail closed ${JSON.stringify(options)}`, async () => {
          const f = fixture(name, db, options), response = await f.request();
          const expected = options.authThrows || options.rpcThrows ? (name === 'pinballmap-ingest' ? 503 : 500)
            : options.rpcError || options.transportThrows ? (name === 'pinballmap-ingest' ? 503 : eventsDomain ? 500 : 403) : 403;
          assert.equal(response.status, expected);
          const text = await response.text();
          assert.ok(!text.includes(marker));
          assert.ok(!text.includes(diagnostic));
          noProtectedWork(f);
        });
      }
      await t.test(`${name}: authentication and methods`, async () => {
        const missing = fixture(name, db);
        assert.equal((await missing.request({})).status, 401);
        assert.deepEqual(missing.clients, []);
        const invalid = fixture(name, db, { invalidJwt: true });
        assert.equal((await invalid.request()).status, 401);
        assert.deepEqual(invalid.calls.map(c => c.path), ['/auth/v1/user']);
        noProtectedWork(invalid);
        for (const method of ['GET', 'OPTIONS']) {
          const f = fixture(name, db), response = await f.request({}, method);
          assert.equal(response.status, method === 'OPTIONS' ? 200 : 405);
          assert.deepEqual(f.clients, []);
          assert.deepEqual(f.calls, []);
        }
      });
      if (name !== 'pinballmap-ingest') await t.test(`${name}: authorized request validation`, async () => {
        await db.exec('delete from member_roles');
        await db.query('insert into member_roles values ($1,$2)', [uid(1), 'club_admin']);
        const f = fixture(name, db);
        const response = await f.request(undefined, 'POST', name === 'opdb-image-sync' ? {} : { mode: 'discover', scope: 'owner', value: 'invalid' });
        assert.equal(response.status, 400);
        assert.ok(!f.calls.some(c => c.path === 'opdb-import' || c.path === 'matchplay-provider' || c.path === '/rest/v1/games'));
      });
    }
    await t.test('scheduler is independent of member auth, SQL availability and anon configuration', async () => {
      await db.exec('delete from member_roles');
      for (const bearer of [undefined, 'Bearer caller-jwt', 'Bearer invalid']) {
        const f = fixture('pinballmap-ingest', db, { rpcThrows: true, authThrows: true, env: { SUPABASE_ANON_KEY: '' } });
        const response = await f.request({ 'x-pinballmap-scheduler-secret': secret, ...(bearer ? { Authorization: bearer } : {}) });
        assert.equal(response.status, 200);
        assert.deepEqual(f.clients, ['service-key']);
        assert.ok(!f.calls.some(c => c.path.includes('snh_member_has_') || c.path === '/auth/v1/user'));
        const payload = JSON.parse(f.calls.find(c => c.path.endsWith('snh_pinballmap_upsert_from_activity')).init.body).p_payload;
        assert.equal(Object.hasOwn(payload, 'manual_actor_user_id'), false); // existing SQL records System/null
      }
    });
    await t.test('invalid/empty scheduler header never falls back to valid authorized user', async () => {
      await db.query('insert into member_roles values ($1,$2)', [uid(1), 'club_admin']);
      for (const supplied of ['', 'wrong']) {
        const f = fixture('pinballmap-ingest', db);
        assert.equal((await f.request({ 'x-pinballmap-scheduler-secret': supplied, Authorization: 'Bearer caller-jwt' })).status, 401);
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.clients, []);
      }
    });
  } finally { await db.close(); }
});
