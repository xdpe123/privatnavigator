import { allGroups, modeGroups, ticketGroups } from './search-filters.js';
import { createRouteMap } from './route-map.js';

const byId = (id) => document.getElementById(id);
const clock = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const modes = {
  WALK: 'Fußweg', HIGHSPEED_RAIL: 'Fernzug', LONG_DISTANCE: 'Fernzug',
  REGIONAL_RAIL: 'Regionalzug', REGIONAL_FAST_RAIL: 'Regionalzug',
  SUBURBAN: 'S-Bahn', SUBWAY: 'U-Bahn', TRAM: 'Straßenbahn', BUS: 'Bus',
};
const storageKey = 'privatnavigator.favorites.v1';
const tripStorageKey = 'privatnavigator.trips.v1';
const filterStorageKey = 'privatnavigator.filters.v1';
const calendar = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
const dateTimeLabel = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const places = { from: null, to: null };
const liveLocation = { id: 'live-location', name: 'Mein Standort', type: 'LOCATION' };
let favorites = [];
let savedTrips = [];
let activeSearch;
let tripQuery;
let tripPage;
let resultsReady = false;
let pushSetup;
let serviceWorker;
let filters = { ticket: false, groups: allGroups };
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
try {
  const saved = JSON.parse(localStorage.getItem(filterStorageKey));
  if (saved?.groups?.length && saved.groups.every((group) => allGroups.includes(group))) {
    filters = { ticket: Boolean(saved.ticket), groups: saved.groups };
  }
} catch {
  // Default modes work without local storage.
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
  const compact = byId('result-favorite');
  compact.disabled = !readyRoute();
  compact.textContent = saved ? '★' : '☆';
  compact.setAttribute('aria-pressed', String(Boolean(saved)));
  compact.setAttribute('aria-label', saved ? 'Strecke aus Favoriten entfernen' : 'Strecke als Favorit speichern');
}

function choose(field, place, invalidate = true) {
  places[field] = place;
  const input = byId(field);
  input.value = place?.name ?? '';
  input.setCustomValidity('');
  byId(`${field}-options`).hidden = true;
  setStatus(`${field}-status`, '');
  refreshFavoriteButtons();
  if (invalidate) clearResults();
}

function clearResults() {
  activeSearch?.abort();
  tripQuery = tripPage = null;
  resultsReady = false;
  if (location.hash === '#verbindungen') showView();
}

const modeInputs = new Map(allGroups.map((group) => {
  const label = element('label', null, 'option');
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, document.createTextNode(modeGroups[group].label));
  byId('mode-options').append(label);
  return [group, checkbox];
}));
const filterDialog = byId('search-filters');
const ticketInput = byId('ticket-filter');
ticketInput.onchange = () => {
  for (const [group, input] of modeInputs) input.disabled = ticketInput.checked && !ticketGroups.includes(group);
};
byId('open-filters').onclick = () => {
  ticketInput.checked = filters.ticket;
  for (const [group, input] of modeInputs) input.checked = filters.groups.includes(group);
  ticketInput.onchange();
  setStatus('filter-status', '');
  filterDialog.showModal();
};
byId('close-filters').onclick = () => filterDialog.close();
byId('filter-form').onsubmit = (event) => {
  event.preventDefault();
  const groups = allGroups.filter((group) => modeInputs.get(group).checked);
  if (!groups.some((group) => !ticketInput.checked || ticketGroups.includes(group))) {
    setStatus('filter-status', 'Wähle mindestens ein passendes Verkehrsmittel aus.');
    return;
  }
  filters = { ticket: ticketInput.checked, groups };
  try {
    localStorage.setItem(filterStorageKey, JSON.stringify(filters));
  } catch {
    // Apply for this session when persistent storage is unavailable.
  }
  updateFilterSummary();
  clearResults();
  filterDialog.close();
};

