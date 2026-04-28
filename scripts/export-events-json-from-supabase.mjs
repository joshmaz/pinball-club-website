#!/usr/bin/env node
/**
 * Export public.events rows from Supabase into data/events.json.
 *
 * Usage:
 *   node --env-file=.env scripts/export-events-json-from-supabase.mjs
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "events.json");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toIsoDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString().slice(0, 10);
}

function cleanString(value, fallback = "") {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s === "" ? fallback : s;
}

function mapRowToJsonEvent(row) {
  return {
    name: cleanString(row.name || row.title, "Untitled Event"),
    date: toIsoDate(row.event_date || row.date),
    location: cleanString(row.location, "TBD"),
    description: cleanString(row.description),
    url: cleanString(row.url || row.event_url),
    imageUrl: cleanString(row.image_url || row.imageUrl),
    source: cleanString(row.source, "supabase"),
  };
}

function sortByDateDescThenName(a, b) {
  const ad = a.date || "";
  const bd = b.date || "";
  if (ad && bd && ad !== bd) {
    return bd.localeCompare(ad);
  }
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  return a.name.localeCompare(b.name);
}

async function fetchEventsRows() {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const endpoint =
    `${supabaseUrl}/rest/v1/events` +
    "?select=id,name,title,event_date,date,location,description,url,event_url,image_url,imageUrl,source" +
    "&order=event_date.desc.nullslast&order=date.desc.nullslast&order=created_at.desc.nullslast";

  const response = await fetch(endpoint, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Supabase events export failed (${response.status} ${response.statusText}): ${details}`
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Supabase events export failed: expected an array response.");
  }
  return data;
}

async function main() {
  const rows = await fetchEventsRows();
  const events = rows.map(mapRowToJsonEvent).sort(sortByDateDescThenName);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(events, null, 4)}\n`, "utf8");

  console.log(`Exported ${events.length} events to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
