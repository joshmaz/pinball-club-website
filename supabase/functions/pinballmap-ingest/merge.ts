/**
 * Pinball Map user_submissions → RPC payload for snh_pinballmap_upsert_from_activity.
 * Mirrors scripts/merge_pinballmap_into_games.py (subset; keep in sync when changing rules).
 */

const RE_PINBALLMAP_SUFFIX = / \(([^)]+, \d{4})\)\s*$/;
const LEGACY_PINBALLMAP_LOCATION_ID = 8908;
const HAINES_ADDRESS = "Haines St";
const BRIDGE_ADDRESS = "Bridge St";
const HAINES_LAST_DAY = "2026-04-23";
const BRIDGE_FIRST_DAY = "2026-04-24";

export type DbGame = {
  id: string;
  slug: string;
  title: string;
  map_at_club: boolean;
  manual_at_club_override: boolean | null;
};

export type DbStint = {
  id: string;
  game_id: string;
  address: string;
  pinball_map_location_id: number | null;
  pinball_map_machine_id: number | null;
  joined_club_date: string | null;
  left_club_date: string | null;
  date_unknown: boolean;
  /** Used to match PostgREST RPC stint row selection (joined_club_date desc, created_at desc). */
  created_at?: string | null;
};

export type ActivityRow = {
  id?: number | string;
  submission_type?: string;
  comment?: string | null;
  machine_name?: string;
  machine_id?: number | null;
  created_at?: string;
};

export type ActivityPayload = {
  meta?: { location_id?: number | string; location_name?: string };
  user_submissions?: ActivityRow[];
};

export function buildPinballConditionPayload(activity: ActivityPayload): {
  location_id: number;
  rows: Record<string, unknown>[];
} {
  const meta = activity.meta || {};
  const locationId = Number(meta.location_id ?? LEGACY_PINBALLMAP_LOCATION_ID) || LEGACY_PINBALLMAP_LOCATION_ID;
  const rows: Record<string, unknown>[] = [];
  for (const row of activity.user_submissions || []) {
    if (row.submission_type !== "new_condition") continue;
    const submissionId = row.id != null ? String(row.id) : "";
    const comment = String(row.comment || "").trim();
    const machineName = String(row.machine_name || "").trim();
    const createdAt = String(row.created_at || "").trim();
    if (!submissionId || !comment || !machineName || !createdAt) continue;
    rows.push({
      submissionId,
      machineName,
      machineId: row.machine_id != null ? Number(row.machine_id) : null,
      comment,
      createdAt,
    });
  }
  return { location_id: locationId, rows };
}

function normalizeMapTitle(machineName: string): string {
  let s = (machineName || "").trim();
  for (;;) {
    const m = RE_PINBALLMAP_SUFFIX.exec(s);
    if (!m) break;
    s = s.slice(0, m.index).trim();
  }
  return s;
}

function toYmd(createdAt: string): string {
  if (!createdAt) return "";
  const dt = new Date(createdAt.replace("Z", "+00:00"));
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

class MachineState {
  machineIds = new Set<number>();
  addDates: string[] = [];
  removeDates: string[] = [];

  addEvent(kind: string, ymd: string, mid: number | null) {
    if (mid != null) this.machineIds.add(mid);
    if (kind === "new_lmx") this.addDates.push(ymd);
    else if (kind === "remove_machine") this.removeDates.push(ymd);
  }
}

function inferJoinAndLeave(
  addDates: string[],
  removeDates: string[]
): { join: string | null; leave: string | null; on: boolean; currentJoin: string | null } {
  const events: [string, "add" | "remove"][] = [];
  for (const d of addDates) events.push([d, "add"]);
  for (const d of removeDates) events.push([d, "remove"]);
  events.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] === "add" ? -1 : 1;
  });
  let on = false;
  let firstJoin: string | null = null;
  let lastLeft: string | null = null;
  let currentJoin: string | null = null;
  for (const [d, k] of events) {
    if (k === "add") {
      if (!firstJoin) firstJoin = d;
      if (!on) currentJoin = d;
      on = true;
    } else {
      if (on) lastLeft = d;
      on = false;
    }
  }
  if (on) return { join: firstJoin, leave: null, on: true, currentJoin };
  return { join: firstJoin, leave: lastLeft, on: false, currentJoin: null };
}

