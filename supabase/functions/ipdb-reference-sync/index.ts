import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import {
  IPDB_JSON_URL,
  MAX_IPDB_EXPORT_BYTES,
  normalizeIpdbArchive,
} from "../_shared/ipdb-reference.mjs";

const BUCKET = "game-reference-archives";
const JOB = "ipdb_reference_sync";
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

async function latestHeaders() {
  let response: Response;
  try {
    response = await fetch(IPDB_JSON_URL, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "SNHPC game-reference sync" },
    });
  } catch {
    throw new Error("IPDB update check failed or timed out; the previous archive remains active.");
  }
  if (!response.ok || response.redirected) {
    throw new Error(`IPDB update check failed (HTTP ${response.status}); the previous archive remains active.`);
  }
  const etag = response.headers.get("etag") || "";
  const length = response.headers.get("content-length");
  if (!etag) throw new Error("IPDB update check did not return a file validator; the previous archive remains active.");
  if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_IPDB_EXPORT_BYTES)) {
    throw new Error("IPDB export exceeds the safe download limit; the previous archive remains active.");
  }
  return { etag, byteSize: length == null ? null : Number(length) };
}

async function downloadArchive() {
  let response: Response;
  try {
    response = await fetch(IPDB_JSON_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { Accept: "application/json, text/plain", "User-Agent": "SNHPC game-reference sync" },
    });
  } catch {
    throw new Error("IPDB download failed or timed out; the previous archive remains active.");
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || response.redirected
    || !["application/json", "application/vnd.api+json", "text/plain"].includes(contentType)) {
    await response.body?.cancel();
    throw new Error("IPDB export did not return JSON; the previous archive remains active.");
  }
  const length = response.headers.get("content-length");
  if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_IPDB_EXPORT_BYTES)) {
    await response.body?.cancel();
    throw new Error("IPDB export exceeds the safe download limit; the previous archive remains active.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IPDB export response had no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IPDB_EXPORT_BYTES) {
        await reader.cancel();
        throw new Error("IPDB export exceeds the safe download limit; the previous archive remains active.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("IPDB export is not valid UTF-8 JSON; the previous archive remains active."); }
  return { bytes, payload, etag: response.headers.get("etag") || "" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  const configuredSecret = Deno.env.get("IPDB_REFERENCE_SYNC_SCHEDULER_SECRET") || "";
  const suppliedSecret = req.headers.get("x-ipdb-reference-sync-secret") || "";
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
  let activeSnapshot: { id: string; etag: string; entry_count: number; source_refreshed_at: string } | null = null;
  let stage = "job start";

  try {
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.from("operations_job_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "IPDB reference sync exceeded its one-hour run window; the next scheduled attempt may retry.",
    }).eq("job", JOB).eq("status", "running").lt("started_at", staleBefore);

    const started = await db.from("operations_job_runs").insert({ job: JOB }).select("id").single();
    if (started.error || !started.data?.id) {
      if (started.error?.code === "23505") return json({ ok: false, error: "An IPDB reference sync is already running." }, 409);
      return json({ ok: false, error: "Could not record the IPDB reference sync run." }, 503);
    }
    runId = started.data.id;
    stage = "IPDB update check";
    const latest = await db.from("ipdb_reference_snapshots")
      .select("id,etag,entry_count,source_refreshed_at")
      .eq("status", "succeeded")
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw new Error("Could not read the previous IPDB archive metadata.");
    activeSnapshot = latest.data || null;

    const remote = await latestHeaders();
    if (latest.data?.id && latest.data.etag === remote.etag) {
      const checkedAt = new Date().toISOString();
      const result = {
        unchanged: true,
        entry_count: latest.data.entry_count,
        source_refreshed_at: latest.data.source_refreshed_at,
        checked_at: checkedAt,
        etag: remote.etag,
        byte_size: remote.byteSize,
      };
      const completed = await db.rpc("snh_ipdb_reference_sync_unchanged", {
        p_snapshot_id: latest.data.id,
        p_run_id: runId,
        p_result: result,
      });
      if (completed.error) throw new Error("Could not record the unchanged IPDB check.");
      const status = await db.from("integration_status").upsert({
        provider: "ipdb", resource_type: "archive", last_attempt_at: checkedAt,
        last_success_at: checkedAt, last_error_at: null, last_error: null, latency_ms: 0,
      });
      if (status.error) console.warn("IPDB integration status update failed");
      return json({ ok: true, unchanged: true, entry_count: latest.data.entry_count, source_refreshed_at: latest.data.source_refreshed_at });
    }

    stage = "IPDB download and validation";
    const { bytes, payload, etag } = await downloadArchive();
    if (!etag) throw new Error("IPDB download did not return a file validator; the previous archive remains active.");
    const normalized = normalizeIpdbArchive(payload, latest.data?.entry_count || 0);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    const fetchedAt = new Date().toISOString();
    const pathTime = fetchedAt.replace(/[:.]/g, "-");
    storagePath = `ipdb-json/${pathTime}-${crypto.randomUUID()}.json`;

    stage = "private archive upload";
    const snapshot = await db.from("ipdb_reference_snapshots").insert({
      source_url: IPDB_JSON_URL,
      storage_path: storagePath,
      etag,
      content_sha256: sha256,
      byte_size: bytes.byteLength,
      entry_count: normalized.entryCount,
      source_refreshed_at: normalized.sourceRefreshedAt,
      fetched_at: fetchedAt,
      last_checked_at: fetchedAt,
      status: "staging",
    }).select("id").single();
    if (snapshot.error || !snapshot.data?.id) throw new Error("Could not create IPDB archive snapshot metadata.");
    snapshotId = snapshot.data.id;

    const upload = await db.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "application/json",
      cacheControl: "31536000",
      upsert: false,
    });
    if (upload.error) throw new Error("Could not store the private IPDB archive.");

    stage = "IPDB record index write";
    for (let offset = 0; offset < normalized.rows.length; offset += 100) {
      const batch = normalized.rows.slice(offset, offset + 100).map((row) => ({ ...row, snapshot_id: snapshotId }));
      const inserted = await db.from("ipdb_reference_entries").insert(batch);
      if (inserted.error) throw new Error("Could not index the complete IPDB reference archive.");
    }

    const indexed = await db.from("ipdb_reference_entries")
      .select("ipdb_id", { count: "exact", head: true })
      .eq("snapshot_id", snapshotId);
    if (indexed.error || indexed.count !== normalized.entryCount) {
      throw new Error("The IPDB record count did not match the validated archive.");
    }

    stage = "snapshot promotion";
    const finishedAt = new Date().toISOString();
    const result = {
      snapshot_id: snapshotId,
      unchanged: false,
      entry_count: normalized.entryCount,
      source_refreshed_at: normalized.sourceRefreshedAt,
      fetched_at: fetchedAt,
      byte_size: bytes.byteLength,
      content_sha256: sha256,
      etag,
    };
    const promoted = await db.rpc("snh_ipdb_reference_sync_promote", {
      p_snapshot_id: snapshotId,
      p_run_id: runId,
      p_result: result,
    });
    if (promoted.error) throw new Error("Could not atomically promote the validated IPDB archive and complete its Operations run.");
    const status = await db.from("integration_status").upsert({
      provider: "ipdb", resource_type: "archive", last_attempt_at: fetchedAt,
      last_success_at: finishedAt, last_error_at: null, last_error: null,
      latency_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(fetchedAt)),
    });
    if (status.error) console.warn("IPDB integration status update failed");
    return json({ ok: true, entry_count: normalized.entryCount, source_refreshed_at: normalized.sourceRefreshedAt, fetched_at: fetchedAt });
  } catch (error) {
    const safeError = error instanceof Error && error.message.startsWith("IPDB ")
      ? error.message
      : `IPDB reference sync failed during ${stage}; the previous successful archive remains active.`;
    if (snapshotId) {
      await db.from("ipdb_reference_snapshots").update({ status: "failed", error: safeError })
        .eq("id", snapshotId).eq("status", "staging");
    }
    if (runId) {
      await db.from("operations_job_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        result: activeSnapshot ? {
          entry_count: activeSnapshot.entry_count,
          source_refreshed_at: activeSnapshot.source_refreshed_at,
          unchanged: false,
        } : {},
        error: safeError,
      }).eq("id", runId);
    }
    const failedAt = new Date().toISOString();
    await db.from("integration_status").upsert({
      provider: "ipdb", resource_type: "archive", last_attempt_at: failedAt,
      last_error_at: failedAt, last_error: safeError,
    });
    return json({ ok: false, error: safeError }, 503);
  }
});
