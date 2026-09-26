#!/usr/bin/env node
// Updates timestamps only, with optimistic concurrency and a durable per-row journal.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
const [proposalPath, journalPath, mode] = process.argv.slice(2);
if (!proposalPath || !journalPath) throw new Error('Usage: node --env-file=.env scripts/apply-event-time-recovery.mjs proposal.json journal.jsonl [--apply]');
if (mode && mode !== '--apply') throw new Error('Unknown mode');
const proposal = JSON.parse(await readFile(proposalPath, 'utf8'));
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Database configuration missing');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function request(query, options = {}) {
  const response = await fetch(`${url}/rest/v1/events?${new URLSearchParams(query)}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`Event request failed: ${response.status}`);
  return response.json();
}
const seen = new Set();
const ready = [], skipped = [];
for (const p of proposal.proposed) {
  if (seen.has(p.id)) throw new Error('Duplicate proposal UUID');
  seen.add(p.id);
  const next = new Date(p.proposed_starts_at);
  if (!Number.isFinite(next.getTime()) || !p.basis) throw new Error('Invalid proposal');
  const [row] = await request({ select: '*', id: `eq.${p.id}` });
  if (!row || row.title !== p.title || Date.parse(row.starts_at) !== Date.parse(p.expected_starts_at) ||
      (row.updated_at && Date.parse(row.updated_at) > Date.parse(proposal.source_checked_at))) {
    skipped.push({ id: p.id, title: p.title, reason: 'Missing or changed since audit' });
    continue;
  }
  ready.push({ proposal: p, before: row });
}
await writeFile(journalPath + '.backup.json', JSON.stringify({ preparedAt: new Date().toISOString(), ready, skipped }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ mode: mode || 'dry-run', ready: ready.length, skipped: skipped.length }));
if (mode === '--apply') {
  await writeFile(journalPath, '', { flag: 'wx', mode: 0o600 });
  for (const { proposal: p, before } of ready) {
    const query = { id: `eq.${p.id}`, starts_at: `eq.${before.starts_at}`, select: '*' };
    query.updated_at = before.updated_at ? `eq.${before.updated_at}` : 'is.null';
    const result = await request(query, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ starts_at: p.proposed_starts_at }) });
    if (result.length !== 1) {
      await appendFile(journalPath, JSON.stringify({ id:p.id,status:'skipped_concurrent_change' })+'\n');
      continue;
    }
    const after = result[0];
    const changed = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    await appendFile(journalPath, JSON.stringify({ id:p.id,title:p.title,status:'applied',before:before.starts_at,after:after.starts_at,basis:p.basis,changed })+'\n');
    if (Date.parse(after.starts_at) !== Date.parse(p.proposed_starts_at) || changed.some(k => !['starts_at','updated_at'].includes(k))) throw new Error('Unexpected returned change; inspect journal');
  }
  console.log('Application complete. Journal:', journalPath);
}
