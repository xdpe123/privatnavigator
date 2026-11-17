const minute = 60_000;
export const historyWindow = 90 * 24 * 60 * minute;
const usableForecasts = new Set(['PREDICTED', 'PROPAGATED']);

export function arrivalEvidence(legs, now, stable = false) {
  const last = legs?.at(-1);
  if (!last) return null;
  const planned = Date.parse(last.scheduledArrival);
  if (legs.some((leg) => leg.cancelled)) {
    return Number.isFinite(planned) && now >= planned ? { kind: 'cancelled', delay: null } : null;
  }
  const arrival = Date.parse(last.arrival || last.scheduledArrival);
  if (!Number.isFinite(planned) || !Number.isFinite(arrival) || arrival > now) return null;
  const kind = last.arrivalReason === 'OBSERVED' ? 'observed'
    : stable ? 'inferred' : usableForecasts.has(last.arrivalReason) ? 'forecast' : null;
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

const berlinWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
const berlinHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' });
const berlinDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });

function metrics(records) {
  const observed = records.filter(trip => ['observed', 'inferred'].includes(trip.kind) && Number.isFinite(trip.delay));
  const delays = observed.map(trip => trip.delay).sort((a, b) => a - b);
  const percentile = (fraction) => delays.length ? Math.round(delays[Math.max(0, Math.ceil(delays.length * fraction) - 1)] / 60 * 10) / 10 : null;
  return {
    total: records.length, observed: observed.length,
    confirmed: observed.filter(trip => trip.kind === 'observed').length,
    inferred: observed.filter(trip => trip.kind === 'inferred').length,
    cancelled: records.filter(trip => trip.kind === 'cancelled').length,
    forecast: records.filter(trip => trip.kind === 'forecast').length,
    unknown: records.filter(trip => trip.kind === 'unknown').length,
    onTime: observed.filter(trip => trip.delay < 360).length,
    exact: observed.filter(trip => trip.delay <= 0).length,
    average: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length / 60 * 10) / 10 : null,
    median: percentile(.5), p90: percentile(.9),
    distribution: [
      { label: 'Pünktlich / früher', count: delays.filter(delay => delay <= 0).length },
      { label: '1–5 Min.', count: delays.filter(delay => delay > 0 && delay < 360).length },
      { label: '6–14 Min.', count: delays.filter(delay => delay >= 360 && delay < 900).length },
      { label: '15–29 Min.', count: delays.filter(delay => delay >= 900 && delay < 1800).length },
      { label: 'Ab 30 Min.', count: delays.filter(delay => delay >= 1800).length },
    ],
  };
}

function grouped(records, key) {
  const groups = new Map();
  for (const trip of records) {
    const label = key(trip);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(trip);
  }
  return [...groups].map(([label, trips]) => ({ label, ...metrics(trips) }));
}

export function punctualityReport(records, days = 90, now = Date.now()) {
  const selected = records.filter(trip => trip.departure >= now - days * 86400_000 && trip.departure <= now)
    .sort((a, b) => b.departure - a.departure);
  return {
    days, ...metrics(selected),
    weekdays: grouped(selected, trip => berlinWeekday.format(trip.departure)),
    hours: grouped(selected, trip => String(Math.floor(Number(berlinHour.format(trip.departure)) / 4) * 4).padStart(2, '0')).sort((a,b) => a.label.localeCompare(b.label)),
    trend: grouped(selected, trip => berlinDay.format(trip.departure)).sort((a,b) => a.label.localeCompare(b.label)),
    lines: grouped(selected, trip => trip.lines),
    recent: selected.slice(0, 100),
  };
}

export function summarizeTrips(records, days = 90, now = Date.now()) {
  const routes = new Map();
  for (const trip of records.filter(trip => trip.departure >= now - days * 86400_000 && trip.departure <= now)) {
    const key = JSON.stringify([trip.origin, trip.destination]);
    if (!routes.has(key)) routes.set(key, {
      origin: trip.origin, destination: trip.destination, total: 0, observed: 0,
      onTime: 0, inferred: 0, forecast: 0, cancelled: 0, unknown: 0, recent: [],
    });
    const route = routes.get(key);
    route.total++;
    route[trip.kind]++;
    if (trip.kind === 'inferred') route.observed++;
    if (['observed', 'inferred'].includes(trip.kind) && trip.delay < 360) route.onTime++;
    if (route.recent.length < 8) route.recent.push({
      departure: trip.departure, lines: trip.lines, kind: trip.kind, delay: trip.delay,
    });
  }
  for (const route of routes.values()) route.details = punctualityReport(records.filter(trip => trip.origin === route.origin && trip.destination === route.destination), days, now);
  return [...routes.values()].sort((a, b) => b.total - a.total);
}
