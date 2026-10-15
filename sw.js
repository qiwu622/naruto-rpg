const CACHE_PREFIX = 'naruto-rpg-';
const CACHE_NAME = `${CACHE_PREFIX}v3.7.0`;
const REVALIDATED_DESTINATIONS = new Set(['document', 'script', 'style', 'worker', 'sharedworker']);
const REVALIDATED_PATH = /\.(?:html?|m?js|css|json|webmanifest)$/i;

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    for (const client of clients) client.postMessage({ type: 'SW_UPDATED' });
  })());
});

function bypassesServiceWorker(url, request) {
  return request.method !== 'GET'
    || url.pathname === '/api'
    || url.pathname.startsWith('/api/')
    || url.pathname === '/auth'
    || url.pathname.startsWith('/auth/')
    || url.pathname.startsWith('/v1/chat/completions')
    || url.pathname.startsWith('/v1/messages');
}

function requiresFreshNetworkResponse(url, request) {
  if (url.origin !== self.location.origin) return false;
  return request.mode === 'navigate'
    || REVALIDATED_DESTINATIONS.has(request.destination)
    || REVALIDATED_PATH.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (bypassesServiceWorker(url, event.request)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(
        event.request,
        requiresFreshNetworkResponse(url, event.request) ? { cache: 'no-store' } : undefined
      );
      if (response?.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)));
      }
      return response;
    } catch {
      return await caches.match(event.request)
        || new Response('Offline', { status: 503 });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});
