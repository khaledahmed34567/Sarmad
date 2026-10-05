/* Sarmad service worker — bump VERSION on every release so installed apps pick up changes */
const VERSION = 'v8-2026-09-30';
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
