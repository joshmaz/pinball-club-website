import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import { createMatchplayCache } from "./cache.mjs";
import { hasConflictingMatchDates, rankEventCandidates, tournamentIdFromInput } from "./match.mjs";

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
  const seriesId = positiveId(row.seriesId) || positiveId(series.seriesId) || positiveId(series.id);
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
    series_id: seriesId,
    series_name: String(series.name || "").slice(0, 120),
    series_url: seriesId ? `https://app.matchplay.events/series/${seriesId}` : "",
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
      tournament?: string; mode?: string; scope?: string; value?: string; page?: number; cursor?: { starts_at?: string; id?: string } | null;
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
    if (body.mode === "reconcile") {
      const pageSize = 500;
      const allEvents: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin.from("events")
          .select("id,title,description,location,starts_at,ends_at,all_day,time_known,previous_schedule,reschedule_note,external_url,external_links,source,published,lifecycle_status,matchplay_format")
          .range(offset, offset + pageSize - 1);
        if (error) throw new Error("Could not read club events");
        const page = (data || []) as Array<Record<string, unknown>>;
        allEvents.push(...page);
        if (page.length < pageSize) break;
      }

      const linkedEventsById = new Map<string, Array<Record<string, unknown>>>();
      for (const event of allEvents) {
        const links = [event.external_url, ...(Array.isArray(event.external_links)
          ? (event.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
        for (const link of links) {
          const id = tournamentIdFromInput(String(link || ""));
          if (!id) continue;
          const linked = linkedEventsById.get(id) || [];
          if (!linked.some(row => String(row.id) === String(event.id))) linked.push(event);
          linkedEventsById.set(id, linked);
        }
      }

      const searchQueries = ["SNHPC", "Southern NH Pinball Club", "Southern New Hampshire Pinball Club"];
      const discovered = new Map<string, Record<string, unknown>>();
      const cacheStates: unknown[] = [];
      const warnings: string[] = [];
      let complete = true;
      let ownerScope: { id: string; name: string } | null = null;
      let ownerListingComplete = true;
      try {
        const { payload: profile, cache } = await getCached("users/profile");
        cacheStates.push(cache);
        const ownerId = positiveId(profile?.userId);
        if (!ownerId) {
          complete = false;
          ownerListingComplete = false;
          warnings.push("The MatchPlay token owner could not be identified, so the organizer inventory was not available.");
        } else {
          ownerScope = { id: ownerId, name: String(profile.name || "MatchPlay token owner").slice(0, 100) };
          let page = 1;
          for (;;) {
            try {
              const { payload: listing, cache: listingCache } = await getCached(`tournaments?owner=${ownerId}&page=${page}`);
              cacheStates.push(listingCache);
              for (const item of Array.isArray(listing?.data) ? listing.data : []) {
                if (!item || typeof item !== "object") continue;
                const row = item as Record<string, unknown>;
                const id = positiveId(row.tournamentId);
                if (id) discovered.set(id, row);
              }
              const links = listing?.links && typeof listing.links === "object"
                ? listing.links as Record<string, unknown> : {};
              if (!links.next) break;
              page += 1;
              if (page > 1000) {
                complete = false;
                ownerListingComplete = false;
                warnings.push("The MatchPlay token owner's organizer inventory exceeded 1,000 pages.");
                break;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              complete = false;
              ownerListingComplete = false;
              warnings.push(/429|too many attempts/i.test(message)
                ? "MatchPlay rate-limited the organizer inventory. The counts cover only records fetched before the limit; run it again later."
                : "The MatchPlay token owner's organizer inventory failed before all pages were read.");
              break;
            }
          }
        }
      } catch {
        complete = false;
        ownerListingComplete = false;
        warnings.push("The MatchPlay token owner could not be read, so the organizer inventory was not available.");
      }

      let titleSearchComplete = true;
      for (const query of searchQueries) {
        let page = 1;
        for (;;) {
          try {
            const { payload, cache } = await getCached(`search?query=${encodeURIComponent(query)}&type=tournaments&page=${page}`);
            cacheStates.push(cache);
            for (const item of Array.isArray(payload?.data) ? payload.data : []) {
              if (!item || typeof item !== "object") continue;
              const row = item as Record<string, unknown>;
              const id = positiveId(row.tournamentId);
              const name = String(row.name || "");
              if (id && /snhpc|southern\s+(?:new\s+hampshire|nh)\s+pinball\s+club/i.test(name)) discovered.set(id, row);
            }
            const links = payload?.links && typeof payload.links === "object"
              ? payload.links as Record<string, unknown> : {};
            if (!links.next) break;
            page += 1;
            if (page > 1000) {
              complete = false;
              titleSearchComplete = false;
              warnings.push("A MatchPlay title search exceeded 1,000 pages, so the inventory stopped before the end.");
              break;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            complete = false;
            titleSearchComplete = false;
            warnings.push(/429|too many attempts/i.test(message)
              ? "MatchPlay rate-limited the title searches. The counts cover only records fetched before the limit; run it again later."
              : "A MatchPlay title search failed before all pages were read.");
            break;
          }
        }
        if (!titleSearchComplete) break;
      }

      const updates: Array<Record<string, unknown>> = [];
      const possibleMatches: Array<Record<string, unknown>> = [];
      let linked = 0;
      let unchanged = 0;
      let noMatch = 0;
      for (const [id, row] of discovered) {
        const tournament = normalizedTournament(row, id);
        if (!tournament.id) continue;
        const exactMatches = linkedEventsById.get(id) || [];
        let event: Record<string, unknown> | undefined;
        let matchLabel = "";
        if (exactMatches.length > 1) {
          possibleMatches.push({
            tournament,
            candidates: exactMatches.slice(0, 8).map(candidate => ({
              id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, published: candidate.published,
              has_matchplay_link: true, match: { confidence: "linked URL", title_overlap: true },
            })),
          });
          linked += 1;
          continue;
        }
        if (exactMatches.length === 1) {
          event = exactMatches[0];
          linked += 1;
          if (hasConflictingMatchDates(tournament, event)) {
            possibleMatches.push({
              tournament,
              candidates: [{
                id: event.id, title: event.title, starts_at: event.starts_at, published: event.published,
                has_matchplay_link: true,
                match: { confidence: "linked URL with conflicting dates", title_overlap: false, date_conflict: true },
              }],
            });
            continue;
          }
          matchLabel = "linked URL";
        } else {
          const candidates = rankEventCandidates(tournament, allEvents);
          if (candidates.length > 1 || candidates.some(candidate => !candidate.match.title_overlap)) {
            possibleMatches.push({
              tournament,
              candidates: candidates.slice(0, 8).map(candidate => ({
                id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, published: candidate.published,
                has_matchplay_link: (() => {
                  const links = [candidate.external_url, ...(Array.isArray(candidate.external_links)
                    ? (candidate.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
                  return links.some(link => tournamentIdFromInput(String(link || "")) !== "");
                })(),
                match: candidate.match,
              })),
            });
            continue;
          }
          if (candidates.length === 1) {
            event = allEvents.find(candidate => String(candidate.id) === String(candidates[0].id));
            matchLabel = candidates[0].match.confidence;
          }
        }
        if (!event) {
          noMatch += 1;
          continue;
        }
        const changes: Array<{ field: string; label: string; current: unknown; proposed: unknown }> = [];
        const compare = (field: string, label: string, incoming: unknown) => {
          if (incoming == null || String(incoming).trim() === "") return;
          const current = event![field];
          const oldValue = current == null ? "" : String(current).trim();
          const newValue = String(incoming).trim();
          let same = oldValue === newValue;
          if (field === "starts_at" && current != null) {
            const currentMs = Date.parse(oldValue);
            const proposedMs = Date.parse(newValue);
            if (Number.isFinite(currentMs) && Number.isFinite(proposedMs)) same = Math.floor(currentMs / 60000) === Math.floor(proposedMs / 60000);
          }
          if (!same) changes.push({ field, label, current: current ?? "", proposed: incoming });
        };
        compare("title", "Title", tournament.title);
        compare("starts_at", "Date and time", tournament.starts_at);
        compare("location", "Location", tournament.location);
        compare("description", "Description", tournament.description);
        compare("matchplay_format", "Tournament format", tournament.matchplay_format);
        const eventLinks = Array.isArray(event.external_links) ? event.external_links as Array<Record<string, unknown>> : [];
        const proposedLinks = [...eventLinks];
        const addLink = (url: string, label: string) => {
          if (url && proposedLinks.length < 5 && !proposedLinks.some(link => link && link.url === url)) proposedLinks.push({ url, label });
        };
        addLink(tournament.url, "Match Play");
        addLink(tournament.series_url, "Match Play series");
        if (proposedLinks.length !== eventLinks.length) changes.push({ field: "external_links", label: "Match Play links", current: eventLinks, proposed: proposedLinks });
        if (changes.length) {
          updates.push({
            tournament,
            event: {
              id: event.id, title: event.title, starts_at: event.starts_at, location: event.location,
              description: event.description, matchplay_format: event.matchplay_format, external_links: event.external_links,
              source: event.source, published: event.published, all_day: event.all_day, time_known: event.time_known,
              ends_at: event.ends_at, previous_schedule: event.previous_schedule, reschedule_note: event.reschedule_note,
              lifecycle_status: event.lifecycle_status,
            },
            match: matchLabel,
            changes,
          });
        } else unchanged += 1;
      }
      return json({
        reconciliation: true,
        scanned_at: new Date().toISOString(),
        scope: {
          organizer: ownerScope,
          organizer_inventory_complete: ownerListingComplete,
          searches: searchQueries,
          pagination: "all available pages",
        },
        complete,
        source_records: discovered.size,
        counts: { linked, changed: updates.length, ambiguous: possibleMatches.length, unchanged, no_match: noMatch },
        cache: cacheStates,
        additions: [],
        updates,
        possible_matches: possibleMatches,
        warnings,
      });
    }

    if (body.mode === "scan") {
      const { data: storedEvents, error: eventsError } = await admin.from("events")
        .select("id,title,description,location,starts_at,ends_at,all_day,time_known,previous_schedule,reschedule_note,external_url,external_links,source,published,lifecycle_status,matchplay_format")
        .limit(500);
      if (eventsError) throw new Error("Could not read club events");
      const now = Date.now();
      const allEvents = storedEvents || [];
      const localEvents = allEvents.filter((event) => {
        if (event.lifecycle_status === "canceled" || !event.starts_at) return false;
        const start = Date.parse(String(event.starts_at));
        const end = event.ends_at ? Date.parse(String(event.ends_at)) : start;
        return Number.isFinite(start) && (end >= now || start >= now - 24 * 60 * 60 * 1000);
      });
      const activeEventIds = new Set(localEvents.map(event => String(event.id)));
      const matchingEvents = allEvents.filter(event => event.lifecycle_status !== "canceled");
      const linkedEventsById = new Map<string, Array<Record<string, unknown>>>();
      const activeLinkedIds = new Set<string>();
      for (const event of allEvents) {
        const links = [event.external_url, ...(Array.isArray(event.external_links) ? (event.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
        for (const link of links) {
          const id = tournamentIdFromInput(String(link || ""));
          if (id) {
            const linked = linkedEventsById.get(id) || [];
            if (!linked.some(row => String(row.id) === String(event.id))) linked.push(event);
            linkedEventsById.set(id, linked);
            if (activeEventIds.has(String(event.id))) activeLinkedIds.add(id);
          }
        }
      }
      const discovered = new Map<string, Record<string, unknown>>();
      const searchQueries = ["SNHPC", "Southern New Hampshire Pinball Club"];
      const searchPageLimit = 5;
      const cacheStates: unknown[] = [];
      const warnings: string[] = [];
      for (const query of searchQueries) {
        let hasMorePages = false;
        for (let page = 1; page <= searchPageLimit; page += 1) {
          let result;
          try {
            result = await getCached(`search?query=${encodeURIComponent(query)}&type=tournaments&page=${page}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (/429|too many attempts/i.test(message)) {
              warnings.push("Match Play rate-limited this scan. Some results may be missing; wait a few minutes and try again.");
              break;
            }
            throw error;
          }
          const { payload, cache } = result;
          cacheStates.push(cache);
          for (const item of Array.isArray(payload?.data) ? payload.data : []) {
            if (!item || typeof item !== "object") continue;
            const row = item as Record<string, unknown>;
            const id = positiveId(row.tournamentId);
            const name = String(row.name || "");
            if (id && /snhpc|southern new hampshire pinball club/i.test(name)) discovered.set(id, row);
          }
          const links = payload?.links && typeof payload.links === "object"
            ? payload.links as Record<string, unknown> : {};
          hasMorePages = !!links.next;
          if (!hasMorePages) break;
        }
        if (hasMorePages && !rateLimited) {
          warnings.push("Search stopped after the first 5 pages for a title to avoid excessive Match Play requests.");
        }
        if (rateLimited) break;
      }
      for (const id of activeLinkedIds) {
        if (rateLimited) break;
        if (discovered.has(id)) continue;
        try {
          const { payload, cache } = await getCached(`tournaments/${id}?includeLocation=1`);
          cacheStates.push(cache);
          if (payload?.data && typeof payload.data === "object") discovered.set(id, payload.data as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/429|too many attempts/i.test(message)) {
            warnings.push("Match Play rate-limited this scan. Some linked events may not have been checked; wait a few minutes and try again.");
            rateLimited = true;
            break;
          }
          throw error;
        }
      }
      const additions: ReturnType<typeof normalizedTournament>[] = [];
      const updates: Array<Record<string, unknown>> = [];
      const possibleMatches: Array<Record<string, unknown>> = [];
      let unchanged = 0;
      for (const [id, row] of discovered) {
        const tournament = normalizedTournament(row, id);
        if (!tournament.id) continue;
        const linkedRecords = linkedEventsById.get(id) || [];
        const activeLinkedRecords = linkedRecords.filter(row => activeEventIds.has(String(row.id)));
        if (linkedRecords.length && activeLinkedRecords.length === 0) continue;
        if (activeLinkedRecords.length > 1) {
          possibleMatches.push({
            tournament,
            candidates: activeLinkedRecords.slice(0, 5).map(candidate => ({
              id: candidate.id, title: candidate.title, starts_at: candidate.starts_at,
              published: candidate.published,
              match: { confidence: "linked URL", title_overlap: true },
            })),
          });
          continue;
        }
        if (activeLinkedRecords.length === 1 && hasConflictingMatchDates(tournament, activeLinkedRecords[0])) {
          const candidate = activeLinkedRecords[0];
          possibleMatches.push({
            tournament,
            candidates: [{
              id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, published: candidate.published,
              match: { confidence: "linked URL with conflicting dates", title_overlap: false, title_date_conflict: true },
            }],
          });
          continue;
        }
        let event = activeLinkedRecords[0];
        let matchLabel = event ? "Match Play link" : "";
        if (!event) {
          const candidates = rankEventCandidates(tournament, matchingEvents as Array<Record<string, unknown>>);
          // A date-only match is never enough to auto-blend data. Keep it in review,
          // even when it is the only local event on that date.
          if (candidates.length > 1 || candidates.some(candidate => !candidate.match.title_overlap)) {
            possibleMatches.push({ tournament, candidates: candidates.slice(0, 5).map(candidate => ({ id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, published: candidate.published, match: candidate.match })) });
            continue;
          }
          if (candidates.length === 1) {
            event = matchingEvents.find(candidate => String(candidate.id) === String(candidates[0].id));
            matchLabel = candidates[0].match.confidence;
            if (event && !activeEventIds.has(String(event.id))) {
              possibleMatches.push({ tournament, candidates: candidates.slice(0, 3).map(candidate => ({ id: candidate.id, title: candidate.title, starts_at: candidate.starts_at, match: candidate.match })) });
              continue;
            }
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
        const proposedLinks = [...eventLinks];
        const addLink = (url: string, label: string) => {
          if (url && proposedLinks.length < 5 && !proposedLinks.some(link => link && link.url === url)) {
            proposedLinks.push({ url, label });
          }
        };
        addLink(tournament.url, "Match Play");
        addLink(tournament.series_url, "Match Play series");
        if (proposedLinks.length !== eventLinks.length) {
          changes.push({ field: "external_links", label: "Match Play links", current: eventLinks, proposed: proposedLinks });
        }
        if (changes.length) updates.push({ tournament, event: { id: event.id, title: event.title, starts_at: event.starts_at, location: event.location, description: event.description, matchplay_format: event.matchplay_format, external_links: event.external_links, source: event.source, published: event.published, all_day: event.all_day, time_known: event.time_known, ends_at: event.ends_at, previous_schedule: event.previous_schedule, reschedule_note: event.reschedule_note, lifecycle_status: event.lifecycle_status }, match: matchLabel, changes });
        else unchanged += 1;
      }
      return json({ scanned_at: new Date().toISOString(), cache: cacheStates, additions, updates, possible_matches: possibleMatches, unchanged, warnings });
    }

    if (body.mode === "historical-backfill") {
      const cursorStart = typeof body.cursor?.starts_at === "string" && Number.isFinite(Date.parse(body.cursor.starts_at))
        ? Date.parse(body.cursor.starts_at) : null;
      const cursorId = String(body.cursor?.id || "");
      const batchSize = 3;
      const { data: storedEvents, error: eventsError, count: totalEvents } = await admin.from("events")
        .select("id,title,description,location,starts_at,ends_at,all_day,time_known,external_url,external_links,source,published,lifecycle_status,matchplay_format", { count: "exact" })
        .limit(500);
      if (eventsError) throw new Error("Could not read club events");
      const allEvents = storedEvents || [];
      const linkedTournamentIds = new Set<string>();
      for (const event of allEvents) {
        const links = [event.external_url, ...(Array.isArray(event.external_links)
          ? (event.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
        for (const link of links) {
          const id = tournamentIdFromInput(String(link || ""));
          if (id) linkedTournamentIds.add(id);
        }
      }
      const now = Date.now();
      const targets = allEvents.filter(event => {
        const start = Date.parse(String(event.starts_at || ""));
        if (!Number.isFinite(start) || start >= now) return false;
        const links = [event.external_url, ...(Array.isArray(event.external_links)
          ? (event.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
        if (links.some(link => tournamentIdFromInput(String(link || "")))) return false;
        if (cursorStart === null) return true;
        return start < cursorStart || (start === cursorStart && String(event.id) > cursorId);
      }).sort((a, b) => {
        const dateOrder = Date.parse(String(b.starts_at || "")) - Date.parse(String(a.starts_at || ""));
        if (dateOrder) return dateOrder;
        const leftId = String(a.id);
        const rightId = String(b.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      const batch = targets.slice(0, batchSize);
      const warnings: string[] = [];
      if ((totalEvents || 0) > 500) {
        warnings.push("The scan is limited to the first 500 club event records; a larger event table needs a paginated pass.");
      }
      const events = [];
      let rateLimited = false;
      let stopAfterCurrent = false;
      let lastCompleted: Record<string, unknown> | null = null;
      for (const event of batch) {
        const title = String(event.title || "").trim();
        const candidates: Array<Record<string, unknown>> = [];
        let searchStatus = title.length >= 3 ? "searched" : "title-too-short";
        if (title.length >= 3) {
          try {
            const found = new Set<string>();
            for (let page = 1; page <= 3; page += 1) {
              const { payload } = await getCached(`search?query=${encodeURIComponent(title)}&type=tournaments&page=${page}`);
              for (const item of Array.isArray(payload?.data) ? payload.data : []) {
                if (!item || typeof item !== "object") continue;
                const tournament = normalizedTournament(item as Record<string, unknown>);
                if (!tournament.id || linkedTournamentIds.has(tournament.id) || found.has(tournament.id)) continue;
                const match = rankEventCandidates(tournament, [event as Record<string, unknown>])[0];
                if (!match) continue;
                found.add(tournament.id);
                const clubMatches = rankEventCandidates(tournament, allEvents as Array<Record<string, unknown>>)
                  .filter(item => item.lifecycle_status !== "canceled")
                  .filter(item => item.match?.title_overlap || String(item.id) === String(event.id))
                  .slice(0, 8)
                  .map(item => ({
                    id: item.id,
                    title: item.title,
                    starts_at: item.starts_at,
                    published: item.published,
                    has_matchplay_link: (() => {
                      const links = [item.external_url, ...(Array.isArray(item.external_links)
                        ? (item.external_links as Array<Record<string, unknown>>).map(link => link?.url) : [])];
                      return links.some(link => tournamentIdFromInput(String(link || "")) !== "");
                    })(),
                    match: item.match,
                  }));
                candidates.push({
                  id: tournament.id,
                  title: tournament.title,
                  starts_at: tournament.starts_at,
                  location: tournament.location,
                  description: tournament.description,
                  matchplay_format: tournament.matchplay_format,
                  url: tournament.url,
                  series_url: tournament.series_url,
                  match: match.match,
                  club_event_matches: clubMatches,
                });
              }
              const links = payload?.links && typeof payload.links === "object"
                ? payload.links as Record<string, unknown> : {};
              if (!links.next) break;
              if (page === 3) warnings.push("Some title results may remain beyond page 3 for “" + title.slice(0, 80) + "”.");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (/429|too many attempts/i.test(message)) {
              warnings.push("Match Play rate-limited the historical search. Some events on this page were not checked; try again later.");
              searchStatus = "rate-limited";
              rateLimited = true;
              stopAfterCurrent = true;
            } else {
              warnings.push("Could not search Match Play for “" + title.slice(0, 80) + "”.");
              searchStatus = "error";
              stopAfterCurrent = true;
            }
          }
        }
        candidates.sort((a, b) => {
          const order: Record<string, number> = { likely: 0, "same day": 1, possible: 2 };
          const ac = String((a.match as Record<string, unknown>)?.confidence || "");
          const bc = String((b.match as Record<string, unknown>)?.confidence || "");
          return (order[ac] ?? 9) - (order[bc] ?? 9);
        });
        events.push({
          id: event.id,
          title: event.title,
          starts_at: event.starts_at,
          published: event.published,
          candidates,
          search_status: searchStatus,
        });
        if (stopAfterCurrent) break;
        lastCompleted = event as Record<string, unknown>;
      }
      const hasNext = stopAfterCurrent || targets.length > batch.length;
      return json({
        scanned_at: new Date().toISOString(),
        batch_size: batchSize,
        remaining_after_batch: Math.max(0, targets.length - (stopAfterCurrent ? events.length - 1 : batch.length)),
        next_cursor: hasNext
          ? (lastCompleted ? { starts_at: lastCompleted.starts_at, id: lastCompleted.id } : (body.cursor || null))
          : null,
        has_next: hasNext,
        events,
        warnings,
      });
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
      series_id: positiveId(data.seriesId) || positiveId(data.series && typeof data.series === "object" ? (data.series as Record<string, unknown>).id : ""),
      series_name: String((data.series && typeof data.series === "object" ? (data.series as Record<string, unknown>).name : "") || "").slice(0, 120),
      series_url: (positiveId(data.seriesId) || positiveId(data.series && typeof data.series === "object" ? (data.series as Record<string, unknown>).id : ""))
        ? `https://app.matchplay.events/series/${positiveId(data.seriesId) || positiveId(data.series && typeof data.series === "object" ? (data.series as Record<string, unknown>).id : "")}`
        : "",
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
