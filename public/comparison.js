import { isCancelled, transfersFor } from './journey-details.js';

const clock = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const day = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
const preferenceKey = 'privatnavigator.connection-preferences';

export function connectionFacts(trip) {
  const checks = transfersFor(trip);
  const walking = trip.legs.filter(leg => leg.mode === 'WALK').reduce((total, leg) =>
    total + Math.max(0, Date.parse(leg.endTime) - Date.parse(leg.startTime)), 0);
  return {
    trip, departure: Date.parse(trip.startTime), arrival: Date.parse(trip.endTime),
    duration: Math.round(trip.duration / 60), transfers: trip.transfers ?? checks.length,
    walk: Math.ceil(walking / 60000), buffer: checks.length ? Math.min(...checks.map(check => check.minutes)) : Infinity,
    cancelled: isCancelled(trip),
  };
}

export function setupComparison(getTrips, display) {
  const form = document.getElementById('connection-preferences');
  const dialog = document.getElementById('comparison');
  const compare = document.getElementById('compare-routes');
  let visible = [];
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey)) || {};
    for (const select of form.querySelectorAll('select')) {
      if ([...select.options].some(option => option.value === saved[select.name])) select.value = saved[select.name];
    }
  } catch {}
  function apply() {
    const options = Object.fromEntries(new FormData(form));
    const trips = getTrips();
    visible = trips.map(connectionFacts).filter(row =>
      (!options.changes || row.transfers <= Number(options.changes)) &&
      (!options.walking || row.walk <= Number(options.walking)) &&
      (!options.buffer || row.buffer >= Number(options.buffer)))
      .sort((a,b) => a[options.order] - b[options.order] || a.departure - b.departure);
    display(visible.map(row => row.trip));
    const count = document.getElementById('match-count');
    count.textContent = visible.length + ' von ' + trips.length;
    compare.disabled = !visible.some(row => !row.cancelled && row.buffer >= 0);
  }
  function save() {
    apply();
    try { localStorage.setItem(preferenceKey, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {}
  }
  form.onchange = save;
  form.onreset = () => queueMicrotask(save);
  compare.onclick = () => {
    const body = document.getElementById('comparison-body');
    body.replaceChildren();
    const candidates = visible.filter(row => !row.cancelled && row.buffer >= 0);
    const winners = new Map();
    for (const [key, label] of [['arrival','Früheste Ankunft'], ['duration','Kürzeste Fahrt'], ['transfers','Wenigste Umstiege'], ['walk','Kürzester Fußweg']]) {
      const best = [...candidates].sort((a,b) => a[key] - b[key] || a.arrival - b.arrival)[0];
      if (!best) continue;
      if (!winners.has(best)) winners.set(best, []);
      winners.get(best).push(label);
    }
    for (const [row, labels] of winners) {
      const card = document.createElement('article');
      const title = document.createElement('h3');
      title.textContent = day.format(row.departure) + ' · ' + clock.format(row.departure) + ' → ' + clock.format(row.arrival);
      const metrics = document.createElement('p');
      metrics.textContent = [row.duration + ' Min.', row.transfers ? row.transfers + ' Umst.' : 'Direkt', row.walk + ' Min. Fußweg',
        ...(Number.isFinite(row.buffer) ? [row.buffer + ' Min. kürzeste Umstiegsreserve'] : [])].join(' · ');
      const reason = document.createElement('small');
      reason.textContent = labels.join(' · ');
      const open = document.createElement('button');
      open.textContent = 'Zur Verbindung';
      open.onclick = () => {
        dialog.close();
        const target = [...document.querySelectorAll('#journeys > .journey')].find(node => node.dataset.journeyId === row.trip.id);
        if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); }
      };
      card.append(reason, title, metrics, open);
      body.append(card);
    }
    dialog.showModal();
  };
  return { apply };
}
