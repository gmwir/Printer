/* Service worker: makes the app work fully offline after the first visit.
   VERSION is rewritten by tools/stamp.js whenever app files change, so phones pick up updates. */
var VERSION = 'ay-3181bae6a8d0';
var FILES = [
  './',
  'app.css',
  'Vazirmatn-Bold.woff2',
  'Vazirmatn-Regular.woff2',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'index.html',
  'manifest.webmanifest',
  'aiexport.js',
  'analytics.js',
  'app.js',
  'backup.js',
  'barcode1d.js',
  'catalog.js',
  'classify.js',
  'core.js',
  'db.js',
  'deals.js',
  'groups.js',
  'grouptree.js',
  'jalali.js',
  'match.js',
  'pdf.js',
  'period.js',
  'pricecheck.js',
  'pricelist.js',
  'purchase.js',
  'qr.js',
  'quotes.js',
  'reports.js',
  'reportsui.js',
  'safety.js',
  'saleslist.js',
  'scan.js',
  'scanworker.js',
  'studioexport.js',
  'ui.js',
  'views2.js',
  'vision.js',
  'xlsx.js',
  'jsQR.js'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); })); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (e) { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then(function (r) { return r || fetch(req); }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (r) {
    return r || fetch(req).then(function (resp) {
      if (resp && resp.ok && resp.type === 'basic') { var copy = resp.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return resp;
    });
  }));
});
