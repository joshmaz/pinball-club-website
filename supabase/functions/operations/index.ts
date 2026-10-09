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
    const { action } = await req.json();
    const token = (Deno.env.get("MATCHPLAY_API_TOKEN") || "").trim();
    if (action === "configuration") return json({
      providers: [
        { provider: "pintips", configured: Boolean(Deno.env.get("PINTIPS_IMPORT_SCHEDULER_SECRET")), test_supported: false, note: "Daily export import. Manual refresh is in Games; counts are in Jobs." },
        { provider: "matchplay", configured: Boolean(token), test_supported: true },
        { provider: "ifpa", configured: null, test_supported: false, note: "Adapter not connected" },
        { provider: "pinballmap", configured: true, test_supported: false, note: "Public API; ingestion health is not instrumented yet" },
      ],
      dispatcher: { configured: Boolean(Deno.env.get("NOTIFICATION_DISPATCH_SECRET")),
        mode: Deno.env.get("NOTIFICATION_DELIVERY_MODE") || "preview" },
    });
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
