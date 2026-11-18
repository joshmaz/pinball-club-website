import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { getMatchplay } from "../matchplay-event-review/provider.mjs";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors,
    "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function serviceKey() {
  try { const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default; if (key) return key; }
  catch { /* legacy configuration */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
type EmailTemplateTestDefinition = {
  alias: string;
  name: string;
  description: string;
  fields: Array<{ key: string; label: string; description: string; sample: string; htmlKey?: string; exampleEmail?: boolean }>;
};
const EMAIL_TEMPLATE_TESTS: Record<string, EmailTemplateTestDefinition> = {
  "snhpc-member-signup-alert-v1": {
    alias: "snhpc-member-signup-alert-v1",
    name: "New website account notice",
    description: "Informational notice for membership managers when a website account is created.",
    fields: [
      { key: "NEW_USER_NAME", htmlKey: "NEW_USER_NAME_HTML", label: "New user name", description: "A fictional display name.", sample: "Mina Arcadewell" },
      { key: "NEW_USER_EMAIL", htmlKey: "NEW_USER_EMAIL_HTML", exampleEmail: true, label: "New user email", description: "A fictional email address ending in @example.com.", sample: "mina.arcadewell@example.com" },
    ],
  },
};
const TEMPLATE_TEST_MODEL = "gpt-4o-mini";
function escapeTemplateHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (ch) => entities[ch] || ch);
}
function templateTestTemplateData(definition: EmailTemplateTestDefinition, values: Record<string, string>, staging: boolean) {
  const variables: Record<string, string> = {
    SUBJECT_PREFIX: staging ? "[STAGING TEMPLATE TEST] " : "[TEMPLATE TEST] ",
    PREVIEW_BANNER: (staging ? "STAGING TEMPLATE TEST" : "TEMPLATE TEST") +
      " — sent only to the configured test inbox with fictional sample data. No member was contacted.",
  };
  for (const field of definition.fields) {
    variables[field.key] = values[field.key];
    if (field.htmlKey) variables[field.htmlKey] = escapeTemplateHtml(values[field.key]);
  }
  return { id: definition.alias, variables };
}

