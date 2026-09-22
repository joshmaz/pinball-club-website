import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importOpdbImages } from '../supabase/functions/_shared/opdb-images.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('ingest calls shared OPDB image importer after creating game rows and isolates failure', async () => {
  const source = await read('supabase/functions/pinballmap-ingest/index.ts');
  assert.ok(source.indexOf('supabase.rpc("snh_pinballmap_upsert_from_activity"') < source.indexOf('await importOpdbImages(supabase, opdbIds)'));
  assert.match(source, /const opdbIds = \[\.\.\.payload\.updates, \.\.\.payload\.creates\]/);
  assert.match(source, /catch \(syncError\) \{[\s\S]*?imageSyncWarning =/);
  assert.match(source, /return jsonResponse\(\{\s*ok: true,[\s\S]*?imageSyncWarning/);
  const sql = await read('supabase/migrations/20260916100000_game_images.sql');
  const importSql = sql.slice(sql.indexOf('create or replace function public.snh_game_images_import_opdb'), sql.indexOf('revoke all on function public.snh_game_images_import_opdb'));
  assert.match(importSql, /on conflict \(game_id, source_type, source_key\) do update/);
  const conflictUpdate = importSql.split('on conflict (game_id, source_type, source_key) do update')[1].split('v_count :=')[0];
  assert.doesNotMatch(conflictUpdate, /usage_status|is_primary|primary_image/);
  assert.match(importSql, /'Open Pinball Database \(OPDB\)'/);
  assert.match(importSql, /'reference_only'/);
});

test('shared OPDB importer deduplicates IDs and reuses stable source keys on repeat', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ machines: [{
    opdbId: 'G-one', name: 'Game One', images: [{ group: 'stable-image-key', urls: { large: 'https://example.org/one.jpg' } }]
  }] }) });
  try {
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 1, error: null }; } };
    await importOpdbImages(client, ['G-one', 'G-one']);
    await importOpdbImages(client, ['G-one']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.args.p_images[0].sourceKey), ['stable-image-key', 'stable-image-key']);
    assert.ok(calls.every(call => call.name === 'snh_game_images_import_opdb'));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('manual and scheduled runs use one overall audit row with counts, status and verified actor', async () => {
  const edge = await read('supabase/functions/pinballmap-ingest/index.ts');
  const sql = await read('supabase/migrations/20260921160000_pinballmap_manual_audit_actor.sql');
  assert.match(edge, /auth\.getUser\(bearer\)/);
  assert.match(edge, /member_roles!inner\(role_slug\)/);
  assert.match(edge, /if \(manualActorUserId\) \(payload as Record<string, unknown>\)\.manual_actor_user_id = manualActorUserId/);
  assert.match(sql, /'games', 'import', nullif\(p_payload->>'manual_actor_user_id', ''\)::uuid/);
  assert.match(sql, /'pinballmap_ingest', v_loc::text/);
  assert.match(sql, /'updates_count', jsonb_array_length\(coalesce\(p_payload->'updates', '\[\]'::jsonb\)\)/);
  assert.match(sql, /'creates_count', jsonb_array_length\(coalesce\(p_payload->'creates', '\[\]'::jsonb\)\)/);
  assert.match(sql, /'status', 'success'/);
  assert.match(sql, /case when p_payload \? 'manual_actor_user_id' then 'manual' else 'scheduled' end/);
  assert.doesNotMatch(sql, /if .*jsonb_array_length.*then[\s\S]*insert into public\.audit_log/);
});
