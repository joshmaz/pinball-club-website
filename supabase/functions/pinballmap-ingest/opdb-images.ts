export type OpdbImageRow = {
  sourceRecordId: string;
  url: string;
  sourcePageUrl: string;
  imageType: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  providerPrimary: boolean;
};

type JsonObject = Record<string, unknown>;
export const OPDB_EXPORT_URL = "https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-opdb.json";

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Convert OPDB's documented structured `images` array into stable metadata.
 * No model-generated or HTML-scraped values are accepted here.
 */
export function extractOpdbImages(payload: unknown, opdbId: string): OpdbImageRow[] {
  if (!payload || typeof payload !== "object") return [];
  const outer = payload as JsonObject;
  const machine = outer.machine && typeof outer.machine === "object" ? outer.machine as JsonObject : outer;
  const images = machine.images;
  if (!Array.isArray(images)) return [];

  const rows: OpdbImageRow[] = [];
  for (const raw of images) {
    if (!raw || typeof raw !== "object") continue;
    const image = raw as JsonObject;
    const group = nonempty(image.group);
    const urls = image.urls && typeof image.urls === "object" ? image.urls as JsonObject : {};
    const sizes = image.sizes && typeof image.sizes === "object" ? image.sizes as JsonObject : {};
    const selectedKey = ["large", "medium", "small"].find((key) => nonempty(urls[key]));
    if (!group || !selectedKey) continue;
    const url = nonempty(urls[selectedKey]);
    if (!url || !/^https:\/\/img\.opdb\.org\//i.test(url)) continue;
    const selectedSize = sizes[selectedKey] && typeof sizes[selectedKey] === "object"
      ? sizes[selectedKey] as JsonObject
      : {};
    rows.push({
      sourceRecordId: group,
      url,
      sourcePageUrl: `https://opdb.org/api/machines/${encodeURIComponent(opdbId)}`,
      imageType: nonempty(image.type),
      title: nonempty(image.title),
      width: positiveInt(selectedSize.width),
      height: positiveInt(selectedSize.height),
      providerPrimary: image.primary === true,
    });
  }

  return rows.sort((a, b) => {
    if ((a.imageType === "playfield") !== (b.imageType === "playfield")) {
      return a.imageType === "playfield" ? -1 : 1;
    }
    if (a.providerPrimary !== b.providerPrimary) return a.providerPrimary ? -1 : 1;
    return a.sourceRecordId.localeCompare(b.sourceRecordId);
  });
}

/** Resolve exact aliases first, then their physical-machine and group parents. */
export function extractOpdbImagesFromExport(payload: unknown, opdbId: string): OpdbImageRow[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as JsonObject;
  const entries: JsonObject[] = [];
  for (const key of ["aliases", "machines", "machineGroups"]) {
    const group = root[key];
    if (Array.isArray(group)) {
      for (const entry of group) if (entry && typeof entry === "object") entries.push(entry as JsonObject);
    }
  }
  const byId = new Map<string, JsonObject>();
  for (const entry of entries) {
    const id = nonempty(entry.opdbId);
    if (id) byId.set(id, entry);
  }
  const idParts = opdbId.split("-");
  const candidates = [opdbId];
  if (idParts.length >= 3) candidates.push(idParts.slice(0, 2).join("-"));
  if (idParts.length >= 2) candidates.push(idParts[0]);
  for (const id of candidates) {
    const entry = byId.get(id);
    const rows = entry ? extractOpdbImages(entry, opdbId) : [];
    if (rows.length) return rows;
  }
  return [];
}

export async function fetchOpdbExport(): Promise<unknown> {
  const response = await fetch(OPDB_EXPORT_URL, {
    headers: { Accept: "application/json", "User-Agent": "snh-pinball-club/pinballmap-ingest" },
  });
  if (!response.ok) throw new Error(`OPDB data export fetch failed (${response.status})`);
  return await response.json();
}
