const offlineCache = 'privatnavigator-shell-v1';
const shellFiles = [
  '/', '/app.js', '/style.css', '/search-filters.js', '/route-map.js', '/journey-details.js', '/recurring-trips.js', '/push-options.js', '/comparison.js', '/punctuality-view.js',
  '/leaflet/leaflet.js', '/leaflet/leaflet.css', '/navigator-180.png', '/navigator-192.png',
  '/navigator-512.png', '/manifest.webmanifest',
];

async function isApp(response) {
  return response.ok && (await response.clone().text()).includes('id="saved-trips"');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const home = await fetch('/', { cache: 'no-cache' });
    if (!await isApp(home)) throw new Error('App-Anmeldung für Offline-Installation erforderlich.');
    const cache = await caches.open(offlineCache);
    await cache.addAll(shellFiles.slice(1));
    await cache.put('/', home);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && url.pathname === '/';
  if (!navigation && !shellFiles.includes(url.pathname)) return;
  event.respondWith((async () => {
    const key = navigation ? '/' : url.pathname;
    const cache = await caches.open(offlineCache);
    try {
      const response = await fetch(event.request);
      if (navigation ? await isApp(response) : response.ok) {
        try { await cache.put(key, response.clone()); } catch {}
      }
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('push', (event) => {
  const { title, body, url, tag } = event.data.json();
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body, icon: '/navigator-192.png', tag: tag || url, data: { url },
    });
    if ('setAppBadge' in navigator) {
      try { await navigator.setAppBadge(1); } catch {}
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin);
  if (url.origin !== self.location.origin) return;
  url.searchParams.set('update', String(Date.now()));
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === url.origin) {
        const navigated = await client.navigate(url.href);
        if (navigated) return navigated.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
