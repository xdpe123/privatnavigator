import { allGroups, modeGroups, ticketGroups } from './search-filters.js';
import { createRouteMap } from './route-map.js';
import { alternativeStops, calendarFile, isCancelled, shortestAlternatives, transfersFor, tripTimeline } from './journey-details.js';
import { nextOccurrence, setupRecurringTrips } from './recurring-trips.js';
import { setupPunctuality } from './punctuality-view.js';
import { normalizePushOptions, pushOptions } from './push-options.js';

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
const reloadStorageKey = 'privatnavigator.reload.v1';
const pushSettingsKey = 'privatnavigator.push-settings.v1';
const calendar = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
const dateTimeLabel = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const places = { from: null, to: null };
const liveLocation = { id: 'live-location', name: 'Mein Standort', type: 'LOCATION' };
let favorites = [];
let savedTrips = [];
let activeSearch;
let tripQuery;
let tripPage;
let displayedJourneys = [];
let displayedEvents = [];
let resultsReady = false;
const liveRequests = new Map();
const savedRefreshes = new Map();
let restoreCursor;
let pushSetup;
let serviceWorker;
let automaticPush = true;
let budgetPush = true;
let pushPreferences = normalizePushOptions();
const pushRegistrations = new Map();
try {
  const stored = JSON.parse(localStorage.getItem(pushSettingsKey));
  automaticPush = stored?.automatic !== false;
  budgetPush = stored?.budget !== false;
  pushPreferences = normalizePushOptions(stored?.preferences);
} catch {}
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

function fetchLiveJourney(id) {
  if (!liveRequests.has(id)) {
    const request = getJson('/api/refresh', { id }).then((journey) => {
      if (!Array.isArray(journey.legs)) throw new Error('Der Fahrplandienst hat keine Fahrtdetails geliefert.');
      return journey;
    }).finally(() => liveRequests.delete(id));
    liveRequests.set(id, request);
  }
  return liveRequests.get(id);
}

function refreshSavedTrip(trip) {
  if (!savedRefreshes.has(trip.key)) {
    const request = fetchLiveJourney(trip.journey.id).then((journey) => {
      const destination = journey.legs.at(-1)?.to;
      const observed = destination?.arrivalTimestampReason === 'OBSERVED' ? Date.parse(destination.arrival) : NaN;
      const confirmedArrival = Number.isFinite(observed) && observed <= Date.now() ? observed : trip.confirmedArrival;
      if (savedTrips.some(({ key }) => key === trip.key)) {
        const written = writeTrips(savedTrips.map((item) =>
          item.key === trip.key ? { ...item, journey, confirmedArrival, updated: Date.now() } : item));
        if (!written) throw new Error('Der neue Stand konnte nicht gespeichert werden.');
      }
    }).finally(() => savedRefreshes.delete(trip.key));
    savedRefreshes.set(trip.key, request);
  }
  return savedRefreshes.get(trip.key);
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

const usageKinds = { places: 'Ortsvorschläge', routes: 'Verbindungen', updates: 'Fahrtupdates und Tafeln' };
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

setupPunctuality(getJson);

const punctualityLabels = { observed: 'Ankunft gemeldet', forecast: 'Letzte Prognose', cancelled: 'Ausfall gemeldet', unknown: 'Unbekannt' };

async function loadPunctuality() {
  const button = byId('reload-punctuality');
  if (button.disabled) return;
  button.disabled = true;
  setStatus('punctuality-status', 'Fahrtstatistik wird geladen …');
  try {
    const { routes, cloudOnly } = await getJson('/api/punctuality', {});
    const list = byId('punctuality-routes');
    list.replaceChildren(...routes.map((route) => {
      const panel = element('details', null, 'punctuality-route');
      const summary = element('summary', `${route.origin} → ${route.destination}`);
      const rate = route.observed ? Math.round(route.onTime / route.observed * 100) : null;
      const count = `${route.total} überwacht · ${route.observed} Ankünfte gemeldet`;
      const label = rate === null ? count : `${rate} % pünktlich · ${count}`;
      summary.append(element('small', label, 'muted'));
      const bar = element('div', null, 'usage-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${route.onTime} pünktlich, ${route.observed - route.onTime} verspätet, ${route.forecast} Prognosen, ${route.cancelled} Ausfälle, ${route.unknown} unbekannt`);
      for (const [kind, total] of Object.entries({
        onTime: route.onTime, late: route.observed - route.onTime,
        forecast: route.forecast, cancelled: route.cancelled, unknown: route.unknown,
      })) {
        const segment = element('span', null, `punctuality-${kind}`);
        segment.style.width = `${total / route.total * 100}%`;
        bar.append(segment);
      }
      const detail = element('ul', null, 'punctuality-recent');
      for (const row of route.recent) {
        const minutes = row.delay === null ? null : Math.round(row.delay / 60);
        const delay = minutes === null ? '' : ` · ${minutes > 0 ? '+' : ''}${minutes} Min.`;
        detail.append(element('li', `${dateTimeLabel.format(new Date(row.departure))} · ${row.lines} · ${punctualityLabels[row.kind]}${delay}`));
      }
      panel.append(summary, bar, element('p', `${route.forecast} Prognosen · ${route.cancelled} Ausfälle · ${route.unknown} ohne verwertbare Ankunftsdaten`, 'muted'), detail);
      return panel;
    }));
    setStatus('punctuality-status', cloudOnly ? 'Die Fahrtstatistik ist in der HTTPS-App verfügbar.'
      : routes.length ? '' : 'Die Statistik beginnt mit diesem Update. Abgeschlossene überwachte Fahrten erscheinen hier nach und nach.');
  } catch (error) {
    setStatus('punctuality-status', error.message);
  } finally {
    button.disabled = false;
  }
}

byId('reload-punctuality').onclick = loadPunctuality;

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
    : hash === '#favoriten' ? 'favorites-view' : hash.startsWith('#fahrt-') || hash.startsWith('#wiederholung-') ? 'journey-view'
    : hash === '#saved-trips' ? 'saved-trips' : 'search-view';
  if (view === currentView) return;
  currentView = view;
  document.body.dataset.view = view;
  byId('results').hidden = view !== 'results';
  byId('journey-view').hidden = view !== 'journey-view';
  byId('favorites-view').hidden = view !== 'favorites-view';
  byId('app-header').hidden = ['results', 'journey-view', 'favorites-view'].includes(view);
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    byId(tab.dataset.view).hidden = !selected;
    if (selected || (['results', 'favorites-view'].includes(view) && tab.dataset.view === 'search-view') ||
        (view === 'journey-view' && tab.dataset.view === 'saved-trips')) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (view === 'settings') {
    void loadUsage();
    void loadPunctuality();
  }
  if (view === 'saved-trips') recurringTrips.render();
}

const openRouteMap = createRouteMap((id, signal) => getJson('/api/refresh', { id, geometry: 'true' }, signal));
const recurringTrips = setupRecurringTrips({ getJson, renderJourney, isCancelled });

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
    writeFavorites(next);
  } catch {
    setStatus('form-status', 'Der Browser konnte den Favoriten nicht speichern.');
    return;
  }
  setStatus('form-status', '');
}

