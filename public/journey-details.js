const minute = 60_000;
const instant = (value) => Date.parse(value);

export function isCancelled(journey) {
  return journey.legs.some((leg) => leg.cancelled || leg.from?.cancelled || leg.to?.cancelled);
}

export function tripTimeline(journey) {
  const legs = journey.legs;
  const useSchedule = isCancelled(journey) || legs.some((leg, index) =>
    index > 0 && instant(leg.startTime) < instant(legs[index - 1].endTime));
  const segments = [];
  let last;
  for (const leg of legs) {
    const start = instant((useSchedule && leg.scheduledStartTime) || leg.startTime);
    const end = instant((useSchedule && leg.scheduledEndTime) || leg.endTime);
    if (start > last) segments.push({ type: 'wait', milliseconds: start - last });
    if (end > start) segments.push({ type: leg.mode === 'WALK' ? 'walk' : 'ride', leg, milliseconds: end - start });
    last = end;
  }
  return segments;
}

export function transfersFor(journey) {
  const checks = [];
  let incoming;
  let walk = 0;
  for (const leg of journey.legs) {
    if (leg.mode === 'WALK') {
      walk += Math.max(0, instant(leg.endTime) - instant(leg.startTime)) || 0;
      continue;
    }
    if (incoming && !leg.interlineWithPreviousLeg && (!leg.tripId || incoming.tripId !== leg.tripId)) {
      const arrival = instant(incoming.to.arrival || incoming.endTime);
      const departure = instant(leg.from.departure || leg.startTime);
      const minutes = Math.floor((departure - arrival - walk) / minute);
      const cancelled = Boolean(incoming.cancelled || incoming.to.cancelled || leg.cancelled || leg.from.cancelled || leg.to.cancelled);
      checks.push({
        incoming, outgoing: leg, minutes, cancelled,
        risky: cancelled || (Number.isFinite(minutes) && minutes < 3),
        estimated: !incoming.realTime || !leg.realTime,
      });
    }
    incoming = leg;
    walk = 0;
  }
  return checks;
}

export function alternativeStops(journey, from, check, now = Date.now()) {
  const leg = check?.incoming;
  if (!leg || leg.cancelled) {
    const start = Math.max(now, instant(journey.startTime));
    return from?.id && Number.isFinite(start) ? [{ ...from, time: new Date(start).toISOString() }] : [];
  }
  const candidates = [leg.to, ...(leg.intermediateStops || []).slice().reverse()];
  const seen = new Set();
  return candidates.flatMap((stop) => {
    const arrival = instant(stop.arrival || stop.scheduledArrival || (stop === leg.to && leg.endTime));
    if (!stop.stopId || stop.cancelled || stop.dropoffType === 'NOT_ALLOWED' || seen.has(stop.stopId) || !(arrival >= now)) return [];
    seen.add(stop.stopId);
    return [{ id: stop.stopId, name: stop.name, time: new Date(arrival + 3 * minute).toISOString(), earlier: stop !== leg.to }];
  }).slice(0, 3);
}

export function calendarFile(trip, labels, url) {
  const start = new Date(trip.journey.startTime);
  const end = new Date(trip.journey.endTime);
  const format = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[;,]/g, '\\$&');
  const encoder = new TextEncoder();
  const fold = (line) => {
    let result = '';
    let size = 0;
    for (const char of line) {
      const bytes = encoder.encode(char).length;
      if (size + bytes > 75) {
        result += '\r\n ';
        size = 1;
      }
      result += char;
      size += bytes;
    }
    return result;
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Privatnavigator//Fahrten//DE', 'BEGIN:VEVENT',
    `UID:${trip.key}@privatnavigator`, `DTSTAMP:${format(new Date())}`,
    `DTSTART:${format(start)}`, `DTEND:${format(end)}`,
    `SUMMARY:${escape(`${trip.from.name} → ${trip.to.name}`)}`,
    `DESCRIPTION:${escape(labels.join('\n'))}`, `URL:${url}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].map(fold).join('\r\n');
}