async function generateEmailTemplateSample(db: ReturnType<typeof createClient>, alias: string): Promise<{ values?: Record<string, string>; error?: string; status?: number }> {
  const definition = EMAIL_TEMPLATE_TESTS[alias];
  if (!definition) return { error: "Choose a supported email template.", status: 400 };
  const apiKey = Deno.env.get("OPENAI_PLATFORM_KEY") || "";
  if (!apiKey) return { error: "AI sample generation is not configured.", status: 409 };
  const fields = definition.fields.map((field) => ({
    key: field.key, description: field.description,
  }));
  const prompt = "Make fictional sample values for this email-template test. Return one JSON object with exactly these keys and string values: " +
    JSON.stringify(fields) + ". Never use real people or real contact details. Any email address must use the reserved example.com domain. " +
    "Keep the examples plausible and friendly. Template context: " + definition.description;
  const inputTokens = Math.ceil((prompt.length + 220) / 3);
  const maxOutputTokens = 120;
  const cost = (((inputTokens * 0.15) + (maxOutputTokens * 0.60)) / 1000000) * 1.5;
  const { data: reservationData, error: reserveError } = await db.rpc("snh_ai_usage_reserve", {
    p_feature: "email_template_test_data", p_model: TEMPLATE_TEST_MODEL, p_reserved_usd: cost,
  });
  if (reserveError) return { error: "AI budget check is unavailable. Sample generation was blocked.", status: 503 };
  const reservation = typeof reservationData === "string" ? JSON.parse(reservationData) : reservationData;
  if (!reservation?.allowed) return { error: "The monthly AI budget limit blocks this sample. Use the example values or contact an administrator.", status: 429 };
  const settle = async (usage: { prompt_tokens?: number; completion_tokens?: number } | null, succeeded: boolean, chargeReservation = false) => {
    const usedInput = Number.isInteger(usage?.prompt_tokens) ? Number(usage?.prompt_tokens) : inputTokens;
    const usedOutput = Number.isInteger(usage?.completion_tokens) ? Number(usage?.completion_tokens) : maxOutputTokens;
    const actualCost = usage
      ? (((usedInput * 0.15) + (usedOutput * 0.60)) / 1000000)
      : chargeReservation ? cost : 0;
    const { error } = await db.rpc("snh_ai_usage_settle", {
      p_call_id: reservation.id, p_cost_usd: actualCost,
      p_input_tokens: usage ? usedInput : 0, p_output_tokens: usage ? usedOutput : 0,
      p_succeeded: succeeded,
    });
    if (error) throw new Error("AI usage could not be recorded. Sample generation was stopped.");
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let settled = false;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: TEMPLATE_TEST_MODEL,
        messages: [
          { role: "system", content: "Generate clearly fictional test data only. Return valid JSON and follow the requested field descriptions exactly." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxOutputTokens,
        temperature: 0.8,
      }),
    });
    const result = await response.json().catch(() => ({}));
    const usage = result?.usage || null;
    if (!response.ok) {
      await settle(usage, false, !usage && response.status >= 500);
      settled = true;
      return { error: response.status === 429 ? "OpenAI rate or account limit reached. Use the example values or try again later."
        : response.status === 401 || response.status === 403 ? "OpenAI authentication failed. Check the server configuration."
        : "Could not generate sample data. Use the example values or try again.", status: 502 };
    }
    const raw = result?.choices?.[0]?.message?.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    const values: Record<string, string> = {};
    for (const field of definition.fields) {
      const value = parsed?.[field.key];
      if (typeof value !== "string" || !value.trim() || value.length > 100) {
        await settle(usage, false, !usage); settled = true;
        return { error: "The sample generator returned unusable data. Use the example values or try again.", status: 502 };
      }
      values[field.key] = value.trim();
    }
    if (definition.fields.some((field) => field.exampleEmail && !/^[^\s@]+@example\.com$/i.test(values[field.key] || ""))) {
      await settle(usage, false, !usage); settled = true;
      return { error: "The sample generator returned an email outside the reserved example.com domain. Use the example values or try again.", status: 502 };
    }
    await settle(usage, true, !usage); settled = true;
    return { values };
  } catch {
    if (!settled) {
      try { await settle(null, false, true); } catch { /* Keep an unsettled reservation counted. */ }
    }
    return { error: controller.signal.aborted ? "Sample generation timed out. Use the example values or try again." : "Could not generate sample data. Use the example values or try again.", status: 502 };
  } finally { clearTimeout(timeout); }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const bearer = req.headers.get("Authorization") || "";
    if (!bearer.startsWith("Bearer ")) return json({ error: "Sign in required" }, 401);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const db = createClient(url, serviceKey(), { auth: { persistSession: false } });
    const { data: auth, error } = await db.auth.getUser(bearer.slice(7));
    if (error || !auth.user) return json({ error: "Invalid session" }, 401);
    const roles = await db.from("members").select("id,member_roles!inner(role_slug)")
      .eq("user_id", auth.user.id).eq("member_roles.role_slug", "club_admin").limit(1);
    if (roles.error || !roles.data?.length) return json({ error: "Club administrator access required" }, 403);
    const body = await req.json();
    const { action } = body;
    const token = (Deno.env.get("MATCHPLAY_API_TOKEN") || "").trim();
    if (action === "configuration") return json({
      providers: [
        { provider: "opdb", configured: Boolean(Deno.env.get("OPDB_REFERENCE_SYNC_SCHEDULER_SECRET")), test_supported: false,
          note: "Weekly validated V2 archive and IPDB crosswalk. Run history and freshness are in Jobs.",
          scheduler_configured: Boolean(Deno.env.get("OPDB_REFERENCE_SYNC_SCHEDULER_SECRET")) },
        { provider: "ipdb", configured: Boolean(Deno.env.get("IPDB_REFERENCE_SYNC_SCHEDULER_SECRET")), test_supported: false,
          note: "Monthly checked JSON reference archive for AI enrichment. Jobs shows the IPDB refresh date and import status.",
          scheduler_configured: Boolean(Deno.env.get("IPDB_REFERENCE_SYNC_SCHEDULER_SECRET")) },
        { provider: "kineticist", configured: true, test_supported: false,
          note: "On-demand game lookup by exact OPDB ID. Game responses are cached for 24 hours." },
        { provider: "pintips", configured: Boolean(Deno.env.get("PINTIPS_IMPORT_SCHEDULER_SECRET")), test_supported: false, note: "Daily export import. Manual refresh is in Games; counts are in Jobs." },
        { provider: "matchplay", configured: Boolean(token), test_supported: true },
        { provider: "ifpa", configured: null, test_supported: false, note: "Adapter not connected" },
        { provider: "pinballmap", configured: Boolean(Deno.env.get("PINBALLMAP_API_TOKEN")), test_supported: false,
          note: "Imports club activity and machine details. Run history and manual import are in Jobs.",
          scheduler_configured: Boolean(Deno.env.get("PINBALLMAP_INGEST_SCHEDULER_SECRET")) },
      ],
      dispatcher: { configured: Boolean(Deno.env.get("NOTIFICATION_DISPATCH_SECRET")),
        mode: Deno.env.get("NOTIFICATION_DELIVERY_MODE") || "preview",
        live_per_run_limit: 10, live_rolling_24h_limit: 10,
        is_staging: new URL(url).hostname === "eptbdrwmcwogxcjleudv.supabase.co",
        preview_email_configured: Boolean(Deno.env.get("NOTIFICATION_TEST_EMAIL") && Deno.env.get("RESEND_API_KEY") && Deno.env.get("NOTIFICATION_FROM")) },
      email_template_test: {
        configured: Boolean(Deno.env.get("NOTIFICATION_TEST_EMAIL") && Deno.env.get("RESEND_API_KEY") && Deno.env.get("NOTIFICATION_FROM")),
        ai_sample_configured: Boolean(Deno.env.get("OPENAI_PLATFORM_KEY")),
        templates: Object.values(EMAIL_TEMPLATE_TESTS).map((item) => ({
          alias: item.alias, name: item.name, description: item.description,
          fields: item.fields.map(({ key, label, description, sample }) => ({ key, label, description, sample })),
        })),
      },
    });
    if (action === "set_ai_usage_budget") {
      const monthlyLimitUsd = Number(body.monthlyLimitUsd);
      if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 100) {
        return json({ error: "Choose a monthly AI limit from $0 to $100." }, 400);
      }
      const userDb = createClient(url, serviceKey(), {
        global: { headers: { Authorization: bearer } },
        auth: { persistSession: false },
      });
      const { error: budgetError } = await userDb.rpc("snh_ai_usage_set_budget", { p_limit_usd: monthlyLimitUsd });
      if (budgetError) return json({ error: "Could not update the AI spending limit." }, 503);
      return json({ ok: true, message: "Monthly AI spending limit updated." });
    }
    if (action === "run_opdb_reference_sync") {
      const schedulerSecret = Deno.env.get("OPDB_REFERENCE_SYNC_SCHEDULER_SECRET") || "";
      const serviceRoleKey = serviceKey();
      if (!schedulerSecret || !serviceRoleKey) return json({ error: "OPDB reference sync is not configured." }, 409);
      try {
        const response = await fetch(`${url.replace(/\/+$/, "")}/functions/v1/opdb-reference-sync`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(290_000),
          headers: {
            "Content-Type": "application/json",
            "apikey": serviceRoleKey,
            "Authorization": `Bearer ${serviceRoleKey}`,
            "x-opdb-reference-sync-secret": schedulerSecret,
          },
          body: "{}",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) return json({ error: result.error || "OPDB refresh failed. Check Jobs for its safe error summary." }, response.status);
        return json(result);
      } catch {
        return json({ error: "OPDB refresh timed out or could not be reached. Check Jobs before retrying." }, 503);
      }
    }
    if (action === "run_ipdb_reference_sync") {
      const schedulerSecret = Deno.env.get("IPDB_REFERENCE_SYNC_SCHEDULER_SECRET") || "";
      const serviceRoleKey = serviceKey();
      if (!schedulerSecret || !serviceRoleKey) return json({ error: "IPDB reference sync is not configured." }, 409);
      try {
        const response = await fetch(`${url.replace(/\/+$/, "")}/functions/v1/ipdb-reference-sync`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(290_000),
          headers: {
            "Content-Type": "application/json",
            "apikey": serviceRoleKey,
            "Authorization": `Bearer ${serviceRoleKey}`,
            "x-ipdb-reference-sync-secret": schedulerSecret,
          },
          body: "{}",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) return json({ error: result.error || "IPDB refresh failed. Check Jobs for its safe error summary." }, response.status);
        return json({ ok: true, message: result.unchanged ? "IPDB export is unchanged; no download was needed." : "IPDB reference archive refreshed." });
      } catch {
        return json({ error: "IPDB refresh timed out or could not be reached. Check Jobs before retrying." }, 503);
      }
    }
    if (action === "generate_email_template_sample") {
      const alias = typeof body.alias === "string" ? body.alias : "";
      const result = await generateEmailTemplateSample(db, alias);
      if (result.error) return json({ error: result.error }, result.status || 502);
      return json({ values: result.values });
    }
    if (action === "send_email_template_test") {
      const alias = typeof body.alias === "string" ? body.alias : "";
      const definition = EMAIL_TEMPLATE_TESTS[alias];
      if (!definition) return json({ error: "Choose a supported email template." }, 400);
      const testEmail = (Deno.env.get("NOTIFICATION_TEST_EMAIL") || "").trim();
      const resendKey = Deno.env.get("RESEND_API_KEY") || "";
      const from = (Deno.env.get("NOTIFICATION_FROM") || "").trim();
      if (!testEmail || !resendKey || !from) return json({ error: "Template testing is unavailable until the test inbox, sender, and Resend key are configured." }, 409);
      const incoming = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? body.variables as Record<string, unknown> : {};
      const values: Record<string, string> = {};
      for (const field of definition.fields) {
        const raw = incoming[field.key];
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value || value.length > 100) return json({ error: "Enter a value of 1 to 100 characters for " + field.label + "." }, 400);
        values[field.key] = value;
      }
      if (definition.fields.some((field) => field.exampleEmail && !/^[^\s@]+@example\.com$/i.test(values[field.key] || ""))) {
        return json({ error: "Sample email values must use the reserved example.com domain." }, 400);
      }
      const userDb = createClient(url, serviceKey(), { global: { headers: { Authorization: bearer } }, auth: { persistSession: false } });
      const audit = await userDb.rpc("snh_operations_template_test_request", {
        p_template_alias: alias, p_ai_sample_used: body.aiSampleUsed === true,
      });
      if (audit.error) return json({ error: "Could not record the email test request." }, 503);
      const staging = new URL(url).hostname === "eptbdrwmcwogxcjleudv.supabase.co";
      const template = templateTestTemplateData(definition, values, staging);
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: "Bearer " + resendKey,
            "Content-Type": "application/json",
            "Idempotency-Key": "template-test-" + crypto.randomUUID(),
          },
          body: JSON.stringify({ from, to: [testEmail], template }),
        });
        if (!response.ok) return json({ error: "Resend could not accept this template test. Check the template and sender configuration." }, 502);
        return json({ ok: true, message: "Template test sent to the configured test inbox. No notification was queued." });
      } catch {
        return json({ error: "Template test timed out or could not be reached. Check Resend logs before retrying." }, 503);
      }
    }
    if (action === "test_matchplay") {
      if (!token) return json({ error: "Match Play is not configured" }, 409);
      const started = Date.now();
      const id = { provider: "matchplay", resource_type: "connection_test" };
      const attempt = await db.from("integration_status").upsert({ ...id, last_attempt_at: new Date(started).toISOString() });
      if (attempt.error) return json({ error: "Could not record connection test" }, 503);
      let ok = false;
      try { const payload = await getMatchplay("users/profile", token); ok = Boolean(payload?.data?.userId || payload?.userId); }
      catch { /* Return only a fixed safe summary, never a provider response. */ }
      const completed = new Date().toISOString();
      const status = await db.from("integration_status").upsert({ ...id, latency_ms: Date.now() - started,
        ...(ok ? { last_success_at: completed } : { last_error_at: completed, last_error: "Connection test failed" }) });
      if (status.error) return json({ error: "Could not record connection test result" }, 503);
      return json({ ok, message: ok ? "Connection successful" : "Connection test failed. Check provider configuration." });
    }
    if (action === "clear_staging_notification_queue") {
      if (new URL(url).hostname !== "eptbdrwmcwogxcjleudv.supabase.co") {
        return json({ error: "Queue clearing is available only in staging." }, 409);
      }
      const cleared = await db.rpc("snh_operations_clear_staging_notifications", {
        p_actor_user_id: auth.user.id,
      });
      if (cleared.error) return json({ error: "Could not clear staging notification queue." }, 503);
      const count = Number(cleared.data);
      if (!Number.isSafeInteger(count) || count < 0) return json({ error: "Invalid queue cleanup result." }, 503);
      return json({ ok: true, count, message: "Canceled " + count + " pending staging notification" + (count === 1 ? "." : "s.") });
    }
    if (action === "send_notification_preview") {
      if (new URL(url).hostname !== "eptbdrwmcwogxcjleudv.supabase.co") {
        return json({ error: "Queued-message preview sending is available only in staging." }, 409);
      }
      const notificationId = body.notificationId;
      if (typeof notificationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notificationId)) {
        return json({ error: "A valid queued message ID is required." }, 400);
      }
      const secret = Deno.env.get("NOTIFICATION_DISPATCH_SECRET");
      if (!secret) return json({ error: "Dispatcher is not configured." }, 409);
      const userDb = createClient(url, serviceKey(), { global: { headers: { Authorization: bearer } }, auth: { persistSession: false } });
      const audit = await userDb.rpc("snh_operations_notification_preview_request", { p_id: notificationId });
      if (audit.error) return json({ error: "Only a pending message can be previewed." }, 409);
      try {
        const response = await fetch(`${url.replace(/\/+$/, "")}/functions/v1/notification-dispatch`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
          headers: { "Content-Type": "application/json", "x-notification-secret": secret },
          body: JSON.stringify({ action: "send_preview", notification_id: notificationId }),
        });
        if (!response.ok) return json({ error: "Could not send staging preview. Check Resend configuration and dispatcher logs." }, response.status);
        const result = await response.json().catch(() => ({}));
        if (result.sent !== true) return json({ error: "Staging preview was not sent. Check Resend configuration and dispatcher logs." }, 502);
        return json({ ok: true, message: "Preview sent to the configured staging test inbox. The queued message remains pending." });
      } catch {
        return json({ error: "Staging preview timed out or could not be reached. Check Resend logs before retrying." }, 503);
      }
    }
    if (action === "dispatch") {
      const secret = Deno.env.get("NOTIFICATION_DISPATCH_SECRET");
      if (!secret) return json({ error: "Dispatcher is not configured" }, 409);
      // User-scoped RPC records the authenticated actor before any mail can be sent.
      const userDb = createClient(url, serviceKey(), { global: { headers: { Authorization: bearer } }, auth: { persistSession: false } });
      const audit = await userDb.rpc("snh_operations_dispatch_request");
      if (audit.error) return json({ error: "Could not audit dispatch request" }, 503);
      const response = await fetch(`${url}/functions/v1/notification-dispatch`, {
        method: "POST", headers: { "x-notification-secret": secret }, signal: AbortSignal.timeout(60000),
      });
      // Whitelist only delivery counts and mode; never forward preview content.
      const result = await response.json();
      const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
      const message = !response.ok ? "Dispatcher failed. See Jobs for the recorded error."
        : result.mode === "preview" ? "Preview completed. No messages were sent."
        : result.mode === "test" ? (result.sent ? "Test message sent to the configured test inbox. The queue was not consumed." : "Test completed. No message was sent; the queue is empty.")
        : result.mode === "live" ? `Dispatch completed: ${count(result.sent)} sent, ${count(result.failed)} failed, ${count(result.canceled)} canceled.`
        : "Dispatcher completed. See Jobs for the result.";
      return json({ ok: response.ok && !count(result.failed), message });
    }
    return json({ error: "Unknown operation" }, 400);
  } catch { return json({ error: "Operation could not be completed. Refresh Jobs before running again." }, 500); }
});