function parseYearMfr(machineName: string): { mfr: string | null; yr: string | null } {
  const m = /\(([^)]+), (\d{4})\)\s*$/.exec(machineName.trim());
  if (!m) return { mfr: null, yr: null };
  const inner = m[1].trim();
  if (inner.includes(")")) return { mfr: null, yr: null };
  return { mfr: inner, yr: m[2].trim() };
}

function machineIdFromGame(
  stints: DbStint[],
  locationId: number
): number | null {
  for (const st of stints) {
    if (st.pinball_map_location_id === locationId && st.pinball_map_machine_id != null) {
      return st.pinball_map_machine_id;
    }
  }
  for (const st of stints) {
    if (st.pinball_map_machine_id != null) return st.pinball_map_machine_id;
  }
  return null;
}

function addressForLocation(locationId: number, meta: ActivityPayload["meta"]): string {
  if (locationId === LEGACY_PINBALLMAP_LOCATION_ID) return HAINES_ADDRESS;
  const name = meta?.location_name;
  if (name) return `${name} (Pinball Map location ${locationId})`;
  return `Pinball Map location ${locationId}`;
}

function chooseCanonicalStint(
  locationId: number,
  join: string | null,
  leave: string | null,
  on: boolean,
  fallbackAddress: string
): { address: string; joined: string | null; left: string | null } {
  if (locationId !== LEGACY_PINBALLMAP_LOCATION_ID) {
    return { address: fallbackAddress, joined: join, left: leave };
  }

  if (join && join >= BRIDGE_FIRST_DAY) {
    return { address: BRIDGE_ADDRESS, joined: join, left: leave };
  }
  if (leave && leave <= HAINES_LAST_DAY) {
    return { address: HAINES_ADDRESS, joined: join, left: leave };
  }
  if (join && join < BRIDGE_FIRST_DAY && (on || !leave || leave >= BRIDGE_FIRST_DAY)) {
    return { address: BRIDGE_ADDRESS, joined: BRIDGE_FIRST_DAY, left: leave };
  }
  if (!join && on) {
    return { address: BRIDGE_ADDRESS, joined: BRIDGE_FIRST_DAY, left: null };
  }
  return { address: HAINES_ADDRESS, joined: join, left: leave };
}

function effectiveMapAtClub(g: DbGame): boolean {
  if (g.manual_at_club_override !== null && g.manual_at_club_override !== undefined) {
    return !!g.manual_at_club_override;
  }
  return !!g.map_at_club;
}

