'use strict';

// Kentucky agate prospecting map — built on the Mineral Maps shell.
// All research data are local files in ./data (see docs/ for provenance).

const STUDY_CENTER = [37.62, -84.02];
const STUDY_BOUNDS = L.latLngBounds([37.20, -84.65], [38.10, -83.15]);
const TARGET_BOUNDS = L.latLngBounds([37.45, -84.30], [37.85, -83.70]);
const DATA = 'data/';
const TILE_CACHE = 'mm-ky-topo-tiles-v1';
const DATA_CACHE = 'mineral-maps-ky-agate-v4';        // app shell + core data; must equal CACHE in sw.js (its version changes with each release)
const USER_CACHE = 'mm-ky-user-data';                  // Forest Service land, places list: never versioned, never deleted by an update (same name in sw.js)
const TOPO_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const COLORS = { 'TOP PRIORITY': '#e3342f', 'STRONG TARGET': '#f28c28', 'MODERATE TARGET': '#f5d327' };

const map = L.map('map', {
  zoomControl: false, attributionControl: true, minZoom: 7, maxZoom: 19, preferCanvas: true, tap: true
}).setView(STUDY_CENTER, 10);

L.control.zoom({ position: 'bottomleft' }).addTo(map);

// Every popup auto-pans so its top stays BELOW the top bar (measured live, so it
// follows the iPhone safe area), and clear of the bottom edge.
Object.defineProperty(L.Popup.prototype.options, 'autoPanPaddingTopLeft', {
  // not enumerable (so Leaflet's option copying in marker.setIcon() skips it) and
  // with a setter (so an explicit per-popup value still works)
  configurable: true, enumerable: false,
  set(v) { Object.defineProperty(this, 'autoPanPaddingTopLeft', { value: v, writable: true, configurable: true, enumerable: true }); },
  get() { const tb = document.querySelector('.topbar'); const b = tb ? tb.getBoundingClientRect().bottom : 60; return L.point(10, Math.round(b + 10)); }
});
L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(10, 16);
L.control.scale({ position: 'bottomleft', metric: true, imperial: true }).addTo(map);

// panes so field layers draw in a sensible order
[['units', 300], ['lines', 410], ['reach', 420], ['contact', 430], ['pts', 450], ['tgt', 460], ['star', 470]].forEach(([n, z]) => {
  map.createPane(n).style.zIndex = z;
});
const canvasLines = L.canvas({ pane: 'lines', padding: 0.3 });
const canvasPts = L.canvas({ pane: 'pts', padding: 0.3 });

// Zoom-12 topo stretched underneath the main topo layer. The saved tile cache always has
// the low zooms, so an area with no close-up tiles saved shows a blurry map, not grey.
const topoBackdrop = L.tileLayer(TOPO_URL, { maxZoom: 19, maxNativeZoom: 12, attribution: '', crossOrigin: 'anonymous', zIndex: 1 });
const basemaps = {
  topo: L.tileLayer(TOPO_URL, { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS National Map', crossOrigin: 'anonymous', zIndex: 2 }),
  imagery: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Esri World Imagery'
  }),
  streets: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS'
  })
};
topoBackdrop.addTo(map);
let currentBase = basemaps.topo.addTo(map);
function setBasemap(name) {
  const next = basemaps[name];
  if (!next || next === currentBase) return;
  map.removeLayer(currentBase); next.addTo(map); currentBase = next;
  if (next === basemaps.topo) { if (!map.hasLayer(topoBackdrop)) topoBackdrop.addTo(map); }
  else if (map.hasLayer(topoBackdrop)) map.removeLayer(topoBackdrop);
}
document.querySelectorAll('input[name="basemap"]').forEach(input => input.addEventListener('change', () => setBasemap(input.value)));

const panel = document.getElementById('panel');
const scrim = document.getElementById('scrim');
function setPanel(open) {
  panel.classList.toggle('open', open); scrim.classList.toggle('show', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
}
document.getElementById('menu-btn').addEventListener('click', () => { setSheet(false); setPanel(true); });
document.getElementById('close-btn').addEventListener('click', () => setPanel(false));
scrim.addEventListener('click', () => setPanel(false));

function showToast(message, ms = 1700) {
  const toast = document.getElementById('toast');
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), ms);
}

const c4 = v => Number(v).toFixed(4);
function coordText(latlng) { return `${c4(latlng.lat)}, ${c4(latlng.lng)}`; }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast(`Copied ${text}`); }
  catch (_) { window.prompt('Copy coordinates:', text); }
}
window.copyText = copyText;

let suppressMapClick = false;
let lastLongPress = 0;                       // time a long-press pin was dropped (its release must not open the coordinate popup)
window.ffJustLongPressed = () => Date.now() - lastLongPress < 900;
map.on('click', e => {
  if (window.ffJustLongPressed()) return;
  if (suppressMapClick) { suppressMapClick = false; return; }
  L.popup().setLatLng(e.latlng)
    .setContent(`<strong>${coordText(e.latlng)}</strong><br><span style="opacity:.7">Long-press to drop a pin</span>`)
    .openOn(map);
});

let pressTimer = null, pressLatLng = null;
map.on('mousedown touchstart', e => {
  pressLatLng = e.latlng; clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressLatLng) return;
    lastLongPress = Date.now();
    if (typeof window.ffDropPin === 'function') window.ffDropPin(pressLatLng.lat, pressLatLng.lng, 'Dropped pin');
    else copyText(coordText(pressLatLng));
  }, 650);
});
['mouseup', 'touchend', 'mousemove', 'touchmove', 'zoomstart', 'movestart'].forEach(evt => {
  map.on(evt, () => { clearTimeout(pressTimer); pressTimer = null; });
});

