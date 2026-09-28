import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { createMatchplayCache } from '../supabase/functions/matchplay-event-review/cache.mjs';
import { getMatchplay } from '../supabase/functions/matchplay-event-review/provider.mjs';
import { rankEventCandidates, tournamentIdFromInput } from '../supabase/functions/matchplay-event-review/match.mjs';

const source = await readFile(new URL('../supabase/functions/matchplay-event-review/index.ts', import.meta.url), 'utf8');
const handlerSource = ts.transpileModule(source.replace(/^import .*;\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const token = 'fake-provider-token|private';
const tournament = {
  tournamentId: 228825, name: '2026 Yankee Swap SNHPC Real', status: 'completed',
  startUtc: '2026-01-03T00:27:00.000000Z', seriesId: null,
  description: 'Tournament description', location: { name: 'Southern New Hampshire Pinball Club' },
};
const linked = { id: 'linked', title: 'Saved event', starts_at: null,
  external_links: [{ url: 'https://app.matchplay.events/tournaments/228825', label: 'Results' }] };

function setup(t, payload = { data: tournament }, providerStatus = 200) {
  const calls = [];
  const fakeFetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push(url);
    if (url.hostname === 'app.matchplay.events') {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.headers.Accept, 'application/json');
      return new Response(JSON.stringify(payload), { status: providerStatus });
    }
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'editor' });
    if (url.pathname === '/rest/v1/members') return Response.json([{ id: 'member' }]);
    if (url.pathname === '/rest/v1/external_api_cache' || url.pathname === '/rest/v1/integration_status') {
      return options.method === 'POST' ? new Response(null, { status: 201 }) : Response.json(null);
    }
    if (url.pathname === '/rest/v1/external_api_cache_policies') return Response.json(null);
    assert.equal(url.pathname, '/rest/v1/events');
    const contains = url.searchParams.get('external_links');
    if (contains) {
      // Exercise the real SDK serialization, and reject the old cs.{[object Object]}.
      assert.equal(contains, 'cs.[{"url":"https://app.matchplay.events/tournaments/228825"}]');
      return Response.json([linked]);
    }
    return Response.json([]);
  };
  t.mock.method(globalThis, 'fetch', fakeFetch);
  let handler;
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake-key', MATCHPLAY_API_TOKEN: token };
  const Deno = { env: { get: name => env[name] }, serve: fn => { handler = fn; } };
  new Function('Deno', 'createClient', 'createMatchplayCache', 'rankEventCandidates', 'tournamentIdFromInput', handlerSource)(
    Deno, (url, key, opts) => createClient(url, key, { ...opts, global: { fetch: fakeFetch } }),
    createMatchplayCache, rankEventCandidates, tournamentIdFromInput,
  );
  return { calls, request: body => handler(new Request('https://function.test', {
    method: 'POST', headers: { Authorization: 'Bearer fake-session' }, body: JSON.stringify(body),
  })) };
}

for (const input of ['228825', 'https://app.matchplay.events/tournaments/228825']) {
  test(`single lookup succeeds through provider and real SDK: ${input}`, async t => {
    const { request, calls } = setup(t);
    const response = await request({ tournament: input });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.tournament.title, tournament.name);
    assert.equal(result.tournament.starts_at, '2026-01-03T00:27:00.000Z');
    assert.equal(result.tournament.location, tournament.location.name);
    assert.equal(result.candidates[0].id, 'linked');
    assert.equal(result.candidates[0].match.confidence, 'linked URL');
    assert.equal(calls.find(url => url.hostname === 'app.matchplay.events').href,
      'https://app.matchplay.events/api/tournaments/228825?includeLocation=1');
  });
}

test('single lookup accepts string IDs and missing optional location/date', async t => {
  const { request } = setup(t, { data: { tournamentId: '228825', name: 'Undated', location: null } });
  const response = await request({ tournament: '228825' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tournament.starts_at, null);
  assert.equal(result.tournament.location, '');
  assert.equal(result.candidates[0].id, 'linked');
});

for (const payload of [{ data: { tournamentId: 999 } }, { data: [] }, { data: null }, null, {}, tournament]) {
  test(`rejects unexpected payload without querying events: ${JSON.stringify(payload)}`, async t => {
    const { request, calls } = setup(t, payload);
    assert.equal((await request({ tournament: '228825' })).status, 502);
    assert.ok(!calls.some(url => url.pathname === '/rest/v1/events'));
  });
}

test('title discovery retains its endpoint and does not query club events', async t => {
  const { request, calls } = setup(t, { data: [tournament], links: { next: 'next-page' } });
  const response = await request({ mode: 'discover', scope: 'title', value: 'SNHPC', page: 2 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tournaments[0].id, '228825');
  assert.equal(result.has_next, true);
  assert.equal(calls.find(url => url.hostname === 'app.matchplay.events').href,
    'https://app.matchplay.events/api/search?query=SNHPC&type=tournaments&page=2');
  assert.ok(!calls.some(url => url.pathname === '/rest/v1/events'));
});

test('provider HTTP errors reach the caller with status and redacted message', async t => {
  const { request } = setup(t, { message: `Denied ${token} Bearer other-credential`, token: 'hidden-field' }, 403);
  const response = await request({ tournament: '228825' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'MatchPlay request failed (403): Denied [redacted] Bearer [redacted]' });
});

for (const [body, status, expected] of [
  ['<html>Service unavailable</html>', 503, 'Service unavailable'],
  [JSON.stringify({ message: 'Gateway timeout' }), 504, 'Gateway timeout'],
  ['', 404, 'MatchPlay request failed (404)'],
  ['x'.repeat(500) + token, 429, 'x'.repeat(240)],
  [JSON.stringify({ message: `Invalid ${encodeURIComponent(token)}` }), 401, 'Invalid [redacted]'],
  ['not JSON', 200, 'invalid JSON response'],
]) {
  test(`safe bounded provider error: ${status}, ${body.length} bytes`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
    await assert.rejects(getMatchplay('tournaments/228825?includeLocation=1', token), error => {
      assert.ok(error.message.includes(expected));
      assert.ok(error.message.includes(String(status)));
      assert.ok(!error.message.includes(token));
      assert.ok(error.message.length < 300);
      return true;
    });
  });
}

test('transport errors do not leak request details', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`network failure ${token}`); });
  await assert.rejects(getMatchplay('tournaments/228825', token), { message: 'MatchPlay request failed: could not reach provider' });
});

test('timeouts retain the retry guidance', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(getMatchplay('tournaments/228825', token), /Please try again in a few minutes/);
});

test('Postgres rejects the original SDK filter and accepts JSONB containment', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(db.query('select $1::jsonb', ['{[object Object]}']), /invalid input syntax for type json/);
    const { rows } = await db.query('select $1::jsonb @> $2::jsonb as matched', [
      JSON.stringify(linked.external_links), JSON.stringify([{ url: linked.external_links[0].url }]),
    ]);
    assert.equal(rows[0].matched, true);
  } finally { await db.close(); }
});
