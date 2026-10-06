import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { validateAiProposalResponse } from './ai-enrichment-contract.mjs';

const source = ts.transpileModule(
  (await readFile(new URL('../supabase/functions/ai-game-enrich-propose/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText;
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const game = { id: uid(20), slug: 'test-game', title: 'Test Game', details: null,
  release_date: '1995-01-01', manufacturer: 'Example', machine_type: 'ss', player_count: 4,
  pinside_url: null, ipdb_url: null, kineticist_url: null, updated_at: '2026-01-01T00:00:00Z' };
const description = 'Example released Test Game in 1995. Shoot the ramps and collect the lit targets to start multiball.';

function fixture(db, options = {}) {
  const calls = [];
  const clients = [];
  let handler;
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key', OPENAI_PLATFORM_KEY: 'provider-key' };
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('Authorization'), 'Bearer caller-jwt');
      assert.equal(headers.get('apikey'), 'public-key');
      if (options.invalidJwt) return Response.json({ message: 'Invalid JWT' }, { status: 401 });
      return Response.json({ id: uid(101) });
    }
    if (url.pathname === '/rest/v1/rpc/snh_member_has_games_access') {
      assert.equal(headers.get('Authorization'), 'Bearer caller-jwt');
      assert.equal(headers.get('apikey'), 'public-key');
      assert.deepEqual(JSON.parse(init.body || '{}'), {}); // no caller-supplied member identity
      if (options.rpcError) return Response.json({ message: 'Database unavailable' }, { status: 500 });
      if (options.rpcThrows) throw new Error('Transport unavailable');
      if ('rpcValue' in options) return Response.json(options.rpcValue);
      // Resolve access through real SQL, not a JavaScript role hierarchy.
      await db.exec("set role authenticated; set request.jwt.claim.sub='" + uid(101) + "'");
      try {
        return Response.json((await db.query('select snh_member_has_games_access() allowed')).rows[0].allowed);
      } finally { await db.exec('reset role'); }
    }
    if (url.pathname === '/rest/v1/games') {
      assert.equal(headers.get('Authorization'), 'Bearer service-key');
      assert.equal(headers.get('apikey'), 'service-key');
      assert.equal(url.searchParams.get('id'), `eq.${game.id}`);
      return Response.json(game);
    }
    if (url.href === 'https://api.openai.com/v1/chat/completions') {
      assert.equal(headers.get('Authorization'), 'Bearer provider-key');
      assert.equal(JSON.parse(init.body).model, 'gpt-4o-mini');
      return Response.json({ choices: [{ message: { content: description } }] });
    }
    if (url.pathname === '/rest/v1/audit_log') {
      assert.equal(headers.get('Authorization'), 'Bearer service-key');
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${url}`); // catches obsolete member/role queries
  };
  new Function('Deno', 'createClient', 'fetch', 'crypto', source)(
    { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    (url, key, opts) => {
      clients.push({ key, opts });
      const client = createClient(url, key, { ...opts, global: { ...opts?.global, fetch: fakeFetch } });
      if (key === 'public-key' && options.authorizationRejects) {
        client.rpc = async () => { throw new Error(options.authorizationRejects); };
      }
      if (key === 'public-key' && options.authenticationRejects) {
        client.auth.getUser = async () => { throw new Error(options.authenticationRejects); };
      }
      return client;
    }, fakeFetch, { randomUUID: () => uid(30) },
  );
  return { calls, clients, request: (body = { gameId: game.id }, headers = { Authorization: 'Bearer caller-jwt' }, method = 'POST') =>
    handler(new Request('https://edge.test', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })) };
}
function assertNoProtectedWork(f) {
  assert.ok(f.calls.every(c => ['/auth/v1/user', '/rest/v1/rpc/snh_member_has_games_access'].includes(c.path)));
  assert.ok(f.clients.every(c => c.key === 'public-key'), 'no privileged client before authorization');
}

test('AI proposal authorization uses caller JWT and canonical SQL before protected work', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      create table members(id uuid primary key,user_id uuid);
      create table member_roles(member_id uuid,role_slug text);
      insert into members values('${uid(1)}','${uid(101)}');`);
    for (const name of ['20260928230000_canonical_effective_role_core.sql', '20260928235000_domain_helpers_use_effective_roles.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    }
    let successfulResponse;
    for (const [role, allowed] of [['games_editor', true], ['games_admin', true], ['club_admin', true],
      ['events_admin', false], ['photos_admin', false], ['membership_admin', false], [null, false]]) {
      await t.test(role || 'no role', async () => {
        await db.exec('delete from member_roles');
        if (role) await db.query('insert into member_roles values ($1,$2)', [uid(1), role]);
        const f = fixture(db);
        const response = await f.request();
        assert.equal(response.status, allowed ? 200 : 403);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        const body = await response.json();
        if (!allowed) {
          assert.deepEqual(body, { ok: false, error: 'Not authorized for game enrichment' });
          assertNoProtectedWork(f);
          return;
        }
        assert.deepEqual(validateAiProposalResponse(body), []);
        assert.equal(body.proposalVersion, '1.1');
        assert.equal(body.status, 'ok');
        assert.equal(body.fields[0].suggestedValue, description);
        assert.deepEqual(body.fields.map(field => field.field), ['details', 'ipdbUrl', 'pinsideUrl', 'kineticistUrl']);
        assert.equal(body.recordVersion, game.updated_at);
        assert.deepEqual(body.model, { provider: 'openai', model: 'openai:gpt-4o-mini', fallbackUsed: false });
        assert.deepEqual(body.regenerationLimits, { descriptionRemaining: 2 });
        assert.deepEqual(f.calls.map(c => c.path), ['/auth/v1/user', '/rest/v1/rpc/snh_member_has_games_access',
          '/rest/v1/games', '/v1/chat/completions', '/rest/v1/audit_log']);
        const audit = JSON.parse(f.calls.at(-1).init.body);
        assert.equal(audit.actor_user_id, uid(101));
        assert.equal(audit.action, 'ai_proposal');
        assert.deepEqual(audit.new_data.fields, body.fields);
        if (successfulResponse) assert.deepEqual(body, successfulResponse);
        successfulResponse = body;
      });
    }
    for (const options of [{ rpcValue: false }, { rpcValue: null }, { rpcValue: 'true' },
      { rpcError: true }, { rpcThrows: true }]) {
      await t.test(`authorization fails closed: ${JSON.stringify(options)}`, async () => {
        const f = fixture(db, options);
        assert.equal((await f.request()).status, 403);
        assertNoProtectedWork(f);
      });
    }
    for (const operation of ['authorization', 'authentication']) {
      await t.test(`${operation} operation rejection hides diagnostics and stops protected work`, async () => {
        const marker = 'SENSITIVE_AUTH_BOUNDARY_MARKER_4A';
        const diagnostic = `Unexpected ${operation} failure at https://user:${marker}@private.invalid/request`;
        const f = fixture(db, { [`${operation}Rejects`]: diagnostic });
        const response = await f.request();
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.ok(!body.includes(marker));
        assert.ok(!body.includes(diagnostic));
        assert.deepEqual(JSON.parse(body), { ok: false,
          error: operation === 'authorization' ? 'Authorization check failed' : 'Authentication check failed' });
        assert.deepEqual(f.calls.map(c => c.path), operation === 'authorization' ? ['/auth/v1/user'] : []);
        assertNoProtectedWork(f);
      });
    }
    await t.test('missing and invalid JWT denied before authorization', async () => {
      const missing = fixture(db);
      assert.equal((await missing.request(undefined, {})).status, 401);
      assert.equal(missing.calls.length, 0);
      const invalid = fixture(db, { invalidJwt: true });
      assert.equal((await invalid.request()).status, 401);
      assert.deepEqual(invalid.calls.map(c => c.path), ['/auth/v1/user']);
      assertNoProtectedWork(invalid);
    });
    await t.test('request validation and method/CORS behavior remain intact', async () => {
      const f = fixture(db);
      assert.equal((await f.request({})).status, 400);
      assertNoProtectedWork(f);
      assert.equal((await f.request(undefined, {}, 'GET')).status, 405);
      const preflight = await f.request(undefined, {}, 'OPTIONS');
      assert.equal(preflight.status, 200);
      assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    });
  } finally { await db.close(); }
});
