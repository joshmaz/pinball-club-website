import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { cachedResource, normalizedSearchKey } from '../supabase/functions/_shared/external-api-cache.mjs';
import { createMatchplayCache } from '../supabase/functions/matchplay-event-review/cache.mjs';

function fixture() {
  let time = 100000, calls = 0, row = null, fail = false;
  const statuses = [];
  const store = { read: async () => row, write: async value => { row = value; },
    status: async value => statuses.push(value) };
  const options = { store, provider: 'test', resourceType: 'event', key: '1', now: () => time,
    fetchPayload: async () => { calls++; if (fail) throw new Error('offline'); return { raw: calls }; },
    ttl: async () => 60 };
  return { options, statuses, calls: () => calls, time: value => { time = value; }, fail: () => { fail = true; } };
}
test('miss, hit, expiry, forced refresh and exact 30-second boundary', async () => {
  const f = fixture();
  assert.equal((await cachedResource(f.options)).cache.source, 'provider');
  f.time(129999);
  assert.equal((await cachedResource({ ...f.options, force: true })).cache.source, 'cache');
  assert.equal(f.calls(), 1);
  f.time(130000);
  assert.equal((await cachedResource({ ...f.options, force: true })).cache.source, 'provider');
  f.time(189999);
  assert.equal((await cachedResource(f.options)).cache.source, 'cache');
  f.time(190000);
  assert.equal((await cachedResource(f.options)).cache.source, 'provider');
  assert.equal(f.calls(), 3);
  assert.equal(f.statuses.length, 6, 'hits do not write provider status');
});
test('failed or invalid refresh preserves payload and original fetched time', async () => {
  const f = fixture();
  const first = await cachedResource(f.options);
  f.time(200000);
  const invalid = await cachedResource({ ...f.options, validate: () => { throw new Error('invalid'); } });
  assert.equal(invalid.cache.stale, true);
  assert.deepEqual(invalid.payload, first.payload);
  f.fail();
  const stale = await cachedResource(f.options);
  assert.equal(stale.cache.fetched_at, first.cache.fetched_at);
  assert.equal(stale.cache.stale, true);
  assert.ok(f.statuses.at(-1).last_error_at);
});
test('no cached response propagates failure; status failures do not break stale fallback', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(cachedResource(f.options), /offline/);
  const g = fixture(); await cachedResource(g.options); g.time(200000); g.fail();
  g.options.store.status = async () => { throw new Error('storage'); };
  assert.equal((await cachedResource(g.options)).cache.stale, true);
});
test('keys normalize query order and encoding, preserve filters, page and case', async () => {
  assert.equal(await normalizedSearchKey('search?query=A%20B&page=1'), await normalizedSearchKey('search?page=1&query=A+B'));
  for (const path of ['search?page=2&query=A+B', 'search?page=1&query=a+b', 'tournaments?page=1&query=A+B']) {
    assert.notEqual(await normalizedSearchKey(path), await normalizedSearchKey('search?page=1&query=A+B'));
  }
});
test('Match Play adapter retains raw data, applies policy and partitions credentials', async t => {
  const rows = new Map(); const policies = [];
  const client = { from(table) {
    const filters = {};
    return { select() { return this; }, eq(k, v) { filters[k] = v; return this; },
      async maybeSingle() {
        if (table === 'external_api_cache_policies') { policies.push(filters.policy); return { data: { ttl_seconds: 42 } }; }
        return { data: rows.get(JSON.stringify(filters)) || null };
      }, async upsert(row) {
        if (table === 'external_api_cache') rows.set(JSON.stringify({ provider: row.provider, resource_type: row.resource_type, cache_key: row.cache_key }), row);
        return { error: null };
      } };
  } };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ data: { tournamentId: 123, status: 'completed', extra: 'preserved' } }); });
  const get = createMatchplayCache(client, 'credential-one');
  const first = await get('tournaments/123?includeLocation=1');
  assert.equal(first.payload.data.extra, 'preserved');
  assert.equal(Date.parse(first.cache.expires_at) - Date.parse(first.cache.fetched_at), 42000);
  assert.equal((await get('tournaments/123?includeLocation=1')).cache.source, 'cache');
  await createMatchplayCache(client, 'credential-two')('tournaments/123?includeLocation=1');
  assert.equal(calls, 2);
  assert.deepEqual(policies, ['completed', 'completed']);
  assert.ok(!JSON.stringify([...rows.values()]).includes('credential-'));
});
test('migration executes, denies clients, seeds TTLs and cleans only old searches', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/migrations/20260928150000_external_api_cache.sql', import.meta.url), 'utf8'));
    assert.equal((await db.query('select count(*)::int as n from external_api_cache_policies')).rows[0].n, 8);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from external_api_cache'), /permission denied/);
      await assert.rejects(db.query('select * from integration_status'), /permission denied/);
      await assert.rejects(db.query('update external_api_cache_policies set ttl_seconds=1'), /permission denied/);
      await assert.rejects(db.query('select cleanup_external_api_search_cache()'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec(`set role service_role;
      insert into external_api_cache values
      ('test','search','old','{}',now()-interval '10 days',now()-interval '8 days'),
      ('test','event','old','{}',now()-interval '10 days',now()-interval '8 days'),
      ('test','search','recent','{}',now()-interval '2 days',now()-interval '1 day');`);
    assert.equal(Number((await db.query('select cleanup_external_api_search_cache() as n')).rows[0].n), 1);
    assert.equal((await db.query('select count(*)::int as n from external_api_cache')).rows[0].n, 2);
    await assert.rejects(db.query("update external_api_cache_policies set ttl_seconds = 0"), /check constraint/);
  } finally { await db.close(); }
});
