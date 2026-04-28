#!/usr/bin/env node
/**
 * One-time/repeatable backfill from data/events.json to public.events.
 *
 * Required env vars:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 * - EVENTS_JSON_PATH (default: data/events.json)
 * - DRY_RUN=true
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const defaultEventsPath = path.join(repoRoot, "data", "events.json");

function toIsoDateOnly(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw || raw.toUpperCase() === "TBD") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

function cleanText(value, maxLen = 0) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (maxLen > 0) return s.slice(0, maxLen);
  return s;
}

function safeUrl(value) {
  const s = cleanText(value, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString();
    }
  } catch (_) {
    return null;
  }
  return null;
}

function makeLegacyImportKey(event) {
  const key = [
    (event.title || "").toLowerCase(),
    event.starts_at ? event.starts_at.slice(0, 10) : "",
    (event.location || "").toLowerCase(),
    event.external_url || "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

async function main() {
  const supabaseUrlRaw = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = supabaseUrlRaw ? String(supabaseUrlRaw).trim() : "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing env vars. Required: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  if (supabaseUrl === "..." || supabaseUrl.includes("YOUR_")) {
    throw new Error(
      "SUPABASE_URL is still a placeholder. Set it to your real project URL, e.g. https://<project-ref>.supabase.co"
    );
  }
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }
  } catch (_) {
    throw new Error(
      `SUPABASE_URL is invalid: "${supabaseUrl}". Expected format: https://<project-ref>.supabase.co`
    );
  }
  if (String(serviceRoleKey).trim() === "..." || String(serviceRoleKey).includes("YOUR_")) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is still a placeholder. Set it to your real service role key."
    );
  }

  const dryRun = String(process.env.DRY_RUN || "").toLowerCase() === "true";
  const jsonPath = process.env.EVENTS_JSON_PATH
    ? path.resolve(process.env.EVENTS_JSON_PATH)
    : defaultEventsPath;

  const raw = await readFile(jsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected events JSON to be an array.");
  }

  const normalized = [];
  const skipped = [];

  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i] || {};
    const title = cleanText(row.name || row.title, 300);
    const dateOnly = toIsoDateOnly(row.date);
    if (!title) {
      skipped.push({ index: i, reason: "missing title" });
      continue;
    }
    const startsAt = dateOnly ? `${dateOnly}T00:00:00Z` : null;
    const event = {
      title,
      description: cleanText(row.description, 4000),
      location: cleanText(row.location, 500),
      starts_at: startsAt,
      external_url: safeUrl(row.url || row.external_url),
      source: cleanText(row.source, 80) || "json_backfill",
      published: true,
    };
    event.legacy_import_key = makeLegacyImportKey(event);
    normalized.push(event);
  }

  const byKey = new Map();
  for (const event of normalized) {
    byKey.set(event.legacy_import_key, event);
  }
  const deduped = [...byKey.values()];

  console.log(`Source rows: ${parsed.length}`);
  console.log(`Valid rows: ${normalized.length}`);
  console.log(`Skipped rows: ${skipped.length}`);
  console.log(`Rows after dedupe: ${deduped.length}`);
  if (skipped.length > 0) {
    console.log("Sample skipped rows:", skipped.slice(0, 10));
  }

  if (dryRun) {
    console.log("DRY_RUN=true, skipping database upsert.");
    return;
  }

  const batchSize = 250;
  let upserted = 0;
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/events?on_conflict=legacy_import_key`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upsert failed on batch starting ${i}: ${text}`);
    }
    upserted += batch.length;
  }

  console.log(`Upserted rows: ${upserted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
