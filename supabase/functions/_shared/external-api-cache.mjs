// Server-only cache. Adapters own validation, normalization and credential scope.
export async function normalizedSearchKey(path) {
  const url = new URL(path, 'https://cache.invalid/');
  url.searchParams.sort();
  const canonical = url.pathname + '?' + url.searchParams.toString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export function supabaseCacheStore(client) {
  const checked = async query => {
    const { data, error } = await query;
    if (error) throw new Error('External API cache storage unavailable');
    return data;
  };
  const filter = (query, id) => Object.entries(id).reduce((q, [k, v]) => q.eq(k, v), query);
  return {
    read: id => checked(filter(client.from('external_api_cache').select('*'), id).maybeSingle()),
    write: row => checked(client.from('external_api_cache').upsert(row)),
    status: row => checked(client.from('integration_status').upsert(row)),
    ttl: async (provider, policy, fallback) => {
      const row = await checked(client.from('external_api_cache_policies').select('ttl_seconds')
        .eq('provider', provider).eq('policy', policy).maybeSingle());
      return row?.ttl_seconds ?? fallback;
    },
  };
}

export async function cachedResource({ store, provider, resourceType, key, fetchPayload,
  validate = () => {}, ttl, force = false, now = Date.now }) {
  const id = { provider, resource_type: resourceType, cache_key: key };
  const cached = await store.read(id);
  const started = now();
  const result = (row, source, stale = false) => ({ payload: row.payload, cache: {
    source, stale, fetched_at: row.fetched_at, expires_at: row.expires_at,
  } });
  if (cached && (force ? started - Date.parse(cached.fetched_at) < 30000
    : Date.parse(cached.expires_at) > started)) return result(cached, 'cache');
  const statusId = { provider, resource_type: resourceType };
  // Observability failures must not discard a successful response or stale fallback.
  const status = async fields => {
    try { await store.status({ ...statusId, ...fields }); }
    catch { console.warn('External API status write failed'); }
  };
  await status({ last_attempt_at: new Date(started).toISOString() });
  let payload;
  try {
    payload = await fetchPayload();
    validate(payload);
  } catch (error) {
    await status({ last_error_at: new Date(now()).toISOString(),
      last_error: 'Provider request or response validation failed', latency_ms: Math.max(0, now() - started) });
    if (cached) return result(cached, 'cache', true);
    throw error;
  }
  const fetched = now();
  const seconds = await ttl(payload);
  const row = { ...id, payload, fetched_at: new Date(fetched).toISOString(),
    expires_at: new Date(fetched + seconds * 1000).toISOString() };
  await store.write(row);
  await status({ last_success_at: row.fetched_at, latency_ms: Math.max(0, fetched - started) });
  return result(row, 'provider');
}
