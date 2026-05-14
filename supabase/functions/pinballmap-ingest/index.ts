import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";
import {
  buildPinballConditionPayload,
  buildPinballRpcPayload,
  type ActivityPayload,
  type DbGame,
  type DbStint,
} from "./merge.ts";

const LOCATION_DEFAULT = 8908;

/** Prefer new default `SUPABASE_SECRET_KEYS` JSON; fall back to legacy JWT service role. */
function resolveElevatedApiKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const dict = JSON.parse(raw) as Record<string, unknown>;
      if (dict && typeof dict === "object") {
        const d = dict.default;
        if (typeof d === "string" && d.trim()) return d.trim();
        for (const v of Object.values(dict)) {
          if (typeof v === "string" && v.trim()) return v.trim();
        }
      }
    } catch {
      /* fall through */
    }
  }
  const legacy = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  return legacy || null;
}

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
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/+$/, "");
    const supabaseKey = resolveElevatedApiKey();
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Missing SUPABASE_URL or an elevated API key. Hosted projects inject SUPABASE_SECRET_KEYS (JSON) and/or legacy SUPABASE_SERVICE_ROLE_KEY by default. If both are empty here, check Edge Function runtime docs or add a custom secret from Project Settings → API (secret key or legacy service_role JWT).",
        },
        500,
      );
    }
    if (supabaseKey.startsWith("sb_publishable_")) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Resolved API key is publishable (anon). Ingest needs a secret key (SUPABASE_SECRET_KEYS.default / sb_secret_…) or legacy service_role JWT, never a browser publishable key.",
        },
        500,
      );
    }

    const locationId = Number(Deno.env.get("PINBALLMAP_LOCATION_ID") || LOCATION_DEFAULT) || LOCATION_DEFAULT;
    const baseQs = `id=${locationId}&limit=50`;
    const rawActivityBase =
      Deno.env.get("PINBALLMAP_ACTIVITY_URL") ||
      `https://pinballmap.com/api/v1/user_submissions/location.json?${baseQs}`;
    const activityBase = rawActivityBase.replace(/([?&])location_id=/g, "$1id=");

    const merged: ActivityPayload = { meta: { location_id: locationId }, user_submissions: [] };
    const seen = new Set<string>();
    for (let page = 1; page <= 80; page += 1) {
      const sep = activityBase.includes("?") ? "&" : "?";
      const url = activityBase.includes("page=") ? activityBase : `${activityBase}${sep}page=${page}`;
      const actRes = await fetch(url);
      if (!actRes.ok) {
        return jsonResponse({ ok: false, error: `Pinball Map fetch failed: ${actRes.status}` }, 502);
      }
      let pageJson = (await actRes.json()) as ActivityPayload & { errors?: string };
      if (pageJson.errors && pageJson.errors.toLowerCase().includes("failed to find location") && url.includes("location_id=")) {
        const retryUrl = url.replace(/([?&])location_id=/g, "$1id=");
        const retry = await fetch(retryUrl);
        if (!retry.ok) {
          return jsonResponse({ ok: false, error: `Pinball Map fetch failed: ${retry.status}` }, 502);
        }
        pageJson = (await retry.json()) as ActivityPayload & { errors?: string };
      }
      if (pageJson.errors) {
        return jsonResponse({ ok: false, error: `Pinball Map API error: ${pageJson.errors}` }, 502);
      }
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

    // Do not force Authorization: Bearer for sb_secret_* keys; PostgREST rejects non-JWT Bearer.
    // createClient sets the correct headers for both legacy JWT and new secret API keys.
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: gameRows, error: gErr } = await supabase.from("games").select("id,slug,title,map_at_club,manual_at_club_override");
    if (gErr) return jsonResponse({ ok: false, error: gErr.message }, 500);

    const { data: stintRows, error: sErr } = await supabase.from("game_location_stints").select(
      "id,game_id,address,pinball_map_location_id,pinball_map_machine_id,joined_club_date,left_club_date,date_unknown,created_at"
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
        created_at: (s as { created_at?: string | null }).created_at ?? null,
      });
      stintsByGameId.set(gid, arr);
    }

    const games = (gameRows || []) as unknown as DbGame[];
    const payload = buildPinballRpcPayload(activity, games, stintsByGameId);

    const { data, error } = await supabase.rpc("snh_pinballmap_upsert_from_activity", {
      p_payload: payload,
    });
    if (error) {
      return jsonResponse(
        {
          ok: false,
          error: error.message,
          hint:
            error.message.includes("service role") || error.code === "42501"
              ? "RPCs expect elevated access (service_role). Use default SUPABASE_SECRET_KEYS or legacy SUPABASE_SERVICE_ROLE_KEY; do not send sb_secret_* as Authorization: Bearer manually."
              : undefined,
        },
        500,
      );
    }

    const conditionPayload = buildPinballConditionPayload(activity);
    let conditionResult: unknown = { ok: true, imported: 0 };
    if (conditionPayload.rows.length) {
      const cond = await supabase.rpc("snh_pinballmap_import_conditions", {
        p_payload: conditionPayload,
      });
      if (cond.error) {
        return jsonResponse(
          {
            ok: false,
            error: cond.error.message,
            hint:
              cond.error.message.includes("service role") || cond.error.code === "42501"
                ? "Same as snh_pinballmap_upsert_from_activity: elevated API key required (see other hint)."
                : undefined,
          },
          500,
        );
      }
      conditionResult = cond.data;
    }

    return jsonResponse({
      ok: true,
      result: data,
      conditions: conditionResult,
      counts: {
        updates: payload.updates.length,
        creates: payload.creates.length,
        conditionRows: conditionPayload.rows.length,
      },
    });
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
