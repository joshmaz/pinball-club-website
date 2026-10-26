export const OPDB_EXPORT_URL =
  "https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-opdb.json";

export type OpdbImageImport = {
  sourceKey: string;
  imageUrl: string;
  sourceUrl: string;
  imageType: string | null;
  altText: string | null;
  licenseName: null;
  licenseUrl: null;
  metadata: Record<string, unknown>;
};

type OpdbExportImage = {
  group?: unknown;
  title?: unknown;
  primary?: unknown;
  type?: unknown;
  urls?: { small?: unknown; medium?: unknown; large?: unknown } | null;
  sizes?: Record<string, { width?: unknown; height?: unknown }> | null;
};

export type OpdbExportEntry = {
  opdbId?: unknown;
  name?: unknown;
  ipdbId?: unknown;
  manufactureDate?: unknown;
  display?: unknown;
  manufacturer?: { name?: unknown; fullName?: unknown } | null;
  images?: OpdbExportImage[] | null;
};

type OpdbExport = {
  machines?: OpdbExportEntry[];
  aliases?: OpdbExportEntry[];
};

function nonemptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const out = value.trim();
  return out || null;
}

function httpsUrl(value: unknown): string | null {
  const out = nonemptyString(value);
  return out && out.startsWith("https://") ? out : null;
}

/**
 * Parse only the documented OPDB export image fields. This deliberately does
 * not crawl arbitrary JSON strings for URLs.
 */
export function imageImportsForEntry(entry: OpdbExportEntry): OpdbImageImport[] {
  const opdbId = nonemptyString(entry.opdbId);
  if (!opdbId) return [];
  const sourceUrl = `https://app.matchplay.events/opdb/entries/${encodeURIComponent(opdbId)}`;
  const machineName = nonemptyString(entry.name);
  const rows: OpdbImageImport[] = [];

  for (const image of Array.isArray(entry.images) ? entry.images : []) {
    const sourceKey = nonemptyString(image && image.group);
    const urls = image && image.urls && typeof image.urls === "object" ? image.urls : null;
    const imageUrl = httpsUrl(urls?.large) || httpsUrl(urls?.medium) || httpsUrl(urls?.small);
    if (!sourceKey || !imageUrl) continue;

    const imageType = nonemptyString(image.type);
    const title = nonemptyString(image.title);
    const chosenSize = imageUrl === urls?.large ? "large" : imageUrl === urls?.medium ? "medium" : "small";
    const dimensions = image.sizes && typeof image.sizes === "object" ? image.sizes[chosenSize] : null;

    rows.push({
      sourceKey,
      imageUrl,
      sourceUrl,
      imageType,
      altText: title || (machineName ? `${machineName}${imageType ? ` ${imageType}` : ""}` : null),
      licenseName: null,
      licenseUrl: null,
      metadata: {
        deliveryVariants: ["small", "medium", "large"].flatMap(size => {
          const url = httpsUrl(urls?.[size as "small" | "medium" | "large"]);
          const dimensions = image.sizes?.[size];
          const width = Number(dimensions?.width);
          return url && Number.isInteger(width) && width > 0
            ? [{ url, width, height: Number(dimensions?.height) || null }] : [];
        }),
        opdbPrimary: image.primary === true,
        opdbTitle: title,
        selectedSize: chosenSize,
        width: dimensions && Number.isFinite(Number(dimensions.width)) ? Number(dimensions.width) : null,
        height: dimensions && Number.isFinite(Number(dimensions.height)) ? Number(dimensions.height) : null,
        rightsReviewed: false,
      },
    });
  }

  rows.sort((a, b) => {
    const rank = (v: string | null) => ({ closeup: 0, playfield: 1, backglass: 2 })[String(v || "").trim().toLowerCase()] ?? 3;
    const typeOrder = rank(a.imageType) - rank(b.imageType);
    if (typeOrder) return typeOrder;
    const ap = a.metadata.opdbPrimary === true ? 1 : 0;
    const bp = b.metadata.opdbPrimary === true ? 1 : 0;
    return bp - ap || a.sourceKey.localeCompare(b.sourceKey);
  });
  return rows;
}

export function entriesByOpdbId(payload: unknown): Map<string, OpdbExportEntry> {
  const out = new Map<string, OpdbExportEntry>();
  if (!payload || typeof payload !== "object") return out;
  const doc = payload as OpdbExport;
  for (const entry of [...(Array.isArray(doc.machines) ? doc.machines : []), ...(Array.isArray(doc.aliases) ? doc.aliases : [])]) {
    const id = nonemptyString(entry && entry.opdbId);
    if (id && !out.has(id)) out.set(id, entry);
  }
  return out;
}

