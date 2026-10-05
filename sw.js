/* Card Scanner service worker: works offline, and always tries the network first so
   updates you publish show up the next time the app is opened. */
const CACHE = 'card-scanner-v1';
const SHELL = ['./', 'index.html', 'logic.js', 'binder.js', 'binder.css', 'celebrate.css', 'celebrate.js', 'sounds.js', 'qrlink.js', 'vendor/qrcode.min.js', 'vendor/jsQR.min.js', 'sounds/ohhh.mp3', 'sounds/what.mp3', 'sounds/wow.mp3', 'sounds/omg.mp3', 'analytics.css', 'analytics.js', 'bulk.css', 'bulk.js', 'char-blue.webp', 'char-yellow.webp', 'thumbs-blue.webp', 'thumbs-yellow.webp', 'avatar-blue.webp', 'avatar-yellow.webp', 'card-back.webp', 'species.json', 'app.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'apps-script.txt'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // card data, fonts, OCR: not cached here
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
