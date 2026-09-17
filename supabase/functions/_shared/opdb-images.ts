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

type OpdbExportEntry = {
  opdbId?: unknown;
  name?: unknown;
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
    const ap = a.metadata.opdbPrimary === true ? 1 : 0;
    const bp = b.metadata.opdbPrimary === true ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const rank = (v: string | null) => (v === "playfield" ? 0 : v === "backglass" ? 1 : 2);
    return rank(a.imageType) - rank(b.imageType);
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