function updateFilterSummary() {
  const active = filters.ticket ? 'Deutschlandticket · Nahverkehr' : '';
  const groups = filters.groups.length < allGroups.length ? 'Verkehrsmittel gefiltert' : '';
  setStatus('filter-summary', [active, groups].filter(Boolean).join(' · '));
}

updateFilterSummary();

const usageKinds = { places: 'Ortsvorschläge', routes: 'Verbindungen', updates: 'Fahrtupdates' };
const usageDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const totalUsage = (entry) => entry.places + entry.routes + entry.updates;

async function loadUsage() {
  const refresh = byId('reload-usage');
  refresh.disabled = true;
  setStatus('usage-status', 'Statistik wird geladen …');
  try {
    const { limit, rolling, days } = await getJson('/api/usage', {});
    byId('usage-total').textContent = `${rolling} / ${limit}`;
    byId('usage-limit').max = limit;
    byId('usage-limit').value = rolling;
    byId('usage-today').textContent = `Heute: ${totalUsage(days.at(-1))} Aufrufe · ${limit - rolling} im laufenden Budget verfügbar`;
    const max = Math.max(1, ...days.map(totalUsage));
    byId('usage-history').replaceChildren(...[...days].reverse().map((entry) => {
      const row = element('li');
      const date = element('time', usageDate.format(Date.parse(entry.date)));
      date.dateTime = entry.date;
      const bar = element('span', null, 'usage-bar');
      bar.setAttribute('role', 'img');
      const label = Object.entries(usageKinds).map(([kind, name]) => `${name}: ${entry[kind]}`).join(', ');
      bar.setAttribute('aria-label', label);
      row.title = label;
      for (const kind of Object.keys(usageKinds)) {
        const segment = element('span', null, `usage-${kind}`);
        segment.style.width = `${entry[kind] / max * 100}%`;
        bar.append(segment);
      }
      row.append(date, bar, element('strong', totalUsage(entry)));
      return row;
    }));
    byId('usage-report').hidden = false;
    setStatus('usage-status', '');
  } catch (error) {
    setStatus('usage-status', `Statistik konnte nicht geladen werden. ${error.message}`);
  } finally {
    refresh.disabled = false;
  }
}

byId('reload-usage').onclick = loadUsage;

for (const option of document.querySelectorAll('input[name="theme"]')) {
  option.checked = option.value === (document.documentElement.dataset.theme || 'light');
  option.onchange = () => {
    document.documentElement.dataset.theme = option.value;
    document.querySelector('meta[name="theme-color"]').content = option.value === 'dark' ? '#171a1e' : '#f4f4f6';
    try {
      localStorage.setItem('privatnavigator.theme', option.value);
    } catch {
      // The choice still applies during this session.
    }
  };
}

const tabs = [...document.querySelectorAll('.bottom-nav a[data-view]')];
let currentView;

function showView() {
  const hash = location.hash;
  const view = hash === '#verbindungen' && resultsReady ? 'results' : hash === '#settings' ? 'settings'
    : hash === '#saved-trips' || hash.startsWith('#fahrt-') ? 'saved-trips' : 'search-view';
  if (view === currentView) return;
  currentView = view;
  document.body.dataset.view = view;
  byId('results').hidden = view !== 'results';
  byId('app-header').hidden = view === 'results';
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    byId(tab.dataset.view).hidden = !selected;
    if (selected || (view === 'results' && tab.dataset.view === 'search-view')) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (view === 'settings') void loadUsage();
}

