// sw.js — offline after the first visit.
//  • The whole release is precached as ONE versioned set and everything is served from it, so HTML and scripts can never come from different
//    releases (v1.1.1 served HTML network-first but scripts cache-first, which breaks right after a deploy).
//  • A new release waits until the page accepts it (message 'skipWaiting'), so a running job is never swapped out from under you.
//  • On hosts that cannot send the cross-origin-isolation headers (RAW decoding needs them) the worker adds them, and it fixes script / wasm MIME types.
const VERSION = 'stacker-v1.2.0';
const ASSETS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/boot.js', 'js/app.js', 'js/collage.js', 'js/decode.js', 'js/engine.js', 'js/exporter.js', 'js/focusfuse.js', 'js/focusmap.js', 'js/jpegenc.js', 'js/lightstack.js', 'js/pipeline.js', 'js/store.js', 'js/worker.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'vendor/exifr/exifr.mjs', 'vendor/piexif.mjs',
  'vendor/libraw/index.js', 'vendor/libraw/worker.js', 'vendor/libraw/libraw.js', 'vendor/libraw/libraw.wasm'];
const MIME = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', css: 'text/css', webmanifest: 'application/manifest+json' };

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))); });
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k.startsWith('stacker-')).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

function isolate(res, url) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers); h.set('Cross-Origin-Embedder-Policy', 'require-corp'); h.set('Cross-Origin-Opener-Policy', 'same-origin'); h.set('Cross-Origin-Resource-Policy', 'same-origin');
  const ext = (new URL(url, location.href).pathname.split('.').pop() || '').toLowerCase();
  if (MIME[ext] && (ext === 'wasm' || ext === 'js' || ext === 'mjs' || !h.get('content-type'))) h.set('Content-Type', MIME[ext]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return; const url = new URL(req.url); if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION), nav = req.mode === 'navigate';
    const hit = await c.match(nav ? 'index.html' : req, { ignoreSearch: true });
    if (hit) return isolate(hit, nav ? 'index.html' : req.url);
    try { return isolate(await fetch(req), req.url); }
    catch (err) { return nav ? new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:2rem;background:#0b0c0f;color:#eee"><h1>Offline</h1><p>Open Stacker once while online so it can be used without a connection.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) : Response.error(); }
  })());
});