function writeFavorites(next) {
  localStorage.setItem(storageKey, JSON.stringify(next));
  favorites = next;
  renderFavorites();
}

function renameDialog(name, save) {
  const dialog = byId('rename-dialog');
  byId('rename-value').value = name || '';
  setStatus('rename-status', '');
  byId('rename-form').onsubmit = (event) => {
    event.preventDefault();
    try {
      save(byId('rename-value').value.trim());
      dialog.close();
    } catch {
      setStatus('rename-status', 'Der Name konnte nicht gespeichert werden.');
    }
  };
  dialog.showModal();
}

byId('cancel-rename').onclick = () => byId('rename-dialog').close();

function renderFavorites() {
  byId('favorite-items').replaceChildren(...favorites.map((favorite) => {
    const { from, to, place } = favorite;
    const label = favorite.label || place?.name || `${from.name} → ${to.name}`;
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
  const manager = byId('favorite-manager');
  manager.replaceChildren(...favorites.map((favorite) => {
    const title = favorite.place?.name || `${favorite.from.name} → ${favorite.to.name}`;
    const row = element('div', null, 'managed-favorite');
    const buttons = element('div', null, 'trip-actions');
    const rename = element('button', 'Umbenennen');
    const remove = element('button', 'Entfernen');
    rename.type = remove.type = 'button';
    rename.onclick = () => renameDialog(favorite.label, (label) =>
      writeFavorites(favorites.map((item) => item.key === favorite.key ? { ...item, label } : item)));
    remove.onclick = () => toggleFavorite(favorite);
    buttons.append(rename, remove);
    row.append(element('strong', favorite.label || title));
    if (favorite.label) row.append(element('small', title, 'muted'));
    row.append(buttons);
    return row;
  }));
  manager.hidden = !favorites.length;
  refreshFavoriteButtons();
}

byId('add-favorite').onsubmit = async (event) => {
  event.preventDefault();
  const list = byId('favorite-search-results');
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  setStatus('favorite-search-status', 'Haltestellen werden gesucht …');
  list.replaceChildren();
  try {
    const matches = (await getJson('/api/stations', { q: byId('favorite-search').value })).filter((p) => p.type === 'STOP');
    for (const place of matches) {
      const row = element('li');
      const button = element('button', place.name);
      button.type = 'button';
      const added = () => favorites.some(({ key }) => key === place.id);
      button.disabled = added();
      button.onclick = () => {
        if (!added()) {
          try {
            writeFavorites([...favorites, { key: place.id, place }]);
            button.disabled = true;
            setStatus('favorite-search-status', `${place.name} hinzugefügt.`);
          } catch {
            setStatus('favorite-search-status', 'Der Favorit konnte nicht gespeichert werden.');
          }
        }
      };
      row.append(button);
      list.append(row);
    }
    setStatus('favorite-search-status', matches.length ? '' : 'Keine Haltestellen gefunden.');
  } catch (error) {
    setStatus('favorite-search-status', error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
};

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
      const favorite = isFavorite && favorites.find(({ key }) => key === place.id);
      const button = element('button', favorite?.label || place.name);
      button.type = 'button';
      const category = isFavorite ? 'Favorit' : place.type === 'STOP' ? 'Haltestelle' : 'Ort';
      button.append(element('small', [category, favorite?.label && place.name, place.area].filter(Boolean).join(' · ')));
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
        let matches = await getJson('/api/stations', { q: query }, controller.signal);
        if (controller.signal.aborted || !suggestionsOpen || input.value.trim() !== query || places[field]) return;
        if (byId('search-kind').value !== 'trip') matches = matches.filter((place) => place.type === 'STOP');
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

function updateSearchKind() {
  const board = byId('search-kind').value !== 'trip';
  byId('planner').toggleAttribute('data-board', board);
  for (const id of ['reverse', 'target-place', 'direction-field', 'from-location', 'open-filters', 'save-route', 'filter-summary']) {
    byId(id).hidden = board;
  }
  if (!board) updateFilterSummary();
  byId('to').required = !board;
  byId('from-label').textContent = board ? 'Bahnhof oder Haltestelle' : 'Start';
  byId('from').placeholder = board ? 'Bahnhof oder Haltestelle' : 'Haltestelle oder Adresse';
  byId('submit').textContent = board ? 'Tafel anzeigen' : 'Verbindungen finden';
  if (board && places.from?.type !== 'STOP') choose('from', null);
  clearResults();
}

byId('search-kind').onchange = updateSearchKind;

function timeLabel(value) {
  const date = new Date(value ?? NaN);
  return Number.isFinite(date.getTime()) ? clock.format(date) : '–';
}

function eventLabel(place, type, fallback) {
  const actual = place[type] || fallback;
  const scheduled = place[type === 'departure' ? 'scheduledDeparture' : 'scheduledArrival'];
  const changed = place.track && place.scheduledTrack && place.track !== place.scheduledTrack;
  const track = place.track || place.scheduledTrack;
  const platform = track ? ` · ${changed ? 'Gleiswechsel auf ' : 'Gleis '}${track}` : '';
  const name = { START: 'Start', END: 'Ziel' }[place.name] || place.name || 'Wegpunkt';
  const row = document.createDocumentFragment();
  row.append(eventTime(actual, scheduled, place.cancelled, ['OBSERVED', 'PREDICTED', 'PROPAGATED'].includes(place[type + 'TimestampReason'])), element('span', name, 'stop-name'));
  if (platform) row.append(element('small', platform.replace(/^ · /, ''), changed ? 'problem stop-platform' : 'muted stop-platform'));
  return row;
}

function eventTime(actual, scheduled, cancelled = false, realtime = false) {
  const minutes = Math.round((Date.parse(actual) - Date.parse(scheduled)) / 60_000);
  const time = element('span', null, 'event-time');
  if (!cancelled && Number.isFinite(minutes) && minutes !== 0) {
    time.append(element('span', timeLabel(scheduled), 'planned-time'));
    const live = element('span', timeLabel(actual), minutes > 0 ? 'is-late' : 'is-on-time');
    live.title = `${minutes > 0 ? '+' : ''}${minutes} Min. gegenüber dem Fahrplan`;
    time.append(live);
  } else {
    time.append(element('span', timeLabel(cancelled ? scheduled || actual : actual), !cancelled && realtime ? 'is-on-time' : 'planned-time'));
  }
  return time;
}

function lineName(leg) {
  return leg.displayName || leg.routeShortName || modes[leg.mode] || leg.mode;
}

function lineColor(leg) {
  const label = lineName(leg);
  const prefix = label.match(/^(ICE|IC|EC|RE|RB|S)(?=\s|\d|$)/i)?.[1].toUpperCase();
  return { ICE: 'ice', IC: 'ic', EC: 'ic', RE: 're', RB: 'rb', S: 'suburban' }[prefix]
    || { TRAM: 'tram', BUS: 'bus', SUBURBAN: 'suburban', HIGHSPEED_RAIL: 'ice', LONG_DISTANCE: 'ic', REGIONAL_RAIL: 're' }[leg.mode]
    || 'walk';
}

function lineBadge(leg) {
  return element('span', lineName(leg), `line line-${lineColor(leg)}`);
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
  const departure = element('p', null, 'stop-event stop-departure');
  departure.append(eventLabel(leg.from, 'departure', leg.startTime));
  row.append(departure);
  if (leg.intermediateStops?.length) {
    const details = element('details', null, 'stops');
    const stops = element('ul');
    for (const stop of leg.intermediateStops) {
      const item = element('li', null, 'stop-event');
      item.append(eventLabel(stop, 'arrival', stop.departure), stop.cancelled ? ' · Halt entfällt' : '');
      stops.append(item);
    }
    details.append(element('summary', `${leg.intermediateStops.length} Zwischenhalte`), stops);
    row.append(details);
  }
  const arrival = element('p', null, 'stop-event stop-arrival');
  arrival.append(eventLabel(leg.to, 'arrival', leg.endTime));
  row.append(arrival);
  for (const { title, message } of legAlerts(leg)) {
    const notice = element('aside', null, 'notice');
    notice.append(element('strong', title || 'Meldung zur Fahrt'));
    if (message && message !== title) notice.append(element('p', message));
    row.append(notice);
  }
  return row;
}

function walkingIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(svg.namespaceURI, 'circle');
  head.setAttribute('cx', '13');
  head.setAttribute('cy', '4.5');
  head.setAttribute('r', '2');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'm7 13 3-4 2 1 2 4 4 1M12 10l-2 6-3 5m3-5 4 2 1 3');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(head, path);
  return svg;
}

function mapControl(label, action) {
  const button = element('button', null, 'map-icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15');
  svg.append(path);
  button.append(svg);
  button.onclick = action;
  return button;
}

function renderTimeline(journey) {
  const bar = element('div', null, 'trip-timeline');
  const legend = [];
  const description = [];
  for (const { type, leg, milliseconds } of tripTimeline(journey)) {
    const name = type === 'walk' ? 'Fußweg' : type === 'wait' ? 'Wartezeit' : lineName(leg);
    const length = Math.max(1, Math.round(milliseconds / 60000));
    const piece = element('div', null, `timeline-segment timeline-${type}${type === 'ride' ? ` line-${lineColor(leg)}` : ''}`);
    piece.style.flex = `${milliseconds} 1 0px`;
    piece.title = `${name} · ${length} Min.`;
    if (type === 'walk') piece.append(walkingIcon());
    if (type === 'ride') piece.append(element('span', name));
    bar.append(piece);
    description.push(piece.title);
    if (type !== 'wait') legend.push(name);
  }
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', description.join(', '));
  return [bar, element('p', legend.join(' → '), 'trip-segment-key')];
}

function routingOptions() {
  return {
    ...(filters.ticket ? { ticket: 'true' } : {}),
    ...(filters.groups.length < allGroups.length ? { modes: filters.groups.join(',') } : {}),
  };
}

function renderTransferCheck(journey, from, to, options) {
  const checks = transfersFor(journey);
  if (!checks.length && !isCancelled(journey)) return null;
  const section = element('section', null, 'transfer-checks');
  section.append(element('h3', 'Anschlusscheck'));
  const list = element('ul');
  for (const check of checks) {
    const timing = check.cancelled ? 'Fahrt oder Halt fällt aus'
      : !Number.isFinite(check.minutes) ? 'Zeitpuffer unbekannt'
      : check.minutes < 0 ? `${check.estimated ? 'Nach Datenstand' : 'Laut Prognose'} nicht erreichbar`
      : `${check.minutes} Min. Puffer${check.estimated ? ' · teilweise Planzeiten' : ''}${check.minutes < 3 ? ' · knapp' : ''}`;
    list.append(element('li', `${check.outgoing.from.name}: ${timing}`, check.risky ? 'problem' : null));
  }
  if (checks.length) section.append(list);
  if (!to?.id) return section;
  const button = element('button', 'Alternativen prüfen');
  button.type = 'button';
  const state = element('p', null, 'muted');
  state.setAttribute('role', 'status');
  const suggestions = element('div');
  button.onclick = async () => {
    const check = checks.find((item) => item.risky) || (!isCancelled(journey) && checks[0]);
    const candidates = alternativeStops(journey, from, check).filter((stop) => stop.id !== to.id);
    if (!candidates.length) {
      state.textContent = 'Kein noch erreichbarer Halt für die Alternativsuche gefunden.';
      return;
    }
    button.disabled = true;
    state.textContent = `Prüfe ${candidates.map((stop) => stop.name).join(', ')} …`;
    suggestions.replaceChildren();
    try {
      const results = await Promise.allSettled(candidates.map(async (stop) => {
        const routes = await getJson('/api/journeys', {
          ...options, from: stop.id, to: to.id, time: stop.time, arriveBy: 'false',
        });
        const feasible = routes.filter((trip) => {
          const firstRide = trip.legs.find((leg) => leg.mode !== 'WALK');
          if (stop.earlier && check?.incoming.tripId && firstRide?.tripId === check.incoming.tripId) return false;
          if (!stop.earlier && check?.outgoing.tripId && firstRide?.tripId === check.outgoing.tripId &&
              Date.parse(trip.endTime) === Date.parse(journey.endTime)) return false;
          return !isCancelled(trip) && !transfersFor(trip).some((item) => item.minutes < 0)
            && Date.parse(trip.startTime) >= Date.parse(stop.time);
        });
        const earliest = Math.min(Infinity, ...feasible.map((trip) => Date.parse(trip.endTime)));
        return feasible.filter((trip) => Date.parse(trip.endTime) === earliest).map((best) => ({ stop, best }));
      }));
      const usableOriginal = !isCancelled(journey) && !checks.some((item) => item.minutes < 0);
      const normalFailed = results.some((result, index) => result.status === 'rejected' && !candidates[index].earlier);
      const alternatives = shortestAlternatives(results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : []).filter(({ stop }) => !normalFailed || !stop.earlier), journey, usableOriginal);
      const failed = results.filter((result) => result.status === 'rejected').length;
      state.textContent = alternatives.length ? `Früheste Ankunft der geprüften Möglichkeiten.${failed ? ' Einzelne Halte konnten nicht geprüft werden.' : ''}`
        : failed ? 'Die Suche konnte nicht für alle Halte abgeschlossen werden.' : 'Keine lohnende Alternative an diesen Halten gefunden.';
      for (const { stop, best } of alternatives) {
        const gain = Math.floor((Date.parse(journey.endTime) - Date.parse(best.endTime)) / 60000);
        suggestions.append(element('h3', `${stop.earlier ? 'Früher aussteigen' : 'Weiterfahrt'} ab ${stop.name}`));
        if (gain > 0 && !isCancelled(journey)) suggestions.append(element('p', `${gain} Min. früher am Ziel`, 'muted'));
        suggestions.append(renderJourney(best, { from: stop, to, options, checkAlternatives: false }));
      }
    } finally {
      button.disabled = false;
    }
  };
  section.append(button, state, suggestions);
  return section;
}

function renderJourney(journey, settings = {}) {
  const { from, to, best = false, saved = false, recurring = false, options = routingOptions(),
    checkAlternatives = true, refreshOnOpen = false } = settings;
  const details = element('details', null, 'panel journey');
  const summary = element('summary');
  const duration = Math.round(journey.duration / 60);
  const changes = journey.transfers === 0 ? 'Direkt' : `${journey.transfers} Umst.`;
  const first = journey.legs[0];
  const last = journey.legs.at(-1);
  const cancelled = isCancelled(journey);
  details.classList.toggle('trip-cancelled', cancelled);
  const times = element('strong', null, 'journey-times');
  times.append(eventTime(journey.startTime, first?.scheduledStartTime || first?.from.scheduledDeparture, cancelled, first?.realTime),
    '–', eventTime(journey.endTime, last?.scheduledEndTime || last?.to.scheduledArrival, cancelled, last?.realTime));
  summary.append(
    times,
    element('span', `${duration} Min. · ${changes}${best ? ' · Beste Zeit' : ''}`, 'trip-meta'),
    ...renderTimeline(journey),
  );
  if (cancelled) summary.append(element('span', 'Verbindung fällt aus', 'result-cancelled'));
  else if (journey.legs.some((leg) => legAlerts(leg).length)) summary.append(element('span', 'Fahrtmeldungen', 'trip-meta problem'));
  const mapButton = mapControl('Route auf der Karte', () => void openRouteMap(journey));
  const steps = element('ol', null, 'legs');
  steps.append(...journey.legs.map((leg, index) => {
    const row = renderLeg(leg);
    if (leg.mode === 'WALK') {
      row.querySelector('h3').append(mapControl('Fußweg auf der Karte', () => void openRouteMap(journey, index)));
    }
    return row;
  }));
  details.append(summary, mapButton, steps);
  if (checkAlternatives) {
    const check = renderTransferCheck(journey, from, to, options);
    if (check) details.append(check);
  }
  if (!saved && journey.id) {
    const existing = savedTrips.find((trip) => (trip.originalId || trip.journey.id) === journey.id);
    const save = element('button', existing ? '★' : '☆');
    save.type = 'button';
    save.className = 'save-trip';
    save.dataset.tripId = journey.id;
    save.disabled = Boolean(existing);
    save.setAttribute('aria-label', existing ? 'Fahrt gespeichert' : 'Fahrt merken');
    save.setAttribute('aria-pressed', String(Boolean(existing)));
    save.title = save.getAttribute('aria-label');
    save.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = savedTrips.find((trip) => (trip.originalId || trip.journey.id) === journey.id);
      const trip = {
        key: Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, '0')).join(''),
        originalId: journey.id,
        from, to, journey, options, updated: Date.now(),
      };
      if (current || writeTrips([...savedTrips, trip])) {
        save.textContent = '★';
        save.setAttribute('aria-label', 'Fahrt gespeichert');
        save.setAttribute('aria-pressed', 'true');
        save.disabled = true;
        if (!current && automaticPush && serviceWorker && pushSetup.enabled && Date.parse(journey.endTime) > Date.now()) {
          const progress = element('p', 'Push wird aktiviert …', 'muted');
          progress.setAttribute('role', 'status');
          details.append(progress);
          try {
            await startTripPush(trip);
            progress.textContent = 'Fahrt gespeichert · Push ist aktiv.';
          } catch (error) {
            progress.textContent = error.name === 'NotAllowedError'
              ? 'Fahrt gespeichert. Erlaube Mitteilungen auf dem iPhone, um Updates zu erhalten.'
              : `Fahrt gespeichert. Push: ${error.message}`;
          }
        }
      }
    };
    summary.append(save);
  }
  if (!recurring && from?.id && to?.id) {
    const repeat = element('button', 'Wiederholen', 'calendar-link recur-link');
    repeat.type = 'button';
    repeat.onclick = () => recurringTrips.open(journey, from, to, options);
    details.append(repeat);
  }
  if (refreshOnOpen && journey.id) {
    let id = journey.id;
    let fetching = false;
    const refresh = async () => {
      if (!details.open || !navigator.onLine || fetching) return;
      fetching = true;
      details.querySelector('.journey-refresh-status')?.remove();
      const status = element('p', 'Fahrt wird aktualisiert …', 'muted journey-refresh-status');
      status.setAttribute('role', 'status');
      details.append(status);
      try {
        const live = await fetchLiveJourney(id);
        if (!details.isConnected) return;
        id = live.id || id;
        const replacement = renderJourney(live, { ...settings, refreshOnOpen: false });
        details.className = replacement.className;
        details.replaceChildren(...replacement.childNodes);
      } catch {
        status.textContent = 'Live-Daten gerade nicht abrufbar. Die bisherigen Fahrtdetails bleiben verfügbar.';
      } finally {
        fetching = false;
      }
    };
    details.addEventListener('toggle', refresh);
    details.addEventListener('refreshjourney', refresh);
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
    ...(['POST', 'PATCH'].includes(method) ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

let budgetSync = Promise.resolve();
function syncBudgetPush(enabled, subscription) {
  const update = budgetSync.then(async () => {
    if (!pushSetup?.budgetAlerts || !serviceWorker || !navigator.onLine) return;
    const approved = subscription || await serviceWorker.pushManager.getSubscription();
    if (!approved) return;
    const response = await fetch('/api/push/budget', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, subscription: approved.toJSON() }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error || 'Die API-Budgetwarnungen konnten nicht gespeichert werden.');
    }
  });
  budgetSync = update.catch(() => {});
  return update;
}