// ---------- GPS ----------
const locationLayer = L.layerGroup().addTo(map);
let lastFix = null;
document.getElementById('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return showToast('Location is unavailable on this device');
  showToast('Getting location…');
  navigator.geolocation.getCurrentPosition(pos => {
    const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
    lastFix = latlng;
    locationLayer.clearLayers();
    L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 3, fillColor: '#2586ff', fillOpacity: 1 }).addTo(locationLayer);
    if (Number.isFinite(pos.coords.accuracy)) {
      L.circle(latlng, { radius: pos.coords.accuracy, color: '#2586ff', weight: 1, opacity: .65, fillOpacity: .08 }).addTo(locationLayer);
    }
    map.setView(latlng, Math.max(map.getZoom(), 15));
    showToast(`${coordText(latlng)} ±${Math.round(pos.coords.accuracy || 0)} m`);
    if (document.getElementById('sort-sel').value === 'near') renderList();
  }, err => showToast(err.message || 'Could not get location'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
});

document.getElementById('center-btn').addEventListener('click', () => map.fitBounds(TARGET_BOUNDS, { padding: [18, 18] }));

// ---------- data helpers ----------
const cache = {};
function getJSON(name) {
  if (!cache[name]) {
    cache[name] = fetch(DATA + name)
      .then(r => { if (!r.ok) throw new Error(name + ' ' + r.status); return r.json(); })
      .catch(e => { delete cache[name]; throw e; }); // allow a retry after a transient/offline miss
  }
  return cache[name];
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nm = (v, unit = '', d = null) => (v === null || v === undefined || Number.isNaN(v)) ? '<i style="opacity:.7">not measured</i>' : `${d === null ? v : Number(v).toFixed(d)}${unit}`;

function priPill(p) { return `<span class="pri" style="background:${COLORS[p] || '#aaa'}">${esc(p)}</span>`; }
function confPill(p) {
  return p.contact_class.startsWith('PROBABLE')
    ? `<span class="conf-prob">PROBABLE EQUIVALENT — less certain</span>`
    : `<span style="color:#9eeefc;font-size:10.5px">${esc(p.contact_class)}</span>`;
}
function whyHorizon(p) {
  if (p.contact_class.startsWith('PROBABLE')) return 'The Wildie Member is the upper-Nada lithosome under a different name south of the arbitrary Berea-quadrangle cutoff (Weir and others, 1966; Gualtieri 1968). Agate/chalcedony nodules in this belt come from the uppermost Borden directly beneath the Renfro dolostone.';
  if (p.contact_class.includes('combined')) return 'The line is the top of the mapped Renfro + Nada unit. The actual target — the top of the Nada under the Renfro dolostone — crops out a few feet to ~10 m lower on the same slopes, so float enters this channel within the source zone shown.';
  return 'This is the mapped base of the Renfro Member on the Nada Member. Kentucky agate is reported from the uppermost Nada/lower Renfro (silica replacing dolostone and evaporite nodules); this exact contact is the source horizon.';
}
function row(k, v) { return `<tr><td>${k}</td><td>${v}</td></tr>`; }

function targetPopup(p) {
  const ws = p.walk_start, sz = p.source_zone_end;
  const tb = [
    row('Coordinates (source crossing)', `<b>${c4(p.lat)}, ${c4(p.lon)}</b>`),
    row('Start walking (primary-reach lower end)', ws ? `${c4(ws[0])}, ${c4(ws[1])}` : 'n/a'),
    row('County / quadrangle', `${esc(p.county)} · ${esc(p.quad)} 7.5′ (${esc(p.gq)})`),
    row('Channel', `${esc(p.stream)} — ${esc(p.nhd)}`),
    row('Elevation at crossing', nm(p.elev_m, ' m'))
  ].join('');
  const geo = [
    row('Contact class', esc(p.contact_class)),
    row('Original line symbol', `<b>${esc(p.line_symbol)}</b> (${esc(p.contact_style)})`),
    row('Polygon pair (below | above, digital)', esc(p.polygon_pair)),
    row('Unit below', esc(p.unit_below)),
    row('Unit above', esc(p.unit_above)),
    row('Interpreted meaning', esc(p.interpretation)),
    row('Geological confidence', esc(p.geo_conf)),
    row('Facies belt', esc(p.facies))
  ].join('');
  const met = [
    row('Distance from contact', `Source crossing = 0 m; primary reach runs ${nm(p.prim_len_m, ' m')} downstream; extended reach to ${nm(p.ext_len_m, ' m')}`),
    row('Target contact upstream of primary-reach end', nm(p.L_prim_km, ' km')),
    row('Drainage area at crossing / at reach end', `${nm(p.da_cross_km2, ' km²')} / ${nm(p.DA_prim_km2, ' km²')}`),
    row('Dilution (contact km per km² drainage)', nm(p.density)),
    row('Pennsylvanian-sandstone share of drainage', nm(p.pen_pct, '%')),
    row('Local relief (1 km radius)', nm(p.relief_1km_m, ' m')),
    row('Hillslope at crossing (200 m) / on upstream contact', `${nm(p.slope200_deg, '°')} / ${nm(p.contact_slope_deg, '°')}`),
    row('Channel gradient first 300 m / primary reach', `${nm(p.grad300_pct, '%')} / ${nm(p.grad_prim_pct, '%')}`),
    row('Incision at crossing', nm(p.incision_m, ' m')),
    row('Nearest mapped fault (not scored)', nm(p.fault_dist_m, ' m')),
    row('Depositional traps', '<i style="opacity:.7">not measured — bar/pool positions cannot be resolved from 20 m DEM; look for them on the reach</i>')
  ].join('');
  const sc = [
    row('Source supply S (0.25)', nm(p.S, '', 2)), row('Concentration/dilution D (0.20)', nm(p.D, '', 2)),
    row('Erosion/replenishment E (0.10)', nm(p.E, '', 2)), row('Incision/relief I (0.15)', nm(p.I, '', 2)),
    row('Transport/gradient T (0.10)', nm(p.Tt, '', 2)), row('Regional evidence R (0.20)', nm(p.Rg, '', 2)),
    row('Geology multiplier G', nm(p.G, '', 2)), row('Score', `<b>${nm(p.score)}</b> / 100 (relative rank, not a probability)`)
  ].join('');
  const ev = [
    row('Nearest documented locality', `${esc(p.doc_nearest)} — ${nm(p.doc_nearest_km, ' km')}`),
    row('Documented locality on this reach (≤500 m)', p.doc_on_reach ? esc(p.doc_on_reach) : 'none'),
    row('Collector reports on this stream', p.report_on_reach ? esc(p.report_on_reach) + ' (not scored)' : 'none'),
    row('Distance outside KGS agate area', p.dist_outline_km ? `${p.dist_outline_km} km` : 'inside'),
    row('Evidence quality', esc(p.evidence_quality))
  ].join('');
  const gmaps = ws ? `https://www.google.com/maps/dir/?api=1&destination=${ws[0]},${ws[1]}` : '#';
  return `<div class="pp">
  <h3>#${p.rank} ${esc(p.stream)}</h3>
  <div>${priPill(p.priority)} <b>${p.score}</b>/100 · ${confPill(p)}</div>
  <table>${tb}</table>
  <div><b>Why this spot</b><ul>${p.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
  <div><b>Weaknesses</b><ul>${(p.negatives.length ? p.negatives : ['none flagged']).map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
  <details><summary>Why this horizon</summary><p style="margin:4px 0">${esc(whyHorizon(p))}</p></details>
  <details><summary>Geology &amp; map units</summary><table>${geo}</table></details>
  <details><summary>Measured terrain &amp; drainage</summary><table>${met}</table></details>
  <details><summary>Score inputs</summary><table>${sc}</table></details>
  <details><summary>Evidence</summary><table>${ev}</table></details>
  <details><summary>Citation</summary><p style="margin:4px 0">${esc(p.citation)}</p></details>
  <div class="btns">
    <button onclick="copyText('${c4(p.lat)}, ${c4(p.lon)}')">Copy source</button>
    ${ws ? `<button onclick="copyText('${c4(ws[0])}, ${c4(ws[1])}')">Copy walk start</button>` : ''}
    <a href="${gmaps}" target="_blank" rel="noopener">Directions to walk start</a>
  </div></div>`;
}

function validPopup(p) {
  const tag = p.shares_reach_with_rank ? `Shares its search reach with ranked target #${p.shares_reach_with_rank}` : 'Valid crossing — not in the ranked 120';
  return `<div class="pp"><h3>${esc(p.stream)}</h3>
  <div style="color:#c9c8bf">VALID LOWER-PRIORITY CROSSING · score ${p.score}/100</div>
  <div style="margin:3px 0">${esc(tag)}</div>
  <table>
  ${row('Coordinates', `<b>${c4(p.lat)}, ${c4(p.lon)}</b>`)}
  ${row('County / quad', `${esc(p.county)} · ${esc(p.quad)} (${esc(p.gq)})`)}
  ${row('Contact', `${esc(p.contact_class)} — line ${esc(p.line_symbol)}, polygons ${esc(p.polygon_pair)}`)}
  ${row('Unit below / above', `${esc(p.unit_below)} / ${esc(p.unit_above)}`)}
  ${row('Confidence', esc(p.geo_conf))}
  ${row('Upstream contact / drainage at reach end', `${nm(p.L_prim_km, ' km')} / ${nm(p.DA_prim_km2, ' km²')}`)}
  ${row('Dilution / relief / incision', `${nm(p.density)} / ${nm(p.relief_1km_m, ' m')} / ${nm(p.incision_m, ' m')}`)}
  ${row('Reach gradient', nm(p.grad_prim_pct, '%'))}
  ${row('Score inputs S D E I T R G', [p.S, p.D, p.E, p.I, p.Tt, p.Rg, p.G].map(x => x ?? '–').join(' · '))}
  </table>
  <div class="btns"><button onclick="copyText('${c4(p.lat)}, ${c4(p.lon)}')">Copy coordinates</button></div></div>`;
}

function propTable(p, keys) {
  return `<table>${keys.filter(k => p[k] !== undefined && p[k] !== null && p[k] !== '').map(k => row(esc(k.replace(/_/g, ' ')), k.endsWith('url') || k === 'source' ? `<a href="${esc(p[k])}" target="_blank" rel="noopener">${esc(p[k])}</a>` : esc(p[k]))).join('')}</table>`;
}

// ---------- layers ----------
const L_ = {};
const groups = {};
function group(key) { if (!groups[key]) groups[key] = L.layerGroup(); return groups[key]; }
let TARGETS = [];
const markerById = {};

async function buildTargets() {
  const gj = await getJSON('targets.geojson');
  TARGETS = gj.features.map(f => f.properties);
  const tierKey = { 'TOP PRIORITY': 'top', 'STRONG TARGET': 'strong', 'MODERATE TARGET': 'moderate' };
  // draw lower tiers first
  [...gj.features].sort((a, b) => b.properties.rank - a.properties.rank).forEach(f => {
    const p = f.properties, col = COLORS[p.priority];
    const big = p.priority !== 'MODERATE TARGET';
    const size = p.priority === 'TOP PRIORITY' ? 26 : (big ? 22 : 16);
    const probable = p.contact_class.startsWith('PROBABLE');
    const icon = L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="rank-icon" style="width:${size}px;height:${size}px;background:${col};${probable ? 'border-style:dashed;opacity:.85;' : ''}">${big ? p.rank : ''}</div>`
    });
    const m = L.marker([p.lat, p.lon], { icon, pane: 'tgt', title: `#${p.rank} ${p.stream}` })
      .bindPopup(() => targetPopup(p), { maxWidth: 330, minWidth: 250 });
    m.on('click', () => { suppressMapClick = true; });
    m.addTo(group(tierKey[p.priority]));
    markerById[p.id] = m;
  });
  const rj = await getJSON('reaches.geojson');
  const pri = {}; TARGETS.forEach(p => pri[p.rank] = p.priority);
  rj.features.forEach(f => {
    const k = f.properties.kind, col = COLORS[f.properties.priority];
    const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
    const style = k === 'source' ? { color: col, weight: 11, opacity: .45, lineCap: 'round' }
      : k === 'primary' ? { color: col, weight: 4.5, opacity: .95 }
        : { color: col, weight: 4, opacity: .9, dashArray: '2 8', lineCap: 'round' };
    const casing = k !== 'source' ? L.polyline(ll, { color: '#111', weight: style.weight + 2.5, opacity: .55, pane: 'reach', interactive: false, dashArray: style.dashArray, lineCap: style.lineCap }) : null;
    const line = L.polyline(ll, { ...style, pane: 'reach' });
    const label = { source: 'Source crossing zone', primary: 'Primary search reach', extended: 'Optional extended search reach' }[k];
    line.bindPopup(() => {
      const p = TARGETS.find(t => t.rank === f.properties.rank);
      if (!p) return `<div class="pp"><b>${label}</b><br><span style="opacity:.8">Target details could not be matched.</span></div>`;
      return `<div class="pp"><b>${label}</b> for #${p.rank}<br>${priPill(p.priority)} ${esc(p.stream)}<br><span style="opacity:.8">${k === 'source' ? 'Where the channel cuts the target horizon (first 15 m of drop or 600 m).' : k === 'primary' ? 'Walk this first: from the lower end upstream to the source crossing.' : 'Float can travel farther; search bars here if the primary reach is barren.'}</span><div class="btns"><button onclick="map.closePopup();openTarget(${p.id})">Open target #${p.rank}</button></div></div>`;
    });
    line.on('click', () => { suppressMapClick = true; });
    if (casing) casing.addTo(group(k));
    line.addTo(group(k));
  });
}

async function buildContacts() {
  const gj = await getJSON('contact_target.geojson');
  L_.contact = L.geoJSON(gj, {
    pane: 'contact',
    style: f => {
      const prob = f.properties.class_label.startsWith('PROBABLE');
      const comb = f.properties.class_label.includes('combined');
      return { color: prob ? '#19d3f5' : (comb ? '#6fe6ff' : '#19d3f5'), weight: comb ? 2.5 : 3, opacity: prob ? .8 : .95, dashArray: prob ? '7 6' : null };
    },
    onEachFeature: (f, l) => {
      l.bindPopup(`<div class="pp"><b>${esc(f.properties.class_label)}</b>${propTable(f.properties, ['quad', 'source_pub', 'original_line_symbol', 'polygon_pair_below_above', 'contact_style', 'meaning', 'confidence', 'source_url'])}</div>`, { maxWidth: 320 });
      l.on('click', () => { suppressMapClick = true; });
    }
  });
  L_.contact.addTo(group('contact'));
}

const lazy = {
  valid: async () => {
    const gj = await getJSON('crossings_valid.geojson');
    return L.geoJSON(gj, {
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: canvasPts, radius: f.properties.contact_class.startsWith('PROBABLE') ? 3.5 : 4, color: '#2b2b28', weight: 1, fillColor: '#b4b3aa', fillOpacity: f.properties.contact_class.startsWith('PROBABLE') ? .45 : .8, dashArray: null }),
      onEachFeature: (f, l) => { l.bindPopup(() => validPopup(f.properties), { maxWidth: 320 }); l.on('click', () => { suppressMapClick = true; }); }
    });
  },
  documented: async () => {
    const gj = await getJSON('evidence_documented.geojson');
    return L.geoJSON(gj, {
      pointToLayer: (f, ll) => L.marker(ll, { pane: 'star', icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="star-icon" style="${f.properties.kind.startsWith('contrast') ? 'color:#bbb' : ''}">★</div>` }) }),
      onEachFeature: (f, l) => { l.bindPopup(`<div class="pp"><b>${esc(f.properties.name)}</b>${propTable(f.properties, ['kind', 'evidence', 'county', 'quad', 'position', 'citation', 'url'])}</div>`, { maxWidth: 320 }); l.on('click', () => { suppressMapClick = true; }); }
    });
  },
  reports: async () => {
    const gj = await getJSON('evidence_reports.geojson');
    return L.geoJSON(gj, {
      pane: 'reach',
      style: { color: '#c79bff', weight: 3, opacity: .75, dashArray: '1 6', lineCap: 'round' },
      pointToLayer: (f, ll) => L.marker(ll, { pane: 'star', icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: '<div class="star-icon hollow">☆</div>' }) }),
      onEachFeature: (f, l) => { l.bindPopup(`<div class="pp"><b>${esc(f.properties.name)}</b> — collector/secondary report${propTable(f.properties, ['evidence', 'precision', 'quality', 'source'])}</div>`, { maxWidth: 320 }); l.on('click', () => { suppressMapClick = true; }); }
    });
  },
  kgsarea: async () => L.geoJSON(await getJSON('evidence_kgs_area.geojson'), {
    pane: 'units', style: { color: '#ffe14d', weight: 2, dashArray: '8 6', fillColor: '#ffe14d', fillOpacity: .07 },
    onEachFeature: (f, l) => l.bindPopup(`<div class="pp"><b>${esc(f.properties.name)}</b>${propTable(f.properties, ['source', 'note', 'url'])}</div>`)
  }),
  targetunits: async () => L.geoJSON(await getJSON('geology_target_units.geojson'), {
    pane: 'units', style: { color: '#6aa84f', weight: .5, fillColor: '#7ec45e', fillOpacity: .35 },
    onEachFeature: (f, l) => l.bindPopup(`<div class="pp"><b>Borden Formation polygon, ${esc(f.properties.quadrangle_name)} quadrangle</b><br>Its upper edge carries the target contact where that edge is drawn in cyan. The polygon itself is mostly older Borden (Nancy/Cowbell) and is not all target rock.</div>`)
  }),
  units: async () => {
    const pal = { 'Quaternary / surficial': '#e8d9a8', 'Renfro Member (above target)': '#d9a441', 'Borden Formation (target Nada / Wildie at top)': '#8fbf6a', 'Slade / Newman / Paragon / Pennington (Mississippian carbonates, above)': '#6d9fcf', 'Devonian - lowest Mississippian shales and Boyle Dolomite': '#8c6d9c', 'Silurian': '#c98fb0', 'Pennsylvanian clastics': '#c9a26b', 'Ordovician and other': '#b0b0a0' };
    return L.geoJSON(await getJSON('geology_units.geojson'), {
      pane: 'units', style: f => ({ color: '#333', weight: .3, fillColor: pal[f.properties.grp] || '#999', fillOpacity: .42 }),
      onEachFeature: (f, l) => l.bindPopup(`<div class="pp"><b>${esc(f.properties.grp)}</b><br><span style="opacity:.8">Simplified from KGS 1:24,000 digital geology (30 m generalization). Use the target contact layer, not these fills, for field positions.</span></div>`)
    });
  },
  othercontacts: async () => L.geoJSON(await getJSON('contact_other.geojson'), {
    pane: 'contact', style: f => ({ color: f.properties.class_label === 'NOT TARGET GEOLOGY' ? '#8a5a5a' : '#9d9d9d', weight: 2, opacity: .85, dashArray: '4 5' }),
    onEachFeature: (f, l) => { l.bindPopup(`<div class="pp"><b>${esc(f.properties.class_label)} — not used</b>${propTable(f.properties, ['quad', 'source_pub', 'original_line_symbol', 'polygon_pair_below_above', 'meaning', 'source_url'])}</div>`, { maxWidth: 320 }); l.on('click', () => { suppressMapClick = true; }); }
  }),
  faults: async () => L.geoJSON(await getJSON('faults.geojson'), {
    pane: 'lines', style: { color: '#d63bd6', weight: 2, opacity: .85 },
    onEachFeature: (f, l) => l.bindPopup(`<div class="pp"><b>Fault</b>${propTable(f.properties, ['fault_name', 'feature_type', 'fault_throw', 'line_style', 'quadrangle_name'])}<span style="opacity:.75">Shown for context; not used in scores.</span></div>`)
  }),
  quads: async () => L.geoJSON(await getJSON('quads.geojson'), {
    pane: 'lines', style: { color: '#e0e0e0', weight: 1.2, opacity: .8, fill: false },
    onEachFeature: (f, l) => l.bindTooltip(String(f.properties.quad || ''), { sticky: true })
  }),
  streams: async () => L.geoJSON(await getJSON('streams.geojson'), {
    renderer: canvasLines,
    style: f => ({ color: '#3b8eea', weight: f.properties.streamorde >= 4 ? 2.2 : (f.properties.streamorde >= 3 ? 1.6 : 1.1), opacity: .8 }),
    interactive: false
  }),
  named: async () => {
    const gj = await getJSON('streams.geojson');
    return L.geoJSON({ type: 'FeatureCollection', features: gj.features.filter(f => f.properties.gnis_name) }, {
      renderer: canvasLines, style: { color: '#1f6fd1', weight: 3, opacity: .9 },
      onEachFeature: (f, l) => { l.bindPopup(`<b>${esc(f.properties.gnis_name)}</b>`); l.on('click', () => { suppressMapClick = true; }); }
    });
  },
  hillshade: async () => L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, opacity: .45, attribution: 'USGS 3DEP shaded relief' }),
  counties: async () => L.geoJSON(await getJSON('counties.geojson'), {
    pane: 'lines', style: { color: '#f0e6c8', weight: 2, dashArray: '6 5', fill: false },
    onEachFeature: (f, l) => l.bindTooltip(f.properties.NAME + ' Co.', { sticky: true })
  })
};

async function setLayer(key, on) {
  if (lazy[key] && !L_[key]) {
    if (!on) return;
    showToast('Loading layer…');
    try { L_[key] = await lazy[key](); L_[key].addTo(group(key)); }
    catch (e) {
      const input = document.querySelector(`input[data-layer="${key}"]`); if (input) input.checked = false;
      showToast('Layer failed to load: ' + e.message, 3000); return;
    }
  }
  const g = group(key);
  if (on) g.addTo(map); else map.removeLayer(g);
}
document.querySelectorAll('input[data-layer]').forEach(inp => {
  inp.addEventListener('change', () => setLayer(inp.dataset.layer, inp.checked));
});

// ---------- target list ----------
const sheet = document.getElementById('sheet');
function setSheet(open) { sheet.classList.toggle('open', open); sheet.setAttribute('aria-hidden', open ? 'false' : 'true'); if (open) renderList(); }
document.getElementById('list-btn').addEventListener('click', () => { setPanel(false); setSheet(!sheet.classList.contains('open')); });
document.getElementById('sheet-close').addEventListener('click', () => setSheet(false));
document.getElementById('sort-sel').addEventListener('change', renderList);
document.getElementById('filter-sel').addEventListener('change', renderList);
const PRI_ORDER = { 'TOP PRIORITY': 0, 'STRONG TARGET': 1, 'MODERATE TARGET': 2 };
const CONF_ORDER = { 'High': 0, 'Moderate-high': 1, 'Moderate': 2 };
function renderList() {
  const key = document.getElementById('sort-sel').value, filt = document.getElementById('filter-sel').value;
  const TS = window.ffTargetStatus || {};
  let arr = TARGETS.filter(p => filt === 'all' || p.priority === filt || (filt === 'unchecked' && !TS[p.id]) || (filt === 'checked' && TS[p.id]));
  const dist = p => lastFix ? map.distance(lastFix, [p.lat, p.lon]) : Infinity;
  if (key === 'near' && !lastFix) showToast('Press Locate first for distance sorting', 2400);
  const cmp = {
    rank: (a, b) => a.rank - b.rank,
    county: (a, b) => a.county.localeCompare(b.county) || a.rank - b.rank,
    quad: (a, b) => a.quad.localeCompare(b.quad) || a.rank - b.rank,
    priority: (a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority] || a.rank - b.rank,
    conf: (a, b) => CONF_ORDER[a.geo_conf] - CONF_ORDER[b.geo_conf] || a.rank - b.rank,
    L_prim_km: (a, b) => b.L_prim_km - a.L_prim_km,
    relief_1km_m: (a, b) => b.relief_1km_m - a.relief_1km_m,
    DA_prim_km2: (a, b) => a.DA_prim_km2 - b.DA_prim_km2,
    prim_len_m: (a, b) => a.prim_len_m - b.prim_len_m,
    near: (a, b) => dist(a) - dist(b) || a.rank - b.rank
  }[key];
  arr = [...arr].sort(cmp);
  const extra = p => ({
    L_prim_km: `${p.L_prim_km} km contact upstream`, relief_1km_m: `${p.relief_1km_m} m relief`, DA_prim_km2: `${p.DA_prim_km2} km² drainage`,
    prim_len_m: `${p.prim_len_m} m to walk start`, near: lastFix ? `${(dist(p) / 1000).toFixed(1)} km away` : '', conf: p.geo_conf
  }[key] || `${p.L_prim_km} km contact · ${p.DA_prim_km2} km²`);
  document.getElementById('target-list').innerHTML = arr.map(p => `
    <div class="trow" data-id="${p.id}">
      <div class="rk" style="background:${COLORS[p.priority]}">${p.rank}</div>
      <div><div class="tname">${esc(p.stream)}${TS[p.id] ? ` <span class="ff-tl ff-tl-${TS[p.id].type}">${{ blank: '✓ tried', find: '★ found', skip: '✕ skip' }[TS[p.id].type] || ''}</span>` : ''}</div>
      <div class="tmeta">${esc(p.county)} · ${esc(p.quad)} · ${p.contact_class.startsWith('PROBABLE') ? 'PROBABLE equiv.' : esc(p.geo_conf)} · ${esc(extra(p))}</div>
      <div class="tmeta">${c4(p.lat)}, ${c4(p.lon)}</div></div>
      <div class="tscore">${p.score}</div>
    </div>`).join('');
  document.querySelectorAll('.trow').forEach(el => el.addEventListener('click', () => openTarget(+el.dataset.id)));
}
function openTarget(id) {
  const p = TARGETS.find(t => t.id === id); if (!p) return;
  const tierKey = { 'TOP PRIORITY': 'top', 'STRONG TARGET': 'strong', 'MODERATE TARGET': 'moderate' }[p.priority];
  const cb = document.querySelector(`input[data-layer="${tierKey}"]`); if (cb && !cb.checked) { cb.checked = true; setLayer(tierKey, true); }
  if (window.innerWidth < 760) setSheet(false);
  map.setView([p.lat, p.lon], 15);
  const m = markerById[id];
  if (m) setTimeout(() => m.openPopup(), 350);
}
window.openTarget = openTarget;

// ---------- offline ----------
const statusEl = document.getElementById('offline-status');
function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function lat2y(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
function tilesFor(b, z) {
  const out = [];
  for (let x = lon2x(b[1], z); x <= lon2x(b[3], z); x++) for (let y = lat2y(b[2], z); y <= lat2y(b[0], z); y++) out.push(`${z}/${y}/${x}`);
  return out;
}
async function tileList(mode) {
  const rj = await getJSON('reaches.geojson');
  const set = new Set();
  const region = [TARGET_BOUNDS.getSouth() - .05, TARGET_BOUNDS.getWest() - .05, TARGET_BOUNDS.getNorth() + .05, TARGET_BOUNDS.getEast() + .05];
  for (let z = 9; z <= 12; z++) tilesFor(region, z).forEach(t => set.add(t));
  const byRank = {};
  rj.features.forEach(f => { (byRank[f.properties.rank] = byRank[f.properties.rank] || []).push(...f.geometry.coordinates); });
  Object.entries(byRank).forEach(([rank, cs]) => {
    rank = +rank;
    const top = rank <= 40;
    if (!top && mode !== 'all') return;
    const lats = cs.map(c => c[1]), lons = cs.map(c => c[0]), pad = 0.006;
    const b = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad];
    const zmax = top ? 16 : 15;
    for (let z = 13; z <= zmax; z++) tilesFor(b, z).forEach(t => set.add(t));
  });
  return [...set];
}
const DATA_FILES = ['targets.geojson', 'reaches.geojson', 'contact_target.geojson', 'contact_other.geojson', 'crossings_valid.geojson', 'evidence_documented.geojson', 'evidence_reports.geojson', 'evidence_kgs_area.geojson', 'geology_units.geojson', 'geology_target_units.geojson', 'faults.geojson', 'quads.geojson', 'counties.geojson', 'streams.geojson', 'experimental_menifee.geojson'];
// App code the offline copy needs besides the data (paths from the site root).
const APP_ROOT = new URL('../../../', location.href).href;
const APP_FILES = ['index.html', 'states/kentucky/map/index.html', 'states/kentucky/map/app.js', 'states/kentucky/map/road_router.js',
  'states/kentucky/map/style.css', 'states/kentucky/map/field.js', 'states/kentucky/map/field.css',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'shared/brand/manifest.json', 'shared/brand/favicon-32.png',
  'shared/brand/apple-touch-icon-180.png', 'shared/brand/mineral-maps-icon-192.png', 'shared/brand/mineral-maps-icon-1024.png'];
async function storedFileOk(cache, url, name) {
  const r = await cache.match(url); if (!r || !r.ok) return false;
  try {
    if (/\.(png|jpe?g)$/i.test(name)) return (await r.clone().blob()).size > 100;
    const t = await r.clone().text(); if (!t.trim()) return false;
    if (/\.json$/i.test(name)) { JSON.parse(t); return true; }
    if (/\.(js|css)$/i.test(name)) return !/^\s*<(!doctype|html)/i.test(t);   // an HTML fallback is not code
    return /<html/i.test(t);
  } catch (_) { return false; }
}
// Is the offline worker installed and active? It is what lets the app open with no signal.
async function swCheck(registerIfMissing) {
  if (!('serviceWorker' in navigator)) return { ok: false, msg: 'this browser cannot install the offline worker' };
  try {
    let reg = await navigator.serviceWorker.getRegistration(location.href);
    if (!reg && registerIfMissing) reg = await navigator.serviceWorker.register('../../../sw.js');
    if (!reg) return { ok: false, msg: 'offline worker not installed — reload the page once while online' };
    if (!reg.active) {
      const w = reg.installing || reg.waiting;
      if (w) await new Promise(res => { const t = setTimeout(res, 15000); w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); res(); } }); });
    }
    if (!reg.active) return { ok: false, msg: 'offline worker did not finish installing — reload once while online and download again' };
    return { ok: true, controlling: !!navigator.serviceWorker.controller,
      msg: navigator.serviceWorker.controller ? 'offline worker installed and active' : 'offline worker installed — close and reopen the app once so this page uses it' };
  } catch (e) { return { ok: false, msg: 'offline worker could not be checked: ' + e.message }; }
}
function listShort(a, n = 6) { return a.length <= n ? a.join(', ') : a.slice(0, n).join(', ') + ` and ${a.length - n} more`; }
function tileURL(t) { const [z, y, x] = t.split('/'); return TOPO_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x); }

function showStatus() {
  let m = null;
  try { m = JSON.parse(localStorage.getItem('kyOffline') || 'null'); } catch (_) { try { localStorage.removeItem('kyOffline'); } catch (_) {} }
  if (!('caches' in window)) { statusEl.className = 'status-box warn'; statusEl.textContent = 'This browser cannot store offline maps.'; return; }
  if (m && m.needsRecheck) {
    statusEl.className = 'status-box';
    statusEl.innerHTML = '<b>Offline map: re-checking after an app update…</b><br>Verifying what is stored on this phone' + (navigator.onLine === false ? '. No signal, so the data refresh waits until you are online.' : ' and refreshing the data files.');
  } else if (m && m.verified && m.app === undefined) {
    // saved by an older version that did not check the app code or the offline worker
    statusEl.className = 'status-box warn';
    statusEl.innerHTML = `<b>Offline map data verified — app code not checked</b><br>${m.tilesOk}/${m.tiles} topo tiles and ${m.dataOk}/${m.data} data files on ${new Date(m.date).toLocaleString()}. Press download again on Wi-Fi to also save and check the app itself.`;
  } else if (m && m.verified) {
    statusEl.className = 'status-box ok';
    statusEl.innerHTML = `<b>OFFLINE MAP COMPLETE — VERIFIED</b><br>${m.tilesOk}/${m.tiles} topo tiles, ${m.dataOk}/${m.data} data files and ${m.appOk}/${m.app} app files re-read from device storage on ${new Date(m.date).toLocaleString()} (${m.mode === 'all' ? 'all 120 reaches' : 'Top + Strong reaches'}). ${esc(m.swMsg || 'Offline worker active')}.`;
    swCheck(false).then(sw => {                                   // re-check live: storage can be cleared
      if (sw.ok) return;
      statusEl.className = 'status-box warn';
      statusEl.innerHTML = `<b>Offline map saved, but the offline worker is missing</b><br>${esc(sw.msg)}. Without it the app will not open with no signal. Press download again on Wi-Fi.`;
    });
  } else if (m) {
    statusEl.className = 'status-box warn';
    const miss = [];
    if (m.tilesOk < m.tiles) miss.push(`${(m.tiles - m.tilesOk).toLocaleString()} topo tiles`);
    if ((m.dataMissing || []).length) miss.push('data: ' + listShort(m.dataMissing));
    else if (m.dataOk < m.data) miss.push(`${m.data - m.dataOk} data files`);
    if ((m.appMissing || []).length) miss.push('app code: ' + listShort(m.appMissing));
    if (m.swOk === false) miss.push(m.swMsg || 'offline worker');
    statusEl.innerHTML = `<b>Offline map INCOMPLETE</b><br>${m.tilesOk}/${m.tiles} tiles, ${m.dataOk}/${m.data} data files` +
      (m.app !== undefined ? `, ${m.appOk}/${m.app} app files` : '') + ` verified.` +
      (miss.length ? `<br><b>Missing:</b> ${esc(miss.join('; '))}.` : '') + `<br>Press download again on a good connection.`;
  } else {
    statusEl.className = 'status-box';
    statusEl.innerHTML = 'Target data are cached automatically after first load. <b>Topo tiles are not downloaded yet.</b>';
  }
}
document.getElementById('dl-btn').addEventListener('click', async () => {
  const btn = document.getElementById('dl-btn');
  if (!('caches' in window)) return showToast('Offline storage unavailable');
  const mode = document.querySelector('input[name="dlset"]:checked').value;
  btn.disabled = true;
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const tiles = await tileList(mode);
    statusEl.className = 'status-box'; statusEl.textContent = `Downloading ${tiles.length} topo tiles + ${DATA_FILES.length} data files…`;
    const dc = await caches.open(DATA_CACHE);
    const base = new URL(DATA, location.href).href;
    await Promise.all(DATA_FILES.map(f => dc.add(base + f).catch(() => {})));
    // app code: fetch fresh copies and store them where the offline worker looks
    statusEl.textContent = 'Saving the app code for offline…';
    await Promise.all(APP_FILES.map(async f => {
      try { const r = await fetch(APP_ROOT + f, { cache: 'no-store' }); if (r.ok) await dc.put(APP_ROOT + f, r); } catch (_) {}
    }));
    const sw = await swCheck(true);
    const tc = await caches.open(TILE_CACHE);
    let done = 0, i = 0;
    async function worker() {
      while (i < tiles.length) {
        const t = tiles[i++], u = tileURL(t);
        if (!(await tc.match(u))) {
          for (let a = 0; a < 3; a++) {
            try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) { await tc.put(u, r); break; } } catch (_) {}
          }
        }
        done++;
        if (done % 20 === 0) statusEl.textContent = `Downloading topo tiles… ${done}/${tiles.length}`;
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    // verification pass: re-read every tile and data file from storage
    statusEl.textContent = 'Verifying stored tiles…';
    let tilesOk = 0, dataOk = 0;
    for (const t of tiles) { const r = await tc.match(tileURL(t)); if (r && r.ok) { const b = await r.blob(); if (b.size > 100 && b.type.startsWith('image')) tilesOk++; } }
    const dataMissing = [], appMissing = [];
    for (const f of DATA_FILES) { const r = await dc.match(base + f); let ok = false; if (r && r.ok) { try { await r.clone().json(); ok = true; } catch (_) {} } if (ok) dataOk++; else dataMissing.push(f); }
    statusEl.textContent = 'Verifying stored app code…';
    let appOk = 0;
    for (const f of APP_FILES) { if (await storedFileOk(dc, APP_ROOT + f, f)) appOk++; else appMissing.push(f.split('/').pop()); }
    const m = { date: Date.now(), cache: DATA_CACHE, mode, tiles: tiles.length, tilesOk, data: DATA_FILES.length, dataOk, dataMissing,
      app: APP_FILES.length, appOk, appMissing, swOk: sw.ok, swMsg: sw.msg,
      verified: tilesOk === tiles.length && dataOk === DATA_FILES.length && appOk === APP_FILES.length && sw.ok };
    try { localStorage.setItem('kyOffline', JSON.stringify(m)); } catch (_) {}
    showStatus();
    showToast(m.verified ? 'Offline map verified' : 'Offline download incomplete', 2500);
  } catch (e) { statusEl.className = 'status-box warn'; statusEl.textContent = 'Download failed: ' + e.message; }
  btn.disabled = false;
});
showStatus();

// ---------- app update: re-check the offline copy, then refresh it when online ----------
// The offline worker's cache name changes with each release (DATA_CACHE / CACHE in sw.js).
// A download made under an older name is re-verified against what is really stored, and
// the data files are re-fetched (cache:'reload' skips the browser's HTTP cache).
function readOffline() { try { return JSON.parse(localStorage.getItem('kyOffline') || 'null'); } catch (_) { return null; } }
function writeOffline(m) { try { localStorage.setItem('kyOffline', JSON.stringify(m)); } catch (_) {} }
async function refreshCoreFiles() {
  const dc = await caches.open(DATA_CACHE), base = new URL(DATA, location.href).href;
  const jobs = [...DATA_FILES.map(f => [base + f, f]), ...APP_FILES.map(f => [APP_ROOT + f, f])];
  let i = 0, got = 0;
  async function worker() {
    while (i < jobs.length) {
      const [u, name] = jobs[i++];
      try {
        const r = await fetch(u, { cache: 'reload' });
        if (!r.ok) continue;
        if (/\.json$/i.test(name) || /\.geojson$/i.test(name)) JSON.parse(await r.clone().text());   // never replace good data with a broken download
        await dc.put(u, r); got++;
      } catch (_) { /* keep the copy already stored */ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return got;
}
let rechecking = null;
function recheckOffline() {
  if (rechecking) return rechecking;
  rechecking = (async () => {
    let m = readOffline(); if (!m || !('caches' in window)) return;
    const was = m.cache || 'mineral-maps-ky-agate-v3';      // downloads made before this field existed came from v3
    if (was === DATA_CACHE && !m.needsRecheck && !m.refreshPending) return;
    m.needsRecheck = true; writeOffline(m); showStatus();
    try {
      const sw = await swCheck(true);
      let refreshed = false;
      if (navigator.onLine !== false) { try { await refreshCoreFiles(); refreshed = true; } catch (_) {} }
      const dc = await caches.open(DATA_CACHE), tc = await caches.open(TILE_CACHE), base = new URL(DATA, location.href).href;
      const tiles = await tileList(m.mode || 'top');
      let tilesOk = 0;
      for (let k = 0; k < tiles.length; k += 60) {
        const hits = await Promise.all(tiles.slice(k, k + 60).map(t => tc.match(tileURL(t))));
        tilesOk += hits.filter(r => r && r.ok).length;
      }
      const dataMissing = [], appMissing = []; let dataOk = 0, appOk = 0;
      for (const f of DATA_FILES) {
        const r = await dc.match(base + f); let ok = false;
        if (r && r.ok) { try { await r.clone().json(); ok = true; } catch (_) {} }
        if (ok) dataOk++; else dataMissing.push(f);
      }
      for (const f of APP_FILES) { if (await storedFileOk(dc, APP_ROOT + f, f)) appOk++; else appMissing.push(f.split('/').pop()); }
      m = { ...m, cache: DATA_CACHE, needsRecheck: false, refreshPending: !refreshed, checked: Date.now(),
        tiles: tiles.length, tilesOk, data: DATA_FILES.length, dataOk, dataMissing, app: APP_FILES.length, appOk, appMissing, swOk: sw.ok, swMsg: sw.msg,
        verified: tilesOk === tiles.length && dataOk === DATA_FILES.length && appOk === APP_FILES.length && sw.ok };
      writeOffline(m); showStatus();
      showToast(m.verified ? 'Offline map re-checked after the update' : 'Offline map needs a fresh download — see Layers', 3200);
    } catch (e) {
      const cur = readOffline() || m; cur.needsRecheck = false; writeOffline(cur); showStatus();
    }
  })().finally(() => { rechecking = null; });
  return rechecking;
}
window.addEventListener('online', () => { const m = readOffline(); if (m && m.refreshPending) recheckOffline(); });
setTimeout(recheckOffline, 3000);

// ---------- start ----------
(async () => {
  try {
    await Promise.all([buildTargets(), buildContacts()]);
    ['top', 'strong', 'moderate', 'source', 'primary', 'extended', 'contact'].forEach(k => group(k).addTo(map));
    setLayer('streams', true);
  } catch (e) { showToast('Could not load target data: ' + e.message, 4000); }
})();

map.fitBounds(TARGET_BOUNDS, { padding: [12, 12] });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('../../../sw.js').catch(err => console.warn('Service worker:', err)); });
}
