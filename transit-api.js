import { allGroups, ticketGroups } from './public/search-filters.js';

export async function transitApi(request, url, client, json) {
  const params = url.searchParams;
  const { stations, journeys, refreshJourney } = client;
  if (request.method !== 'GET') return json(405, { error: 'Nur GET ist verfügbar.' });
  if (url.pathname === '/api/stations') {
    const query = params.get('q')?.trim();
    if (!query || query.length < 3 || query.length > 120) return json(400, { error: 'Bitte 3 bis 120 Zeichen eingeben.' });
    return json(200, await stations(query));
  }
  if (url.pathname === '/api/journeys') {
    const from = params.get('from');
    const to = params.get('to');
    const time = params.get('time');
    const arriveBy = params.get('arriveBy');
    const cursor = params.get('cursor');
    if (!from || !to || from === to || from.length > 250 || to.length > 250 ||
        !time || !Number.isFinite(Date.parse(time)) || !['true', 'false'].includes(arriveBy) || cursor?.length > 1000) {
      return json(400, { error: 'Bitte Start, Ziel und Zeitpunkt prüfen.' });
    }
    const ticket = params.get('ticket') === 'true';
    const requested = params.has('modes') ? params.get('modes').split(',') : null;
    if (requested?.some((group) => !allGroups.includes(group))) {
      return json(400, { error: 'Bitte gültige Verkehrsmittel auswählen.' });
    }
    const groups = ticket ? ticketGroups.filter((group) => !requested || requested.includes(group)) : requested;
    if (groups && !groups.length) return json(400, { error: 'Bitte mindestens ein passendes Verkehrsmittel auswählen.' });
    const page = await journeys(from, to, time, arriveBy, groups, ticket, cursor);
    return json(200, params.get('paged') === 'true' ? page : page.itineraries.slice(0, 5));
  }
  if (url.pathname === '/api/refresh') {
    const itineraryId = params.get('id');
    if (!itineraryId || itineraryId.length > 7000) {
      return json(400, { error: 'Diese Fahrt-ID kann nicht aktualisiert werden.' });
    }
    try {
      return json(200, await refreshJourney(itineraryId, params.get('geometry') === 'true'));
    } catch (error) {
      if ([400, 404, 422].includes(error.upstreamStatus)) {
        return json(404, { error: 'Der Fahrplandienst konnte diese Fahrt nicht mehr zuordnen.' });
      }
      throw error;
    }
  }
  return json(404, { error: 'API-Endpunkt nicht gefunden.' });
}