function reportBudgetPushError(error) {
  setStatus('push-settings-status', error.message);
}

async function subscribeForPush() {
  const subscription = await serviceWorker.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: pushSetup.publicKey,
  });
  void syncBudgetPush(budgetPush, subscription).catch(reportBudgetPushError);
  return subscription;
}

function startTripPush(trip, approved) {
  if (!pushRegistrations.has(trip.key)) {
    const request = (async () => {
      const subscription = approved || await subscribeForPush();
      const { id } = await pushRequest('POST', {
        tripKey: trip.key, itineraryId: trip.journey.id, subscription: subscription.toJSON(), preferences: pushPreferences,
      });
      if (!savedTrips.some(({ key }) => key === trip.key) ||
          !writeTrips(savedTrips.map((item) => item.key === trip.key ? { ...item, watchId: id } : item))) {
        await pushRequest('DELETE', id);
        throw new Error('Die Push-Überwachung konnte nicht gespeichert werden.');
      }
    })().finally(() => pushRegistrations.delete(trip.key));
    pushRegistrations.set(trip.key, request);
  }
  return pushRegistrations.get(trip.key);
}

let bulkPush;
let savingPushSettings = false;
function activateUpcomingPush(subscription) {
  if (!automaticPush || !serviceWorker || !pushSetup.enabled || !navigator.onLine) return Promise.resolve();
  if (!bulkPush) {
    bulkPush = (async () => {
      const approved = subscription || await serviceWorker.pushManager.getSubscription();
      if (!approved) return;
      for (const trip of [...savedTrips].sort((a, b) => Date.parse(a.journey.startTime) - Date.parse(b.journey.startTime))) {
        if (trip.watchId !== undefined || Date.parse(trip.journey.endTime) <= Date.now()) continue;
        if (!automaticPush || savingPushSettings) break;
        try {
          await startTripPush(trip, approved);
        } catch (error) {
          setStatus('push-settings-status', error.message);
          if (error.status === 429) break;
        }
      }
    })().finally(() => { bulkPush = null; });
  }
  return bulkPush;
}

