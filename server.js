import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createTransitClient } from './transit.js';
import { transitApi } from './transit-api.js';
import { authorizePushSite, handlePush, monitorTrips } from './push.js';
import { record, report } from './local-usage.js';

const port = Number(process.env.PORT || 3000);
const lan = process.argv.includes('--lan');
const contact = process.env.TRANSITOUS_CONTACT?.trim();
const transit = createTransitClient(contact, record);
const { refreshJourney } = transit;
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/search-filters.js', ['search-filters.js', 'text/javascript']],
  ['/route-map.js', ['route-map.js', 'text/javascript']],
  ['/journey-details.js', ['journey-details.js', 'text/javascript']],
  ['/push-options.js', ['push-options.js', 'text/javascript']],
  ['/punctuality-view.js', ['punctuality-view.js', 'text/javascript']],
  ['/recurring-trips.js', ['recurring-trips.js', 'text/javascript']],
  ['/leaflet/leaflet.js', ['leaflet/leaflet.js', 'text/javascript']],
  ['/leaflet/leaflet.css', ['leaflet/leaflet.css', 'text/css']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/navigator-180.png', ['navigator-180.png', 'image/png']],
  ['/navigator-192.png', ['navigator-192.png', 'image/png']],
  ['/navigator-512.png', ['navigator-512.png', 'image/png']],
]);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (!authorizePushSite(request, response)) return;
    if (request.method === 'GET' && url.pathname === '/api/usage') return json(response, 200, report());
    if (request.method === 'GET' && url.pathname === '/api/punctuality') return json(response, 200, { routes: [], cloudOnly: true });
    if (url.pathname.startsWith('/api/push')) return await handlePush(request, response, url, json, refreshJourney);
    if (request.method !== 'GET') return json(response, 405, { error: 'Nur GET ist verfügbar.' });
    if (url.pathname.startsWith('/api/')) return await transitApi(request, url, transit, (status, body) => json(response, status, body));
    const file = files.get(url.pathname);
    if (!file) return json(response, 404, { error: 'Seite nicht gefunden.' });
    const content = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch (error) {
    if (error.status === 429) return json(response, 429, { error: error.message });
    console.error(error.message, error.cause?.code || '');
    json(response, 502, { error: 'Fahrplandienst gerade nicht erreichbar. Bitte versuche es in Kürze erneut.' });
  }
});

server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
  monitorTrips(refreshJourney);
  console.log(`Privatnavigator: http://localhost:${port}`);
  if (!contact) console.log('Für Transitous-Kontaktangaben: .env.example ansehen.');
  if (lan) {
    for (const address of Object.values(networkInterfaces()).flat()) {
      if (address?.family === 'IPv4' && !address.internal) console.log(`Handy im WLAN: http://${address.address}:${port}`);
    }
  }
});
