import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildPinballRpcPayload, type ActivityPayload, type DbGame, type DbStint } from "./merge.ts";

const LOCATION_DEFAULT = 8908;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return jsonResponse({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }

    const locationId = Number(Deno.env.get("PINBALLMAP_LOCATION_ID") || LOCATION_DEFAULT) || LOCATION_DEFAULT;
    const baseQs = `location_id=${locationId}&limit=50`;
    const activityBase =
      Deno.env.get("PINBALLMAP_ACTIVITY_URL") ||
      `https://pinballmap.com/api/v1/user_submissions/location.json?${baseQs}`;

    const merged: ActivityPayload = { meta: { location_id: locationId }, user_submissions: [] };
    const seen = new Set<string>();
    for (let page = 1; page <= 80; page += 1) {
      const sep = activityBase.includes("?") ? "&" : "?";
      const url = activityBase.includes("page=") ? activityBase : `${activityBase}${sep}page=${page}`;
      const actRes = await fetch(url);
      if (!actRes.ok) {
        return jsonResponse({ ok: false, error: `Pinball Map fetch failed: ${actRes.status}` }, 502);
      }
      const pageJson = (await actRes.json()) as ActivityPayload;
      if (page === 1) merged.meta = { ...merged.meta, ...(pageJson.meta || {}) };
      const subs = pageJson.user_submissions || [];
      for (const row of subs) {
        const id = `${row.submission_type}|${row.created_at}|${row.machine_name}|${row.machine_id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.user_submissions!.push(row);
      }
      if (subs.length < 50) break;
    }
    const activity = merged;

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: gameRows, error: gErr } = await supabase.from("games").select("id,slug,title,map_at_club,manual_at_club_override");
    if (gErr) return jsonResponse({ ok: false, error: gErr.message }, 500);

    const { data: stintRows, error: sErr } = await supabase.from("game_location_stints").select(
      "id,game_id,address,pinball_map_location_id,pinball_map_machine_id,joined_club_date,left_club_date,date_unknown"
    );
    if (sErr) return jsonResponse({ ok: false, error: sErr.message }, 500);

    const stintsByGameId = new Map<string, DbStint[]>();
    for (const s of stintRows || []) {
      const gid = String((s as { game_id: string }).game_id);
      const arr = stintsByGameId.get(gid) || [];
      arr.push({
        id: String((s as { id: string }).id),
        game_id: gid,
        address: String((s as { address: string }).address || ""),
        pinball_map_location_id: (s as { pinball_map_location_id: number | null }).pinball_map_location_id ?? null,
        pinball_map_machine_id: (s as { pinball_map_machine_id: number | null }).pinball_map_machine_id ?? null,
        joined_club_date: (s as { joined_club_date: string | null }).joined_club_date,
        left_club_date: (s as { left_club_date: string | null }).left_club_date,
        date_unknown: !!(s as { date_unknown: boolean }).date_unknown,
      });
      stintsByGameId.set(gid, arr);
    }

    const games = (gameRows || []) as unknown as DbGame[];
    const payload = buildPinballRpcPayload(activity, games, stintsByGameId);

    const { data, error } = await supabase.rpc("snh_pinballmap_upsert_from_activity", {
      p_payload: payload,
    });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    return jsonResponse({ ok: true, result: data, counts: { updates: payload.updates.length, creates: payload.creates.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