const openRouteMap = createRouteMap((id, signal) => getJson('/api/refresh', { id, geometry: 'true' }, signal));

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
  const picker = input.closest('.place');
  let timer;
  let pending;
  let suggestionsOpen = false;

  function showPlaces(matches, isFavorite = false) {
    options.replaceChildren(...matches.map((place) => {
      const item = element('li');
      const button = element('button', place.name);
      button.type = 'button';
      const category = isFavorite ? 'Favorit' : place.type === 'STOP' ? 'Haltestelle' : 'Ort';
      button.append(element('small', [category, place.area].filter(Boolean).join(' · ')));
      button.onclick = () => {
        input.focus();
        choose(field, place);
      };
      item.append(button);
      return item;
    }));
    options.hidden = !matches.length;
  }

  function offerFavorites() {
    if (input.value.trim() && !places[field]) return;
    suggestionsOpen = true;
    showPlaces(favorites.flatMap(({ place }) => place?.type === 'STOP' ? [place] : []), true);
  }

  function closeSuggestions() {
    suggestionsOpen = false;
    options.hidden = true;
  }

  input.addEventListener('focus', offerFavorites);
  input.addEventListener('click', offerFavorites);
  picker.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !picker.contains(event.relatedTarget)) closeSuggestions();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!picker.contains(event.target)) closeSuggestions();
  });
  picker.addEventListener('keydown', (event) => {
    if (options.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      input.focus();
      closeSuggestions();
    } else if (event.key === 'ArrowDown' && event.target === input) {
      event.preventDefault();
      options.querySelector('button')?.focus();
    }
  });
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
    suggestionsOpen = true;
    if (!query) {
      offerFavorites();
      return;
    }
    if (query.length < 3) return;
    timer = setTimeout(async () => {
      const controller = new AbortController();
      pending = controller;
      try {
        const matches = await getJson('/api/stations', { q: query }, controller.signal);
        if (controller.signal.aborted || !suggestionsOpen || input.value.trim() !== query || places[field]) return;
        showPlaces(matches);
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
    closeSuggestions();
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
byId('result-favorite').onclick = () => toggleFavorite(currentRoute());
byId('result-swap').onclick = () => {
  const { from, to } = places;
  choose('from', to, false);
  choose('to', from, false);
  byId('planner').requestSubmit();
};

function showSelectedTime() {
  const date = new Date(byId('time').value);
  byId('time-display').textContent = Number.isFinite(date.getTime()) ? dateTimeLabel.format(date) : 'Datum und Uhrzeit wählen';
}

byId('now').onclick = () => {
  byId('time').value = localNow();
  showSelectedTime();
  clearResults();
};
byId('time').oninput = () => {
  showSelectedTime();
  clearResults();
};
byId('time').onchange = byId('time').oninput;
byId('direction').onchange = clearResults;
byId('time').value = localNow();
showSelectedTime();
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
  const mapButton = element('button', 'Route auf der Karte', 'map-link');
  mapButton.type = 'button';
  mapButton.onclick = () => void openRouteMap(journey);
  const steps = element('ol', null, 'legs');
  steps.append(...journey.legs.map((leg, index) => {
    const row = renderLeg(leg);
    if (leg.mode === 'WALK') {
      const button = element('button', 'Fußweg auf der Karte', 'map-link');
      button.type = 'button';
      button.onclick = () => void openRouteMap(journey, index);
      row.append(button);
    }
    return row;
  }));
  details.append(summary, mapButton, steps);
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
        if (!current && serviceWorker && pushSetup.enabled && Date.parse(journey.endTime) > Date.now()) {
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
  if (window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window &&
      (pushSetup.enabled || pushSetup.testEnabled)) {
    await navigator.serviceWorker.register('/sw.js');
    serviceWorker = await navigator.serviceWorker.ready;
  }
  if (pushSetup.testEnabled) {
    byId('push-test').hidden = false;
    byId('send-push-test').disabled = !serviceWorker;
    if (!serviceWorker) setStatus('push-test-status', 'Auf dem iPhone in Safari zum Home-Bildschirm hinzufügen und über das App-Symbol öffnen.');
  }
  renderSavedTrips();
}

byId('send-push-test').onclick = async () => {
  const button = byId('send-push-test');
  button.disabled = true;
  try {
    const subscription = await serviceWorker.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: pushSetup.publicKey,
    });
    const response = await fetch('/api/push/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription.toJSON()),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.resetSubscription) {
        await subscription.unsubscribe();
        throw new Error(`${result.error} Das alte Abo wurde zurückgesetzt. Tippe erneut auf „Testmitteilung senden“.`);
      }
      throw new Error(result.diagnostic ? `${result.error} (${result.diagnostic})` : result.error);
    }
    setStatus('push-test-status', 'Apple hat die Testmitteilung angenommen. Prüfe deine Mitteilungszentrale.');
  } catch (error) {
    setStatus('push-test-status', error.name === 'NotAllowedError'
      ? 'Erlaube Mitteilungen in den iPhone-Einstellungen für diese Web-App.' : error.message);
  } finally {
    button.disabled = false;
  }
};

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
    if ((serviceWorker && pushSetup.enabled) || trip.watchId) {
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
  showView();
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

const paging = { earlier: byId('earlier-trips'), later: byId('later-trips') };

function updatePaging(busy = false) {
  for (const [direction, button] of Object.entries(paging)) {
    button.hidden = !tripPage?.[direction];
    button.disabled = busy;
  }
}

async function showTripPage(query, controller, direction) {
  const cursor = direction && tripPage?.[direction];
  updatePaging(true);
  if (direction) setStatus('result-status', 'Weitere Verbindungen werden geladen …');
  try {
    const page = await getJson('/api/journeys', {
      ...query.params, paged: 'true', ...(cursor ? { cursor } : {}),
    }, controller.signal);
    if (controller.signal.aborted) return;
    if (cursor && page[direction] === cursor) page[direction] = null;
    tripPage = page;
    const { itineraries } = page;
    itineraries.sort((a, b) => (query.params.arriveBy ? Date.parse(b.startTime) - Date.parse(a.startTime)
      : Date.parse(a.endTime) - Date.parse(b.endTime)) || a.transfers - b.transfers || a.duration - b.duration);
    byId('journeys').replaceChildren(...itineraries.map((journey, index) =>
      renderJourney(journey, { from: query.from, to: query.to, best: index === 0 })
    ));
    setStatus('result-status', itineraries.length ? '' : 'Keine Verbindungen im Suchzeitraum gefunden.');
    if (direction) byId('results-title').focus();
  } catch (error) {
    if (!controller.signal.aborted) setStatus('result-status', error.message);
  } finally {
    if (!controller.signal.aborted) updatePaging();
  }
}

for (const [direction, button] of Object.entries(paging)) {
  button.onclick = () => {
    if (tripQuery && tripPage?.[direction]) {
      activeSearch?.abort();
      activeSearch = new AbortController();
      void showTripPage(tripQuery, activeSearch, direction);
    }
  };
}

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
  tripQuery = tripPage = null;
  updatePaging();
  setStatus('form-status', '');
  resultsReady = true;
  byId('query-from').textContent = places.from.name;
  byId('query-to').textContent = places.to.name;
  const arriveBy = byId('direction').value === 'true';
  const date = new Date(byId('time').value);
  byId('query-time').textContent = `${arriveBy ? 'Ankunft' : 'Abfahrt'} · ${dateTimeLabel.format(date)}`;
  setStatus('query-filters', byId('filter-summary').textContent);
  byId('journeys').replaceChildren();
  setStatus('result-status', 'Verbindungen werden gesucht …');
  location.hash = '#verbindungen';
  showView();
  byId('results-title').focus({ preventScroll: true });
  try {
    let { from, to } = places;
    if (from.type === 'LOCATION' || to.type === 'LOCATION') {
      const position = await currentLocation();
      if (controller.signal.aborted) return;
      if (from.type === 'LOCATION') from = position;
      if (to.type === 'LOCATION') to = position;
    }
    const params = {
      from: from.id,
      to: to.id,
      time: date.toISOString(),
      arriveBy,
      ...(filters.ticket ? { ticket: 'true' } : {}),
      ...(filters.groups.length < allGroups.length ? { modes: filters.groups.join(',') } : {}),
    };
    tripQuery = { from, to, params };
    await showTripPage(tripQuery, controller);
  } catch (error) {
    if (!controller.signal.aborted) setStatus('result-status', error.message);
  }
});