function normYmd(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function normMachineId(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when two stint addresses refer to the same club site (Haines vs Bridge) for Pinball Map 8908. */
function pinballStintAddressesMatch(locId: number, a: string, b: string): boolean {
  const ta = a.trim().toLowerCase();
  const tb = b.trim().toLowerCase();
  if (ta === tb) return true;
  if (locId !== LEGACY_PINBALLMAP_LOCATION_ID) return false;
  const haines = (s: string) => s === "haines st" || s.includes("haines street");
  const bridge = (s: string) => s === "bridge st" || (s.includes("bridge st") && s.includes("nashua"));
  if (haines(ta) && haines(tb)) return true;
  if (bridge(ta) && bridge(tb)) return true;
  return false;
}

/** Same row the RPC targets for update/insert (snh_pinballmap_upsert_from_activity). */
function findRpcMatchedStint(
  gameId: string,
  locId: number,
  stintAddress: string,
  stints: DbStint[],
): DbStint | null {
  const cand = stints.filter(
    (s) =>
      s.game_id === gameId &&
      (s.pinball_map_location_id ?? locId) === locId &&
      pinballStintAddressesMatch(locId, stintAddress, s.address),
  );
  cand.sort((a, b) => {
    const aNull = !a.joined_club_date;
    const bNull = !b.joined_club_date;
    if (aNull !== bNull) return aNull ? 1 : -1;
    const ja = normYmd(a.joined_club_date) || "";
    const jb = normYmd(b.joined_club_date) || "";
    if (ja !== jb) return ja < jb ? 1 : -1;
    const ca = (a.created_at || "").trim();
    const cb = (b.created_at || "").trim();
    if (ca !== cb) return ca < cb ? 1 : -1;
    return 0;
  });
  return cand[0] || null;
}

/** True when JSON stint fields that the RPC would write already match the DB row. */
function stintMatchesDb(stint: Record<string, unknown>, db: DbStint | null, locId: number): boolean {
  if (!db) return false;
  const loc = Number(stint.pinballMapLocationId);
  const dbLoc = db.pinball_map_location_id ?? locId;
  if (loc !== dbLoc) return false;
  if (!pinballStintAddressesMatch(locId, String(stint.address || ""), db.address)) return false;

  if (Object.prototype.hasOwnProperty.call(stint, "joinedClubDate")) {
    if (normYmd(stint.joinedClubDate as string) !== normYmd(db.joined_club_date)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(stint, "leftClubDate")) {
    if (normYmd(stint.leftClubDate as string | null) !== normYmd(db.left_club_date)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(stint, "pinballMapMachineId")) {
    const p = normMachineId(stint.pinballMapMachineId);
    const d = db.pinball_map_machine_id == null ? null : Number(db.pinball_map_machine_id);
    const dNorm = d != null && Number.isFinite(d) ? d : null;
    if (p !== dNorm) return false;
  }
  return true;
}

export function buildPinballRpcPayload(
  activity: ActivityPayload,
  games: DbGame[],
  stintsByGameId: Map<string, DbStint[]>
): {
  location_id: number;
  location_address: string;
  updates: Record<string, unknown>[];
  creates: Record<string, unknown>[];
} {
  const meta = activity.meta || {};
  const locationId = Number(meta.location_id ?? 8908) || 8908;
  const locationAddress = addressForLocation(locationId, meta);
  const subs = activity.user_submissions || [];

  const byKey = new Map<string, MachineState>();
  const sampleName = new Map<string, string>();
  const midToKey = new Map<number, string>();

  for (const row of subs) {
    const key = normalizeMapTitle(row.machine_name || "");
    const mid = row.machine_id != null ? Number(row.machine_id) : null;
    if (mid != null && key) midToKey.set(mid, key);
  }

  for (const row of subs) {
    const st = row.submission_type;
    if (st !== "new_lmx" && st !== "remove_machine") continue;
    const key = normalizeMapTitle(row.machine_name || "");
    if (!key) continue;
    const ymd = toYmd(row.created_at || "");
    if (!ymd) continue;
    const mid = row.machine_id != null ? Number(row.machine_id) : null;
    if (!byKey.has(key)) byKey.set(key, new MachineState());
    byKey.get(key)!.addEvent(String(st), ymd, Number.isFinite(mid) ? mid : null);
    if (!sampleName.has(key)) sampleName.set(key, row.machine_name || key);
  }

  const inferred = new Map<
    string,
    { join: string | null; leave: string | null; on: boolean; currentJoin: string | null; repId: number | null }
  >();
  for (const [key, st] of byKey) {
    const { join, leave, on, currentJoin } = inferJoinAndLeave(st.addDates, st.removeDates);
    const repId = st.machineIds.size ? Math.min(...st.machineIds) : null;
    inferred.set(key, { join, leave, on, currentJoin, repId });
  }

  const allTitles = new Set(games.map((g) => g.title.trim()).filter(Boolean));
  const inferredLower = new Map<string, string>();
  for (const k of inferred.keys()) {
    const kl = k.toLowerCase();
    if (!inferredLower.has(kl)) inferredLower.set(kl, k);
  }

  function findCanonicalShort(shortKey: string, repMachineId: number | null): string | null {
    const sk = (shortKey || "").trim();
    if (!sk) return null;
    if (allTitles.has(sk)) return sk;
    const skl = sk.toLowerCase();
    const prefixMatches = [...allTitles].filter((t) => t.toLowerCase().startsWith(skl + " ("));
    if (!prefixMatches.length) return null;
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (repMachineId != null) {
      for (const g of games) {
        if (!prefixMatches.includes(g.title)) continue;
        const st = stintsByGameId.get(g.id) || [];
        if (machineIdFromGame(st, locationId) === repMachineId) return g.title;
      }
    }
    return prefixMatches.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  function resolveInferredKey(title: string, game: DbGame): string | null {
    const t = (title || "").trim();
    if (!t) return null;
    if (inferred.has(t)) return t;
    const kl = t.toLowerCase();
    if (inferredLower.has(kl)) return inferredLower.get(kl)!;
    const prefixKeys = [...inferred.keys()].filter((ik) => ik && kl.startsWith(ik.toLowerCase() + " ("));
    if (prefixKeys.length) return prefixKeys.reduce((a, b) => (a.length >= b.length ? a : b));
    const midG = machineIdFromGame(stintsByGameId.get(game.id) || [], locationId);
    if (midG != null && midToKey.has(midG)) return midToKey.get(midG)!;
    return null;
  }

  const updates: Record<string, unknown>[] = [];

  for (const g of games) {
    const mapKey = resolveInferredKey(g.title, g);
    if (!mapKey) continue;
    const inf = inferred.get(mapKey);
    if (!inf) continue;
    const stintJoin = inf.on ? (inf.currentJoin || inf.join) : inf.join;
    const canonical = chooseCanonicalStint(locationId, stintJoin, inf.leave, inf.on, locationAddress);
    const stint: Record<string, unknown> = {
      address: canonical.address,
      pinballMapLocationId: locationId,
    };
    if (canonical.joined) stint.joinedClubDate = canonical.joined;
    if (canonical.left && !inf.on) stint.leftClubDate = canonical.left;
    else if (inf.on) stint.leftClubDate = null;
    if (inf.repId != null) stint.pinballMapMachineId = inf.repId;

    const dbStint = findRpcMatchedStint(g.id, locationId, canonical.address, stintsByGameId.get(g.id) || []);
    const mapMatches = inf.on === effectiveMapAtClub(g);
    const stintMatches = dbStint != null && stintMatchesDb(stint, dbStint, locationId);
    if (mapMatches && stintMatches) continue;

    updates.push({
      slug: g.slug,
      title: g.title,
      mapAtClub: inf.on,
      stint,
    });
  }

  const creates: Record<string, unknown>[] = [];
  for (const [key, inf] of inferred) {
    if (allTitles.has(key)) continue;
    if (findCanonicalShort(key, inf.repId) != null) continue;
    const mname = sampleName.get(key) || key;
    const { mfr, yr } = parseYearMfr(mname);
    const rel = yr && yr.length === 4 ? `${yr}-01-01` : null;
    const parts: string[] = [];
    if (mfr && yr) parts.push(`${yr} ${mfr}.`);
    parts.push("From Pinball Map location activity (not on our site list before).");
    if (inf.join) parts.push(`First listed on the map on ${inf.join}.`);
    if (inf.leave) parts.push(`Removed from the map on ${inf.leave}.`);
    else if (inf.on && inf.join) parts.push("Still on the map as of the latest activity.");
    const deets = parts.join(" ");

    const stintJoin = inf.on ? (inf.currentJoin || inf.join) : inf.join;
    const canonical = chooseCanonicalStint(locationId, stintJoin, inf.leave, inf.on, locationAddress);
    const stint: Record<string, unknown> = {
      address: canonical.address,
      pinballMapLocationId: locationId,
    };
    if (canonical.joined) stint.joinedClubDate = canonical.joined;
    if (canonical.left && !inf.on) stint.leftClubDate = canonical.left;
    if (inf.repId != null) stint.pinballMapMachineId = inf.repId;

    const slug = key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    creates.push({
      slug,
      title: key,
      details: deets,
      mapAtClub: inf.on,
      releaseDate: rel,
      locationStints: [stint],
    });
  }

  return { location_id: locationId, location_address: locationAddress, updates, creates };
}
