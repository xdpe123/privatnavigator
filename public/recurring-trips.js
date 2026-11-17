const zone = 'Europe/Berlin';
const datetime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dateLabel = new Intl.DateTimeFormat('de-DE', {
  timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
});
const weekdayLabels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const weekdays = [1, 2, 3, 4, 5, 6, 0];
const day = 86_400_000;
const storageKey = 'privatnavigator.recurring.v1';

function localParts(value) {
  return datetime.format(new Date(value)).split(' ');
}

function inBerlin(date, time) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let timestamp = target;
  for (let step = 0; step < 3; step++) {
    const [actualDate, actualTime] = localParts(timestamp);
    if (actualDate === date && actualTime === time) return timestamp;
    timestamp += target - Date.parse(`${actualDate}T${actualTime}:00Z`);
  }
  return null;
}

export function nextOccurrence(rule, now = Date.now()) {
  const [today] = localParts(now);
  const first = new Date(`${rule.start > today ? rule.start : today}T00:00:00Z`).getTime();
  for (let index = 0; index < 15; index++) {
    const date = new Date(first + index * day);
    if (!rule.days.includes(date.getUTCDay())) continue;
    const timestamp = inBerlin(date.toISOString().slice(0, 10), rule.time);
    if (timestamp !== null && timestamp >= now - 60_000) return timestamp;
  }
  return null;
}

function serviceLines(journey) {
  return journey.legs.filter((leg) => leg.mode !== 'WALK')
    .map((leg) => (leg.displayName || leg.routeShortName || leg.mode).toUpperCase().replace(/\s/g, ''));
}

function scheduledDeparture(journey) {
  const first = journey.legs[0];
  return first?.scheduledStartTime || first?.from?.scheduledDeparture || journey.startTime;
}

export function chooseRecurringTrip(rule, trips, occurrence, cancelled) {
  const sameLines = (trip) => JSON.stringify(serviceLines(trip)) === JSON.stringify(rule.lines);
  const distance = (trip) => Math.abs(Date.parse(scheduledDeparture(trip)) - occurrence);
  const matching = trips.filter((trip) => sameLines(trip) && distance(trip) <= 900_000).sort((a, b) => distance(a) - distance(b))[0];
  if (matching) return { trip: matching, fallback: false };
  const trip = trips.filter((item) => !cancelled(item) && Date.parse(item.startTime) >= occurrence)
    .sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime))[0];
  return trip ? { trip, fallback: true } : null;
}

function validRule(rule) {
  const place = (item) => typeof item?.id === 'string' && typeof item?.name === 'string';
  return typeof rule?.key === 'string' && place(rule.from) && place(rule.to) &&
    /^\d{4}-\d{2}-\d{2}$/.test(rule.start) && Number.isFinite(Date.parse(rule.start)) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time) &&
    Array.isArray(rule.days) && rule.days.length > 0 && rule.days.every((value) => Number.isInteger(value) && value >= 0 && value <= 6) &&
    Array.isArray(rule.lines) && rule.lines.every((line) => typeof line === 'string');
}

