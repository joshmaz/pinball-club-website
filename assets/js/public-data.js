/* Shared public snapshot contract and read-only loaders. Also used by Node exporters. */
(function (root) {
  const MAX_AGE_DAYS = 7;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SOURCES = { games: 'games_catalog_v1', events: 'events' };

  function validateSnapshot(dataset, payload, options = {}) {
    if (!SOURCES[dataset]) throw new Error('Unknown snapshot dataset.');
    const data = dataset === 'events' && Array.isArray(payload) ? payload : payload && payload[dataset];
    if (!Array.isArray(data)) throw new Error(`Invalid ${dataset} snapshot: expected an array.`);
    const metadata = payload && payload._meta || null;
    if (options.requireMetadata && !metadata) throw new Error(`${dataset} snapshot has no freshness metadata.`);
    if (metadata) {
      if (metadata.schemaVersion !== 1 || metadata.dataset !== dataset ||
          metadata.source !== SOURCES[dataset] || metadata.recordCount !== data.length ||
          typeof metadata.generatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.generatedAt))) {
        throw new Error(`Invalid ${dataset} snapshot metadata.`);
      }
      if (Date.parse(metadata.generatedAt) > (options.now || Date.now()) + 300000) {
        throw new Error(`${dataset} snapshot generation time is in the future.`);
      }
    }
    const ids = new Set();
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof (row.title || row.name) !== 'string' || !(row.title || row.name).trim()) {
        throw new Error(`Invalid ${dataset} snapshot record.`);
      }
      if ((metadata || row.id) && !UUID.test(row.id || '')) throw new Error(`Invalid ${dataset} record UUID.`);
      if (row.id && ids.has(row.id)) throw new Error(`Duplicate ${dataset} UUID: ${row.id}`);
      if (row.id) ids.add(row.id);
      if (dataset === 'events' && row.date !== 'TBD') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') ||
            !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) {
          throw new Error('Invalid event snapshot date.');
        }
      }
    }
    const ageDays = metadata ? Math.max(0, ((options.now || Date.now()) - Date.parse(metadata.generatedAt)) / 86400000) : null;
    return { data, metadata, ageDays, stale: ageDays === null || ageDays > MAX_AGE_DAYS };
  }

  function createSnapshot(dataset, data, generatedAt = new Date().toISOString()) {
    const payload = {
      _meta: { schemaVersion: 1, dataset, source: SOURCES[dataset], generatedAt, recordCount: data.length },
      [dataset]: data,
    };
    validateSnapshot(dataset, payload, { requireMetadata: true });
    return payload;
  }

  function eventFromRow(row) {
    if (!row || !UUID.test(row.id || '') || typeof row.title !== 'string' || !row.title.trim()) {
      throw new Error('Invalid public event row.');
    }
    let date = 'TBD';
    if (row.starts_at) {
      if (!Number.isFinite(Date.parse(row.starts_at))) throw new Error('Invalid event starts_at.');
      date = new Date(row.starts_at).toISOString().slice(0, 10);
    }
    return {
      id: row.id, title: row.title, date, starts_at: row.starts_at || null, location: row.location || 'TBD',
      all_day: !!row.all_day, time_known: typeof row.time_known === 'boolean' ? row.time_known : null,
      external_links: Array.isArray(row.external_links) ? row.external_links : (row.external_url ? [{ url: row.external_url }] : []),
      description: row.description || '', url: row.external_url || '', source: row.source || 'supabase',
    };
  }

  async function load(dataset, { live, preferLive = true, fetchImpl = root.fetch.bind(root), now } = {}) {
    let reason = '';
    if (preferLive && live) {
      try {
        const data = await live();
        validateSnapshot(dataset, { [dataset]: data }, { now });
        // Empty successful reads are authoritative, not a reason to revive a snapshot.
        return { data, source: 'supabase', metadata: null, stale: false };
      } catch (error) {
        reason = error.message || String(error);
      }
    } else if (preferLive) {
      reason = 'Supabase unavailable';
    }
    const response = await fetchImpl(`data/${dataset}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${dataset} snapshot request failed (${response.status}).`);
    const snapshot = validateSnapshot(dataset, await response.json(), { now });
    return { ...snapshot, source: preferLive ? 'static-fallback' : 'static', reason };
  }

  async function readPages(makeQuery) {
    const rows = [];
    for (let offset = 0; ; ) {
      const result = await makeQuery().range(offset, offset + 499);
      if (result.error) throw new Error(result.error.message || String(result.error));
      if (!Array.isArray(result.data)) throw new Error('Invalid Supabase response.');
      rows.push(...result.data);
      offset += result.data.length;
      if (typeof result.count === 'number') {
        if (offset === result.count) return rows;
        if (!result.data.length || offset > result.count) throw new Error('Inconsistent Supabase pagination.');
      } else if (result.data.length < 500) return rows;
    }
  }

  function loadGames() {
    const client = root.snhSupabase;
    return load('games', {
      preferLive: !!(root.SNH_CONFIG && root.SNH_CONFIG.gamesCatalogSource === 'db'),
      live: client && (() => readPages(() => client.from('games_catalog_v1').select('game', { count: 'exact' }).order('slug'))
        .then((rows) => rows.map((row) => row.game))),
    });
  }

  function loadEvents() {
    const client = root.snhSupabase;
    return load('events', {
      live: client && (() => readPages(() => client.from('events')
        .select('id,title,description,location,starts_at,external_url,source,all_day,time_known,external_links', { count: 'exact' })
        .or('published.eq.true,published.is.null')
        .order('starts_at', { ascending: true, nullsFirst: false }).order('id'))
        .then((rows) => rows.map(eventFromRow))),
    });
  }

  function sourceLabel(result) {
    if (result.source === 'supabase') return 'Data source: Supabase';
    const saved = result.metadata ? result.metadata.generatedAt.slice(0, 10) : 'unknown date';
    return `Data source: ${result.source === 'static' ? 'JSON snapshot' : 'JSON fallback'} (saved ${saved}${result.stale ? '; may be out of date' : ''})`;
  }

  const api = { MAX_AGE_DAYS, validateSnapshot, createSnapshot, eventFromRow, load, readPages, loadGames, loadEvents, sourceLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SNHPublicData = api;
})(typeof window !== 'undefined' ? window : globalThis);
