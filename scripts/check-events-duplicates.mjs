#!/usr/bin/env node
/**
 * Fails if data/events.json contains duplicate events by (title/name + date).
 * Usage:
 *   node scripts/check-events-duplicates.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const eventsPath = path.join(__dirname, "..", "data", "events.json");

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function duplicateKey(row) {
  return [norm(row.name || row.title), norm(row.date)].join("|");
}

async function main() {
  const raw = await readFile(eventsPath, "utf8");
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error("data/events.json must be an array.");
  }

  const seen = new Map();
  const duplicates = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const key = duplicateKey(row);
    if (!seen.has(key)) {
      seen.set(key, i);
      continue;
    }
    duplicates.push({
      firstIndex: seen.get(key),
      duplicateIndex: i,
      name: row.name || row.title || "",
      date: row.date || "",
      location: row.location || ""
    });
  }

  if (duplicates.length === 0) {
    console.log(`No duplicate events found in ${eventsPath}.`);
    return;
  }

  console.error(`Found ${duplicates.length} duplicate event row(s) in ${eventsPath}:`);
  for (const d of duplicates) {
    console.error(
      `- "${d.name}" on ${d.date} (rows ${d.firstIndex} and ${d.duplicateIndex})` +
      (d.location ? ` at ${d.location}` : "")
    );
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
