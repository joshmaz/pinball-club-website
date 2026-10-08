#!/usr/bin/env node
// Full-catalog OPDB discovery; dry-run by default. Never downloads image binaries.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

export function planSync(games, existing, entries, parse) {
  const grouped = new Map();
  const withoutId = [];
  for (const game of games) {
    const id = String(game.opdb_id || '').trim();
    if (!id) { withoutId.push({ id: game.id, title: game.title }); continue; }
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(game);
  }
  const plans = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([opdbId, matches]) => {
    const entry = entries.get(opdbId);
    const images = entry ? parse(entry) : [];
    const changes = matches.map(game => {
      const rows = existing.filter(row => row.game_id === game.id);
      return { gameId: game.id, title: game.title, newImages: images.filter(i => !rows.some(r => r.source_key === i.sourceKey)).length,
        existingImages: images.filter(i => rows.some(r => r.source_key === i.sourceKey)).length,
        unmatchedExisting: rows.filter(r => !images.some(i => i.sourceKey === r.source_key)).map(r => r.id) };
    });
    return { opdbId, matched: !!entry, images, changes, missingCandidates: images.filter(i => !(i.metadata.deliveryVariants || []).length).map(i => i.sourceKey) };
  });
  return { withoutId, plans };
}
async function allRows(client, table, select, configure) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await configure(client.from(table).select(select)).order('id').range(offset, offset + 499);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
async function main() {
  const args = process.argv.slice(2);
  let apply = false, limit, onlyId, report = '/tmp/opdb-image-sync-dry-run.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--limit') limit = Number(args[++i]);
    else if (args[i] === '--opdb-id') onlyId = args[++i];
    else if (args[i] === '--report') report = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  if (!report || (onlyId !== undefined && !onlyId)) throw new Error('Missing argument value');
  if (apply && report === '/tmp/opdb-image-sync-dry-run.json') report = '/tmp/opdb-image-sync-apply.json';
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (use node --env-file=.env).');
  const source = await readFile(new URL('../supabase/functions/_shared/opdb-images.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { fetchOpdbExport, imageImportsForEntry } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [games, existing, entries] = await Promise.all([
    allRows(client, 'games', 'id,title,opdb_id', q => q.is('deleted_at', null)),
    allRows(client, 'game_images', 'id,game_id,source_key,usage_status,is_primary,metadata', q => q.eq('source_type', 'opdb')),
    fetchOpdbExport(),
  ]);
  const plan = planSync(games, existing, entries, imageImportsForEntry);
  const selected = plan.plans.filter(p => !onlyId || p.opdbId === onlyId).slice(0, limit);
  if (onlyId && !selected.length) throw new Error('OPDB ID is not in the active catalog');
  const summary = { catalogGames: games.length, withoutOpdbId: plan.withoutId.length, uniqueOpdbIds: plan.plans.length,
    selectedIds: selected.length, matchedIds: selected.filter(p => p.matched).length,
    unmatchedIds: selected.filter(p => !p.matched).map(p => p.opdbId),
    sourceImages: selected.reduce((n,p) => n+p.images.length,0),
    newAssociations: selected.flatMap(p => p.changes).reduce((n,g) => n+g.newImages,0),
    refreshedAssociations: selected.flatMap(p => p.changes).reduce((n,g) => n+g.existingImages,0),
    missingCandidates: selected.reduce((n,p) => n+p.missingCandidates.length,0) };
  const output = { generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', summary, withoutId: plan.withoutId, plans: selected, results: [] };
  await writeFile(report, JSON.stringify(output, null, 2)+'\n');
  console.log(JSON.stringify(summary));
  if (!apply) return;
  for (const item of selected) {
    if (!item.matched || !item.images.length) continue;
    try {
      const { data, error } = await client.rpc('snh_game_images_import_opdb', { p_opdb_id: item.opdbId, p_images: item.images });
      if (error) throw new Error(error.message);
      const { data: after, error: readError } = await client.from('game_images').select('id,game_id,source_key,usage_status,is_primary,metadata').eq('source_type', 'opdb').in('game_id', item.changes.map(g => g.gameId));
      if (readError) throw new Error(readError.message);
      for (const game of item.changes) for (const image of item.images) {
        const row = after.find(r => r.game_id === game.gameId && r.source_key === image.sourceKey);
        const before = existing.find(r => r.game_id === game.gameId && r.source_key === image.sourceKey);
        if (!row || JSON.stringify(row.metadata.deliveryVariants) !== JSON.stringify(image.metadata.deliveryVariants)) throw new Error('Candidate verification failed');
        if (before && (row.usage_status !== before.usage_status || row.is_primary !== before.is_primary)) throw new Error('Approval/selection changed; review possible concurrent edit');
        if (!before && (row.usage_status !== 'reference_only' || row.is_primary)) throw new Error('New image approval verification failed');
      }
      output.results.push({ opdbId: item.opdbId, status: 'verified', imported: Number(data || 0) });
    } catch (error) {
      output.results.push({ opdbId: item.opdbId, status: 'error', error: error.message });
      await writeFile(report, JSON.stringify(output, null, 2)+'\n');
      throw new Error(`Sync stopped at ${item.opdbId}: ${error.message}; report saved`);
    }
    await writeFile(report, JSON.stringify(output, null, 2)+'\n');
    console.log(item.opdbId, 'verified');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
