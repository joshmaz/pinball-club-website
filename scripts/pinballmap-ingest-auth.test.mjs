import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash, timingSafeEqual } from 'node:crypto';

// Match the existing Edge harnesses: transpile locally, then inject runtime imports.
const authSource = await readFile(new URL('../supabase/functions/pinballmap-ingest/auth.ts', import.meta.url), 'utf8');
const authCode = ts.transpileModule(authSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { authorizeIngest, GAMES_INGEST_ROLES, ingestMethodResponse, SCHEDULER_HEADER } = new Function(
  'createHash', 'timingSafeEqual',
  authCode + '\nreturn { authorizeIngest, GAMES_INGEST_ROLES, ingestMethodResponse, SCHEDULER_HEADER };',
)(createHash, timingSafeEqual);

// Fixed test fixture, not a deployment credential.
const secret = 'test-only-scheduler-credential';
const request = (headers = {}, method = 'POST') => new Request('https://example.test/ingest', {
  method, headers,
  ...(method === 'POST' ? { body: JSON.stringify({ manual_actor_user_id: 'forged-actor' }) } : {}),
});

async function authorize(headers, options = {}) {
  const calls = [];
  const result = await authorizeIngest(request(headers), {
    schedulerSecret: options.secret === undefined ? secret : options.secret,
    getUser: async token => {
      calls.push(['user', token]);
      if (options.authError) throw new Error('private upstream details');
      return token === 'valid-user-jwt' ? 'verified-user' : null;
    },
    hasGamesAccess: async id => {
      calls.push(['roles', id]);
      if (options.roleError) throw new Error('private database details');
      return (options.roles || []).some(role => GAMES_INGEST_ROLES.includes(role));
    },
  });
  return { result, calls };
}

test('scheduler header contract and exact Games role set', () => {
  assert.equal(SCHEDULER_HEADER, 'x-pinballmap-scheduler-secret');
  assert.deepEqual(GAMES_INGEST_ROLES, ['games_editor', 'games_admin', 'club_admin']);
});

test('missing, malformed, public-key and matching-header credentials cannot bypass authentication', async () => {
  for (const headers of [
    {}, { apikey: 'public-anon-key' }, { Authorization: 'Bearer ' },
    { Authorization: 'Basic valid-user-jwt' }, { Authorization: 'Bearer invalid-token' },
    { Authorization: 'Bearer expired-user-jwt' },
    ...['public-anon-key', 'sb_publishable_public', 'arbitrary'].map(value => ({ Authorization: `Bearer ${value}`, apikey: value })),
  ]) {
    const { result } = await authorize(headers);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
});

test('each inherited Games role authorizes the verified actor; unrelated or absent roles do not', async () => {
  for (const role of GAMES_INGEST_ROLES) {
    const { result, calls } = await authorize({ Authorization: 'Bearer valid-user-jwt', apikey: 'valid-user-jwt' }, { roles: [role], secret: '' });
    assert.deepEqual(result, { ok: true, manualActorUserId: 'verified-user' });
    assert.deepEqual(calls, [['user', 'valid-user-jwt'], ['roles', 'verified-user']]);
  }
  for (const roles of [[], ['events_admin'], ['membership_admin'], ['photos_editor'], ['website_volunteer']]) {
    assert.equal((await authorize({ Authorization: 'Bearer valid-user-jwt' }, { roles })).result.status, 403);
  }
});

test('scheduler mode wins and never consults user authentication, even with a user bearer', async () => {
  for (const bearer of [undefined, 'Bearer valid-user-jwt', 'Bearer invalid-token']) {
    const headers = { [SCHEDULER_HEADER]: secret, ...(bearer ? { Authorization: bearer } : {}) };
    assert.deepEqual(await authorize(headers), { result: { ok: true, manualActorUserId: null }, calls: [] });
  }
  for (const supplied of ['', 'wrong', 'public-anon-key', 'sb_publishable_public']) {
    const { result, calls } = await authorize({ [SCHEDULER_HEADER]: supplied, Authorization: 'Bearer valid-user-jwt' }, { roles: ['club_admin'] });
    assert.equal(result.status, 401);
    assert.deepEqual(calls, []);
  }
  for (const configured of ['', '   ']) {
    const { result, calls } = await authorize({ [SCHEDULER_HEADER]: secret, Authorization: 'Bearer valid-user-jwt' }, { secret: configured, roles: ['club_admin'] });
    assert.equal(result.status, 503);
    assert.deepEqual(calls, []);
  }
  assert.equal((await authorizeIngest(request({ [SCHEDULER_HEADER]: secret }), {
    schedulerSecret: undefined,
    getUser: async () => { throw new Error('must not call'); },
    hasGamesAccess: async () => { throw new Error('must not call'); },
  })).status, 503);
});

test('authentication and role lookup errors fail closed without leaking details', async () => {
  for (const options of [{ authError: true }, { roleError: true }]) {
    const { result } = await authorize({ Authorization: 'Bearer valid-user-jwt' }, options);
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.error, /private/);
  }
});

// Execute the real entrypoint with local dependencies: no network or Deno server.
async function handlerFixture({ roles = [], schedulerSecret = secret, roleError = false } = {}) {
  let handler;
  const effects = [];
  const source = await readFile(new URL('../supabase/functions/pinballmap-ingest/index.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const db = {
    auth: { getUser: async token => ({ data: { user: token === 'valid-user-jwt' ? { id: 'verified-user' } : null }, error: null }) },
    from: table => {
      if (table !== 'members') effects.push(['read', table]);
      const query = {
        select: () => query, eq: () => query,
        in: (_column, allowed) => { assert.deepEqual(Array.from(allowed), GAMES_INGEST_ROLES); return query; },
        limit: async () => ({ data: roles.some(role => GAMES_INGEST_ROLES.includes(role)) ? [{}] : [], error: roleError ? {} : null }),
        then: resolve => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
    rpc: async (name, args) => { effects.push(['rpc', name, args]); return { data: { ok: true }, error: null }; },
  };
  const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', PINBALLMAP_API_TOKEN: 'test-provider-key', PINBALLMAP_INGEST_SCHEDULER_SECRET: schedulerSecret };
  vm.runInNewContext(code, {
    Deno: { serve: callback => { handler = callback; }, env: { get: name => env[name] } },
    Response, URL, authorizeIngest, GAMES_INGEST_ROLES, ingestMethodResponse,
    createClient: () => db,
    fetch: async () => { effects.push(['fetch']); return { ok: true, json: async () => ({ user_submissions: [], machines: [] }) }; },
    buildPinballRpcPayload: () => ({ location_id: 8908, updates: [], creates: [] }),
    buildPinballConditionPayload: () => ({ rows: [] }),
    importOpdbImages: async () => { effects.push(['opdb']); },
  });
  return { handler, effects };
}

test('real handler rejects unauthorized requests before all ingestion side effects', async () => {
  for (const [headers, options, status] of [
    [{}, {}, 401],
    [{ Authorization: 'Bearer public-anon-key', apikey: 'public-anon-key' }, {}, 401],
    [{ Authorization: 'Bearer valid-user-jwt' }, {}, 403],
    [{ Authorization: 'Bearer valid-user-jwt' }, { roleError: true }, 503],
    [{ [SCHEDULER_HEADER]: 'wrong', Authorization: 'Bearer valid-user-jwt' }, { roles: ['club_admin'] }, 401],
    [{ [SCHEDULER_HEADER]: secret }, { schedulerSecret: '' }, 503],
  ]) {
    const { handler, effects } = await handlerFixture(options);
    assert.equal((await handler(request(headers))).status, status);
    assert.deepEqual(effects, []);
  }
});

test('real handler preserves verified manual versus System attribution and ignores forged body actor', async () => {
  for (const scheduled of [false, true]) {
    const { handler, effects } = await handlerFixture({ roles: ['games_admin'] });
    const response = await handler(request(scheduled ? { [SCHEDULER_HEADER]: secret } : { Authorization: 'Bearer valid-user-jwt' }));
    assert.equal(response.status, 200);
    const payload = effects.find(effect => effect[0] === 'rpc')[2].p_payload;
    assert.equal(payload.manual_actor_user_id, scheduled ? undefined : 'verified-user');
    assert.equal(Object.hasOwn(payload, 'manual_actor_user_id'), !scheduled);
  }
});

test('real handler preflight and unsupported methods have no ingestion effects', async () => {
  for (const method of ['OPTIONS', 'GET', 'PUT', 'DELETE', 'HEAD']) {
    const { handler, effects } = await handlerFixture();
    const response = await handler(request({}, method));
    assert.equal(response.status, method === 'OPTIONS' ? 200 : 405);
    assert.deepEqual(effects, []);
    if (method === 'OPTIONS') assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  }
});
