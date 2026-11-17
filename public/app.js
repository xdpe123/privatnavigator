const byId = (id) => document.getElementById(id);
const clock = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const modes = {
  WALK: 'Fußweg', HIGHSPEED_RAIL: 'Fernzug', LONG_DISTANCE: 'Fernzug',
  REGIONAL_RAIL: 'Regionalzug', REGIONAL_FAST_RAIL: 'Regionalzug',
  SUBURBAN: 'S-Bahn', SUBWAY: 'U-Bahn', TRAM: 'Straßenbahn', BUS: 'Bus',
};
const storageKey = 'privatnavigator.favorites.v1';
const tripStorageKey = 'privatnavigator.trips.v1';
const calendar = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
const places = { from: null, to: null };
const liveLocation = { id: 'live-location', name: 'Mein Standort', type: 'LOCATION' };
let favorites = [];
let savedTrips = [];
let activeSearch;
let pushSetup;
let serviceWorker;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved)) favorites = saved;
} catch {
  // Browser storage can be unavailable in private browsing.
}
try {
  const saved = JSON.parse(localStorage.getItem(tripStorageKey));
  if (Array.isArray(saved)) savedTrips = saved;
} catch {
  // Saved journeys are optional when the browser blocks local storage.
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function setStatus(id, message) {
  const status = byId(id);
  status.textContent = message;
  status.hidden = !message;
}

async function getJson(path, params, signal) {
  const response = await fetch(`${path}?${new URLSearchParams(params)}`, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function localNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function readyRoute() {
  return places.from && places.to && places.from.id !== places.to.id;
}

function currentRoute() {
  return { key: JSON.stringify([places.from.id, places.to.id]), from: places.from, to: places.to };
}

function refreshFavoriteButtons() {
  for (const field of ['from', 'to']) {
    const button = byId(`${field}-star`);
    const selected = places[field];
    const saved = Boolean(selected && favorites.some(({ key }) => key === selected.id));
    button.disabled = !selected;
    button.textContent = saved ? '★' : '☆';
    button.setAttribute('aria-pressed', String(saved));
  }
  const routeButton = byId('save-route');
  routeButton.disabled = !readyRoute();
  const saved = readyRoute() && favorites.some(({ key }) => key === currentRoute().key);
  routeButton.textContent = saved ? '★ Strecke gespeichert' : '☆ Strecke speichern';
  routeButton.setAttribute('aria-pressed', String(Boolean(saved)));
}

function choose(field, place) {
  places[field] = place;
  const input = byId(field);
  input.value = place?.name ?? '';
  input.setCustomValidity('');
  byId(`${field}-options`).hidden = true;
  setStatus(`${field}-status`, '');
  refreshFavoriteButtons();
  clearResults();
}

function clearResults() {
  activeSearch?.abort();
  byId('results').hidden = true;
}

function currentLocation() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext || !navigator.geolocation) {
      reject(new Error('Der Standortzugriff benötigt die HTTPS-Adresse der App.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      const id = `${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`;
      resolve({ ...liveLocation, id });
    }, (error) => {
      reject(new Error(error.code === 1
        ? 'Erlaube den Standortzugriff in den Einstellungen deines Browsers.'
        : 'Dein Standort konnte gerade nicht bestimmt werden.'));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
  });
}

function toggleFavorite(favorite) {
  const next = favorites.some(({ key }) => key === favorite.key)
    ? favorites.filter(({ key }) => key !== favorite.key)
    : [...favorites, favorite];
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    setStatus('form-status', 'Der Browser konnte den Favoriten nicht speichern.');
    return;
  }
  favorites = next;
  setStatus('form-status', '');
  renderFavorites();
}

function renderFavorites() {
  byId('favorites').hidden = !favorites.length;
  byId('favorite-items').replaceChildren(...favorites.map((favorite) => {
    const { from, to, place } = favorite;
    const label = place?.name || `${from.name} → ${to.name}`;
    const row = element('div', null, 'favorite-row');
    const open = element('button', label);
    open.type = 'button';
    open.onclick = () => {
      if (place) choose(places.from ? 'to' : 'from', place);
      else {
        choose('from', from);
        choose('to', to);
      }
    };
    const remove = element('button', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Favorit entfernen: ${label}`);
    remove.onclick = () => toggleFavorite(favorite);
    row.append(open, remove);
    return row;
  }));
  refreshFavoriteButtons();
}

for (const field of ['from', 'to']) {
  const input = byId(field);
  const options = byId(`${field}-options`);
  let timer;
  let pending;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    pending?.abort();
    places[field] = null;
    clearResults();
    input.setCustomValidity('');
    options.hidden = true;
    refreshFavoriteButtons();
    setStatus(`${field}-status`, '');
    const query = input.value.trim();
    if (query.length < 3) return;
    timer = setTimeout(async () => {
      const controller = new AbortController();
      pending = controller;
      try {
        const matches = await getJson('/api/stations', { q: query }, controller.signal);
        if (controller.signal.aborted || input.value.trim() !== query || places[field]) return;
        options.replaceChildren(...matches.map((place) => {
          const item = element('li');
          const button = element('button', place.name);
          button.type = 'button';
          button.append(element('small', [place.type === 'STOP' ? 'Haltestelle' : 'Ort', place.area].filter(Boolean).join(' · ')));
          button.onclick = () => {
            choose(field, place);
            input.focus();
          };
          item.append(button);
          return item;
        }));
        options.hidden = !matches.length;
        if (!matches.length) setStatus(`${field}-status`, 'Keine passenden Orte gefunden.');
      } catch (error) {
        if (!controller.signal.aborted && input.value.trim() === query && !places[field]) {
          setStatus(`${field}-status`, error.message);
        }
      }
    }, 400);
  });
  byId(`${field}-star`).onclick = () => toggleFavorite({ key: places[field].id, place: places[field] });
  const locate = byId(`${field}-location`);
  locate.onclick = async () => {
    const initial = input.value;
    const initialPlace = places[field];
    locate.disabled = true;
    options.hidden = true;
    setStatus(`${field}-status`, 'Standort wird ermittelt …');
    try {
      await currentLocation();
      if (input.value === initial && places[field] === initialPlace) choose(field, liveLocation);
    } catch (error) {
      if (input.value === initial && places[field] === initialPlace) setStatus(`${field}-status`, error.message);
    } finally {
      locate.disabled = false;
    }
  };
}

byId('reverse').onclick = () => {
  const { from, to } = places;
  choose('from', to);
  choose('to', from);
};
byId('save-route').onclick = () => toggleFavorite(currentRoute());
byId('now').onclick = () => {
  byId('time').value = localNow();
  clearResults();
};
byId('time').onchange = clearResults;
byId('direction').onchange = clearResults;
byId('time').value = localNow();
renderFavorites();

function timeLabel(value) {
  const date = new Date(value ?? NaN);
  return Number.isFinite(date.getTime()) ? clock.format(date) : '–';
}

function eventLabel(place, type, fallback) {
  const actual = place[type] || fallback;
  const scheduled = place[type === 'departure' ? 'scheduledDeparture' : 'scheduledArrival'];
  const minutes = Math.round((Date.parse(actual) - Date.parse(scheduled)) / 60_000);
  const delay = Number.isFinite(minutes) && minutes !== 0
    ? ` (${minutes > 0 ? '+' : ''}${minutes} Min., geplant ${timeLabel(scheduled)})` : '';
  const changed = place.track && place.scheduledTrack && place.track !== place.scheduledTrack;
  const track = place.track || place.scheduledTrack;
  const platform = track ? ` · ${changed ? 'Gleiswechsel auf ' : 'Gleis '}${track}` : '';
  const name = { START: 'Start', END: 'Ziel' }[place.name] || place.name || 'Wegpunkt';
  return `${timeLabel(actual)}${delay} · ${name}${platform}`;
}

function lineName(leg) {
  return leg.displayName || leg.routeShortName || modes[leg.mode] || leg.mode;
}

function lineBadge(leg) {
  const label = lineName(leg);
  const prefix = label.match(/^(ICE|IC|EC|RE|RB|S)(?=\s|\d|$)/i)?.[1].toUpperCase();
  const color = { ICE: 'ice', IC: 'ic', EC: 'ic', RE: 're', RB: 'rb', S: 'suburban' }[prefix]
    || { TRAM: 'tram', BUS: 'bus', SUBURBAN: 'suburban', HIGHSPEED_RAIL: 'ice', LONG_DISTANCE: 'ic', REGIONAL_RAIL: 're' }[leg.mode]
    || 'walk';
  return element('span', label, `line line-${color}`);
}

function legAlerts(leg) {
  const unique = new Map();
  const alerts = [leg.alerts, leg.from.alerts, leg.to.alerts,
    ...(leg.intermediateStops || []).map((stop) => stop.alerts)].flatMap((items) => items || []);
  for (const alert of alerts) {
    const title = alert.headerText?.trim();
    const message = alert.descriptionText?.trim();
    if (title || message) unique.set(JSON.stringify([title, message]), { title, message });
  }
  return [...unique.values()];
}

function renderLeg(leg) {
  const row = element('li', null, 'leg');
  const heading = element('h3');
  heading.append(lineBadge(leg));
  if (leg.headsign) heading.append(document.createTextNode(` Richtung ${leg.headsign}`));
  row.append(heading);
  if (leg.cancelled || leg.from.cancelled || leg.to.cancelled) row.append(element('p', 'Fahrt oder Halt fällt aus', 'problem'));
  else if (leg.mode !== 'WALK') row.append(element('p', leg.realTime ? 'Echtzeit verfügbar' : 'Fahrplanzeit', 'muted'));
  row.append(element('p', eventLabel(leg.from, 'departure', leg.startTime)));
  if (leg.intermediateStops?.length) {
    const details = element('details', null, 'stops');
    const stops = element('ul');
    for (const stop of leg.intermediateStops) {
      stops.append(element('li', eventLabel(stop, 'arrival', stop.departure) + (stop.cancelled ? ' · Halt entfällt' : '')));
    }
    details.append(element('summary', `${leg.intermediateStops.length} Zwischenhalte`), stops);
    row.append(details);
  }
  row.append(element('p', eventLabel(leg.to, 'arrival', leg.endTime)));
  for (const { title, message } of legAlerts(leg)) {
    const notice = element('aside', null, 'notice');
    notice.append(element('strong', title || 'Meldung zur Fahrt'));
    if (message && message !== title) notice.append(element('p', message));
    row.append(notice);
  }
  return row;
}

function renderJourney(journey, { from, to, best = false, saved = false } = {}) {
  const details = element('details', null, 'panel journey');
  const summary = element('summary');
  const duration = Math.round(journey.duration / 60);
  const changes = journey.transfers === 0 ? 'Direkt' : `${journey.transfers} Umst.`;
  const lines = element('div', null, 'lines');
  lines.append(...journey.legs.filter((leg) => leg.mode !== 'WALK').map(lineBadge));
  const hasAlerts = journey.legs.some((leg) => leg.cancelled || leg.from.cancelled || leg.to.cancelled || legAlerts(leg).length);
  summary.append(
    element('strong', `${timeLabel(journey.startTime)} → ${timeLabel(journey.endTime)}`),
    element('span', `${duration} Min. · ${changes}${best ? ' · Beste Zeit' : ''}`, 'trip-meta'),
    lines,
  );
  if (hasAlerts) summary.append(element('span', 'Fahrtmeldungen', 'trip-meta problem'));
  const steps = element('ol', null, 'legs');
  steps.append(...journey.legs.map(renderLeg));
  details.append(summary, steps);
  if (!saved && journey.id) {
    const existing = savedTrips.find((trip) => (trip.originalId || trip.journey.id) === journey.id);
    const save = element('button', existing ? '✓ Fahrt gespeichert' : '☆ Fahrt merken');
    save.type = 'button';
    save.className = 'save-trip';
    save.dataset.tripId = journey.id;
    save.disabled = Boolean(existing);
    save.onclick = async () => {
      const current = savedTrips.find((trip) => (trip.originalId || trip.journey.id) === journey.id);
      const trip = {
        key: Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, '0')).join(''),
        originalId: journey.id,
        from, to, journey, updated: Date.now(),
      };
      if (current || writeTrips([...savedTrips, trip])) {
        save.textContent = '✓ Fahrt gespeichert';
        save.disabled = true;
        if (!current && serviceWorker && Date.parse(journey.endTime) > Date.now()) {
          try {
            await startTripPush(trip);
          } catch (error) {
            setStatus('saved-status', error.name === 'NotAllowedError'
              ? 'Fahrt gespeichert. Erlaube Mitteilungen auf dem iPhone, um Updates zu erhalten.'
              : `Fahrt gespeichert. Push: ${error.message}`);
          }
        }
      }
    };
    details.append(save);
  }
  return details;
}

function writeTrips(next) {
  try {
    localStorage.setItem(tripStorageKey, JSON.stringify(next));
  } catch {
    setStatus('saved-status', 'Der Browser konnte die Fahrten nicht speichern.');
    return false;
  }
  savedTrips = next;
  setStatus('saved-status', '');
  renderSavedTrips();
  return true;
}

async function pushRequest(method, data) {
  const query = method === 'DELETE' ? `?id=${encodeURIComponent(data)}` : '';
  const response = await fetch(`/api/push/watch${query}`, {
    method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function startTripPush(trip) {
  const subscription = await serviceWorker.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: pushSetup.publicKey,
  });
  const { id } = await pushRequest('POST', {
    tripKey: trip.key, itineraryId: trip.journey.id, subscription: subscription.toJSON(),
  });
  if (!savedTrips.some(({ key }) => key === trip.key) ||
      !writeTrips(savedTrips.map((item) => item.key === trip.key ? { ...item, watchId: id } : item))) {
    await pushRequest('DELETE', id);
  }
}

async function setupPush() {
  const response = await fetch('/api/push');
  pushSetup = await response.json();
  if (window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && pushSetup.enabled) {
    await navigator.serviceWorker.register('/sw.js');
    serviceWorker = await navigator.serviceWorker.ready;
  }
  renderSavedTrips();
}

function renderSavedTrips() {
  byId('saved-empty').hidden = Boolean(savedTrips.length);
  byId('saved-items').replaceChildren(...[...savedTrips].sort((a, b) =>
    Date.parse(a.journey.startTime) - Date.parse(b.journey.startTime)
  ).map((trip) => {
    const card = element('article', null, 'saved-trip');
    card.id = `fahrt-${trip.key}`;
    const heading = element('h3', `${trip.from.name} → ${trip.to.name}`);
    const stamp = element('p', `${calendar.format(new Date(trip.journey.startTime))} · Datenstand ${timeLabel(trip.updated)}`, 'muted');
    const details = renderJourney(trip.journey, { saved: true });
    const actions = element('div', null, 'trip-actions');
    const refresh = element('button', 'Live aktualisieren');
    const remove = element('button', 'Entfernen');
    refresh.type = remove.type = 'button';
    refresh.className = 'refresh-trip';
    const status = element('p', null, 'field-status');
    status.setAttribute('role', 'status');
    refresh.onclick = async () => {
      refresh.disabled = true;
      status.textContent = 'Aktualisiere …';
      try {
        const journey = await getJson('/api/refresh', { id: trip.journey.id });
        if (!Array.isArray(journey.legs)) throw new Error('Der Fahrplandienst hat keine Fahrtdetails geliefert.');
        if (savedTrips.some(({ key }) => key === trip.key) && writeTrips(savedTrips.map((item) =>
          item.key === trip.key ? { ...item, journey, updated: Date.now() } : item
        ))) {
          const updated = byId(card.id);
          updated.querySelector('.journey').open = true;
          updated.querySelector('button').focus({ preventScroll: true });
          setStatus('saved-status', 'Fahrt aktualisiert.');
        }
      } catch (error) {
        status.textContent = `${error.message} Der gespeicherte Stand ist weiter verfügbar.`;
      } finally {
        refresh.disabled = false;
      }
    };
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        if (trip.watchId) await pushRequest('DELETE', trip.watchId);
        if (writeTrips(savedTrips.filter(({ key }) => key !== trip.key))) {
          document.querySelectorAll('#journeys .save-trip').forEach((button) => {
            if (button.dataset.tripId === (trip.originalId || trip.journey.id)) {
              button.disabled = false;
              button.textContent = '☆ Fahrt merken';
            }
          });
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        remove.disabled = false;
      }
    };
    actions.append(refresh);
    if (serviceWorker || trip.watchId) {
      const push = element('button', trip.watchId ? 'Push deaktivieren' : 'Push aktivieren');
      push.type = 'button';
      push.disabled = !trip.watchId && Date.parse(trip.journey.endTime) <= Date.now();
      push.onclick = async () => {
        push.disabled = remove.disabled = true;
        try {
          if (trip.watchId) {
            await pushRequest('DELETE', trip.watchId);
            writeTrips(savedTrips.map((item) => item.key === trip.key ? { ...item, watchId: null } : item));
          } else {
            await startTripPush(trip);
          }
        } catch (error) {
          status.textContent = error.name === 'NotAllowedError'
            ? 'Erlaube Mitteilungen in den iPhone-Einstellungen für diese Web-App.' : error.message;
        } finally {
          push.disabled = remove.disabled = false;
        }
      };
      actions.append(push);
    } else if (pushSetup?.enabled) {
      status.textContent = 'Für iPhone-Push öffne die App vom Home-Bildschirm.';
    }
    actions.append(remove);
    card.append(heading, stamp, details, actions, status);
    return card;
  }));
}

renderSavedTrips();
void setupPush().catch(() => {});

byId('export-data').onclick = () => {
  const trips = savedTrips.map(({ watchId, ...trip }) => trip);
  const data = new Blob([JSON.stringify({ version: 1, favorites, trips })], { type: 'application/json' });
  const url = URL.createObjectURL(data);
  const download = element('a');
  download.href = url;
  download.download = 'privatnavigator-daten.json';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function importedPlace(place) {
  return typeof place?.id === 'string' && typeof place?.name === 'string';
}

function importedTrip(trip) {
  const journey = trip?.journey;
  return /^[a-f0-9]{24}$/.test(trip?.key) && importedPlace(trip.from) && importedPlace(trip.to) &&
    typeof journey?.id === 'string' && Number.isFinite(trip.updated) &&
    Number.isFinite(Date.parse(journey.startTime)) && Number.isFinite(Date.parse(journey.endTime)) &&
    Array.isArray(journey.legs) && journey.legs.every((leg) => typeof leg?.mode === 'string' &&
      leg.from && leg.to && (!leg.intermediateStops || Array.isArray(leg.intermediateStops)));
}

byId('import-data').onclick = () => byId('import-file').click();
byId('import-file').onchange = async (event) => {
  const input = event.target;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('Die Datei ist größer als 5 MB.');
    const data = JSON.parse(await file.text());
    if (data?.version !== 1 || !Array.isArray(data.favorites) || !Array.isArray(data.trips)) {
      throw new Error('Das ist keine Sicherungsdatei des Privatnavigators.');
    }
    const addedFavorites = data.favorites.filter((favorite) => typeof favorite?.key === 'string' &&
      (favorite.place ? importedPlace(favorite.place) : importedPlace(favorite.from) && importedPlace(favorite.to)));
    const addedTrips = data.trips.filter(importedTrip).map(({ watchId, ...trip }) => trip);
    const unique = (items) => [...new Map(items.map((item) => [item.key, item])).values()];
    const nextFavorites = unique([...addedFavorites, ...favorites]);
    const nextTrips = unique([...addedTrips, ...savedTrips]);
    localStorage.setItem(storageKey, JSON.stringify(nextFavorites));
    favorites = nextFavorites;
    renderFavorites();
    if (!writeTrips(nextTrips)) throw new Error('Die Fahrten konnten nicht vollständig gespeichert werden.');
    setStatus('transfer-status', 'Daten eingelesen. Mitteilungen kannst du für übertragene Fahrten erneut aktivieren.');
  } catch (error) {
    setStatus('transfer-status', error.message);
  }
};

function openTripLink() {
  if (!/^#fahrt-[a-f0-9]{24}$/.test(location.hash)) return;
  const card = byId(location.hash.slice(1));
  if (!card) {
    setStatus('saved-status', 'Diese Fahrt ist in diesem Browser nicht gespeichert.');
    return;
  }
  card.querySelector('.journey').open = true;
  card.scrollIntoView();
  card.querySelector('.refresh-trip').click();
}

window.addEventListener('hashchange', openTripLink);
openTripLink();

byId('planner').addEventListener('submit', async (event) => {
  event.preventDefault();
  for (const field of ['from', 'to']) {
    if (!places[field]) {
      setStatus('form-status', 'Bitte Start und Ziel aus den Vorschlägen auswählen.');
      byId(field).focus();
      return;
    }
  }
  if (!readyRoute()) {
    setStatus('form-status', 'Start und Ziel müssen unterschiedlich sein.');
    return;
  }
  activeSearch?.abort();
  const controller = new AbortController();
  activeSearch = controller;
  setStatus('form-status', '');
  byId('results').hidden = false;
  const content = byId('journeys');
  content.replaceChildren();
  setStatus('result-status', `Suche ${places.from.name} → ${places.to.name} …`);
  try {
    let { from, to } = places;
    if (from.type === 'LOCATION' || to.type === 'LOCATION') {
      const position = await currentLocation();
      if (controller.signal.aborted) return;
      if (from.type === 'LOCATION') from = position;
      if (to.type === 'LOCATION') to = position;
    }
    const arriveBy = byId('direction').value === 'true';
    const journeys = await getJson('/api/journeys', {
      from: from.id,
      to: to.id,
      time: new Date(byId('time').value).toISOString(),
      arriveBy,
    }, controller.signal);
    if (controller.signal.aborted) return;
    journeys.sort((a, b) => (arriveBy ? Date.parse(b.startTime) - Date.parse(a.startTime)
      : Date.parse(a.endTime) - Date.parse(b.endTime)) || a.transfers - b.transfers || a.duration - b.duration);
    content.replaceChildren(...journeys.map((journey, index) =>
      renderJourney(journey, { from, to, best: index === 0 })
    ));
    setStatus('result-status', journeys.length ? '' : 'Keine Verbindungen im Suchzeitraum gefunden.');
  } catch (error) {
    if (!controller.signal.aborted) setStatus('result-status', error.message);
  }
});
