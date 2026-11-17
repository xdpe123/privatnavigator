export function createTransitClient(contact) {
  const userAgent = `PrivatNavigator/0.3 (${contact || 'local prototype'})`;
  const cache = new Map();

  function lookup(url, ttl) {
    const key = url.href;
    const cached = cache.get(key);
    if (cached?.until > Date.now()) return cached.result;
    const result = fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    }).then((response) => {
      if (!response.ok) {
        const error = new Error(`Transitous HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
      }
      return response.json();
    }).catch((error) => {
      if (cache.get(key)?.result === result) cache.delete(key);
      throw error;
    });
    if (cache.size >= 250) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + ttl, result });
    return result;
  }

  async function stations(query) {
    const upstream = new URL('https://api.transitous.org/api/v1/geocode');
    upstream.search = new URLSearchParams({ text: query, language: 'de' });
    const matches = await lookup(upstream, 600_000);
    return matches.filter(({ type, id, lat, lon }) => type === 'STOP' ? Boolean(id)
      : ['ADDRESS', 'PLACE'].includes(type) && Number.isFinite(lat) && Number.isFinite(lon))
      .slice(0, 10)
      .map(({ type, id, name, lat, lon, areas, country }) => ({
        id: type === 'STOP' ? id : `${lat},${lon}`,
        name,
        area: [...new Set(areas?.filter(({ default: preferred }) => preferred).map(({ name }) => name))]
          .slice(0, 2).join(', ') || country,
        type,
      }));
  }

  async function journeys(from, to, time, arriveBy) {
    const upstream = new URL('https://api.transitous.org/api/v6/plan');
    upstream.search = new URLSearchParams({
      fromPlace: from, toPlace: to, time, arriveBy, numItineraries: '5',
      detailedLegs: 'false', language: 'de',
    });
    const plan = await lookup(upstream, 30_000);
    return plan.itineraries;
  }

  function refreshJourney(itineraryId) {
    const upstream = new URL('https://api.transitous.org/api/v6/refresh-itinerary');
    upstream.search = new URLSearchParams({ itineraryId, detailedLegs: 'false', language: 'de' });
    return lookup(upstream, 20_000);
  }

  return { stations, journeys, refreshJourney };
}
