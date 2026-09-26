#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import publicData from '../assets/js/public-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queries = {
  games: { table: 'games_catalog_v1', select: 'game', order: 'slug.asc' },
  events: {
    table: 'events', select: 'id,title,description,location,starts_at,external_url,source,all_day,time_known,external_links',
    order: 'starts_at.asc.nullslast,id.asc', or: '(published.eq.true,published.is.null)',
  },
};

export function publicCredentials(env) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY to refresh public snapshots.');
  // Never let a mistakenly assigned elevated key bypass public RLS during export.
  if (key.startsWith('sb_secret_')) throw new Error('Snapshot exports require a public key.');
  if (!key.startsWith('sb_publishable_')) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); } catch { /* reject below */ }
    if (claims?.role !== 'anon') throw new Error('Snapshot exports require an anon or publishable key.');
  }
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid Supabase URL.');
  return { url: url.replace(/\/+$/, ''), key };
}

export async function fetchSnapshot(dataset, { env = process.env, fetchImpl = fetch, generatedAt } = {}) {
  const query = queries[dataset];
  if (!query) throw new Error('Unknown dataset.');
  const { url, key } = publicCredentials(env);
  const rows = [];
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({ select: query.select, order: query.order, limit: '500', offset: String(offset) });
    if (query.or) params.set('or', query.or);
    const response = await fetchImpl(`${url}/rest/v1/${query.table}?${params}`, {
      headers: { apikey: key, ...(key.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${key}` }), Prefer: 'count=exact' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${dataset} export failed (${response.status}). Existing snapshots were not replaced.`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Invalid ${dataset} export response.`);
    const totalText = response.headers.get('content-range')?.split('/')[1];
    if (!/^\d+$/.test(totalText || '')) throw new Error(`Missing ${dataset} row count; refusing a potentially incomplete snapshot.`);
    const total = Number(totalText);
    rows.push(...page);
    offset += page.length;
    if (offset === total) break;
    if (!page.length || offset > total) throw new Error(`Inconsistent ${dataset} pagination; retry the refresh.`);
  }
  const data = dataset === 'games' ? rows.map((row) => row.game) : rows.map(publicData.eventFromRow);
  return publicData.createSnapshot(dataset, data, generatedAt);
}

export async function refreshSnapshots(datasets = ['games', 'events'], options = {}) {
  const dataDir = options.dataDir || path.join(root, 'data');
  const generatedAt = new Date().toISOString();
  // Fetch and validate every dataset before replacing any committed snapshot.
  const payloads = await Promise.all(datasets.map((dataset) => fetchSnapshot(dataset, { ...options, generatedAt })));
  await mkdir(dataDir, { recursive: true });
  for (let i = 0; i < datasets.length; i++) {
    const target = path.join(dataDir, `${datasets[i]}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payloads[i], null, 2)}\n`);
    await rename(temporary, target);
    console.log(`Refreshed ${datasets[i]}: ${payloads[i]._meta.recordCount} public records.`);
  }
}

export async function checkSnapshots({ dataDir = path.join(root, 'data'), maxAgeDays, now = Date.now() } = {}) {
  for (const dataset of ['games', 'events']) {
    const payload = JSON.parse(await readFile(path.join(dataDir, `${dataset}.json`), 'utf8'));
    const checked = publicData.validateSnapshot(dataset, payload, { requireMetadata: true, now });
    console.log(`${dataset}: ${checked.data.length} records, age ${checked.ageDays.toFixed(1)} days.`);
    if (maxAgeDays !== undefined && checked.ageDays > maxAgeDays) throw new Error(`${dataset} snapshot exceeds ${maxAgeDays} days.`);
    if (checked.stale) console.warn(`Warning: ${dataset} snapshot is older than ${publicData.MAX_AGE_DAYS} days. Run the refresh command.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ageOption] = process.argv.slice(2);
    if (command === 'refresh' && !ageOption) await refreshSnapshots();
    else if (command === 'check') {
      const maxAgeDays = ageOption === undefined ? undefined : Number(ageOption.replace(/^--max-age-days=/, ''));
      if (ageOption && (!ageOption.startsWith('--max-age-days=') || !Number.isFinite(maxAgeDays) || maxAgeDays < 0)) throw new Error('Invalid max age.');
      await checkSnapshots({ maxAgeDays });
    } else throw new Error('Usage: node scripts/snapshots.mjs refresh|check [--max-age-days=7]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
