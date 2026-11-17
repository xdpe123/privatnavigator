export const apiLimit = 720;
export const day = 86_400_000;
export const historyDays = 14;
const berlinDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });

export function dayKey(time) {
  return berlinDate.format(time);
}

export function requestKind(path) {
  if (path.endsWith('/geocode')) return 'places';
  if (path.endsWith('/plan')) return 'routes';
  return 'updates';
}

export function usageReport(rows, rolling, now = Date.now()) {
  const today = dayKey(now);
  const date = Date.parse(today);
  const days = Array.from({ length: historyDays }, (_, index) => {
    const key = new Date(date - (historyDays - 1 - index) * day).toISOString().slice(0, 10);
    return { date: key, places: 0, routes: 0, updates: 0 };
  });
  const byDate = new Map(days.map((item) => [item.date, item]));
  for (const item of rows) {
    const entry = byDate.get(item.date);
    if (entry) entry[item.kind] += item.count;
  }
  return { limit: apiLimit, rolling, days };
}

export function budgetError() {
  const error = new Error('Das App-Limit von 720 Transitous-Aufrufen in 24 Stunden ist erreicht. Versuche es später erneut.');
  error.status = 429;
  return error;
}