const pushFields = new Map(Object.entries(pushOptions).map(([key, label]) => {
  const row = element('label', null, 'option');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = pushPreferences[key];
  row.append(input, document.createTextNode(label));
  byId('push-option-fields').append(row);
  return [key, input];
}));
byId('auto-push').checked = automaticPush;
byId('budget-push').checked = budgetPush;
byId('push-settings-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = byId('save-push-settings');
  button.disabled = true;
  savingPushSettings = true;
  const automatic = byId('auto-push').checked;
  const budget = byId('budget-push').checked;
  const preferences = Object.fromEntries([...pushFields].map(([key, input]) => [key, input.checked]));
  setStatus('push-settings-status', 'Einstellungen werden gespeichert …');
  try {
    await Promise.allSettled(pushRegistrations.values());
    const ids = savedTrips.flatMap((trip) => trip.watchId ? [trip.watchId] : []);
    if (ids.length) await pushRequest('PATCH', { ids, preferences });
    budgetPush = budget;
    await syncBudgetPush(budget);
    automaticPush = automatic;
    pushPreferences = preferences;
    localStorage.setItem(pushSettingsKey, JSON.stringify({ automatic, preferences, budget }));
    setStatus('push-settings-status', 'Push-Einstellungen gespeichert.');
  } catch (error) {
    setStatus('push-settings-status', error.message);
  } finally {
    savingPushSettings = false;
    button.disabled = false;
  }
  void activateUpcomingPush().catch(() => {});
};

