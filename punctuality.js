const minute = 60_000;
export const historyWindow = 90 * 24 * 60 * minute;
const usableForecasts = new Set(['PREDICTED', 'PROPAGATED']);

export function arrivalEvidence(legs, now) {
  const last = legs?.at(-1);
  if (!last) return null;
  const planned = Date.parse(last.scheduledArrival);
  if (legs.some((leg) => leg.cancelled)) {
    return Number.isFinite(planned) && now >= planned ? { kind: 'cancelled', delay: null } : null;
  }
  const arrival = Date.parse(last.arrival);
  if (!Number.isFinite(planned) || !Number.isFinite(arrival) || arrival > now) return null;
  const kind = last.arrivalReason === 'OBSERVED' ? 'observed'
    : usableForecasts.has(last.arrivalReason) ? 'forecast' : null;
  return kind ? { kind, delay: Math.round((arrival - planned) / 1000) } : null;
}

export function completedTrip(watch) {
  const first = watch.baseline?.[0];
  const last = watch.baseline?.at(-1);
  if (!first?.from || !last?.to || !Number.isFinite(watch.departure)) return null;
  const { kind, delay } = watch.observation || { kind: 'unknown', delay: null };
  const lines = watch.baseline.map((leg) => leg.name).join(' → ');
  const departure = Date.parse(first.scheduledDeparture) || watch.departure;
  return {
    id: JSON.stringify([first.from, last.to, lines, departure]),
    origin: first.from, destination: last.to, lines, departure, kind, delay,
  };
}

export function summarizeTrips(records) {
  const routes = new Map();
  for (const trip of records) {
    const key = JSON.stringify([trip.origin, trip.destination]);
    if (!routes.has(key)) routes.set(key, {
      origin: trip.origin, destination: trip.destination, total: 0, observed: 0,
      onTime: 0, forecast: 0, cancelled: 0, unknown: 0, recent: [],
    });
    const route = routes.get(key);
    route.total++;
    route[trip.kind]++;
    if (trip.kind === 'observed' && trip.delay < 360) route.onTime++;
    if (route.recent.length < 8) route.recent.push({
      departure: trip.departure, lines: trip.lines, kind: trip.kind, delay: trip.delay,
    });
  }
  return [...routes.values()].sort((a, b) => b.total - a.total);
}
