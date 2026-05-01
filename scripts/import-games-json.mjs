/**
 * One-shot import of data/games.json into Supabase via RPC snh_games_import_from_json.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (never use in browser).
 *
 *   node --env-file=.env scripts/import-games-json.mjs
 *   node --env-file=.env scripts/import-games-json.mjs path/to/games.json
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).');
  process.exit(1);
}

const gamesPath = process.argv[2] || join(root, 'data', 'games.json');
const raw = readFileSync(gamesPath, 'utf8');
const body = JSON.parse(raw);
if (!body || !Array.isArray(body.games)) {
  console.error('Expected { games: [...] } in', gamesPath);
  process.exit(1);
}

const rpcUrl = `${url.replace(/\/$/, '')}/rest/v1/rpc/snh_games_import_from_json`;
const res = await fetch(rpcUrl, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify({ p_json: body }),
});

const text = await res.text();
if (!res.ok) {
  console.error('Import failed', res.status, text);
  process.exit(1);
}

console.log('Import OK:', text);