byId('allow-push').onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const subscription = await subscribeForPush();
    setStatus('push-settings-status', 'Mitteilungen sind erlaubt.');
    await activateUpcomingPush(subscription);
  } catch (error) {
    setStatus('push-settings-status', error.name === 'NotAllowedError'
      ? 'Erlaube Mitteilungen für Privatnavigator in den iPhone-Einstellungen.' : error.message);
  } finally {
    button.disabled = false;
  }
};

async function setupPush() {
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js');
  }
  const response = await fetch('/api/push');
  pushSetup = await response.json();
  if (window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window &&
      (pushSetup.enabled || pushSetup.budgetAlerts || pushSetup.testEnabled)) {
    serviceWorker = await navigator.serviceWorker.ready;
  }
  void syncBudgetPush(budgetPush).catch(reportBudgetPushError);
  if (pushSetup.testEnabled) {
    byId('push-test').hidden = false;
    byId('send-push-test').disabled = !serviceWorker;
    if (!serviceWorker) setStatus('push-test-status', 'Auf dem iPhone in Safari zum Home-Bildschirm hinzufügen und über das App-Symbol öffnen.');
    if (pushSetup.testTypes?.length) {
      byId('settings-push-tests').hidden = false;
      byId('push-test-type').replaceChildren(...pushSetup.testTypes.map(({ type, label }) => {
        const option = element('option', label);
        option.value = type;
        return option;
      }));
      byId('send-selected-push-test').disabled = !serviceWorker;
      if (!serviceWorker) setStatus('selected-push-test-status', 'Öffne den Privatnavigator auf dem iPhone über sein Home-Bildschirm-Symbol.');
    }
  }
  if (serviceWorker && (pushSetup.enabled || pushSetup.budgetAlerts)) byId('allow-push').hidden = false;
  renderSavedTrips();
  const open = savedTrips.find(({ key }) => location.hash === `#fahrt-${key}`);
  if (open && !savedRefreshes.has(open.key)) openTripLink(false);
  void activateUpcomingPush().then(() => {
    const trip = savedTrips.find(({ key }) => location.hash === `#fahrt-${key}`);
    if (trip?.watchId && !savedRefreshes.has(trip.key)) openTripLink(false);
  }).catch(() => {});
}

async function sendPushTest(button, status, type = 'general') {
  button.disabled = true;
  setStatus(status, 'Testmitteilung wird gesendet …');
  try {
    const subscription = await subscribeForPush();
    const response = await fetch('/api/push/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, subscription: subscription.toJSON() }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.resetSubscription) {
        await syncBudgetPush(false, subscription).catch(() => {});
        await subscription.unsubscribe();
        throw new Error(`${result.error} Das alte Abo wurde zurückgesetzt. Tippe erneut auf „Testmitteilung senden“.`);
      }
      throw new Error(result.diagnostic ? `${result.error} (${result.diagnostic})` : result.error);
    }
    setStatus(status, 'Apple hat die Testmitteilung angenommen. Prüfe deine Mitteilungszentrale.');
  } catch (error) {
    setStatus(status, error.name === 'NotAllowedError'
      ? 'Erlaube Mitteilungen in den iPhone-Einstellungen für diese Web-App.' : error.message);
  } finally {
    button.disabled = false;
  }
}

