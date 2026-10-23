/* brain viewer service worker — install shell + offline fallback.
 *
 * Network-first for everything the dashboard needs, because this app is edited
 * constantly and a stale app.js/app.py pair looks like a bug. The cache only
 * exists so the installed icon opens (showing the last known frame) when the
 * laptop is asleep, and so iOS keeps the installable status.
 */
const V = 'neuro-v2';   // v2: new app icon (orb, full-bleed) — bump so installed PWAs refetch the shell
const SHELL = [
  '/',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // fonts, tailscale etc: leave alone
  if (url.pathname.startsWith('/api/')) return;    // live data must never be cached

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(V).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/')))
  );
});
