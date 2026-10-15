/* L-O ERP service worker: makes the system installable and opens the app shell offline.
   API calls are never cached (always live, always with the session). */
const CACHE = 'lo-erp-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/brand/shield-256.png', '/brand/icon-192.png', '/brand/wordmark-white.png'];

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
