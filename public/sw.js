// Minimal service worker — exists only so the PWA is installable.
// No caching at all: the browser always fetches fresh content from the network.
// This trades offline support for the guarantee that deploys show up immediately.

const VERSION = 'forge-v4-no-cache';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Wipe every cache the previous SW versions left behind.
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        await self.clients.claim();
        // Force every open client to reload so they pick up the live network content
        // instead of whatever stale HTML/JS the old SW served them.
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const c of clients) {
            try { await c.navigate(c.url); } catch (_) {}
        }
    })());
});

// Intentionally no fetch handler — the browser handles every request directly.
