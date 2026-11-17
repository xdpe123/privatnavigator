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
    if (!from || !to || from === to || from.length > 250 || to.length > 250 ||
        !time || !Number.isFinite(Date.parse(time)) || !['true', 'false'].includes(arriveBy)) {
      return json(400, { error: 'Bitte Start, Ziel und Zeitpunkt prüfen.' });
    }
    return json(200, await journeys(from, to, time, arriveBy));
  }
  if (url.pathname === '/api/refresh') {
    const itineraryId = params.get('id');
    if (!itineraryId || itineraryId.length > 7000) {
      return json(400, { error: 'Diese Fahrt-ID kann nicht aktualisiert werden.' });
    }
    try {
      return json(200, await refreshJourney(itineraryId));
    } catch (error) {
      if ([400, 404, 422].includes(error.upstreamStatus)) {
        return json(404, { error: 'Der Fahrplandienst konnte diese Fahrt nicht mehr zuordnen.' });
      }
      throw error;
    }
  }
  return json(404, { error: 'API-Endpunkt nicht gefunden.' });
}
