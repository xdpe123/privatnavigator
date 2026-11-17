import { matchesFilters, routingModes } from './public/search-filters.js';

export function createTransitClient(contact, beforeRequest = () => {}) {
  const userAgent = `PrivatNavigator/0.4 (${contact || 'local prototype'})`;
  const cache = new Map();

  function lookup(url, ttl) {
    const key = url.href;
    const cached = cache.get(key);
    if (cached?.until > Date.now()) return cached.result;
    const result = Promise.resolve().then(() => beforeRequest(url.pathname)).then(() => fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })).then((response) => {
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

  async function journeys(from, to, time, arriveBy, groups, ticket, cursor, includeCancelled = false) {
    const upstream = new URL('https://api.transitous.org/api/v6/plan');
    upstream.search = new URLSearchParams({
      fromPlace: from, toPlace: to, time, arriveBy, numItineraries: groups ? '12' : '5',
      detailedLegs: 'false', language: 'de',
    });
    if (groups) upstream.searchParams.set('transitModes', routingModes(groups).join(','));
    if (cursor) upstream.searchParams.set('pageCursor', cursor);
    const realtime = lookup(upstream, 30_000);
    let scheduled = null;
    if (includeCancelled) {
      const plannedUrl = new URL(upstream);
      plannedUrl.searchParams.set('realtimeMode', 'REALTIME_ANNOTATION_ONLY');
      plannedUrl.searchParams.set('withScheduledSkippedStops', 'true');
      scheduled = lookup(plannedUrl, 30_000).catch(() => null);
    }
    const [plan, planned] = await Promise.all([realtime, scheduled]);
    const known = new Set(plan.itineraries.map((trip) => trip.id));
    const cancellations = (planned?.itineraries || []).filter((trip) => !known.has(trip.id)
      && trip.legs.some((leg) => leg.cancelled || leg.from?.cancelled || leg.to?.cancelled));
    const itineraries = [...plan.itineraries, ...cancellations];
    return {
      itineraries: groups ? itineraries.filter((trip) => matchesFilters(trip, groups, ticket)) : itineraries,
      earlier: plan.previousPageCursor || planned?.previousPageCursor || null,
      later: plan.nextPageCursor || planned?.nextPageCursor || null,
      cancellationsUnavailable: includeCancelled && !planned,
    };
  }

  async function board(stopId, time, mode, cursor) {
    const upstream = new URL('https://api.transitous.org/api/v6/stoptimes');
    upstream.search = new URLSearchParams({
      stopId, time, n: '30', direction: 'LATER', language: 'de',
      arriveBy: String(mode === 'arrivals'), both: String(mode === 'both'),
      realtimeMode: 'REALTIME_ANNOTATION_ONLY',
    });
    if (cursor) upstream.searchParams.set('pageCursor', cursor);
    const result = await lookup(upstream, 25_000);
    return { events: result.stopTimes, earlier: result.previousPageCursor || null, later: result.nextPageCursor || null };
  }

  function refreshJourney(itineraryId, geometry = false) {
    const upstream = new URL('https://api.transitous.org/api/v6/refresh-itinerary');
    upstream.search = new URLSearchParams({ itineraryId, detailedLegs: String(geometry), language: 'de' });
    if (geometry) {
      upstream.searchParams.set('detailedTransfers', 'true');
      upstream.searchParams.set('useRoutedTransfers', 'true');
    }
    return lookup(upstream, 20_000);
  }

  return { stations, journeys, refreshJourney, board };
}
