/* BookNest Service Worker：离线可用 + 封面本地缓存 */
const VERSION = 'booknest-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './scanner.js',
  './manifest.webmanifest',
  './vendor/zxing.min.js',
  './vendor/qrcode.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 封面图片 / 静态资源：缓存优先
  if (url.pathname.startsWith('/api/cover') || url.pathname.startsWith('/covers/') || url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
            return res;
          })
      )
    );
    return;
  }

  // 接口：网络优先，失败时给出明确错误
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({ error: '离线状态：无法访问本地服务' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // 页面外壳：网络优先，离线回退缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
