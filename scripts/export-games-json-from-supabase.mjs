#!/usr/bin/env node
/**
 * Export public.games_catalog_v1 rows from Supabase into data/games.json.
 *
 * Usage:
 *   node --env-file=.env scripts/export-games-json-from-supabase.mjs
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_ANON_KEY
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "games.json");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getApiKey() {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (service) return service;
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  if (anon) return anon;
  throw new Error(
    "Missing API key: set SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_ANON_KEY."
  );
}

async function fetchGamesRows() {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const apiKey = getApiKey();
  const endpoint =
    `${supabaseUrl}/rest/v1/games_catalog_v1` +
    "?select=game" +
    "&order=title.asc";

  const response = await fetch(endpoint, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Supabase games export failed (${response.status} ${response.statusText}): ${details}`
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Supabase games export failed: expected an array response.");
  }
  return data;
}

function normalizeRows(rows) {
  return rows
    .map((row) => row?.game)
    .filter((game) => game && typeof game === "object");
}

async function main() {
  const rows = await fetchGamesRows();
  const games = normalizeRows(rows);
  const payload = { games };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Exported ${games.length} games to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
