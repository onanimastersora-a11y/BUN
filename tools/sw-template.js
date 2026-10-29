// BUN service worker (web / iPhone app). Generated into the build by
// tools/vite-web-plugin.mjs, which fills in VERSION and FILES.
// - Caches the whole app on install so it opens offline.
// - Shows the reminder notifications pushed by the site's worker.
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `bun-${VERSION}`;
const scope = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', ...FILES].map((f) => new URL(f, scope).toString())))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bun-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.href.startsWith(scope)) return;
  if (req.mode === 'navigate') {
    // Fresh page when online, cached page when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(new URL('./', scope).toString(), copy));
          return res;
        })
        .catch(() => caches.match(new URL('./', scope).toString())),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || 'BUN 🐾';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: new URL('icons/icon-192.png', scope).toString(),
      badge: new URL('icons/badge-96.png', scope).toString(),
      data: { url: data.url || scope },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(scope));
      if (open) return open.focus();
      return self.clients.openWindow(target);
    }),
  );
});
