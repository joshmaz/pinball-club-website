import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { importOpdbImages } from "../_shared/opdb-images.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function resolveElevatedApiKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const defaultKey = parsed.default;
      if (typeof defaultKey === "string" && defaultKey.trim()) return defaultKey.trim();
      const values = Object.values(parsed);
      const key = values.find((value) => typeof value === "string" && value.trim());
      if (typeof key === "string") return key.trim();
    } catch {
      // Fall through to the legacy key.
    }
  }
  return (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim() || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
    const elevatedKey = resolveElevatedApiKey();
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!supabaseUrl || !elevatedKey) throw new Error("Missing Supabase Edge Function configuration");
    if (!jwt) return json({ ok: false, error: "Missing bearer token" }, 401);

    const admin = createClient(supabaseUrl, elevatedKey, { auth: { persistSession: false } });
    const authResult = await admin.auth.getUser(jwt);
    const user = authResult.data.user;
    if (authResult.error || !user) return json({ ok: false, error: "Invalid auth token" }, 401);

    const roles = await admin
      .from("members")
      .select("id,member_roles!inner(role_slug)")
      .eq("user_id", user.id)
      .in("member_roles.role_slug", ["games_editor", "games_admin", "club_admin"])
      .limit(1);
    if (roles.error || !(roles.data || []).length) {
      return json({ ok: false, error: "Not authorized for game image sync" }, 403);
    }

    const body = await req.json() as { gameId?: string };
    if (!body.gameId) return json({ ok: false, error: "gameId is required" }, 400);
    const game = await admin
      .from("games")
      .select("id,opdb_id")
      .eq("id", body.gameId)
      .is("deleted_at", null)
      .maybeSingle();
    if (game.error) throw new Error(game.error.message);
    if (!game.data) return json({ ok: false, error: "Game not found" }, 404);
    if (!game.data.opdb_id) return json({ ok: false, error: "Game has no OPDB id" }, 400);

    const result = await importOpdbImages(admin, [String(game.data.opdb_id)]);
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
