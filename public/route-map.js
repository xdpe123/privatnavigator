const tiles = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
let leaflet;

function loadLeaflet() {
  if (!leaflet) {
    leaflet = Promise.all([
      loadAsset('link', { rel: 'stylesheet', href: '/leaflet/leaflet.css' }),
      loadAsset('script', { src: '/leaflet/leaflet.js' }),
    ]).then(() => window.L).catch((error) => {
      leaflet = undefined;
      throw error;
    });
  }
  return leaflet;
}

function loadAsset(tag, attributes) {
  return new Promise((resolve, reject) => {
    const asset = document.createElement(tag);
    Object.assign(asset, attributes);
    asset.onload = resolve;
    asset.onerror = () => {
      asset.remove();
      reject(new Error('Die Karte konnte nicht geladen werden.'));
    };
    document.head.append(asset);
  });
}

export function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0;
  const totals = [0, 0];
  const points = [];
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let value = 0;
      let shift = 0;
      let chunk;
      do {
        chunk = encoded.charCodeAt(index++) - 63;
        if (!Number.isInteger(chunk) || chunk < 0 || chunk > 63 || shift > 30) return [];
        value += (chunk & 31) * 2 ** shift;
        shift += 5;
      } while (chunk >= 32);
      totals[axis] += value % 2 ? -(value + 1) / 2 : value / 2;
    }
    const [lat, lon] = totals.map((coordinate) => coordinate / 1_000_000);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    points.push([lat, lon]);
  }
  return points.length > 1 ? points : [];
}

function placePoint(place) {
  return Number.isFinite(place?.lat) && Number.isFinite(place?.lon) ? [place.lat, place.lon] : null;
}

function placeName(place) {
  return { START: 'Start', END: 'Ziel' }[place?.name] || place?.name || 'Haltepunkt';
}

export function createRouteMap(fetchDetails) {
  const get = (id) => document.getElementById(id);
  const dialog = get('map-dialog');
  const canvas = get('map-canvas');
  const walks = get('map-walks');
  const locate = get('map-location');
  const cache = new Map();
  let loading;
  let map;
  let library;
  let watch;
  let marker;
  let accuracy;

  function status(id, message) {
    const node = get(id);
    node.textContent = message;
    node.hidden = !message;
  }

  function stopLocation() {
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    watch = undefined;
    marker?.remove();
    accuracy?.remove();
    marker = accuracy = undefined;
    locate.setAttribute('aria-pressed', 'false');
    status('map-location-status', '');
  }

  dialog.addEventListener('close', () => {
    loading?.abort();
    stopLocation();
    map?.remove();
    map = undefined;
  });

  locate.onclick = () => {
    if (watch !== undefined) return stopLocation();
    if (!window.isSecureContext || !navigator.geolocation) {
      status('map-location-status', 'Öffne die HTTPS-Adresse der App, um deinen Standort anzuzeigen.');
      return;
    }
    locate.setAttribute('aria-pressed', 'true');
    status('map-location-status', 'Standort wird ermittelt …');
    watch = navigator.geolocation.watchPosition(({ coords }) => {
      if (watch === undefined || !map || !dialog.open) return;
      const point = [coords.latitude, coords.longitude];
      if (marker) {
        marker.setLatLng(point);
        accuracy.setLatLng(point).setRadius(coords.accuracy);
      } else {
        accuracy = library.circle(point, { radius: coords.accuracy, color: '#145484', weight: 1, fillOpacity: 0.12 }).addTo(map);
        marker = library.circleMarker(point, { radius: 8, color: '#fff', weight: 3, fillColor: '#145484', fillOpacity: 1 })
          .addTo(map).bindTooltip('Mein Standort');
        map.panInside(point, { padding: [24, 24] });
      }
      status('map-location-status', `Standort aktiv · Genauigkeit ca. ${Math.round(coords.accuracy)} m`);
    }, ({ code }) => {
      if (watch === undefined || !dialog.open) return;
      if (code === 1) stopLocation();
      status('map-location-status', code === 1
        ? 'Erlaube den Standortzugriff in deinen iPhone- oder Browser-Einstellungen.'
        : 'Der aktuelle Standort ist gerade nicht verfügbar.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
  };

  return async (journey, walkIndex = null) => {
    if (dialog.open) return;
    const controller = new AbortController();
    loading = controller;
    canvas.hidden = get('map-controls').hidden = true;
    walks.replaceChildren();
    status('map-status', 'Fahrtverlauf wird geladen …');
    dialog.showModal();

    try {
      library = await loadLeaflet();
      let detail = cache.get(journey.id);
      let detailError = '';
      if (!detail && journey.id) {
        try {
          detail = await fetchDetails(journey.id, controller.signal);
          if (!Array.isArray(detail?.legs)) throw new Error('Der Fahrtverlauf ist nicht verfügbar.');
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(journey.id, detail);
        } catch (error) {
          detailError = error.message;
          detail = null;
        }
      }
      if (controller.signal.aborted || !dialog.open) return;
      const records = (detail || journey).legs.map((leg) => ({
        leg, points: decodePolyline(leg.legGeometry?.points),
        endpoints: [placePoint(leg.from), placePoint(leg.to)].filter(Boolean),
      }));
      const points = records.flatMap((record) => [...record.points, ...record.endpoints]);
      if (!points.length) throw new Error(detailError || 'Für diese Fahrt sind keine Kartendaten verfügbar.');
      canvas.hidden = get('map-controls').hidden = false;
      map = library.map(canvas, { scrollWheelZoom: false });
      library.tileLayer(tiles, {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      const overview = () => {
        for (const button of walks.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
        map.fitBounds(points, { padding: [24, 24], maxZoom: 15 });
        status('map-status', detailError || (records.some((record) => !record.points.length)
          ? 'Für einzelne Abschnitte sind nur die Haltepunkte verfügbar.' : ''));
      };
      get('map-overview').onclick = overview;
      records.forEach((record) => {
        const { leg, points: line, endpoints } = record;
        const walking = leg.mode === 'WALK';
        const color = walking ? '#145484' : '#c8001a';
        const layer = line.length ? library.polyline(line, {
          color, weight: 5, opacity: 0.9, dashArray: walking ? '8 7' : undefined, interactive: walking,
        }).addTo(map) : null;
        for (const place of [leg.from, leg.to]) {
          const point = placePoint(place);
          if (!point) continue;
          const label = document.createElement('span');
          label.textContent = placeName(place);
          library.circleMarker(point, { radius: 4, color, fillColor: '#fff', fillOpacity: 1, weight: 2 })
            .addTo(map).bindPopup(label);
        }
        if (!walking || (!line.length && !endpoints.length)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Fußweg · ${placeName(leg.to)}`;
        button.setAttribute('aria-pressed', 'false');
        const focus = () => {
          for (const child of walks.querySelectorAll('button')) child.setAttribute('aria-pressed', String(child === button));
          map.fitBounds(line.length ? line : endpoints, { padding: [30, 30], maxZoom: 17 });
          status('map-status', line.length ? '' : 'Für diesen Fußweg sind nur die Haltepunkte verfügbar.');
        };
        button.onclick = focus;
        layer?.on('click', focus);
        record.focus = focus;
        walks.append(button);
      });
      const selected = journey.legs[walkIndex];
      const preferred = selected && records.find(({ leg }) => leg.mode === 'WALK' &&
        leg.from.name === selected.from.name && leg.to.name === selected.to.name);
      overview();
      preferred?.focus?.();
    } catch (error) {
      if (!controller.signal.aborted) status('map-status', error.message);
    }
  };
}
