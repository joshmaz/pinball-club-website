import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    if (Number(req.headers.get("Content-Length") || 0) > 8192) return json({ error: "Request too large" }, 413);
    const text = await req.text();
    if (text.length > 8192) return json({ error: "Request too large" }, 413);
    const body = JSON.parse(text);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const db = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    // A random receipt is a short-lived capability for a boolean outcome only.
    // It is deliberately usable after the caller's own Auth user has been deleted.
    if (body.action === "status") {
      if (!uuid.test(body.receipt || "")) return json({ error: "Invalid receipt" }, 400);
      const result = await db.rpc("snh_account_deletion_request", { p_receipt: body.receipt });
      if (result.error || !result.data) return json({ error: "Confirmation unavailable. Contact support if needed." }, 404);
      return json({ ok: true, completed: result.data.completed === true });
    }
    const bearer = req.headers.get("Authorization") || "";
    if (!bearer.startsWith("Bearer ")) return json({ error: "Sign in required" }, 401);
    const { data, error } = await db.auth.getUser(bearer.slice(7));
    if (error || !data.user) return json({ error: "Please sign in again" }, 401);
    const actor = data.user;
    // No billing provider is connected today. Fail closed if configuration changes
    // until a provider adapter can confirm cancellation of further recurring charges.
    if ((Deno.env.get("ACCOUNT_DELETION_BILLING_MODE") || "manual") !== "manual") {
      return json({ error: "Subscription cancellation needs staff assistance before deletion." }, 409);
    }
    if (body.action === "prepare") {
      if (body.billingAcknowledged !== true || body.confirmation !== "DELETE") {
        return json({ error: "Confirm deletion and acknowledge the payment reminder" }, 400);
      }
      if (body.memberId != null && !uuid.test(body.memberId)) return json({ error: "Invalid member" }, 400);
      if (typeof body.password !== "string" || !body.password || body.password.length > 1024) {
        return json({ error: "Your current password is required" }, 400);
      }
      // Never accept an email or actor ID supplied by the browser. Reauthenticate
      // the verified caller with a separate, non-persisted client.
      const reauth = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
      const fresh = await reauth.auth.signInWithPassword({ email: actor.email || "", password: body.password });
      if (fresh.error || fresh.data.user?.id !== actor.id) return json({ error: "Current password could not be verified" }, 403);
      await reauth.auth.signOut({ scope: "local" });
      // If MFA is configured, an existing AAL2 session is also required.
      const claims = JSON.parse(atob(bearer.slice(7).split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
      if (actor.factors?.some(f => f.status === "verified") && claims.aal !== "aal2") {
        return json({ error: "Complete two-factor sign-in before deleting an account" }, 403);
      }
      const self = body.memberId == null;
      const reason = self ? "Self-service account deletion" : typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason || reason.length > 250) return json({ error: "Enter a reason of up to 250 characters" }, 400);
      const prepared = await db.rpc("snh_prepare_account_deletion", { p_actor: actor.id,
        p_member_id: body.memberId || null, p_reason: reason });
      if (prepared.error) return json({ error: "Deletion is not permitted. Protected administrators need another Website Administrator." }, 403);
      return json({ ok: true, receipt: prepared.data });
    }
    if (body.action === "delete") {
      if (!uuid.test(body.receipt || "")) return json({ error: "Invalid receipt" }, 400);
      const active = await db.rpc("snh_activate_account_deletion", { p_receipt: body.receipt, p_actor: actor.id });
      if (active.error || !active.data) return json({ error: "Confirmation expired or permissions changed. Start again." }, 403);
      // Storage ownership is checked again for each target, not assumed from the
      // initial inventory. Storage API errors roll back Auth deletion safely.
      const deletion = await db.auth.admin.deleteUser(active.data, false);
      const outcome = await db.rpc("snh_account_deletion_request", { p_receipt: body.receipt });
      if (!outcome.error && outcome.data?.completed === true) return json({ ok: true, completed: true });
      if (deletion.error) return json({ error: "Account was not deleted. Check its status before retrying; contact support if this continues." }, 409);
      return json({ error: "Could not confirm completion. Check deletion status." }, 503);
    }
    return json({ error: "Unknown action" }, 400);
  } catch { return json({ error: "Could not confirm deletion. Check deletion status before retrying." }, 503); }
});
