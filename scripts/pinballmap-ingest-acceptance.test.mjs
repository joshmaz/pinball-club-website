import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

// Transpile with the repository's existing compiler instead of relying on Node TS loading.
const opdbSource = await read('supabase/functions/_shared/opdb-images.ts');
const opdbCode = ts.transpileModule(opdbSource.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { importOpdbImages } = new Function(opdbCode + '\nreturn { importOpdbImages };')();

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
  assert.match(edge, /await authorizeIngest\(req/);
  assert.match(edge, /auth\.getUser\(bearer\)/);
  assert.match(edge, /const manualActorUserId = authorization\.manualActorUserId/);
  // Caller-JWT authorization and SQL inheritance are exercised by interactive-edge-auth.test.mjs.
  assert.match(edge, /if \(manualActorUserId\) \(payload as Record<string, unknown>\)\.manual_actor_user_id = manualActorUserId/);
  assert.match(sql, /'games', 'import', nullif\(p_payload->>'manual_actor_user_id', ''\)::uuid/);
  assert.match(sql, /'pinballmap_ingest', v_loc::text/);
  assert.match(sql, /'updates_count', jsonb_array_length\(coalesce\(p_payload->'updates', '\[\]'::jsonb\)\)/);
  assert.match(sql, /'creates_count', jsonb_array_length\(coalesce\(p_payload->'creates', '\[\]'::jsonb\)\)/);
  assert.match(sql, /'status', 'success'/);
  assert.match(sql, /case when p_payload \? 'manual_actor_user_id' then 'manual' else 'scheduled' end/);
  assert.doesNotMatch(sql, /if .*jsonb_array_length.*then[\s\S]*insert into public\.audit_log/);
});


test('cron requires the dedicated scheduler credential while gateway JWT verification stays disabled', async () => {
  const sql = await read('supabase/migrations/20260928190000_pinballmap_ingest_scheduler_auth.sql');
  assert.match(sql, /create or replace function private\.snh_pinballmap_ingest_cron_invoke/);
  assert.match(sql, /where ds\.name = 'snh_pinballmap_ingest_scheduler_secret'/);
  assert.match(sql, /v_scheduler_secret is null or btrim\(v_scheduler_secret\) = ''/);
  assert.match(sql, /'x-pinballmap-scheduler-secret', v_scheduler_secret/);
  assert.match(sql, /'apikey', v_key/);
  assert.doesNotMatch(sql, /'Authorization'|cron\.schedule|cron\.unschedule/);
  assert.match(sql, /revoke all on function private\.snh_pinballmap_ingest_cron_invoke \(\) from public, anon, authenticated/);
  assert.match(sql, /timeout_milliseconds := 300000/);
  const config = await read('supabase/config.toml');
  const section = config.split('[functions.pinballmap-ingest]')[1].split('[functions.')[0];
  assert.match(section, /verify_jwt = false/);
  for (const path of ['README.md', 'docs/games-relational-migration-plan.md']) {
    const doc = await read(path);
    assert.match(doc, /x-pinballmap-scheduler-secret/);
    assert.match(doc, /PINBALLMAP_INGEST_SCHEDULER_SECRET/);
    assert.match(doc, /snh_pinballmap_ingest_scheduler_secret/);
  }
});
