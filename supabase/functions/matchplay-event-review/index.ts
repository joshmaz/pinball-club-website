import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { rankEventCandidates, tournamentIdFromInput } from "./match.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function elevatedKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch { /* use legacy key */ }
  }
  return (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const bearer = req.headers.get("Authorization") || "";
    const jwt = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    if (!jwt) return json({ error: "Sign in to review MatchPlay events" }, 401);
    const body = await req.json() as { tournament?: string };
    const tournamentId = tournamentIdFromInput(body?.tournament);
    if (!tournamentId) return json({ error: "Enter a MatchPlay tournament URL or ID" }, 400);

    const url = (Deno.env.get("SUPABASE_URL") || "").trim();
    const key = elevatedKey();
    if (!url || !key) throw new Error("Supabase function is not configured");
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const auth = await admin.auth.getUser(jwt);
    if (auth.error || !auth.data.user) return json({ error: "Invalid session" }, 401);
    const roles = await admin.from("members")
      .select("id,member_roles!inner(role_slug)")
      .eq("user_id", auth.data.user.id)
      .in("member_roles.role_slug", ["events_editor", "events_admin", "club_admin"])
      .limit(1);
    if (roles.error) throw new Error("Could not check event editor access");
    if (!roles.data?.length) return json({ error: "Event editor access required" }, 403);

    const token = (Deno.env.get("MATCHPLAY_API_TOKEN") || "").trim();
    if (!token) return json({ error: "MatchPlay API token is not configured" }, 503);
    const response = await fetch(`https://app.matchplay.events/api/tournaments/${tournamentId}?includeLocation=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return json({ error: `MatchPlay request failed (${response.status})` }, 502);
    const payload = await response.json() as { data?: Record<string, unknown> };
    const data = payload.data || {};
    if (String(data.tournamentId || "") !== tournamentId) {
      return json({ error: "MatchPlay returned an unexpected tournament" }, 502);
    }
    const startsAt = typeof data.startUtc === "string" && Number.isFinite(Date.parse(data.startUtc))
      ? new Date(data.startUtc).toISOString() : null;
    const location = data.location && typeof data.location === "object"
      ? String((data.location as Record<string, unknown>).name || "") : "";
    const tournament = {
      id: tournamentId,
      title: String(data.name || "").slice(0, 300),
      starts_at: startsAt,
      location: location.slice(0, 300),
      description: typeof data.description === "string" ? data.description.slice(0, 5000) : "",
      url: `https://app.matchplay.events/tournaments/${tournamentId}`,
      status: String(data.status || ""),
      series_id: data.seriesId ?? null,
    };

    const seen = new Map<string, Record<string, unknown>>();
    if (startsAt) {
      const startMs = Date.parse(startsAt);
      const nearby = await admin.from("events")
        .select("id,title,description,location,starts_at,external_url,source,published")
        .gte("starts_at", new Date(startMs - 36 * 3600000).toISOString())
        .lte("starts_at", new Date(startMs + 36 * 3600000).toISOString())
        .limit(200);
      if (nearby.error) throw new Error("Could not read club events");
      for (const event of nearby.data || []) seen.set(String(event.id), event);
    }
    const linked = await admin.from("events")
      .select("id,title,description,location,starts_at,external_url,source,published")
      .eq("external_url", tournament.url).limit(20);
    if (linked.error) throw new Error("Could not read linked club events");
    for (const event of linked.data || []) seen.set(String(event.id), event);

    return json({ tournament, candidates: rankEventCandidates(tournament, [...seen.values()]) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "MatchPlay review failed" }, 500);
  }
});
