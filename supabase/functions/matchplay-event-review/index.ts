import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { createMatchplayCache } from "./cache.mjs";
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

function positiveId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^[1-9]\d{0,9}$/.test(text) ? text : "";
}

function normalizedTournament(row: Record<string, unknown>, fallbackId?: string) {
  const id = positiveId(row.tournamentId) || positiveId(fallbackId);
  const location = row.location && typeof row.location === "object" ? row.location as Record<string, unknown> : {};
  const organizer = row.organizer && typeof row.organizer === "object" ? row.organizer as Record<string, unknown> : {};
  const series = row.series && typeof row.series === "object" ? row.series as Record<string, unknown> : {};
  return {
    id,
    title: String(row.name || "").slice(0, 300),
    starts_at: typeof row.startUtc === "string" && Number.isFinite(Date.parse(row.startUtc)) ? new Date(row.startUtc).toISOString() : null,
    location: String(location.name || "").slice(0, 300),
    description: typeof row.description === "string" ? row.description.slice(0, 4000) : "",
    matchplay_format: String(row.type || "").slice(0, 120),
    url: id ? `https://app.matchplay.events/tournaments/${id}` : "",
    status: String(row.status || "").slice(0, 40),
    organizer_id: positiveId(row.organizerId),
    organizer_name: String(organizer.name || "").slice(0, 100),
    series_id: positiveId(row.seriesId),
    series_name: String(series.name || "").slice(0, 120),
    updated_at: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
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
    let userClient: ReturnType<typeof createClient>;
    try {
      const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
      if (!anonKey) return json({ error: "Authentication check failed" }, 500);
      userClient = createClient(url, anonKey, {
        global: { headers: { Authorization: bearer } },
        auth: { persistSession: false },
      });
      const auth = await userClient.auth.getUser(jwt);
      if (auth.error || !auth.data.user) return json({ error: "Invalid session" }, 401);
    } catch {
      return json({ error: "Authentication check failed" }, 500);
    }
    try {
      const { data: allowed, error } = await userClient.rpc("snh_member_has_events_access");
      if (error) return json({ error: "Could not check event editor access" }, 500);
      if (allowed !== true) return json({ error: "Event editor access required" }, 403);
    } catch {
      return json({ error: "Could not check event editor access" }, 500);
    }

    const admin = createClient(url, key, { auth: { persistSession: false } });
    const token = (Deno.env.get("MATCHPLAY_API_TOKEN") || "").trim();
    if (!token) return json({ error: "MatchPlay API token is not configured" }, 503);
    const getCached = createMatchplayCache(admin, token);
    if (body.mode === "scan") {
      const { data: storedEvents, error: eventsError } = await admin.from("events")
        .select("id,title,description,location,starts_at,ends_at,all_day,time_known,previous_schedule,reschedule_note,external_url,external_links,source,published,lifecycle_status,matchplay_format")
        .limit(500);
      if (eventsError) throw new Error("Could not read club events");
      const now = Date.now();
      const localEvents = (storedEvents || []).filter((event) => {
        if (event.lifecycle_status === "canceled" || !event.starts_at) return false;
        const start = Date.parse(String(event.starts_at));
        const end = event.ends_at ? Date.parse(String(event.ends_at)) : start;
        return Number.isFinite(start) && (end >= now || start >= now - 24 * 60 * 60 * 1000);
      });
      const byId = new Map<string, Record<string, unknown>>();
      for (const event of localEvents) {
        const links = [event.external_url, ...(Array.isArray(event.external_links) ? (event.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
        for (const link of links) {
          const id = tournamentIdFromInput(String(link || ""));
          if (id) byId.set(id, event);
        }
      }
      const discovered = new Map<string, Record<string, unknown>>();
      const searchQueries = ["SNHPC", "Southern New Hampshire Pinball Club"];
      const cacheStates: unknown[] = [];
      for (const query of searchQueries) {
        const { payload, cache } = await getCached(`search?query=${encodeURIComponent(query)}&type=tournaments&page=1`);
        cacheStates.push(cache);
        for (const item of Array.isArray(payload?.data) ? payload.data : []) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          const id = positiveId(row.tournamentId);
          const name = String(row.name || "");
          if (id && /snhpc|southern new hampshire pinball club/i.test(name)) discovered.set(id, row);
        }
      }
      for (const id of byId.keys()) {
        if (discovered.has(id)) continue;
        const { payload, cache } = await getCached(`tournaments/${id}?includeLocation=1`);
        cacheStates.push(cache);
        if (payload?.data && typeof payload.data === "object") discovered.set(id, payload.data as Record<string, unknown>);
      }
      const additions: ReturnType<typeof normalizedTournament>[] = [];
      const updates: Array<Record<string, unknown>> = [];
      const possibleMatches: Array<Record<string, unknown>> = [];
      let unchanged = 0;
      for (const [id, row] of discovered) {
        const tournament = normalizedTournament(row, id);
        if (!tournament.id) continue;
        let event = byId.get(id);
        let matchLabel = event ? "Match Play link" : "";
        if (!event) {
          const candidates = rankEventCandidates(tournament, localEvents as Array<Record<string, unknown>>);
          if (candidates.length > 1) {
            possibleMatches.push({ tournament, candidates: candidates.slice(0, 3).map(candidate => ({ id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, match: candidate.match })) });
            continue;
          }
          if (candidates.length === 1) {
            event = localEvents.find(candidate => String(candidate.id) === String(candidates[0].id));
            matchLabel = candidates[0].match.confidence;
          }
        }
        if (!event) { additions.push(tournament); continue; }
        const changes: Array<{ field: string; label: string; current: unknown; proposed: unknown }> = [];
        const compare = (field: string, label: string, incoming: unknown) => {
          if (incoming == null || String(incoming).trim() === "") return;
          const current = (event as Record<string, unknown>)[field];
          const oldValue = current == null ? "" : String(current).trim();
          const newValue = String(incoming).trim();
          let same = oldValue === newValue;
          if (field === "starts_at" && current != null) {
            const currentMs = Date.parse(oldValue);
            const proposedMs = Date.parse(newValue);
            if (Number.isFinite(currentMs) && Number.isFinite(proposedMs)) {
              // The review displays event times to the minute; ignore hidden seconds.
              same = Math.floor(currentMs / 60000) === Math.floor(proposedMs / 60000);
            }
          }
          if (!same) changes.push({ field, label, current: current ?? "", proposed: incoming });
        };
        compare("title", "Title", tournament.title);
        compare("starts_at", "Date and time", tournament.starts_at);
        compare("location", "Location", tournament.location);
        compare("description", "Description", tournament.description);
        compare("matchplay_format", "Tournament format", tournament.matchplay_format);
        const eventLinks = Array.isArray(event.external_links) ? event.external_links as Array<Record<string, unknown>> : [];
        if (!eventLinks.some(link => link && link.url === tournament.url) && eventLinks.length < 5) {
          changes.push({ field: "external_links", label: "Match Play link", current: eventLinks, proposed: [...eventLinks, { url: tournament.url, label: "Match Play" }] });
        }
        if (changes.length) updates.push({ tournament, event: { id: event.id, title: event.title, starts_at: event.starts_at, location: event.location, description: event.description, matchplay_format: event.matchplay_format, external_links: event.external_links, source: event.source, published: event.published, all_day: event.all_day, time_known: event.time_known, ends_at: event.ends_at, previous_schedule: event.previous_schedule, reschedule_note: event.reschedule_note, lifecycle_status: event.lifecycle_status }, match: matchLabel, changes });
        else unchanged += 1;
      }
      return json({ scanned_at: new Date().toISOString(), cache: cacheStates, additions, updates, possible_matches: possibleMatches, unchanged });
    }

    if (body.mode === "discover") {
      const scope = String(body.scope || "");
      const value = String(body.value || "").trim();
      const page = Number.isInteger(body.page) && Number(body.page) >= 1 && Number(body.page) <= 1000
        ? Number(body.page) : 1;
      let path = "";
      let ownerLabel = "";
      if (scope === "mine") {
        const { payload: profile } = await getCached("users/profile");
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
      const { payload: listing, cache } = await getCached(path);
      const rows = Array.isArray(listing.data) ? listing.data : [];
      const links = listing.links && typeof listing.links === "object"
        ? listing.links as Record<string, unknown> : {};
      return json({
        cache,
        owner_label: ownerLabel,
        page,
        has_next: !!links.next,
        has_previous: page > 1,
        tournaments: rows.slice(0, 10).map((entry) => {
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
    const { payload, cache } = await getCached(`tournaments/${tournamentId}?includeLocation=1`);
    const data = payload?.data || {};
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
      matchplay_format: String(data.type || "").slice(0, 120),
      organizer_id: positiveId(data.organizerId),
      organizer_name: String((data.organizer && typeof data.organizer === "object" ? (data.organizer as Record<string, unknown>).name : "") || "").slice(0, 100),
      series_id: data.seriesId ?? null,
      series_name: String((data.series && typeof data.series === "object" ? (data.series as Record<string, unknown>).name : "") || "").slice(0, 120),
      updated_at: typeof data.updatedAt === "string" ? data.updatedAt : null,
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
      // The column is JSONB; an array argument is serialized as a PostgreSQL array.
      .contains("external_links", JSON.stringify([{ url: tournament.url }])).limit(20);
    if (linked.error) throw new Error("Could not read linked club events");
    for (const event of linked.data || []) seen.set(String(event.id), event);

    return json({ tournament, cache, candidates: rankEventCandidates(tournament, [...seen.values()]) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MatchPlay review failed";
    return json({ error: message }, message.startsWith("MatchPlay request failed") ? 502 : 500);
  }
});
