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
  const request = await req.json().catch(() => ({}));
  if (request && request.action === "send_preview") return sendPreview(db, request.notification_id);
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
  const rawBudget = summary.budget && typeof summary.budget === "object" ? summary.budget : null;
  const safeCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  const budget = rawBudget ? {
    rolling_limit: safeCount(rawBudget.rolling_limit),
    per_run_limit: safeCount(rawBudget.per_run_limit),
    sent_last_24h: safeCount(rawBudget.sent_last_24h),
    in_flight: safeCount(rawBudget.in_flight),
    used: safeCount(rawBudget.used),
    remaining: safeCount(rawBudget.remaining),
    eligible_pending: safeCount(rawBudget.eligible_pending),
    waiting_pending: safeCount(rawBudget.waiting_pending),
    expired_pending: safeCount(rawBudget.expired_pending),
  } : null;
  const safeError = outcome.ok && !summary.failed ? null
    : typeof summary.error === "string" && summary.error.trim()
      ? summary.error.replace(/[\r\n\t]/g, " ").slice(0, 180)
      : "Notification dispatch failed. Check dispatcher logs.";
  const finish = await db.from("operations_job_runs").update({
    finished_at: new Date().toISOString(),
    status: outcome.ok && !summary.failed ? "succeeded" : "failed",
    result: { mode: summary.mode || configuredMode, sent: summary.sent ?? 0,
      canceled: summary.canceled ?? 0, failed: summary.failed ?? 0,
      limited: summary.limited === true, preview, budget },
    error: safeError,
  }).eq("id", run.data.id);
  if (finish.error) return response({ error: "Could not record job completion" }, 503);
  return outcome;
});

async function sendPreview(db: SupabaseClient, notificationId: unknown): Promise<Response> {
  if (!isStagingProject()) return response({ error: "Queued-message previews are available only in staging" }, 409);
  if (typeof notificationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notificationId)) {
    return response({ error: "A valid queued message ID is required" }, 400);
  }
  const testEmail = Deno.env.get("NOTIFICATION_TEST_EMAIL")?.trim();
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFICATION_FROM");
  if (!testEmail || !apiKey || !from) return response({ error: "Staging preview email configuration is missing" }, 409);
  const queued = await db.from("notification_outbox").select("id,subject,body,status")
    .eq("id", notificationId).eq("status", "pending").maybeSingle();
  if (queued.error) return response({ error: "Could not load pending notification" }, 503);
  if (!queued.data) return response({ error: "Pending notification was not found" }, 404);
  const subject = "[STAGING PREVIEW] " + String(queued.data.subject || "Notification");
  const text = [
    "STAGING PREVIEW — this copy was sent only to the configured test inbox.",
    "The queued message remains pending; its intended recipient was not contacted.",
    "",
    String(queued.data.body || "(No message body was saved.)"),
  ].join("\n");
  const result = await send(apiKey, from, testEmail, subject, text,
    "staging-preview-" + notificationId + "-" + crypto.randomUUID());
  return response({ sent: result.ok, preview: true, error: result.ok ? undefined : result.error }, result.ok ? 200 : 502);
}

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
    const [queue, status] = await Promise.all([
      db.from("notification_outbox").select("kind,subject,created_at")
        .eq("status", "pending").order("created_at").limit(1),
      db.rpc("snh_notification_live_status"),
    ]);
    if (queue.error || status.error || !status.data) return response({ mode, error: "Could not preview queue and live-send budget" }, 500);
    return response({ mode, next: queue.data?.[0] || null, budget: status.data });
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
  if (!apiKey || !from) return response({ mode, error: "Live delivery configuration missing" }, 500);

  const budgetResult = await db.rpc("snh_notification_live_status");
  if (budgetResult.error || !budgetResult.data) return response({ mode, error: "Could not check live-send budget" }, 503);
  const budget = budgetResult.data as { remaining?: number };
  if (!Number.isInteger(budget.remaining) || Number(budget.remaining) < 0) {
    return response({ mode, error: "Live-send budget is unavailable" }, 503);
  }
  const remainingAtStart = Number(budget.remaining);
  if (remainingAtStart === 0) {
    return response({ mode, sent: 0, canceled: 0, failed: 0, limited: true, budget: budgetResult.data });
  }

  let sent = 0;
  const canceled = 0;
  let failed = 0;
  const runLimit = Math.min(10, remainingAtStart);
  for (let i = 0; i < runLimit; i += 1) {
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
  const refreshedBudget = await db.rpc("snh_notification_live_status");
  const finalBudget = !refreshedBudget.error && refreshedBudget.data ? refreshedBudget.data : {
    ...budgetResult.data,
    sent_last_24h: Number(budgetResult.data.sent_last_24h || 0) + sent,
    used: Number(budgetResult.data.used || 0) + sent,
    remaining: Math.max(0, remainingAtStart - sent),
  };
  return response({ mode, sent, canceled, failed,
    limited: Number(finalBudget.remaining || 0) === 0, budget: finalBudget });
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
