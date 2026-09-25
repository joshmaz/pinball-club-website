import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";

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
  const mode = Deno.env.get("NOTIFICATION_DELIVERY_MODE") || "preview";
  if (!["preview", "test", "live"].includes(mode)) return response({ error: "Invalid delivery mode" }, 500);

  // Preview and test never claim or consume a real job. The test message goes
  // only to the configured test inbox, never to a queued recipient.
  if (mode !== "live") {
    const { data, error } = await db.from("notification_outbox")
      .select("id,kind,subject,body,created_at")
      .eq("status", "pending").order("created_at").limit(1);
    if (error) return response({ error: "Could not preview queue" }, 500);
    if (mode === "preview") {
      return response({ mode, next: data?.[0] || null });
    }
    const testEmail = Deno.env.get("NOTIFICATION_TEST_EMAIL")?.trim();
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("NOTIFICATION_FROM");
    if (!testEmail || !apiKey || !from) return response({ error: "Test delivery configuration missing" }, 500);
    if (!data?.length) return response({ mode, sent: false, reason: "Queue is empty" });
    const result = await send(apiKey, from, testEmail,
      `[TEST] ${data[0].subject}`, `${data[0].body}\n\nTest delivery. No queued message was consumed.`,
      `test-${crypto.randomUUID()}`);
    return response({ mode, sent: result.ok, providerId: result.id || null,
      error: result.ok ? undefined : result.error }, result.ok ? 200 : 502);
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFICATION_FROM");
  if (!apiKey || !from) return response({ error: "Live delivery configuration missing" }, 500);

  let sent = 0;
  let canceled = 0;
  let failed = 0;
  for (let i = 0; i < 10; i += 1) {
    const claim = await db.rpc("snh_claim_notification");
    if (claim.error) return response({ error: "Could not claim queue", sent, canceled, failed }, 500);
    const job = (claim.data as Job[] | null)?.[0];
    if (!job) break;

    // Removing a coordinator's role before dispatch stops their pending mail.
    const roles = await db.from("member_roles").select("id")
      .eq("member_id", job.recipient_member_id)
      .in("role_slug", ["membership_editor", "membership_admin", "club_admin"]).limit(1);
    let status: "sent" | "failed" | "canceled" = "failed";
    let providerId: string | null = null;
    let failure: string | null = null;
    if (roles.error) {
      failure = "Could not verify recipient role";
    } else if (!roles.data?.length) {
      status = "canceled";
    } else {
      const result = await send(apiKey, from, job.recipient_email, job.subject, job.body, job.id);
      status = result.ok ? "sent" : "failed";
      providerId = result.id || null;
      failure = result.error || null;
    }
    const finish = await db.rpc("snh_finish_notification", {
      p_id: job.id, p_lease_id: job.lease_id, p_status: status,
      p_provider_id: providerId, p_error: failure,
    });
    if (finish.error || !finish.data) return response({ error: "Could not record delivery result", sent, canceled, failed }, 500);
    if (status === "sent") sent++;
    else if (status === "canceled") canceled++;
    else failed++;
  }
  return response({ mode, sent, canceled, failed });
});

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
