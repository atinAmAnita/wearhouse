// STOCKFORGE service worker — shell-only caching.
// API requests always go to the network (we never want stale eBay/inventory data).
// Static shell (HTML/CSS/JS) cached so the app launches instantly.

const VERSION = 'forge-shell-v1';
const SHELL = [
    '/app',
    '/app.html',
    '/app.js',
    '/styles.css',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION).then(cache => cache.addAll(SHELL).catch(() => {
            // Don't fail install if some assets aren't reachable (e.g., during a deploy)
            return Promise.all(SHELL.map(url => cache.add(url).catch(() => null)));
        }))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Drop old shell caches
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // never cache mutations

    const url = new URL(req.url);

    // API: always live. Never cached.
    if (url.pathname.startsWith('/api/')) return;

    // External (CDN libraries, eBay images): default browser handling.
    if (url.origin !== self.location.origin) return;

    // Shell: cache-first with network fallback. On success, refresh cache in background.
    event.respondWith(
        caches.match(req).then(cached => {
            const fetchPromise = fetch(req).then(networkResp => {
                if (networkResp.ok) {
                    const copy = networkResp.clone();
                    caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {});
                }
                return networkResp;
            }).catch(() => cached); // offline: serve cached if we have it
            return cached || fetchPromise;
        })
    );
});
