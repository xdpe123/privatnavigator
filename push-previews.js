import { evaluateWatch, minute } from './trip-monitor.js';

const cases = {
  general: { label: 'Allgemeiner Zustelltest' },
  before60: { label: 'Fahrtstatus · 60 Minuten vorher', reminder: 60 },
  before30: { label: 'Fahrtstatus · 30 Minuten vorher', reminder: 30 },
  delay: { label: 'Verspätung bei der Abfahrt', change: (legs, shift) => { legs[0].departure = shift(68); } },
  arrival: { label: 'Geänderte Ankunftszeit', change: (legs, shift) => { legs[0].arrival = shift(100); } },
  platform: { label: 'Gleiswechsel bei der Abfahrt', change: (legs) => { legs[0].track = '7'; } },
  arrivalPlatform: { label: 'Gleiswechsel bei der Ankunft', change: (legs) => { legs[0].arrivalTrack = '4'; } },
  cancelled: { label: 'Fahrt oder Halt fällt aus', change: (legs) => { legs[0].cancelled = true; } },
  resumed: { label: 'Ausfall aufgehoben', resumed: true },
  skipped: { label: 'Zwischenhalt entfällt', change: (legs) => { legs[0].skipped = ['Musterstadt West']; } },
  notice: { label: 'Neue Fahrtmeldung', change: (legs) => { legs[0].alerts = ['Geänderte Halte wegen Bauarbeiten.']; } },
  route: { label: 'Fahrtverlauf geändert', change: (legs) => { legs.push({ ...legs[0], name: 'S 5' }); } },
  unavailable: { label: 'Status ohne verfügbare Live-Daten', reminder: 60, unavailable: true },
};

export const pushTestTypes = Object.entries(cases).map(([type, { label }]) => ({ type, label }));

export function pushPreview(type, now = Date.now()) {
  if (!Object.hasOwn(cases, type)) return null;
  if (type === 'general') return {
    title: 'Privatnavigator · Push-Test',
    body: 'Apple-Push funktioniert. Tippe hier, um den Privatnavigator zu öffnen.',
    url: '/', tag: 'test-general',
  };
  const example = cases[type];
  const shift = (offset) => new Date(now + offset * minute).toISOString();
  const departure = example.reminder ?? 60;
  const baseline = [{
    name: 'RE 1', from: 'Musterstadt Hbf', to: 'Beispielstadt Hbf',
    departure: shift(departure), scheduledDeparture: shift(departure),
    arrival: shift(departure + 25), scheduledArrival: shift(departure + 25),
    track: '5', arrivalTrack: '2', skipped: [], alerts: [], realTime: true, cancelled: Boolean(example.resumed),
  }];
  const latest = structuredClone(baseline);
  if (example.resumed) latest[0].cancelled = false;
  example.change?.(latest, shift);
  const watch = {
    baseline, departure: now + departure * minute, until: now + (departure + 60) * minute,
    reminders: example.reminder ? [example.reminder] : [],
  };
  const { message } = evaluateWatch(watch, example.unavailable ? null : latest, now);
  return { title: `Test · ${message.title}`, body: message.body, url: '/#settings', tag: `test-${type}` };
}
