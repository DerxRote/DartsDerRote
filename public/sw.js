/* Darts Counter – Service Worker: App offline verfügbar machen.
   Bei jeder Änderung an den Dateien VERSION hochzählen, damit Geräte die neue Version laden.
   /app/ (Freunde-Bereich) wird nicht vorab geladen, weil davor die Anmeldung von Cloudflare Access sitzt.
   /api/ und /cdn-cgi/ gehen immer direkt ans Netz. */
const VERSION = 'darts-v6';
const FILES = [
  '/', '/css/style.css', '/fonts/fonts.css', '/js/engine.js', '/js/app.js',
  '/manifest.webmanifest', '/manifest-app.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Nur echte, eigene Antworten cachen – keine Weiterleitungen zur Anmeldung.
const cacheable = (res) => res && res.ok && res.type === 'basic' && !res.redirected;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;

  // Seiten: erst Netz (für Updates und die Anmeldung), offline aus dem Cache
  if (req.mode === 'navigate') {
    const key = url.pathname.startsWith('/app') ? '/app/' : '/';
    event.respondWith(fetch(req).then((res) => {
      if (cacheable(res)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((hit) => hit || caches.match('/'))));
    return;
  }

  // Dateien: sofort aus dem Cache, im Hintergrund aktualisieren
  event.respondWith(caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => { if (cacheable(res)) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
