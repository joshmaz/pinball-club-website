#!/usr/bin/env node
/**
 * Move repo-hosted club game photos into the existing game-images bucket and
 * convert their backfilled game_images associations in place.
 *
 * Dry run (default):
 *   node --env-file=.env scripts/migrate-legacy-game-images.mjs --dry-run
 * Apply:
 *   node --env-file=.env scripts/migrate-legacy-game-images.mjs --apply
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STORAGE_BUCKET,
  inventoryLegacyImages,
  planMigration,
} from "./migrate-legacy-game-images-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
if (apply && process.argv.includes("--dry-run")) throw new Error("Choose either --dry-run or --apply, not both.");
const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
const apiKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Use a local .env file; never commit credentials.`);
  return value;
}

function headers(extra = {}) {
  return { apikey: apiKey, Authorization: `Bearer ${apiKey}`, ...extra };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function loadDatabaseState() {
  const games = await requestJson(`${supabaseUrl}/rest/v1/games?select=id,slug,title,image_filename&deleted_at=is.null&limit=1000`, { headers: headers() });
  const images = await requestJson(`${supabaseUrl}/rest/v1/game_images?select=id,game_id,source_type,source_key,location_type,location_value,usage_status,is_primary,alt_text,metadata&limit=5000`, { headers: headers() });
  return { games, images };
}

async function upload(entry) {
  const encodedPath = entry.storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${encodedPath}`, {
    method: "POST",
    headers: headers({
      "Content-Type": entry.imageType.mime,
      "Cache-Control": "3600",
      "x-upsert": "true",
    }),
    body: entry.bytes,
  });
  if (!response.ok) throw new Error(`upload failed (${response.status}): ${await response.text()}`);
}

async function finalize(entry) {
  return requestJson(`${supabaseUrl}/rest/v1/rpc/snh_game_images_migrate_legacy`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_game_id: entry.game.id,
      p_legacy_filename: entry.filename,
      p_storage_path: entry.storagePath,
      p_public_url: entry.publicUrl,
      p_metadata: {
        originalFilename: entry.filename,
        contentType: entry.imageType.mime,
        sizeBytes: entry.sizeBytes,
        sha256: entry.checksum,
        migrationTool: "scripts/migrate-legacy-game-images.mjs",
      },
    }),
  });
}

function logEntry(entry) {
  const game = entry.game || entry.catalogGame;
  const mapping = game ? `${game.title || game.slug} (${game.slug || game.id})` : "no game";
  const detail = entry.storagePath ? ` -> ${entry.storagePath}` : "";
  console.log(`[${entry.action.toUpperCase()}] ${entry.filename} -> ${mapping}${detail}${entry.reason ? `: ${entry.reason}` : ""}`);
}

async function main() {
  console.log(`Legacy game image migration: ${apply ? "APPLY" : "DRY RUN"}`);
  const inventory = await inventoryLegacyImages(rootDir);
  const { games, images } = await loadDatabaseState();
  const plan = planMigration(inventory, games, images, supabaseUrl);
  plan.forEach(logEntry);

  const counts = {
    discovered: plan.length,
    wouldUpload: 0,
    recordsToCreate: 0,
    recordsToUpdate: 0,
    skipped: 0,
    manualReview: 0,
    failed: 0,
  };
  for (const entry of plan) {
    if (entry.action === "skip") { counts.skipped += 1; continue; }
    if (entry.action === "manual_review") { counts.manualReview += 1; continue; }
    counts.wouldUpload += 1;
    // Main already backfilled a row for every legacy image. Updating that row
    // is what preserves its ID, approval, primary choice, and alt text.
    counts.recordsToUpdate += 1;
    if (!apply) continue;
    try {
      await upload(entry);
      const result = await finalize(entry);
      if (result?.status === "migrated") console.log(`  migrated association ${result.imageId}`);
      else if (result?.status === "already_migrated") { counts.skipped += 1; console.log(`  already migrated ${result.imageId}`); }
      else { counts.manualReview += 1; console.error(`  manual review: ${result?.reason || "unexpected RPC result"}`); }
    } catch (error) {
      counts.failed += 1;
      console.error(`  FAILED ${entry.filename}: ${error.message}`);
    }
  }
  if (inventory.missingFiles.length) {
    counts.manualReview += inventory.missingFiles.length;
    for (const item of inventory.missingFiles) console.log(`[MANUAL_REVIEW] missing file ${item.filename} referenced by ${item.title} (${item.slug})`);
  }
  console.log("\nSummary", JSON.stringify(counts, null, 2));
  if (counts.manualReview || counts.failed) process.exitCode = 2;
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
