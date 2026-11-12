import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import {
  MAX_OPDB_EXPORT_BYTES,
  OPDB_V2_EXPORT_URL,
  normalizeOpdbArchive,
  readBoundedResponse,
} from "../_shared/opdb-reference.mjs";

const BUCKET = "game-reference-archives";
const JOB = "opdb_reference_sync";
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

function serviceKey() {
  try {
    const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    if (key) return key;
  } catch { /* Use the legacy service role key when configured. */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0 && left.length > 0 && right.length > 0;
}

async function downloadArchive() {
  let response: Response;
  try {
    response = await fetch(OPDB_V2_EXPORT_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { Accept: "application/json", "User-Agent": "SNHPC game-reference sync" },
    });
  } catch {
    throw new Error("OPDB V2 download failed or timed out; the previous archive remains active.");
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/vnd.api+json") {
    await response.body?.cancel();
    throw new Error("OPDB V2 export did not return JSON; the previous archive remains active.");
  }
  const bytes = await readBoundedResponse(response, MAX_OPDB_EXPORT_BYTES);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("OPDB V2 export is not valid UTF-8 JSON; the previous archive remains active."); }
  return { bytes, payload };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  const configuredSecret = Deno.env.get("OPDB_REFERENCE_SYNC_SCHEDULER_SECRET") || "";
  const suppliedSecret = req.headers.get("x-opdb-reference-sync-secret") || "";
  if (!await constantTimeEqual(suppliedSecret, configuredSecret)) {
    return json({ ok: false, error: "Not authorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const key = serviceKey();
  if (!supabaseUrl || !key) return json({ ok: false, error: "Reference sync service is not configured." }, 503);
  const db = createClient(supabaseUrl, key, { auth: { persistSession: false } });
  let runId: string | null = null;
  let snapshotId: string | null = null;
  let storagePath: string | null = null;
  let stage = "job start";

  try {
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.from("operations_job_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "OPDB reference sync exceeded its one-hour run window; the next scheduled attempt may retry.",
    }).eq("job", JOB).eq("status", "running").lt("started_at", staleBefore);

    const started = await db.from("operations_job_runs").insert({ job: JOB }).select("id").single();
    if (started.error || !started.data?.id) {
      if (started.error?.code === "23505") return json({ ok: false, error: "An OPDB reference sync is already running." }, 409);
      return json({ ok: false, error: "Could not record the OPDB reference sync run." }, 503);
    }
    runId = started.data.id;
    stage = "OPDB V2 download and validation";

    const previous = await db.from("opdb_reference_snapshots")
      .select("entry_count")
      .eq("status", "succeeded")
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous.error) throw new Error("Could not read the previous OPDB archive metadata.");

    const { bytes, payload } = await downloadArchive();
    const normalized = normalizeOpdbArchive(payload, previous.data?.entry_count || 0);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    const fetchedAt = new Date().toISOString();
    const pathTime = fetchedAt.replace(/[:.]/g, "-");
    storagePath = `opdb-v2/${pathTime}-${crypto.randomUUID()}.json`;

    stage = "private archive upload";
    const snapshot = await db.from("opdb_reference_snapshots").insert({
      source_url: OPDB_V2_EXPORT_URL,
      storage_path: storagePath,
      content_sha256: sha256,
      byte_size: bytes.byteLength,
      entry_count: normalized.entryCount,
      ipdb_mapping_count: normalized.ipdbCount,
      fetched_at: fetchedAt,
      status: "staging",
    }).select("id").single();
    if (snapshot.error || !snapshot.data?.id) throw new Error("Could not create OPDB archive snapshot metadata.");
    snapshotId = snapshot.data.id;

    const upload = await db.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "application/json",
      cacheControl: "31536000",
      upsert: false,
    });
    if (upload.error) throw new Error("Could not store the private OPDB archive.");

    stage = "crosswalk index write";
    for (let offset = 0; offset < normalized.rows.length; offset += 400) {
      const batch = normalized.rows.slice(offset, offset + 400).map((row) => ({ ...row, snapshot_id: snapshotId }));
      const inserted = await db.from("opdb_reference_entries").insert(batch);
      if (inserted.error) throw new Error("Could not index the complete OPDB reference crosswalk.");
    }

    const indexed = await db.from("opdb_reference_entries")
      .select("opdb_id", { count: "exact", head: true })
      .eq("snapshot_id", snapshotId);
    if (indexed.error || indexed.count !== normalized.entryCount) {
      throw new Error("The OPDB crosswalk count did not match the validated archive.");
    }

    stage = "snapshot promotion";
    const finishedAt = new Date().toISOString();
    const result = {
      snapshot_id: snapshotId,
      entry_count: normalized.entryCount,
      ipdb_mapping_count: normalized.ipdbCount,
      byte_size: bytes.byteLength,
      content_sha256: sha256,
    };
    const promoted = await db.rpc("snh_opdb_reference_sync_promote", {
      p_snapshot_id: snapshotId,
      p_run_id: runId,
      p_result: result,
    });
    if (promoted.error) throw new Error("Could not atomically promote the validated OPDB archive and complete its Operations run.");
    const status = await db.from("integration_status").upsert({
      provider: "opdb", resource_type: "archive", last_attempt_at: fetchedAt,
      last_success_at: finishedAt, last_error_at: null, last_error: null,
      latency_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(fetchedAt)),
    });
    if (status.error) console.warn("OPDB integration status update failed");
    return json({ ok: true, entry_count: normalized.entryCount, ipdb_mapping_count: normalized.ipdbCount, fetched_at: fetchedAt });
  } catch (error) {
    const safeError = error instanceof Error && error.message.startsWith("OPDB ")
      ? error.message
      : `OPDB reference sync failed during ${stage}; the previous successful archive remains active.`;
    if (snapshotId) {
      await db.from("opdb_reference_snapshots").update({ status: "failed", error: safeError })
        .eq("id", snapshotId).eq("status", "staging");
    }
    if (runId) {
      await db.from("operations_job_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: safeError }).eq("id", runId);
    }
    await db.from("integration_status").upsert({
      provider: "opdb", resource_type: "archive", last_attempt_at: new Date().toISOString(),
      last_error_at: new Date().toISOString(), last_error: safeError,
    });
    return json({ ok: false, error: safeError }, 503);
  }
});