byId('send-push-test').onclick = (event) => sendPushTest(event.currentTarget, 'push-test-status');
byId('send-selected-push-test').onclick = (event) =>
  sendPushTest(event.currentTarget, 'selected-push-test-status', byId('push-test-type').value);

function nextSavedTrip() {
  const now = Date.now();
  return savedTrips.filter(({ journey }) => Date.parse(journey.endTime) > now)
    .sort((a, b) => Date.parse(a.journey.startTime) - Date.parse(b.journey.startTime))[0];
}

function renderNextTrip() {
  const now = Date.now();
  const card = byId('next-trip');
  const trip = nextSavedTrip();
  card.hidden = !trip;
  if (!trip) return;
  const { journey, from, to } = trip;
  const train = journey.legs.find((leg) => leg.mode !== 'WALK' && Date.parse(leg.endTime) > now);
  const platform = train?.from.track || train?.from.scheduledTrack;
  card.href = `#fahrt-${trip.key}`;
  const timing = `${calendar.format(new Date(journey.startTime))} · ${timeLabel(journey.startTime)}–${timeLabel(journey.endTime)}`;
  card.replaceChildren(
    element('span', Date.parse(journey.startTime) > now ? 'Nächste gemerkte Fahrt' : 'Aktuelle gemerkte Fahrt', 'muted'),
    element('strong', `${from.name} → ${to.name}`),
    element('span', [timing, train && lineName(train), platform && `Gleis ${platform}`].filter(Boolean).join(' · '), 'muted'),
    element('span', isCancelled(journey) ? 'Verbindung fällt aus' : `Datenstand ${timeLabel(trip.updated)}`, isCancelled(journey) ? 'problem' : 'muted'),
  );
}

function tripArchiveTime(trip) {
  const last = trip.journey.legs.at(-1);
  const arrival = Number.isFinite(trip.confirmedArrival) ? trip.confirmedArrival
    : Math.max(Date.parse(trip.journey.endTime) || 0, Date.parse(last?.to?.arrival) || 0, Date.parse(last?.scheduledEndTime) || 0);
  return arrival ? arrival + 30 * 60_000 : Infinity;
}

function renderSavedTrips() {
  const archived = (trip) => Date.now() >= tripArchiveTime(trip);
  const active = savedTrips.filter(trip => !archived(trip)).sort((a, b) => Date.parse(a.journey.startTime) - Date.parse(b.journey.startTime));
  const old = savedTrips.filter(archived).sort((a, b) => Date.parse(b.journey.startTime) - Date.parse(a.journey.startTime));
  const card = (trip) => {
    const link = element('a', null, 'panel saved-overview');
    link.href = '#fahrt-' + trip.key;
    link.append(element('strong', trip.from.name + ' → ' + trip.to.name),
      element('span', calendar.format(new Date(trip.journey.startTime)) + ' · ' + timeLabel(trip.journey.startTime), 'muted'));
    if (archived(trip)) link.append(element('small', Number.isFinite(trip.confirmedArrival) ? 'Ankunft bestätigt' : 'Nach zuletzt bekannter Ankunft archiviert', 'muted'));
    return link;
  };
  byId('saved-empty').hidden = Boolean(active.length);
  byId('saved-items').replaceChildren(...active.map(card));
  byId('archived-items').replaceChildren(...old.map(card));
  byId('archive-count').textContent = 'Alte Verbindungen (' + old.length + ')';
  byId('archive-empty').hidden = Boolean(old.length);
  renderNextTrip();
}

