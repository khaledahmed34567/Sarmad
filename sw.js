/* Sarmad service worker — bump VERSION on every release so installed apps pick up changes */
const VERSION = 'v5-2026-09-30';
const CACHE = 'sarmad-' + VERSION;
const PUSH_ICON = 'data:image/png;base64,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';
const PRECACHE = ['./', 'index.html', 'style.css', 'script.js', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache:'reload' }))))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // Firebase, imgbb, fonts… go straight to network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {                                                // everything else: network-first so updates land immediately
      const res = await fetch(req, { cache:'no-cache' });
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

/* ---- Push notifications (FCM data messages: title / body / link) ---- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  const p = d.data || d.notification || d;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    if (wins.some(c => c.visibilityState === 'visible')) return;   // app is open: it shows its own toast
    await self.registration.showNotification(p.title || 'سرمد', {
      body: p.body || '', icon: PUSH_ICON, badge: PUSH_ICON, dir: 'rtl', lang: 'ar',
      tag: p.tag || 'sarmad', data: { link: p.link || '' },
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '';
  const target = /^https?:/i.test(link) ? link : new URL('./#/' + link.replace(/^#?\/?/, ''), self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const c of wins) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if (!/^https?:/i.test(link)) { try { await c.navigate(target); } catch (_) {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
