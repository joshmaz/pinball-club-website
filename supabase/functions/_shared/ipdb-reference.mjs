export const IPDB_JSON_URL = 'https://raw.githubusercontent.com/xantari/Ipdb.Database/master/Database/ipdbdatabase.json';
export const MAX_IPDB_EXPORT_BYTES = 25 * 1024 * 1024;
export const MIN_IPDB_ENTRY_COUNT = 5000;

function text(value, max = 10000) {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
    ? value.trim() || null
    : null;
}

function integerOrNull(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function dateOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? undefined : day;
}

function sourceRefreshDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  const timestamp = new Date(value);
  if (timestamp.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return timestamp.toISOString();
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((image) => {
    if (!image || typeof image !== 'object') return [];
    const name = text(image.Name, 500);
    const rawUrl = text(image.Url, 2000);
    if (!name || !rawUrl) return [];
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'www.ipdb.org' || url.username || url.password || url.port) return [];
      return [{ Name: name, Url: url.href }];
    } catch {
      return [];
    }
  });
}

function normalizeRecord(record, index, seen) {
  const ipdbId = integerOrNull(record?.IpdbId, 1, 2_147_483_647);
  const title = text(record?.Title, 300);
  const players = record?.Players == null ? null : integerOrNull(record.Players, 1, 16);
  const manufactureDate = dateOrNull(record?.DateOfManufacture);
  if (!record || typeof record !== 'object' || !ipdbId || seen.has(ipdbId) || !title
    || (record.Players != null && players == null) || manufactureDate === undefined) {
    throw new Error(`IPDB export record ${index + 1} is invalid or duplicated; the previous archive remains active.`);
  }
  seen.add(ipdbId);
  return {
    ipdb_id: ipdbId,
    title,
    players,
    additional_details: text(record.AdditionalDetails, 1000) || '',
    manufacturer: text(record.Manufacturer, 500),
    manufacturer_short_name: text(record.ManufacturerShortName, 200),
    manufacturer_id: integerOrNull(record.ManufacturerId, 0, 2_147_483_647),
    machine_type: text(record.Type, 200),
    type_short_name: text(record.TypeShortName, 80),
    date_of_manufacture: manufactureDate,
    theme: text(record.Theme, 500),
    notable_features: text(record.NotableFeatures, 10000),
    design_by: text(record.DesignBy, 1000),
    art_by: text(record.ArtBy, 1000),
    notes: text(record.Notes, 12000),
    photos_in: text(record.PhotosIn, 3000),
    image_files: normalizeImages(record.ImageFiles),
  };
}

function objectEnd(value) {
  let braces = 0;
  let brackets = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') braces++;
    else if (char === '}') {
      braces--;
      if (braces === 0 && brackets === 0) return i + 1;
    } else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }
  return -1;
}

// Parse the large Data array one record at a time, keeping the source bytes
// separately for archival upload without materializing the whole JSON object.
export function createIpdbArchiveParser(previousEntryCount = 0) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seen = new Set();
  const rows = [];
  let buffer = '';
  let mode = 'header';
  let sourceRefreshedAt = null;
  let ended = false;
  let afterRecord = false;
  let afterComma = false;

  const process = () => {
    while (true) {
      if (mode === 'header') {
        const marker = /"Data"\s*:\s*\[/.exec(buffer);
        if (!marker) return;
        const headerText = buffer.slice(0, marker.index) + '"Data":[]}';
        let header;
        try { header = JSON.parse(headerText); }
        catch { throw new Error('IPDB export has an unexpected root header; the previous archive remains active.'); }
        sourceRefreshedAt = sourceRefreshDate(header?.LastRefreshDateUtc);
        if (!sourceRefreshedAt || !Array.isArray(header.Data) || header.Data.length !== 0) {
          throw new Error('IPDB export has an unexpected refresh timestamp or Data array; the previous archive remains active.');
        }
        buffer = buffer.slice(marker.index + marker[0].length);
        mode = 'data';
      }

      if (mode === 'data') {
        const trimmed = buffer.trimStart();
        buffer = trimmed;
        if (!buffer) return;
        if (afterRecord && buffer[0] === ',') {
          buffer = buffer.slice(1);
          afterRecord = false;
          afterComma = true;
          continue;
        }
        if (afterRecord && buffer[0] === ']') {
          buffer = buffer.slice(1);
          afterRecord = false;
          mode = 'root-close';
          continue;
        }
        if (!afterRecord && !afterComma && buffer[0] === ']') {
          buffer = buffer.slice(1);
          mode = 'root-close';
          continue;
        }
        if (buffer[0] !== '{') throw new Error('IPDB export Data array contains an invalid record; the previous archive remains active.');
        const end = objectEnd(buffer);
        if (end < 0) return;
        let record;
        try { record = JSON.parse(buffer.slice(0, end)); }
        catch { throw new Error(`IPDB export record ${rows.length + 1} is invalid JSON; the previous archive remains active.`); }
        rows.push(normalizeRecord(record, rows.length, seen));
        buffer = buffer.slice(end);
        afterRecord = true;
        afterComma = false;
        continue;
      }

      if (mode === 'root-close') {
        const tail = buffer.trimStart();
        if (!tail) { buffer = ''; return; }
        if (tail[0] !== '}') throw new Error('IPDB export has unexpected data after its Data array; the previous archive remains active.');
        buffer = tail.slice(1);
        mode = 'done';
        ended = true;
        continue;
      }

      if (mode === 'done') {
        if (buffer.trim()) throw new Error('IPDB export has trailing data; the previous archive remains active.');
        buffer = '';
        return;
      }
    }
  };

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      process();
    },
    finish() {
      buffer += decoder.decode();
      process();
      if (!ended || mode !== 'done' || buffer.trim()) {
        throw new Error('IPDB export ended before its JSON structure was complete; the previous archive remains active.');
      }
      if (rows.length < MIN_IPDB_ENTRY_COUNT || rows.length > 12000
        || rows.length < Math.floor(Math.max(0, previousEntryCount) * 0.5)) {
        throw new Error('IPDB export has an unexpected record count; the previous archive remains active.');
      }
      return { rows, entryCount: rows.length, sourceRefreshedAt };
    },
  };
}

// Reject a partial or unexpectedly changed catalog before any current snapshot is replaced.
export function normalizeIpdbArchive(payload, previousEntryCount = 0) {
  const refreshedAt = sourceRefreshDate(payload?.LastRefreshDateUtc);
  const records = payload?.Data;
  if (!refreshedAt || !Array.isArray(records) || records.length < MIN_IPDB_ENTRY_COUNT
    || records.length > 12000 || records.length < Math.floor(Math.max(0, previousEntryCount) * 0.5)) {
    throw new Error('IPDB export has an unexpected shape, refresh date, or record count; the previous archive remains active.');
  }
  const seen = new Set();
  const rows = records.map((record, index) => normalizeRecord(record, index, seen));
  return { rows, entryCount: rows.length, sourceRefreshedAt: refreshedAt };
}
