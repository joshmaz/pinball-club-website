import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { authorizeIngest, ingestMethodResponse } from "../pinballmap-ingest/auth.ts";
import { downloadTips } from "./provider.mjs";

const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
function serviceKey() {
  try { const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default; if (key) return key; }
  catch { /* Legacy key fallback. */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
Deno.serve(async req => {
  const method = ingestMethodResponse(req);
  if (method) return method;
  const db = createClient(Deno.env.get("SUPABASE_URL") || "", serviceKey(), { auth: { persistSession: false } });
  // Reuse the verified-token and timing-safe scheduler authorization implementation,
  // with this integration's own header/secret and a stricter admin capability.
  const auth = await authorizeIngest(req, {
    schedulerHeader: "x-pintips-scheduler-secret",
    schedulerSecret: Deno.env.get("PINTIPS_IMPORT_SCHEDULER_SECRET"),
    getUser: async token => {
      const { data, error } = await db.auth.getUser(token);
      if (error) return null;
      return data.user?.id || null;
    },
    hasGamesAccess: async () => {
      const userDb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_ANON_KEY") || "", {
        global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false },
      });
      const { data, error } = await userDb.rpc("snh_member_has_games_admin_access");
      if (error) throw error;
      return data === true;
    },
  });
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const start = await db.rpc("snh_pintips_begin", { p_actor: auth.manualActorUserId });
  if (start.error) return json({ ok: false, error: "Could not start refresh. Check the PinTips migration and Operations jobs." }, 503);
  if (!start.data) return json({ ok: false, error: "A refresh is running or was just requested. Wait a minute before retrying." }, 409);
  const runId = start.data;
  let failure = "PinTips download failed. Check CDN availability and retry.";
  try {
    const rows = await downloadTips();
    failure = "PinTips database import failed. Check the migration and database health, then retry. Previous tips are unchanged.";
    const result = await db.rpc("snh_pintips_finish", { p_run: runId, p_tips: rows });
    if (result.error) throw new Error(failure);
    return json({ ok: true, ...result.data });
  } catch (error) {
    // Provider messages contain only our fixed diagnostics, never remote bodies or credentials.
    if (failure.startsWith("PinTips download") && error instanceof Error) failure = error.message;
    const recorded = await db.rpc("snh_pintips_fail", { p_run: runId, p_error: failure });
    if (recorded.error) failure += " Could not record completion; check the running job in Operations.";
    return json({ ok: false, error: failure }, 503);
  }
});
