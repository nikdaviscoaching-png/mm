// sw.js — offline after first load. HTML: network-first with a short timeout (never stuck);
// everything else: cache-first (versioned). Bump VERSION on every release.
const VERSION = 'stacker-v1.1.1';
const ASSETS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/collage.js', 'js/decode.js', 'js/engine.js', 'js/pipeline.js', 'js/store.js', 'js/worker.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'vendor/exifr/exifr.mjs', 'vendor/piexif.mjs', 'vendor/jsquash/encode.js', 'vendor/jsquash/meta.js', 'vendor/jsquash/utils.js', 'vendor/jsquash/codec/enc/mozjpeg_enc.js', 'vendor/jsquash/codec/enc/mozjpeg_enc.wasm',
  'vendor/libraw/index.js', 'vendor/libraw/worker.js', 'vendor/libraw/libraw.js', 'vendor/libraw/libraw.wasm'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return; const url = new URL(req.url); if (url.origin !== location.origin) return;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith((async () => {
      try { const res = await Promise.race([fetch(req), timeout(2500)]); if (res && res.ok) { const c = await caches.open(VERSION); c.put('index.html', res.clone()); } return res; }
      catch (err) { const c = await caches.open(VERSION); return (await c.match('index.html')) || (await c.match('./')) || new Response('<h1>Offline</h1><p>Open Stacker once while online.</p>', { headers: { 'content-type': 'text/html' } }); }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(VERSION); const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit;
    const res = await fetch(req); if (res.ok && res.type === 'basic') c.put(req, res.clone()); return res;
  })());
});
