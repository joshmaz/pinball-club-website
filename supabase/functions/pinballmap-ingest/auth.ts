import { createHash, timingSafeEqual } from "node:crypto";

export const SCHEDULER_HEADER = "x-pinballmap-scheduler-secret";

type Dependencies = {
  schedulerSecret: string | undefined;
  getUser: (token: string) => Promise<string | null>;
  hasGamesAccess: (userId: string) => Promise<boolean>;
};

type Authorization =
  | { ok: true; manualActorUserId: string | null }
  | { ok: false; status: number; error: string };

/** This endpoint accepts writes only; preflight never reaches authentication or ingestion. */
export function ingestMethodResponse(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    } });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST required" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Allow": "POST, OPTIONS" },
    });
  }
  return null;
}

export async function authorizeIngest(req: Request, deps: Dependencies): Promise<Authorization> {
  // Presence selects scheduler mode, including an empty header. Never fall back.
  if (req.headers.has(SCHEDULER_HEADER)) {
    const expected = deps.schedulerSecret;
    if (!expected || !expected.trim()) {
      return { ok: false, status: 503, error: "Scheduler authentication is not configured" };
    }
    const supplied = req.headers.get(SCHEDULER_HEADER) || "";
    // Fixed-size digests allow timing-safe comparison even for different lengths.
    const matches = timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(expected).digest(),
    );
    if (!supplied || !matches) {
      return { ok: false, status: 401, error: "Invalid scheduler credential" };
    }
    return { ok: true, manualActorUserId: null };
  }

  // apikey is deliberately irrelevant: only a verified user token grants this path.
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return { ok: false, status: 401, error: "User bearer token required" };
  let userId: string | null;
  try {
    userId = await deps.getUser(match[1]);
  } catch {
    return { ok: false, status: 503, error: "Could not verify user" };
  }
  if (!userId) return { ok: false, status: 401, error: "Invalid user token" };
  try {
    if (await deps.hasGamesAccess(userId) !== true) {
      return { ok: false, status: 403, error: "Games access required" };
    }
  } catch {
    return { ok: false, status: 503, error: "Could not verify games access" };
  }
  return { ok: true, manualActorUserId: userId };
}
