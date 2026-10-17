/* L-O ERP service worker: makes the system installable, opens the app shell offline,
   and shows notifications pushed by the server even when the system is closed.
   API calls are never cached (always live, always with the session). */
const CACHE = 'lo-erp-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/brand/shield-256.png', '/brand/icon-192.png', '/brand/wordmark-white.png', '/brand/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/iclock/')) return;
  // Network first so a new release shows at once; the cache is only the offline fallback.
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/brand/'))) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))));
});

/* A notification from the server: { title, body, link, tag }. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'L-O ERP';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/brand/icon-192.png',
    badge: '/brand/badge-96.png',
    dir: 'rtl',
    lang: 'ar',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: typeof data.link === 'string' && data.link.startsWith('/') ? data.link : '/home' },
  }));
});

/* Opening a notification brings the system forward at the screen it is about. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/home';
  const target = new URL(`/#${link}`, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        return client.focus().then((focused) => (focused && 'navigate' in focused ? focused.navigate(target).catch(() => focused) : focused));
      }
    }
    return self.clients.openWindow(target);
  }));
});
