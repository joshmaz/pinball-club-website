import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import data from '../assets/js/public-data.js';
import { fetchSnapshot, refreshSnapshots, checkSnapshots, publicCredentials } from './snapshots.mjs';

const id = '6c76d069-3d02-443f-8c33-3f0da3946609';
const eventRow = { id, title: 'League', starts_at: '2026-09-21T00:30:00Z', external_url: 'https://example.com/league' };
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test' };
const response = (payload) => ({ ok: true, json: async () => payload });

test('event snapshot preserves edit UUIDs and maps the current schema only', () => {
  const event = data.eventFromRow({ ...eventRow, unpublished_private_field: 'never export' });
  assert.equal(event.id, id);
  assert.equal(event.date, '2026-09-21');
  assert.equal(event.url, eventRow.external_url);
  assert.equal(event.unpublished_private_field, undefined);
  assert.equal(data.eventFromRow({ ...eventRow, starts_at: null }).date, 'TBD');
  assert.throws(() => data.eventFromRow({ ...eventRow, starts_at: 'invalid' }));
});

test('successful empty database response never resurrects old events', async () => {
  const result = await data.load('events', {
    live: async () => [], fetchImpl: async () => assert.fail('must not fetch snapshot'),
  });
  assert.deepEqual(result.data, []);
  assert.equal(result.source, 'supabase');
});

test('network and malformed database failures use a validated, dated snapshot', async () => {
  const payload = data.createSnapshot('events', [data.eventFromRow(eventRow)]);
  for (const live of [async () => { throw new Error('offline'); }, async () => null]) {
    const result = await data.load('events', { live, fetchImpl: async () => response(payload) });
    assert.equal(result.source, 'static-fallback');
    assert.equal(result.data[0].id, id);
    assert.match(data.sourceLabel(result), /saved \d{4}-\d{2}-\d{2}/);
  }
});

test('explicit static Games mode skips database access; invalid fallbacks fail safely', async () => {
  const result = await data.load('games', {
    preferLive: false, live: async () => assert.fail('must not query live'),
    fetchImpl: async () => response({ games: [{ title: 'Legacy game' }] }),
  });
  assert.equal(result.source, 'static');
  assert.equal(result.stale, true);
  await assert.rejects(data.load('events', { fetchImpl: async () => response({ events: 'bad' }) }), /expected an array/);
  await assert.rejects(data.load('games', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /404/);
});

test('legacy arrays remain readable while versioned snapshots enforce IDs, metadata and dates', () => {
  assert.equal(data.validateSnapshot('events', [{ name: 'Legacy', date: '2026-04-18' }]).data.length, 1);
  const snapshot = data.createSnapshot('events', [data.eventFromRow(eventRow)]);
  for (const broken of [
    { ...snapshot, _meta: { ...snapshot._meta, schemaVersion: 2 } },
    { ...snapshot, _meta: { ...snapshot._meta, recordCount: 9 } },
    { ...snapshot, events: [{ ...snapshot.events[0], id: '' }] },
    { ...snapshot, events: [{ ...snapshot.events[0], date: '2026-02-30' }] },
  ]) assert.throws(() => data.validateSnapshot('events', broken));
  assert.throws(() => data.createSnapshot('events', [snapshot.events[0], snapshot.events[0]]), /Duplicate/);
});

test('both browser and exporter pagination respect server caps smaller than requested pages', async () => {
  const offsets = [];
  const rows = await data.readPages(() => ({
    range: async (start) => {
      offsets.push(start);
      return { data: [start], count: 3 };
    },
  }));
  assert.deepEqual(rows, [0, 1, 2]);
  assert.deepEqual(offsets, [0, 1, 2]);
  let calls = 0;
  const snapshot = await fetchSnapshot('events', {
    env, fetchImpl: async (url, options) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('or'), '(published.eq.true,published.is.null)');
      assert.equal(query.get('select'), 'id,title,description,location,starts_at,external_url,source,all_day,time_known,external_links');
      assert.equal(query.get('offset'), String(calls));
      assert.equal(options.headers.apikey, env.SUPABASE_ANON_KEY);
      assert.equal(options.headers.Authorization, undefined);
      const row = { ...eventRow, id: `6c76d069-3d02-443f-8c33-3f0da394660${calls++}` };
      return { ...response([row]), headers: new Headers({ 'content-range': `${calls - 1}-${calls - 1}/2` }) };
    },
  });
  assert.equal(snapshot.events.length, 2);
  assert.equal(calls, 2);
});

test('exports reject elevated keys and do not use a service key when a public key exists', () => {
  assert.deepEqual(publicCredentials({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'private' }), { url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY });
  assert.throws(() => publicCredentials({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'private' }));
  assert.throws(() => publicCredentials({ ...env, SUPABASE_ANON_KEY: 'sb_secret_private' }));
  const elevatedJwt = 'x.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.x';
  assert.throws(() => publicCredentials({ ...env, SUPABASE_ANON_KEY: elevatedJwt }));
});

test('failed refresh leaves both previous snapshots intact; check enforces optional age threshold', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pinball-snapshots-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const generatedAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const games = data.createSnapshot('games', [{ id, title: 'Game' }], generatedAt);
  const events = data.createSnapshot('events', [data.eventFromRow(eventRow)], generatedAt);
  await writeFile(path.join(dataDir, 'games.json'), JSON.stringify(games));
  await writeFile(path.join(dataDir, 'events.json'), JSON.stringify(events));
  await assert.rejects(refreshSnapshots(['games', 'events'], {
    env, dataDir, fetchImpl: async (url) => url.includes('/events?')
      ? { ok: false, status: 500 }
      : { ...response([{ game: { id, title: 'Changed' } }]), headers: new Headers({ 'content-range': '0-0/1' }) },
  }), /export failed/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'games.json'))), games);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'events.json'))), events);
  await checkSnapshots({ dataDir });
  await assert.rejects(checkSnapshots({ dataDir, maxAgeDays: 7 }), /exceeds 7 days/);
});

test('public pages load the shared reader before consumers', async () => {
  for (const [page, script] of [['games.html', 'games.js'], ['events.html', 'events.js'], ['index.html', 'home-gallery.js']]) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.ok(html.indexOf('src="assets/js/public-data.js"') >= 0);
    assert.ok(html.indexOf('src="assets/js/public-data.js"') < html.indexOf(`src="assets/js/${script}"`));
  }
});
