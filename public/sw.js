self.addEventListener('push', (event) => {
  const { title, body, url } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, {
    body, icon: '/icon-192.png', tag: url, data: { url },
  }));
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
