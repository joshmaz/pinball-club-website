import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";

type Job = {
  id: string;
  lease_id: string;
  kind: string;
  recipient_member_id: string;
  recipient_email: string;
  subject: string;
  body: string;
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function elevatedKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const value = JSON.parse(keys).default;
      if (typeof value === "string" && value.startsWith("sb_secret_")) return value;
    } catch { /* use legacy key */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function isStagingProject(): boolean {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  try {
    return new URL(supabaseUrl).hostname === "eptbdrwmcwogxcjleudv.supabase.co";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST required" }, 405);
  const expectedSecret = Deno.env.get("NOTIFICATION_DISPATCH_SECRET");
  if (!expectedSecret || req.headers.get("x-notification-secret") !== expectedSecret) {
    return response({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = elevatedKey();
  if (!url || !key) return response({ error: "Supabase configuration missing" }, 500);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const run = await db.from("operations_job_runs").insert({ job: "notification_dispatch" }).select("id").single();
  if (run.error) return response({ error: "Could not record job start" }, 503);
  let outcome: Response;
  try { outcome = await dispatch(db); }
  catch { outcome = response({ error: "Dispatcher failed unexpectedly" }, 500); }
  const summary = await outcome.clone().json();
  const configuredMode = Deno.env.get("NOTIFICATION_DELIVERY_MODE") || "preview";
  const next = summary.mode === "preview" && summary.next && typeof summary.next === "object" ? summary.next : null;
  const parsedCreatedAt = typeof next?.created_at === "string" ? Date.parse(next.created_at) : NaN;
  const ageSeconds = Number.isFinite(parsedCreatedAt)
    ? Math.max(0, Math.floor((Date.now() - parsedCreatedAt) / 1000)) : null;
  const preview = next ? {
    kind: typeof next.kind === "string" ? next.kind.slice(0, 80) : "notification",
    subject: typeof next.subject === "string" ? next.subject.slice(0, 180) : "",
    created_at: typeof next.created_at === "string" ? next.created_at : null,
    age_seconds: ageSeconds,
    live_eligible: ageSeconds === null ? null : ageSeconds < 24 * 60 * 60,
  } : null;
  const safeError = outcome.ok && !summary.failed ? null
    : typeof summary.error === "string" && summary.error.trim()
      ? summary.error.replace(/[\r\n\t]/g, " ").slice(0, 180)
      : "Notification dispatch failed. Check dispatcher logs.";
  const finish = await db.from("operations_job_runs").update({
    finished_at: new Date().toISOString(),
    status: outcome.ok && !summary.failed ? "succeeded" : "failed",
    result: { mode: summary.mode || configuredMode, sent: summary.sent ?? 0,
      canceled: summary.canceled ?? 0, failed: summary.failed ?? 0, preview },
    error: safeError,
  }).eq("id", run.data.id);
  if (finish.error) return response({ error: "Could not record job completion" }, 503);
  return outcome;
});

async function dispatch(db: SupabaseClient): Promise<Response> {
  const mode = Deno.env.get("NOTIFICATION_DELIVERY_MODE") || "preview";
  const isStaging = isStagingProject();
  if (!["preview", "test", "live"].includes(mode)) return response({ mode, error: "Invalid delivery mode" }, 500);
  if (isStaging && mode === "live") {
    return response({ mode, error: "Live delivery is disabled for staging" }, 409);
  }

  // Preview reports only safe metadata for the oldest pending message. Tests use
  // a synthetic payload so they never expose, consume, or repeatedly resend queue content.
  if (mode === "preview") {
    const { data, error } = await db.from("notification_outbox")
      .select("kind,subject,created_at")
      .eq("status", "pending").order("created_at").limit(1);
    if (error) return response({ mode, error: "Could not preview queue" }, 500);
    return response({ mode, next: data?.[0] || null });
  }

  if (mode === "test") {
    const testEmail = Deno.env.get("NOTIFICATION_TEST_EMAIL")?.trim();
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("NOTIFICATION_FROM");
    if (!testEmail || !apiKey || !from) return response({ mode, error: "Test delivery configuration missing" }, 500);
    const subject = `${isStaging ? "[STAGING TEST]" : "[TEST]"} Notification dispatcher test`;
    const sentAt = new Date().toISOString();
    const text = [
      "This is a synthetic notification dispatcher test.",
      isStaging ? "STAGING ENVIRONMENT. Test delivery." : "Test delivery.",
      "No queued message was read or changed.",
      `Sent at ${sentAt}.`,
    ].join("\n\n");
    const result = await send(apiKey, from, testEmail, subject, text, `test-${crypto.randomUUID()}`);
    return response({ mode, sent: result.ok, synthetic: true, providerId: result.id || null,
      error: result.ok ? undefined : result.error }, result.ok ? 200 : 502);
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFICATION_FROM");
  if (!apiKey || !from) return response({ error: "Live delivery configuration missing" }, 500);

  let sent = 0;
  const canceled = 0;
  let failed = 0;
  for (let i = 0; i < 10; i += 1) {
    const claim = await db.rpc("snh_claim_notification");
    if (claim.error) return response({ error: "Could not claim queue", sent, canceled, failed }, 500);
    const job = (claim.data as Job[] | null)?.[0];
    if (!job) break;

    // The explicit recipient was authorized at enqueue; role changes do not
    // revoke delivery of an already-authorized message.
    const result = await send(apiKey, from, job.recipient_email, job.subject, job.body, job.id);
    const status = result.ok ? "sent" : "failed";
    const providerId = result.id || null;
    const failure = result.error || null;
    const finish = await db.rpc("snh_finish_notification", {
      p_id: job.id, p_lease_id: job.lease_id, p_status: status,
      p_provider_id: providerId, p_error: failure,
    });
    if (finish.error || !finish.data) return response({ error: "Could not record delivery result", sent, canceled, failed }, 500);
    if (status === "sent") sent++;
    else failed++;
  }
  return response({ mode, sent, canceled, failed });
}

async function send(apiKey: string, from: string, to: string, subject: string,
  text: string, idempotencyKey: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Resend HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: "Resend request failed" };
  }
}