export function setupRecurringTrips({ getJson, renderJourney, isCancelled }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('recurring-dialog');
  const form = get('recurring-form');
  const list = get('recurring-items');
  const weekdayList = get('recurring-days');
  let entry;
  let rules = [];
  try {
    const data = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(data)) rules = data.filter(validRule);
  } catch {}

  for (const weekday of weekdays) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'day';
    input.value = String(weekday);
    label.append(input, weekdayLabels[weekday]);
    weekdayList.append(label);
  }

  function write(next) {
    localStorage.setItem(storageKey, JSON.stringify(next));
    rules = next;
    render();
  }

  function make(tag, value, classes) {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    if (classes) node.className = classes;
    return node;
  }

  function render() {
    get('recurring-empty').hidden = rules.length > 0;
    list.replaceChildren(...rules.map((rule) => {
      const details = make('details', null, 'panel recurring-trip');
      const next = nextOccurrence(rule);
      const summary = make('summary');
      summary.append(make('strong', `${rule.from.name} → ${rule.to.name}`),
        make('span', `${rule.days.length === 7 ? 'Täglich' : weekdays.filter((day) => rule.days.includes(day)).map((day) => weekdayLabels[day]).join(', ')} · ${rule.time} Uhr`, 'muted'),
        make('span', next === null ? 'Kein Termin gefunden' : `Nächste Fahrt · ${dateLabel.format(next)}`, 'muted'));
      const output = make('div', null, 'recurring-journey');
      const status = make('p', null, 'muted');
      status.setAttribute('role', 'status');
      const remove = make('button', 'Wiederholung entfernen');
      remove.type = 'button';
      remove.onclick = () => {
        try {
          write(rules.filter(({ key }) => key !== rule.key));
        } catch {
          status.textContent = 'Die Wiederholung konnte nicht entfernt werden.';
        }
      };
      let loaded;
      let loading;
      details.ontoggle = async () => {
        if (!details.open || loading) return;
        const occurrence = nextOccurrence(rule);
        if (occurrence === null || occurrence === loaded) return;
        loading = true;
        output.replaceChildren();
        status.textContent = 'Verbindung wird geladen …';
        try {
          const time = new Date(Math.max(Date.now() - 60_000, occurrence - 300_000)).toISOString();
          const routes = await getJson('/api/journeys', {
            from: rule.from.id, to: rule.to.id, time, arriveBy: 'false', cancellations: 'true', paged: 'true',
            ...(rule.options?.ticket === 'true' ? { ticket: 'true' } : {}),
            ...(typeof rule.options?.modes === 'string' ? { modes: rule.options.modes } : {}),
          });
          const found = chooseRecurringTrip(rule, routes.itineraries, occurrence, isCancelled);
          status.textContent = found?.fallback ? 'Die gewohnte Fahrt wurde nicht gefunden. Hier ist die früheste passende Weiterreise.'
            : found ? '' : 'Für diesen Termin wurde keine passende Verbindung gefunden.';
          if (found) {
            output.append(renderJourney(found.trip, { from: rule.from, to: rule.to, options: rule.options, saved: true, recurring: true }));
            loaded = occurrence;
          }
        } catch (error) {
          status.textContent = error.message;
        } finally {
          loading = false;
        }
      };
      details.append(summary, status, output, remove);
      return details;
    }));
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const days = new FormData(form).getAll('day').map(Number);
    if (!days.length) {
      get('recurring-status').textContent = 'Wähle mindestens einen Wochentag.';
      return;
    }
    const time = get('recurring-time').value;
    const rule = { ...entry, time, days };
    const key = JSON.stringify([rule.from.id, rule.to.id, time, days]);
    try {
      write([...rules.filter((item) => item.key !== key), { ...rule, key }]);
      dialog.close();
      location.hash = '#saved-trips';
    } catch {
      get('recurring-status').textContent = 'Die Wiederholung konnte nicht gespeichert werden.';
    }
  };
  get('cancel-recurring').onclick = () => dialog.close();
  render();
  return {
    render,
    open(journey, from, to, options) {
      const [start, time] = localParts(scheduledDeparture(journey));
      entry = { from, to, options, start, lines: serviceLines(journey) };
      get('recurring-route').textContent = `${from.name} → ${to.name}`;
      get('recurring-time').value = time;
      get('recurring-status').textContent = '';
      for (const input of weekdayList.querySelectorAll('input')) input.checked = true;
      dialog.showModal();
    },
    export: () => rules,
    import(items) {
      if (!Array.isArray(items)) return;
      const merged = new Map(items.filter(validRule).map((rule) => [rule.key, rule]));
      for (const rule of rules) merged.set(rule.key, rule);
      write([...merged.values()]);
    },
  };
}