export async function fetchOpdbExport(): Promise<Map<string, OpdbExportEntry>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(OPDB_EXPORT_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "snh-pinball-club/opdb-image-sync",
      },
    });
    if (!response.ok) throw new Error(`OPDB export request failed (${response.status})`);
    return entriesByOpdbId(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function importOpdbImages(
  supabase: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> },
  opdbIds: string[],
): Promise<{ requested: number; matched: number; imported: number; missing: string[] }> {
  const ids = [...new Set(opdbIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { requested: 0, matched: 0, imported: 0, missing: [] };

  const entries = await fetchOpdbExport();
  let matched = 0;
  let imported = 0;
  const missing: string[] = [];
  for (const opdbId of ids) {
    const entry = entries.get(opdbId);
    if (!entry) {
      missing.push(opdbId);
      continue;
    }
    matched += 1;
    const images = imageImportsForEntry(entry);
    const result = await supabase.rpc("snh_game_images_import_opdb", {
      p_opdb_id: opdbId,
      p_images: images,
    });
    if (result.error) throw new Error(result.error.message || `Could not import OPDB images for ${opdbId}`);
    imported += Number(result.data || 0);
  }
  return { requested: ids.length, matched, imported, missing };
}

/** Exact identifiers first; title fallback requires both manufacturer and year.
 * Group IDs constrain candidates, but never select an arbitrary edition/alias.
 */
export function matchNewGameToOpdb(
  game: Record<string, unknown>, entries: Map<string, OpdbExportEntry>,
): { entry: OpdbExportEntry | null; via: string; status: "matched" | "unmatched" | "ambiguous" } {
  const hint = nonemptyString(game.opdbId);
  const normalized = (value: unknown) => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  let ipdbId: string | null = null;
  try {
    const url = new URL(String(game.ipdbUrl || ""));
    const id = url.searchParams.get("id");
    if (["www.ipdb.org", "ipdb.org"].includes(url.hostname) && id && /^[1-9]\d*$/.test(id)) ipdbId = String(Number(id));
  } catch { /* no IPDB identifier */ }
  const scoped = [...entries.values()].filter(entry => !hint || entry.opdbId === hint || String(entry.opdbId).startsWith(`${hint}-`));
  const select = (candidates: OpdbExportEntry[], via: string) => ({
    entry: candidates.length === 1 ? candidates[0] : null,
    via,
    status: (candidates.length === 1 ? "matched" : candidates.length > 1 ? "ambiguous" : "unmatched") as "matched" | "ambiguous" | "unmatched",
  });
  const exact = hint ? entries.get(hint) : undefined;
  if (exact && (!ipdbId || exact.ipdbId == null || String(exact.ipdbId) === ipdbId)) {
    return select([exact], "pinballmap_opdb_id");
  }
  if (ipdbId) {
    // Conflicting IDs or repeated IPDB IDs are not safe to auto-approve.
    return select(scoped.filter(entry => String(entry.ipdbId) === ipdbId), "opdb_ipdb_id");
  }
  if (hint && scoped.length === 1) return select(scoped, "pinballmap_opdb_group_unique");
  const title = normalized(game.title);
  const manufacturer = normalized(game.manufacturer);
  const year = String(game.releaseDate || "").slice(0, 4);
  if (!title || !manufacturer || !/^\d{4}$/.test(year)) return select([], "opdb_exact_metadata");
  return select(scoped.filter(entry => normalized(entry.name) === title
    && [entry.manufacturer?.name, entry.manufacturer?.fullName].some(name => normalized(name) === manufacturer)
    && String(entry.manufactureDate || "").slice(0, 4) === year), "opdb_exact_metadata");
}

/** Resolve before catalog writes: provider failures leave new games retryable. */
export async function prepareNewGameOpdbImports(creates: Record<string, unknown>[]) {
  const summary = { matched: 0, unmatched: [] as string[], ambiguous: [] as string[], withoutImages: [] as string[] };
  if (!creates.length) return summary;
  const entries = await fetchOpdbExport();
  if (!entries.size) throw new Error("OPDB export did not contain any machines");
  for (const game of creates) {
    const match = matchNewGameToOpdb(game, entries);
    const slug = String(game.slug || game.title || "");
    // Do not persist a group/unknown ID as a verified machine match.
    delete game.opdbId;
    delete game.opdbMatchedVia;
    delete game.opdbCanonicalName;
    game.opdbImages = [];
    if (!match.entry) {
      summary[match.status === "ambiguous" ? "ambiguous" : "unmatched"].push(slug);
      continue;
    }
    game.opdbId = match.entry.opdbId;
    game.opdbMatchedVia = match.via;
    game.opdbCanonicalName = nonemptyString(match.entry.name);
    const baseId = String(match.entry.opdbId).split('-').slice(0, 2).join('-');
    const display = nonemptyString(match.entry.display) || nonemptyString(entries.get(baseId)?.display);
    if (display && ['reels', 'lights', 'alphanumeric', 'dmd', 'lcd'].includes(display)) game.display = display;
    game.opdbImages = imageImportsForEntry(match.entry);
    summary.matched += 1;
    if (!(game.opdbImages as OpdbImageImport[]).length) summary.withoutImages.push(slug);
  }
  return summary;
}
