#!/usr/bin/env node
/**
 * One-off backfill: refresh Pinball Map–imported club_issues titles and game_id
 * using the same rules as snh_pinballmap_import_conditions (via
 * snh_pinballmap_backfill_club_issues).
 *
 * Prerequisites: Node 18+ (global fetch). Deploy migration
 * 20260516100000_club_issues_pinballmap_enrich.sql first.
 *
 * Environment:
 *   SUPABASE_URL              — project URL (https://xxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (never commit)
 *   PINBALLMAP_LOCATION_ID    — optional, default 8908
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL="https://....supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *   node scripts/backfill_pinballmap_club_issues.mjs
 */

const LOCATION_DEFAULT = 8908;

function buildPinballConditionPayload(activity) {
  const meta = activity.meta || {};
  const locationId = Number(meta.location_id ?? LOCATION_DEFAULT) || LOCATION_DEFAULT;
  const rows = [];
  for (const row of activity.user_submissions || []) {
    if (row.submission_type !== "new_condition") continue;
    const submissionId = row.id != null ? String(row.id) : "";
    const comment = String(row.comment || "").trim();
    const machineName = String(row.machine_name || "").trim();
    const createdAt = String(row.created_at || "").trim();
    if (!submissionId || !comment || !machineName || !createdAt) continue;
    rows.push({
      submissionId,
      machineName,
      machineId: row.machine_id != null ? Number(row.machine_id) : null,
      comment,
      createdAt,
    });
  }
  return { location_id: locationId, rows };
}

async function fetchAllActivity(locationId) {
  const baseQs = `id=${locationId}&limit=50`;
  const activityBase = `https://pinballmap.com/api/v1/user_submissions/location.json?${baseQs}`;
  const merged = { meta: { location_id: locationId }, user_submissions: [] };
  const seen = new Set();
  for (let page = 1; page <= 80; page += 1) {
    const sep = activityBase.includes("?") ? "&" : "?";
    const url = activityBase.includes("page=") ? activityBase : `${activityBase}${sep}page=${page}`;
    const actRes = await fetch(url);
    if (!actRes.ok) {
      throw new Error(`Pinball Map fetch failed: ${actRes.status}`);
    }
    let pageJson = await actRes.json();
    if (pageJson.errors && pageJson.errors.toLowerCase().includes("failed to find location") && url.includes("location_id=")) {
      const retryUrl = url.replace(/([?&])location_id=/g, "$1id=");
      const retry = await fetch(retryUrl);
      if (!retry.ok) throw new Error(`Pinball Map fetch failed: ${retry.status}`);
      pageJson = await retry.json();
    }
    if (pageJson.errors) {
      throw new Error(`Pinball Map API error: ${pageJson.errors}`);
    }
    if (page === 1) merged.meta = { ...merged.meta, ...(pageJson.meta || {}) };
    const subs = pageJson.user_submissions || [];
    for (const row of subs) {
      const id = `${row.submission_type}|${row.created_at}|${row.machine_name}|${row.machine_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.user_submissions.push(row);
    }
    if (subs.length < 50) break;
  }
  return merged;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const locationId = Number(process.env.PINBALLMAP_LOCATION_ID || LOCATION_DEFAULT) || LOCATION_DEFAULT;

  console.log(`Fetching Pinball Map activity for location ${locationId}…`);
  const activity = await fetchAllActivity(locationId);
  const payload = buildPinballConditionPayload(activity);
  console.log(`Condition rows in payload: ${payload.rows.length}`);

  const rpcUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/snh_pinballmap_backfill_club_issues`;
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ p_payload: payload }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Non-JSON response:", text.slice(0, 500));
    process.exit(1);
  }

  if (!res.ok) {
    console.error("RPC failed:", res.status, data);
    process.exit(1);
  }

  console.log("Backfill result:", JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
