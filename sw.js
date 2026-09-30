const CACHE = 'mineral-maps-ky-agate-v4';
const TILE_CACHE = 'mm-ky-topo-tiles-v1';
// Things the user downloaded (Forest Service land, offline places list). Deliberately
// NOT versioned, so an app update never deletes them. Keep the name in sync with app.js.
const USER_CACHE = 'mm-ky-user-data';
const USER_FILES = /land_fs_ownership\.geojson|places_ky\.json/;
const SHELL = [
  './index.html',
  './states/kentucky/map/index.html',
  './states/kentucky/map/app.js',
  './states/kentucky/map/road_router.js',
  './states/kentucky/map/style.css',
  './states/kentucky/map/field.js',
  './states/kentucky/map/field.css',
  './states/kentucky/map/data/targets.geojson',
  './states/kentucky/map/data/reaches.geojson',
  './states/kentucky/map/data/contact_target.geojson',
  './states/kentucky/map/data/contact_other.geojson',
  './states/kentucky/map/data/crossings_valid.geojson',
  './states/kentucky/map/data/geology_units.geojson',
  './states/kentucky/map/data/geology_target_units.geojson',
  './states/kentucky/map/data/faults.geojson',
  './states/kentucky/map/data/evidence_documented.geojson',
  './states/kentucky/map/data/evidence_reports.geojson',
  './states/kentucky/map/data/evidence_kgs_area.geojson',
  './states/kentucky/map/data/counties.geojson',
  './states/kentucky/map/data/quads.geojson',
  './states/kentucky/map/data/streams.geojson',
  './states/kentucky/map/data/experimental_menifee.geojson',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './shared/brand/manifest.json',
  './shared/brand/favicon-32.png',
  './shared/brand/apple-touch-icon-180.png',
  './shared/brand/mineral-maps-icon-192.png',
  './shared/brand/mineral-maps-icon-1024.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const user = await caches.open(USER_CACHE);
    for (const k of keys) {
      if (k === CACHE || k === TILE_CACHE || k === USER_CACHE) continue;
      // before an old app cache is deleted, rescue user downloads that older versions kept inside it
      try {
        const old = await caches.open(k);
        for (const req of await old.keys()) {
          if (USER_FILES.test(req.url) && !(await user.match(req))) { const r = await old.match(req); if (r) await user.put(req, r); }
        }
      } catch (_) {}
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // USGS Topo tiles: serve from the user-downloaded offline tile cache first.
  if (url.hostname === 'basemap.nationalmap.gov' && url.pathname.includes('/USGSTopo/')) {
    event.respondWith(caches.open(TILE_CACHE).then(c => c.match(event.request.url)).then(hit => hit || fetch(event.request)));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Same-origin: network first, fall back to cache (keeps data fresh when online).
  // With one bar of signal a fetch can hang for a minute before failing, so give
  // the network 4 seconds when a cached copy exists, then serve the cached copy.
  // IMPORTANT: only navigations fall back to the app shell. A missing .json/.js
  // request must never receive index.html, because that turns an offline miss into
  // a misleading parse/syntax error.
  const network = fetch(event.request).then(r => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)).catch(() => {}); }
    return r;
  });
  event.waitUntil(network.catch(() => {}));
  const cached = caches.match(event.request, { ignoreSearch: true });
  const timed = cached.then(hit => hit
    ? Promise.race([network, new Promise((_, rej) => setTimeout(() => rej(new Error('slow network')), 4000))])
    : network);
  event.respondWith(timed.catch(async () => {
    const hit = await cached;
    if (hit) return hit;
    if (event.request.mode === 'navigate') {
      const shell = await caches.match(new URL('./states/kentucky/map/index.html', self.registration.scope).href);
      if (shell) return shell;
    }
    return new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
  }));
});
