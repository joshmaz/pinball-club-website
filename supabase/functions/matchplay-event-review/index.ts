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

async function getMatchplay(path: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://app.matchplay.events/api/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`MatchPlay request failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}

function positiveId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^[1-9]\d{0,9}$/.test(text) ? text : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const bearer = req.headers.get("Authorization") || "";
    const jwt = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    if (!jwt) return json({ error: "Sign in to review MatchPlay events" }, 401);
    const body = await req.json() as {
      tournament?: string; mode?: string; scope?: string; value?: string; page?: number;
    };

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
    if (body.mode === "discover") {
      const scope = String(body.scope || "");
      const value = String(body.value || "").trim();
      const page = Number.isInteger(body.page) && Number(body.page) >= 1 && Number(body.page) <= 1000
        ? Number(body.page) : 1;
      let path = "";
      let ownerLabel = "";
      if (scope === "mine") {
        const profile = await getMatchplay("users/profile", token);
        const ownerId = positiveId(profile.userId);
        if (!ownerId) throw new Error("MatchPlay token owner could not be identified");
        ownerLabel = String(profile.name || "MatchPlay token owner").slice(0, 100);
        path = `tournaments?owner=${ownerId}&page=${page}`;
      } else if (scope === "owner") {
        const ownerId = positiveId(value);
        if (!ownerId) return json({ error: "Enter a numeric MatchPlay organizer ID" }, 400);
        path = `tournaments?owner=${ownerId}&page=${page}`;
      } else if (scope === "series") {
        const seriesId = positiveId(value);
        if (!seriesId) return json({ error: "Enter a numeric MatchPlay series ID" }, 400);
        path = `tournaments?series=${seriesId}&page=${page}`;
      } else if (scope === "title") {
        if (value.length < 3 || value.length > 100) {
          return json({ error: "Enter 3–100 title search characters" }, 400);
        }
        path = `search?query=${encodeURIComponent(value)}&type=tournaments&page=${page}`;
      } else {
        return json({ error: "Choose a MatchPlay discovery method" }, 400);
      }
      const listing = await getMatchplay(path, token);
      const rows = Array.isArray(listing.data) ? listing.data : [];
      const links = listing.links && typeof listing.links === "object"
        ? listing.links as Record<string, unknown> : {};
      return json({
        owner_label: ownerLabel,
        page,
        has_next: !!links.next,
        has_previous: page > 1,
        tournaments: rows.slice(0, 25).map((entry) => {
          const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          const organizer = row.organizer && typeof row.organizer === "object"
            ? row.organizer as Record<string, unknown> : {};
          const id = positiveId(row.tournamentId);
          return {
            id,
            title: String(row.name || "").slice(0, 300),
            starts_at: typeof row.startUtc === "string" ? row.startUtc : null,
            status: String(row.status || "").slice(0, 40),
            organizer_id: positiveId(row.organizerId),
            organizer_name: String(organizer.name || "").slice(0, 100),
            series_id: positiveId(row.seriesId),
            url: id ? `https://app.matchplay.events/tournaments/${id}` : "",
          };
        }).filter((row) => row.id),
      });
    }

    const tournamentId = tournamentIdFromInput(body?.tournament);
    if (!tournamentId) return json({ error: "Enter a MatchPlay tournament URL or ID" }, 400);
    const payload = await getMatchplay(`tournaments/${tournamentId}?includeLocation=1`, token) as {
      data?: Record<string, unknown>;
    };
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
        .select("id,title,description,location,starts_at,external_url,external_links,source,published")
        .gte("starts_at", new Date(startMs - 36 * 3600000).toISOString())
        .lte("starts_at", new Date(startMs + 36 * 3600000).toISOString())
        .limit(200);
      if (nearby.error) throw new Error("Could not read club events");
      for (const event of nearby.data || []) seen.set(String(event.id), event);
    }
    const linked = await admin.from("events")
      .select("id,title,description,location,starts_at,external_url,external_links,source,published")
      .contains("external_links", [{ url: tournament.url }]).limit(20);
    if (linked.error) throw new Error("Could not read linked club events");
    for (const event of linked.data || []) seen.set(String(event.id), event);

    return json({ tournament, candidates: rankEventCandidates(tournament, [...seen.values()]) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MatchPlay review failed";
    return json({ error: message }, message.startsWith("MatchPlay request failed") ? 502 : 500);
  }
});