function renderSavedTrip(trip) {
  const card = element('article', null, 'saved-trip');
  const heading = element('h3', `${trip.from.name} → ${trip.to.name}`);
  const stamp = element('p', `${calendar.format(new Date(trip.journey.startTime))} · Datenstand ${timeLabel(trip.updated)}`, 'muted');
  const details = renderJourney(trip.journey, { ...trip, saved: true });
  details.open = true;
  details.classList.add('static-journey');
  const actions = element('div', null, 'trip-actions');
  const refresh = element('button', 'Live aktualisieren');
  const remove = element('button', 'Entfernen');
  refresh.type = remove.type = 'button';
  refresh.className = 'refresh-trip';
  const status = element('p', null, 'field-status');
  status.setAttribute('role', 'status');
  refresh.onclick = async () => {
    if (!navigator.onLine || refresh.disabled) return;
    refresh.disabled = true;
    status.textContent = 'Aktualisiere …';
    try {
      await refreshSavedTrip(trip);
      if (card.isConnected && location.hash === `#fahrt-${trip.key}`) openTripLink(false);
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
        location.hash = '#saved-trips';
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
    if (trip.watchId) status.textContent = 'Push ist aktiv. Die Meldungsarten findest du in den Einstellungen.';
    push.onclick = async () => {
      push.disabled = remove.disabled = true;
      status.textContent = trip.watchId ? 'Push wird deaktiviert …' : 'Push wird aktiviert …';
      try {
        if (trip.watchId) {
          await pushRequest('DELETE', trip.watchId);
          writeTrips(savedTrips.map((item) => item.key === trip.key ? { ...item, watchId: null } : item));
        } else {
          await startTripPush(trip);
        }
        if (location.hash === `#fahrt-${trip.key}`) openTripLink(false);
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
  const calendarLink = element('button', 'In Kalender übernehmen', 'calendar-link');
  calendarLink.type = 'button';
  calendarLink.onclick = () => {
    const url = new URL(`/#fahrt-${trip.key}`, location.origin).href;
    const data = calendarFile(trip, trip.journey.legs.map((leg) =>
      `${timeLabel(leg.startTime)} ${leg.from.name} → ${timeLabel(leg.endTime)} ${leg.to.name} · ${lineName(leg)}`), url);
    const file = URL.createObjectURL(new Blob([data], { type: 'text/calendar;charset=utf-8' }));
    const link = element('a');
    link.href = file;
    link.download = 'Privatnavigator-Fahrt.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(file), 1000);
  };
  actions.append(calendarLink);
  card.append(heading, stamp, details, actions, status);
  return card;
}

renderSavedTrips();
void setupPush().catch(() => {});
function acknowledgeBadge() {
  if (document.visibilityState !== 'visible') return;
  renderNextTrip();
  if ('clearAppBadge' in navigator) void navigator.clearAppBadge().catch(() => {});
}
document.addEventListener('visibilitychange', acknowledgeBadge);
acknowledgeBadge();

byId('export-data').onclick = () => {
  const trips = savedTrips.map(({ watchId, ...trip }) => trip);
  const data = new Blob([JSON.stringify({ version: 1, favorites, trips, recurring: recurringTrips.export() })], { type: 'application/json' });
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
    recurringTrips.import(data.recurring);
    setStatus('transfer-status', 'Daten eingelesen. Mitteilungen kannst du für übertragene Fahrten erneut aktivieren.');
  } catch (error) {
    setStatus('transfer-status', error.message);
  }
};

function openTripLink(refresh = true) {
  showView();
  if (currentView !== 'journey-view') return;
  const content = byId('journey-view-body');
  const title = byId('journey-view-title');
  const menu = byId('journey-menu');
  menu.hidden = true;
  menu.open = false;
  byId('offline-journey').hidden = navigator.onLine;
  const wrapper = element('div');
  content.replaceChildren(wrapper);
  if (location.hash.startsWith('#wiederholung-')) {
    let rule;
    try { rule = recurringTrips.find(decodeURIComponent(location.hash.slice('#wiederholung-'.length))); } catch {}
    title.textContent = rule?.label || 'Wiederholende Reise';
    if (!rule) return wrapper.append(element('p', 'Diese Wiederholung ist auf diesem Gerät nicht gespeichert.'));
    menu.hidden = false;
    byId('rename-recurring').onclick = () => renameDialog(rule.label, (label) => {
      recurringTrips.rename(rule.key, label);
      openTripLink();
    });
    void recurringTrips.openDetail(rule, wrapper);
    return;
  }
  title.textContent = 'Fahrt';
  const trip = savedTrips.find(({ key }) => location.hash === `#fahrt-${key}`);
  if (!trip) return wrapper.append(element('p', 'Diese Fahrt ist auf diesem Gerät nicht gespeichert.'));
  const card = renderSavedTrip(trip);
  wrapper.append(card);
  if (refresh && navigator.onLine) card.querySelector('.refresh-trip').click();
}

window.addEventListener('hashchange', () => openTripLink());
for (const event of ['online', 'offline']) window.addEventListener(event, () => {
  byId('offline-journey').hidden = navigator.onLine;
});
openTripLink();

const paging = { earlier: byId('earlier-trips'), later: byId('later-trips') };

function renderBoardEvent(event) {
  const row = element('article', null, 'panel board-event');
  row.dataset.eventKey = JSON.stringify([event.tripId, event.place?.stopId, event.place?.scheduledDeparture, event.place?.scheduledArrival]);
  const arrival = Boolean(event.place.scheduledArrival || event.place.arrival);
  const actual = arrival ? event.place.arrival : event.place.departure;
  const planned = arrival ? event.place.scheduledArrival : event.place.scheduledDeparture;
  const cancelled = event.cancelled || event.tripCancelled || event.place.cancelled;
  const timing = element('strong');
  timing.append(eventTime(actual || planned, planned, cancelled, Boolean(event.realTime || ['OBSERVED', 'PREDICTED', 'PROPAGATED'].includes(event.place[arrival ? 'arrivalTimestampReason' : 'departureTimestampReason']))));
  const details = element('div');
  const terminal = arrival ? event.tripFrom?.name : event.headsign || event.tripTo?.name;
  const track = event.place.track || event.place.scheduledTrack;
  const changed = event.place.track && event.place.scheduledTrack && event.place.track !== event.place.scheduledTrack;
  details.append(lineBadge(event),
    element('span', `${arrival ? 'Ankunft' : 'Abfahrt'}${terminal ? ` · ${arrival ? 'aus' : 'nach'} ${terminal}` : ''}`, 'board-direction'));
  if (track) details.append(element('p', `${changed ? 'Gleiswechsel auf' : 'Gleis'} ${track}`, changed ? 'problem' : 'muted'));
  if (cancelled) details.append(element('p', event.tripCancelled ? 'Fahrt fällt aus' : 'Halt fällt aus', 'problem'));
  row.append(timing, details);
  return row;
}

function updatePaging(busy = false) {
  for (const [direction, button] of Object.entries(paging)) {
    button.hidden = !tripPage?.[direction];
    button.disabled = busy;
  }
}

async function showTripPage(query, controller, direction) {
  const cursor = direction ? tripPage?.[direction] : query.cursor;
  updatePaging(true);
  if (direction) setStatus('result-status', 'Weitere Verbindungen werden geladen …');
  try {
    const page = await getJson(query.board ? '/api/board' : '/api/journeys', {
      ...query.params, ...(!query.board ? { paged: 'true', cancellations: 'true' } : {}), ...(cursor ? { cursor } : {}),
    }, controller.signal);
    if (controller.signal.aborted) return;
    if (direction && cursor && page[direction] === cursor) page[direction] = null;
    tripPage = direction ? { ...tripPage, [direction]: page[direction] } : page;
    query.cursor = cursor;
    const list = byId('journeys');
    const anchor = direction === 'earlier' ? list.firstElementChild : null;
    const offset = anchor?.getBoundingClientRect().top;
    if (query.board) {
      const key = (event) => JSON.stringify([event.tripId, event.place?.stopId, event.place?.scheduledDeparture, event.place?.scheduledArrival]);
      displayedEvents = [...new Map([...(direction ? displayedEvents : []), ...page.events].map(event => [key(event), event])).values()]
        .sort((a, b) => Date.parse(a.place.arrival || a.place.departure || a.place.scheduledArrival || a.place.scheduledDeparture) - Date.parse(b.place.arrival || b.place.departure || b.place.scheduledArrival || b.place.scheduledDeparture));
      list.replaceChildren(...displayedEvents.map(renderBoardEvent));
      setStatus('result-status', displayedEvents.length ? '' : 'Keine Fahrten für diesen Zeitraum gefunden.');
      if (anchor && list.children.length) window.scrollBy(0, list.children[displayedEvents.findIndex(event => key(event) === anchor.dataset.eventKey)]?.getBoundingClientRect().top - offset || 0);
      return;
    }
    displayedJourneys = [...new Map([...(direction ? displayedJourneys : []), ...page.itineraries].map(journey => [journey.id, journey])).values()]
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || Date.parse(a.endTime) - Date.parse(b.endTime));
    const itineraries = displayedJourneys;
    const best = itineraries.filter((journey) => !isCancelled(journey) && !transfersFor(journey).some((check) => check.minutes < 0))
      .sort((a, b) => a.duration - b.duration || a.transfers - b.transfers)[0];
    const oldId = anchor?.dataset.journeyId;
    const openIds = new Set([...list.querySelectorAll('.journey[open]')].map(node => node.dataset.journeyId));
    list.replaceChildren(...itineraries.map((journey) => {
      const card = renderJourney(journey, { from: query.from, to: query.to, best: journey === best, options: query.options, refreshOnOpen: true });
      card.dataset.journeyId = journey.id;
      card.open = openIds.has(journey.id);
      return card;
    }));
    if (oldId) {
      const same = [...list.children].find(node => node.dataset.journeyId === oldId);
      if (same) window.scrollBy(0, same.getBoundingClientRect().top - offset);
    }
    setStatus('result-status', [
      itineraries.length ? '' : 'Keine Verbindungen im Suchzeitraum gefunden.',
      page.cancellationsUnavailable ? 'Ausgefallene Fahrplanverbindungen konnten nicht zusätzlich abgerufen werden.' : '',
    ].filter(Boolean).join(' '));

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
  const kind = byId('search-kind').value;
  const board = kind !== 'trip';
  for (const field of board ? ['from'] : ['from', 'to']) {
    if (!places[field]) {
      setStatus('form-status', board ? 'Bitte einen Bahnhof aus den Vorschlägen auswählen.' : 'Bitte Start und Ziel aus den Vorschlägen auswählen.');
      byId(field).focus();
      return;
    }
  }
  if (board && places.from.type !== 'STOP') {
    setStatus('form-status', 'Bitte einen Bahnhof oder eine Haltestelle auswählen.');
    return;
  }
  if (!board && !readyRoute()) {
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
  const resultTitle = board ? byId('search-kind').selectedOptions[0].text : 'Verbindungen';
  byId('results-title').textContent = resultTitle;
  byId('results').toggleAttribute('data-board', board);
  for (const id of ['query-to', 'result-swap', 'result-favorite']) byId(id).hidden = board;
  byId('query-from').textContent = places.from.name;
  byId('query-to').textContent = board ? '' : places.to.name;
  const arriveBy = byId('direction').value === 'true';
  const date = new Date(byId('time').value);
  byId('query-time').textContent = `${board ? '' : arriveBy ? 'Ankunft · ' : 'Abfahrt · '}${dateTimeLabel.format(date)}`;
  setStatus('query-filters', board ? '' : byId('filter-summary').textContent);
  byId('journeys').replaceChildren();
  setStatus('result-status', 'Verbindungen werden gesucht …');
  location.hash = '#verbindungen';
  showView();
  byId('results-title').focus({ preventScroll: true });
  const cursor = restoreCursor;
  restoreCursor = undefined;
  try {
    let { from, to } = places;
    if (!board && (from.type === 'LOCATION' || to.type === 'LOCATION')) {
      const position = await currentLocation();
      if (controller.signal.aborted) return;
      if (from.type === 'LOCATION') from = position;
      if (to.type === 'LOCATION') to = position;
    }
    const options = routingOptions();
    const time = date.toISOString();
    const params = board ? { stop: from.id, mode: kind, time } : { from: from.id, to: to.id, time, arriveBy, ...options };
    tripQuery = { from, to, params, board, options, cursor };
    await showTripPage(tripQuery, controller);
  } catch (error) {
    if (!controller.signal.aborted) setStatus('result-status', error.message);
  }
});

for (const button of document.querySelectorAll('[data-reload]')) {
  button.onclick = () => {
    if (resultsReady && location.hash === '#verbindungen') {
      try {
        sessionStorage.setItem(reloadStorageKey, JSON.stringify({
          ...places, time: byId('time').value, direction: byId('direction').value,
          kind: byId('search-kind').value, cursor: tripQuery?.cursor,
        }));
      } catch {}
    }
    location.reload();
  };
}

try {
  const saved = JSON.parse(sessionStorage.getItem(reloadStorageKey));
  sessionStorage.removeItem(reloadStorageKey);
  if (saved && location.hash === '#verbindungen') {
    byId('search-kind').value = saved.kind;
    updateSearchKind();
    choose('from', saved.from);
    choose('to', saved.to);
    byId('time').value = saved.time;
    byId('direction').value = saved.direction;
    showSelectedTime();
    restoreCursor = saved.cursor;
    byId('planner').requestSubmit();
  }
} catch {}

let lastResume = 0;
let lastIdleRefresh = 0;
try { lastIdleRefresh = Number(localStorage.getItem('privatnavigator.idle-refresh')) || 0; } catch {}
function hasNearbyTrip() {
  const now = Date.now();
  return savedTrips.some(trip => tripArchiveTime(trip) > now && Date.parse(trip.journey.startTime) <= now + 12 * 3600_000)
    || recurringTrips.export().some(rule => {
      const next = nextOccurrence(rule);
      return next !== null && next <= now + 12 * 3600_000;
    });
}
function refreshVisibleData() {
  if (!navigator.onLine || document.visibilityState !== 'visible' || Date.now() - lastResume < 1500) return;
  if (document.querySelector('dialog[open]')) return;
  lastResume = Date.now();
  renderSavedTrips();
  if (!hasNearbyTrip()) {
    if (Date.now() - lastIdleRefresh < 3600_000) return;
    lastIdleRefresh = Date.now();
    try { localStorage.setItem('privatnavigator.idle-refresh', String(lastIdleRefresh)); } catch {}
  }
  if (currentView === 'journey-view') {
    const refresh = byId('journey-view-body').querySelector('.refresh-trip');
    if (refresh) refresh.click();
    else if (location.hash.startsWith('#wiederholung-')) openTripLink();
  } else if (currentView === 'results' && tripQuery && tripPage) {
    const open = byId('journeys').querySelector('.journey[open]');
    if (open) open.dispatchEvent(new Event('refreshjourney'));
    else if (!Object.values(paging).some((button) => button.disabled)) {
      activeSearch?.abort();
      activeSearch = new AbortController();
      void showTripPage(tripQuery, activeSearch);
    }
  } else if (currentView === 'search-view' || currentView === 'saved-trips') {
    const trip = nextSavedTrip();
    if (trip) void refreshSavedTrip(trip).catch(() => {});
  }
}

document.addEventListener('visibilitychange', refreshVisibleData);
window.addEventListener('pageshow', (event) => { if (event.persisted) refreshVisibleData(); });
window.addEventListener('online', refreshVisibleData);
window.addEventListener('online', () => void syncBudgetPush(budgetPush).catch(reportBudgetPushError));
if (currentView === 'search-view' || currentView === 'saved-trips') refreshVisibleData();

setInterval(() => { if (document.visibilityState === 'visible') renderSavedTrips(); }, 60_000);
