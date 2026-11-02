// 自我观察本 · offline cache. Bump VERSION whenever any file changes.
const VERSION = 'v3';
const CACHE = 'zwgcb-' + VERSION;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('zwgcb-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  const net = fetch(req).then(async res => {
    if (res && res.ok) { const copy = res.clone(); const c = await caches.open(CACHE); await c.put(key, copy); }
    return res;
  }).catch(() => null);
  e.waitUntil(net.then(() => {}));
  e.respondWith(caches.match(key, { ignoreSearch: true }).then(hit => hit || net.then(res => res || new Response('离线，而且这个文件还没有缓存。联网打开一次就好。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
});
