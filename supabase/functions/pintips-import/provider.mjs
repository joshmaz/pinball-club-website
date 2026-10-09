export const EXPORT_URL = 'https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-pintips.json';
export const OPDB_ID = /^G([a-zA-Z0-9]+)(?:-M([a-zA-Z0-9]+)(?:-A([a-zA-Z0-9]+))?)?$/;
export function opdbGroup(id) {
  const match = typeof id === 'string' && OPDB_ID.exec(id);
  return match ? `G${match[1]}` : null;
}

// Reject the entire snapshot on a schema change, duplicate identity, or damaged row.
// In particular, do not broaden future machine-specific tips to their whole group.
export function normalizeExport(payload) {
  if (!Array.isArray(payload) || !payload.length || payload.length > 100000) {
    throw new Error('PinTips export must be a nonempty array of at most 100000 tips. Check the official export format.');
  }
  const ids = new Set();
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value.replace(' ', 'T') + 'Z'));
  return payload.map((row, index) => {
    if (!row || !Number.isSafeInteger(row.tipId) || row.tipId < 1 || ids.has(row.tipId)
      || typeof row.opdbId !== 'string' || !/^G[a-zA-Z0-9]+$/.test(row.opdbId)
      || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 20000 || row.text.includes('\0')
      || typeof row.category !== 'string' || !/^[a-z][a-z0-9_]{0,49}$/.test(row.category)
      || !Number.isSafeInteger(row.voteTotal) || Math.abs(row.voteTotal) > 2147483647
      || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) {
      throw new Error(`Invalid or duplicate PinTips row ${index + 1}. Check the official export schema; the previous snapshot is unchanged.`);
    }
    ids.add(row.tipId);
    return { tip_id: row.tipId, opdb_group: row.opdbId, category: row.category,
      text: row.text, vote_total: row.voteTotal, source_created_at: row.createdAt,
      source_updated_at: row.updatedAt };
  });
}

export async function downloadTips(fetcher = fetch) {
  let response;
  try { response = await fetcher(EXPORT_URL, { signal: AbortSignal.timeout(60000), redirect: 'error' }); }
  catch { throw new Error('PinTips download failed or timed out. Check CDN availability and retry.'); }
  if (!response.ok) throw new Error(`PinTips CDN returned HTTP ${response.status}. Retry when the provider is available.`);
  // Bound memory even when Content-Length is absent or dishonest.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PinTips download had no response body. Retry the refresh.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) throw new Error('PinTips export exceeds 20 MB. Review the provider format before raising the limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('PinTips export is not valid UTF-8 JSON. Retry or check the provider export.'); }
  return normalizeExport(payload);
}
