export const OPDB_V2_EXPORT_URL = 'https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-v2.json';
export const OPDB_ID_PATTERN = /^G[A-Za-z0-9]+(?:-M[A-Za-z0-9]+)?(?:-A[A-Za-z0-9]+)?$/;
export const MAX_OPDB_EXPORT_BYTES = 20 * 1024 * 1024;
export const MIN_OPDB_ENTRY_COUNT = 1000;
export const MIN_OPDB_IPDB_MAPPINGS = 500;

function validText(value, max = 300) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}

function validDate(value) {
  return value == null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)));
}

// V2 uses one entries array. Reject the full archive if identity fields drift;
// never silently truncate a source snapshot or publish a partial crosswalk.
export function normalizeOpdbArchive(payload, previousEntryCount = 0) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)
    || payload.entries.length < MIN_OPDB_ENTRY_COUNT || payload.entries.length > 100_000
    || payload.entries.length < Math.floor(Math.max(0, previousEntryCount) * 0.5)) {
    throw new Error('OPDB V2 export has an unexpected shape or record count; the previous archive remains active.');
  }
  const seen = new Set();
  let ipdbCount = 0;
  const rows = payload.entries.map((entry, index) => {
    const id = entry && entry.opdbId;
    const group = entry && entry.opdbGroup;
    const expectedGroup = typeof id === 'string' ? id.split('-')[0] : '';
    const ipdbId = entry && entry.ipdbId;
    if (!entry || typeof entry !== 'object' || !OPDB_ID_PATTERN.test(id || '') || seen.has(id)
      || !/^G[A-Za-z0-9]+$/.test(group || '') || group !== expectedGroup
      || !validText(entry.name) || !validDate(entry.manufactureDate)
      || (ipdbId != null && (!Number.isSafeInteger(ipdbId) || ipdbId < 1))) {
      throw new Error(`OPDB V2 export entry ${index + 1} is invalid or duplicated; the previous archive remains active.`);
    }
    seen.add(id);
    if (ipdbId != null) ipdbCount += 1;
    const manufacturer = entry.manufacturer && entry.manufacturer.name;
    return {
      opdb_id: id,
      opdb_group: group,
      ipdb_id: ipdbId ?? null,
      name: entry.name.trim(),
      manufacture_date: entry.manufactureDate ?? null,
      manufacturer: validText(manufacturer, 200) ? manufacturer.trim() : null,
    };
  });
  if (ipdbCount < MIN_OPDB_IPDB_MAPPINGS) {
    throw new Error('OPDB V2 export has too few IPDB cross-references; the previous archive remains active.');
  }
  return { rows, entryCount: rows.length, ipdbCount };
}

export async function readBoundedResponse(response, maxBytes = MAX_OPDB_EXPORT_BYTES) {
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new Error(`OPDB V2 export request failed (HTTP ${response.status}).`);
  }
  const length = response.headers.get('content-length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new Error('OPDB V2 export exceeds the safe download limit; the previous archive remains active.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OPDB V2 export response had no body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('OPDB V2 export exceeds the safe download limit; the previous archive remains active.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function ipdbPermalink(ipdbId) {
  if (!Number.isSafeInteger(ipdbId) || ipdbId < 1) return null;
  return `https://www.ipdb.org/machine.cgi?id=${ipdbId}`;
}
