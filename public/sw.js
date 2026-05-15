// STOCKFORGE service worker.
// Strategy: network-first for the shell so fresh deploys show up on the next visit.
// Falls back to the cached copy only when offline. API requests are never cached.

const VERSION = 'forge-shell-v3';
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
            return Promise.all(SHELL.map(url => cache.add(url).catch(() => null)));
        }))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Wipe ALL old caches, regardless of name — the previous cache-first version
        // shipped stale HTML/JS and we need a clean slate.
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
        await self.clients.claim();
        // Force all open clients to reload so they pick up the new shell immediately,
        // rather than waiting for the user to refresh manually.
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const c of clients) {
            try { await c.navigate(c.url); } catch (_) { /* some clients can't navigate */ }
        }
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return;
    if (url.origin !== self.location.origin) return;

    // Network-first: always try the live version. Cache only as a fallback for offline.
    event.respondWith(
        fetch(req).then(networkResp => {
            if (networkResp.ok) {
                const copy = networkResp.clone();
                caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {});
            }
            return networkResp;
        }).catch(() => caches.match(req))
    );
});
