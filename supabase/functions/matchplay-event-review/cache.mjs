import { cachedResource, normalizedSearchKey, supabaseCacheStore } from '../_shared/external-api-cache.mjs';
import { getMatchplay } from './provider.mjs';

export function createMatchplayCache(client, token) {
  const store = supabaseCacheStore(client);
  return async path => {
    // Profile identifies the credential owner. Never put it into a shared cache.
    if (path === 'users/profile') return { payload: await getMatchplay(path, token), cache: null };
    const eventId = /^tournaments\/(\d+)\?includeLocation=1$/.exec(path)?.[1];
    const resourceType = eventId ? 'event' : 'search';
    // Partition by credential without retaining the credential itself.
    const scope = await normalizedSearchKey('scope?token=' + encodeURIComponent(token));
    return cachedResource({ store, provider: 'matchplay', resourceType,
      key: 'v1:' + scope + ':' + await normalizedSearchKey(path),
      fetchPayload: () => getMatchplay(path, token),
      validate: payload => {
        if (eventId ? String(payload?.data?.tournamentId || '') !== eventId : !Array.isArray(payload?.data)) {
          throw new Error('MatchPlay request failed: unexpected response');
        }
      },
      ttl: payload => {
        const completed = eventId && payload.data.status === 'completed';
        return store.ttl('matchplay', completed ? 'completed' : resourceType,
          completed ? 86400 : eventId ? 7200 : 1800);
      },
    });
  };
}
