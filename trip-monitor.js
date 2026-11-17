import { arrivalEvidence } from './punctuality.js';
import { normalizePushOptions } from './public/push-options.js';

export const minute = 60_000;
export const checkInterval = 5 * minute;
const reminderOffsets = [60, 30];
const clock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

export function snapshot(journey) {
  return journey.legs.filter((leg) => leg.mode !== 'WALK').map((leg) => {
    const stopAlerts = [leg.alerts, leg.from.alerts, leg.to.alerts,
      ...(leg.intermediateStops || []).map((stop) => stop.alerts)];
    const alerts = stopAlerts.flatMap((items) => items || [])
      .map((alert) => [alert.headerText, alert.descriptionText].filter(Boolean).join(' · ')).filter(Boolean);
    return {
      name: leg.displayName || leg.routeShortName || 'Fahrt',
      from: leg.from.name,
      to: leg.to.name,
      departure: leg.startTime,
      arrival: leg.endTime,
      scheduledDeparture: leg.scheduledStartTime || leg.from.scheduledDeparture,
      scheduledArrival: leg.scheduledEndTime || leg.to.scheduledArrival,
      arrivalReason: leg.to.arrivalTimestampReason,
      realTime: Boolean(leg.realTime),
      track: leg.from.track || leg.from.scheduledTrack || '',
      arrivalTrack: leg.to.track || leg.to.scheduledTrack || '',
      cancelled: Boolean(leg.cancelled || leg.from.cancelled || leg.to.cancelled),
      skipped: (leg.intermediateStops || []).filter((stop) => stop.cancelled).map((stop) => stop.name),
      alerts: [...new Set(alerts)].sort(),
    };
  });
}

function delay(actual, scheduled) {
  const minutes = Math.round((Date.parse(actual) - Date.parse(scheduled)) / minute);
  return Number.isFinite(minutes) ? minutes : null;
}

function departureLabel(leg) {
  const timestamp = Date.parse(leg.departure);
  return Number.isFinite(timestamp) ? `${clock.format(timestamp)} Uhr` : 'Zeit unbekannt';
}

function changes(before, after, options) {
  if (before.length !== after.length) return options.route ? 'Der Fahrtverlauf wurde geändert.' : '';
  const messages = [];
  for (const [index, current] of after.entries()) {
    const old = before[index];
    const prefix = current.name;
    if (options.cancellation && old.cancelled !== current.cancelled) messages.push(`${prefix}: ${current.cancelled ? 'Fahrt oder Halt fällt aus' : 'Ausfall aufgehoben'}.`);
    if (options.platform && old.track !== current.track && current.track) messages.push(`${prefix} ab ${current.from}: Gleis ${current.track}.`);
    if (options.platform && old.arrivalTrack !== current.arrivalTrack && current.arrivalTrack) messages.push(`${prefix}: Ankunft auf Gleis ${current.arrivalTrack}.`);
    if (options.stops && JSON.stringify(old.skipped) !== JSON.stringify(current.skipped)) messages.push(`${prefix}: Zwischenhalte geändert.`);
    if (options.time && old.departure !== current.departure) messages.push(`${prefix}: Abfahrt jetzt ${departureLabel(current)}.`);
    if (options.time && old.arrival !== current.arrival && old.departure === current.departure) messages.push(`${prefix}: Ankunftszeit geändert.`);
    const notice = current.alerts.find((message) => !old.alerts.includes(message));
    if (options.notices && notice) messages.push(`${prefix}: ${notice}`);
  }
  return messages.join(' ');
}

function status(latest) {
  if (!latest) return 'Aktuelle Daten momentan nicht abrufbar. Öffne die Fahrt für den gespeicherten Stand.';
  if (!latest.length) return 'Für diese Verbindung liegen keine Fahrzeugprognosen vor.';
  const first = latest[0];
  const cancelled = latest.find((leg) => leg.cancelled);
  if (cancelled) return `${cancelled.name}: Fahrt oder Halt fällt aus.`;
  const delays = latest.flatMap((leg) => leg.realTime ? [
    delay(leg.departure, leg.scheduledDeparture), delay(leg.arrival, leg.scheduledArrival),
  ] : []);
  const highest = Math.max(0, ...delays.filter((value) => value !== null));
  const complete = latest.every((leg) => leg.realTime &&
    delay(leg.departure, leg.scheduledDeparture) !== null && delay(leg.arrival, leg.scheduledArrival) !== null);
  const summary = highest > 0 ? `Bis zu ${highest} Min. später.`
    : complete ? 'Laut Prognose pünktlich.' : 'Echtzeitdaten teilweise oder ganz unbekannt.';
  return [`${first.name} ab ${first.from} · ${departureLabel(first)}${first.track ? ` · Gleis ${first.track}` : ''}.`, summary].join(' ');
}

export function tripSchedule(journey, now) {
  const departure = Date.parse(journey.legs[0]?.scheduledStartTime || journey.startTime);
  const arrival = Date.parse(journey.legs.at(-1)?.scheduledEndTime || journey.endTime);
  if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival <= now) return null;
  return {
    departure,
    until: Math.max(arrival, Date.parse(journey.endTime) || 0) + 30 * minute,
    nextCheck: now + checkInterval,
    reminders: reminderOffsets.filter((offset) => departure - offset * minute >= now),
  };
}

export function pendingReminders(watch, now) {
  if (now >= watch.departure) return [];
  return watch.reminders.filter((offset) => now >= watch.departure - offset * minute);
}

export function evaluateWatch(watch, latest, now) {
  const options = normalizePushOptions(watch.preferences);
  const elapsed = pendingReminders(watch, now);
  const due = elapsed.filter((offset) => options[`before${offset}`]);
  const change = latest ? changes(watch.baseline, latest, options) : '';
  const content = [change, due.length ? status(latest) : ''].filter(Boolean).join(' ');
  const legs = latest || watch.baseline;
  const route = [legs[0]?.from, legs.at(-1)?.to].filter(Boolean).join(' → ');
  const body = content && [route, content].filter(Boolean).join('\n').slice(0, 300);
  const evidence = arrivalEvidence(latest, now);
  const previous = watch.observation;
  const observation = evidence?.kind === 'observed' || evidence?.kind === 'cancelled' ? evidence
    : previous?.kind === 'observed' ? previous : evidence || previous;
  return {
    message: body ? { title: due.length ? `Fahrtstatus · ${due.at(-1)} Min. vorher` : 'Änderung zu deiner Fahrt', body } : null,
    next: {
      ...watch,
      until: Math.max(watch.until, (Date.parse(latest?.at(-1)?.arrival) || 0) + 30 * minute),
      baseline: latest || watch.baseline,
      ...(observation ? { observation } : {}),
      reminders: watch.reminders.filter((offset) => now < watch.departure && !elapsed.includes(offset)),
      nextCheck: now + checkInterval,
    },
  };
}
