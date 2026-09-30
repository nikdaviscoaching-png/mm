'use strict';
/* =============================================================================
   OFFLINE ROAD ROUTER

   Downloads the official Kentucky 911 road-centerline network for the map's
   study area once while online, turns it into a compact graph, and stores the
   graph in IndexedDB. Routing then works entirely on-device with no signal.

   This is intentionally basic: it draws a road-following line, not spoken
   turn-by-turn directions. Land ownership / permission is a separate question.
   ============================================================================= */
(function (root) {
  const API = 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_911_Road_Centerlines_WGS84WM/MapServer/0/query';
  const BOX = [-84.65, 37.20, -83.15, 38.10]; // west,south,east,north — agate study area
  const DB_NAME = 'mineral_maps_offline_roads_v1';
  const STORE = 'graphs';
  const GRAPH_ID = 'agate-study-v1';
  const PAGE = 1000;
  const SNAP_M = 14;

  let dbPromise = null;
  let graph = null;
  let prepared = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in root)) return reject(new Error('IndexedDB is unavailable'));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Could not open road storage'));
    });
    return dbPromise;
  }

  async function stored() {
    if (graph) return graph;
    try {
      const d = await openDB();
      graph = await new Promise((resolve, reject) => {
        const q = d.transaction(STORE, 'readonly').objectStore(STORE).get(GRAPH_ID);
        q.onsuccess = () => resolve(q.result || null);
        q.onerror = () => reject(q.error);
      });
      return graph;
    } catch (_) { return null; }
  }

  async function save(g) {
    const d = await openDB();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(g);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not save roads'));
    });
    graph = g; prepared = null;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function rad(x) { return x * Math.PI / 180; }
  function hav(aLon, aLat, bLon, bLat) {
    const p1 = rad(aLat), p2 = rad(bLat), dp = p2 - p1, dl = rad(bLon - aLon);
    const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function lineLength(c) {
    let d = 0;
    for (let i = 1; i < c.length; i++) d += hav(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    return d;
  }
  function linesOf(g) {
    if (!g) return [];
    if (g.type === 'LineString') return [g.coordinates];
    if (g.type === 'MultiLineString') return g.coordinates;
    return [];
  }
  function cleanLine(c) {
    const out = [];
    for (const p of c || []) {
      if (!Array.isArray(p) || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
      const q = [+p[0].toFixed(5), +p[1].toFixed(5)];
      if (!out.length || q[0] !== out[out.length - 1][0] || q[1] !== out[out.length - 1][1]) out.push(q);
    }
    return out;
  }

  // Endpoint snapping joins tiny GIS gaps at intersections without inventing
  // multi-kilometre links. This is the specific failure mode the earlier road
  // file had, so the graph also records its largest-component percentage.
  function buildGraph(features, progress) {
    const nodes = [], edges = [], buckets = new Map();
    const cell = 0.0002;
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const bucket = k => { let a = buckets.get(k); if (!a) buckets.set(k, a = []); return a; };

    function nodeFor(p) {
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      let best = -1, bd = SNAP_M + 0.001;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const ids = buckets.get(`${gx + dx},${gy + dy}`) || [];
        for (const id of ids) {
          const n = nodes[id], d = hav(p[0], p[1], n[0], n[1]);
          if (d < bd) { bd = d; best = id; }
        }
      }
      if (best >= 0) return best;
      const id = nodes.length; nodes.push(p); bucket(key(p[0], p[1])).push(id); return id;
    }

    let seen = 0;
    for (const f of features || []) {
      const props = f.properties || {};
      for (const raw of linesOf(f.geometry)) {
        const c = cleanLine(raw); if (c.length < 2) continue;
        const d = lineLength(c); if (!(d > 1)) continue;
        const a = nodeFor(c[0]), b = nodeFor(c[c.length - 1]);
        if (a === b && d < 30) continue;
        const sp = Number(props.SpeedLimit);
        // Kentucky 911 OneWay: FT = travel only in the digitized direction, TF = only against it,
        // blank / B = both ways. Anything else is treated as two-way rather than guessed.
        const ow = String(props.OneWay == null ? '' : props.OneWay).trim().toUpperCase();
        const e = {
          a, b, d: Math.round(d),
          s: Number.isFinite(sp) && sp >= 5 && sp <= 85 ? sp : 30,
          n: String(props.LSt_Name || props.St_Name || '').slice(0, 80),
          r: String(props.RoadClass || '').slice(0, 40),
          c,
        };
        if (ow === 'FT' || ow === 'TF') e.o = ow;
        edges.push(e);
      }
      seen++;
      if (progress && seen % 1500 === 0) progress({ stage: 'build', done: seen, total: features.length });
    }

    const adj = Array.from({ length: nodes.length }, () => []);
    edges.forEach((e, i) => { adj[e.a].push(e.b); adj[e.b].push(e.a); });
    const mark = new Uint8Array(nodes.length); let largest = 0;
    for (let s = 0; s < nodes.length; s++) {
      if (mark[s]) continue;
      let n = 0, q = [s]; mark[s] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi]; n++;
        for (const v of adj[u]) if (!mark[v]) { mark[v] = 1; q.push(v); }
      }
      if (n > largest) largest = n;
    }
    const connectedPct = nodes.length ? +(100 * largest / nodes.length).toFixed(1) : 0;

    return {
      id: GRAPH_ID, version: 2, savedAt: Date.now(), source: 'Kentucky 911 Road Centerlines',
      box: BOX, featureCount: features.length, nodes, edges, connectedPct,
    };
  }

  async function fetchRoads(progress) {
    if (navigator.onLine === false) throw new Error('Connect to the internet once to download the road network');
    const features = []; let complete = false;
    for (let offset = 0, page = 0; page < 100; page++, offset += PAGE) {
      const q = new URLSearchParams({
        where: '1=1', geometry: BOX.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID,LSt_Name,St_Name,RoadClass,SpeedLimit,OneWay',
        returnGeometry: 'true', outSR: '4326', geometryPrecision: '5', maxAllowableOffset: '0.00002',
        orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'geojson'
      });
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
      let r;
      try { r = await fetch(API + '?' + q.toString(), { mode: 'cors', cache: 'no-store', signal: ctl.signal }); }
      finally { clearTimeout(timer); }
      if (!r.ok) throw new Error(`road server returned ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'road server error');
      const got = Array.isArray(j.features) ? j.features : [];
      features.push(...got);
      if (progress) progress({ stage: 'download', done: features.length });
      if (got.length < PAGE && !(j.properties && j.properties.exceededTransferLimit) && !j.exceededTransferLimit) { complete = true; break; }
      if (!got.length) { complete = true; break; }
    }
    if (!features.length) throw new Error('No road features were returned');
    if (!complete) throw new Error('Road service pagination did not finish; refusing to save an incomplete offline network');
    return features;
  }

  async function download(progress) {
    if (progress) progress({ stage: 'starting', done: 0 });
    const features = await fetchRoads(progress);
    if (progress) progress({ stage: 'build', done: 0, total: features.length });
    // Let the browser repaint the progress text before graph construction.
    await new Promise(r => setTimeout(r, 40));
    const g = buildGraph(features, progress);
    if (!g.edges.length) throw new Error('Downloaded roads could not be turned into a network');
    await save(g);
    if (progress) progress({ stage: 'saved', done: g.edges.length, total: g.edges.length });
    return g;
  }

  // Spatial index of road SEGMENTS (not just junctions), so a start or end point can
  // snap onto the middle of a road.
  const ECELL = 0.01;                                   // degrees, about 0.9-1.1 km
  const ekey = (gx, gy) => (gx + 20000) * 40000 + (gy + 20000);
  function prep(g) {
    if (!g) return null;
    if (prepared && prepared.graph === g) return prepared;
    const adj = Array.from({ length: g.nodes.length }, () => []);
    g.edges.forEach((e, i) => {
      adj[e.a].push([e.b, i]);
      adj[e.b].push([e.a, i]);
    });
    const egrid = new Map();
    g.edges.forEach((e, i) => {
      const c = e.c;
      for (let k = 1; k < c.length; k++) {
        const x0 = Math.floor(Math.min(c[k - 1][0], c[k][0]) / ECELL), x1 = Math.floor(Math.max(c[k - 1][0], c[k][0]) / ECELL);
        const y0 = Math.floor(Math.min(c[k - 1][1], c[k][1]) / ECELL), y1 = Math.floor(Math.max(c[k - 1][1], c[k][1]) / ECELL);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const key = ekey(gx, gy); let arr = egrid.get(key);
          if (!arr) egrid.set(key, arr = []);
          if (arr[arr.length - 1] !== i) arr.push(i);
        }
      }
    });
    const mphToMps = 1609.344 / 3600;
    const maxSpeedMps = Math.max(1, ...g.edges.map(e => (Number(e.s) || 30) * mphToMps));
    prepared = { graph: g, adj, egrid, mphToMps, maxSpeedMps };
    return prepared;
  }

  // Nearest point on the nearest road segment. Returns the edge, the segment index, the
  // point, and how far along the edge (metres from its first end) the point is.
  function snap(P, lon, lat, maxM) {
    const g = P.graph, kx = 111320 * Math.cos(rad(lat)), ky = 110540;
    const cellM = ECELL * kx, gx = Math.floor(lon / ECELL), gy = Math.floor(lat / ECELL);
    const limit = maxM || 5000, maxRing = Math.ceil(limit / cellM) + 1;
    let best = null, seenEdge = new Set();
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (ring && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const ids = P.egrid.get(ekey(gx + dx, gy + dy)); if (!ids) continue;
        for (const ei of ids) {
          if (seenEdge.has(ei)) continue; seenEdge.add(ei);
          const c = g.edges[ei].c;
          for (let k = 1; k < c.length; k++) {
            const ax = (c[k - 1][0] - lon) * kx, ay = (c[k - 1][1] - lat) * ky, bx = (c[k][0] - lon) * kx, by = (c[k][1] - lat) * ky;
            const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
            const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
            const d = Math.hypot(ax + t * vx, ay + t * vy);
            if (!best || d < best.d) best = { ei, seg: k - 1, t, d };
          }
        }
      }
      if (best && best.d <= ring * cellM) break;        // nothing unscanned can be closer
    }
    if (!best || best.d > limit) return null;
    const c = g.edges[best.ei].c, A = c[best.seg], B = c[best.seg + 1];
    best.pt = [+(A[0] + best.t * (B[0] - A[0])).toFixed(6), +(A[1] + best.t * (B[1] - A[1])).toFixed(6)];
    let along = 0; for (let k = 1; k <= best.seg; k++) along += hav(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1]);
    along += hav(A[0], A[1], best.pt[0], best.pt[1]);
    best.along = along; best.total = lineLength(c);
    return best;
  }

  class Heap {
    constructor() { this.a = []; }
    push(f, n) {
      const a = this.a; let i = a.length; a.push([f, n]);
      while (i) { const p = (i - 1) >> 1; if (a[p][0] <= f) break; a[i] = a[p]; i = p; } a[i] = [f, n];
    }
    pop() {
      const a = this.a; if (!a.length) return null; const root = a[0], last = a.pop();
      if (a.length) { let i = 0; a[0] = last;
        while (true) { let l = i * 2 + 1, r = l + 1, m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; }
      }
      return root;
    }
    get length() { return this.a.length; }
  }

  // Route between ANY two points on the saved road network. Each end snaps to the
  // nearest point on the nearest road (that road is temporarily split there by a
  // virtual junction), so nothing has to be planned in advance and a start or end in
  // the middle of a road works. One-way streets are obeyed.
  async function route(fromLat, fromLon, toLat, toLon) {
    const g = await stored(); if (!g) return null;
    const P = prep(g);
    const S = snap(P, fromLon, fromLat), T = snap(P, toLon, toLat);
    if (!S || !T) return null;                       // outside the saved road area / more than 5 km from any road
    const n = g.nodes.length, VS = n, VT = n + 1;
    const fwdOK = e => e.o !== 'TF', backOK = e => e.o !== 'FT';   // digitized direction is edge.a -> edge.b
    const eS = g.edges[S.ei], eT = g.edges[T.ei];
    // geometry of the pieces of a split edge
    const toA = (e, X) => [X.pt, ...e.c.slice(0, X.seg + 1).reverse()];        // snap point back to the edge's first junction
    const toB = (e, X) => [X.pt, ...e.c.slice(X.seg + 1)];                     // snap point on to its last junction
    const between = (e, X, Y) => [X.pt, ...e.c.slice(X.seg + 1, Y.seg + 1), Y.pt];   // X before Y along the edge
    const secs = (e, m) => m / (Math.max(5, Number(e.s) || 30) * P.mphToMps);
    const virt = [];                                 // virtual pieces: {from, to, geom, len, sec}
    const add = (from, to, geom, len, e) => virt.push({ from, to, geom, len, sec: secs(e, len) });
    if (backOK(eS)) add(VS, eS.a, toA(eS, S), S.along, eS);
    if (fwdOK(eS)) add(VS, eS.b, toB(eS, S), S.total - S.along, eS);
    if (fwdOK(eT)) add(eT.a, VT, toA(eT, T).reverse(), T.along, eT);
    if (backOK(eT)) add(eT.b, VT, toB(eT, T).reverse(), T.total - T.along, eT);
    if (S.ei === T.ei) {                             // both ends on the same road: the piece between them
      if (S.along <= T.along && fwdOK(eS)) add(VS, VT, between(eS, S, T), T.along - S.along, eS);
      else if (S.along > T.along && backOK(eS)) add(VS, VT, between(eS, T, S).reverse(), S.along - T.along, eS);
    }
    const startLinks = [], endLinks = new Map();
    virt.forEach((v, i) => {
      if (v.from === VS) startLinks.push(i);
      else { if (!endLinks.has(v.from)) endLinks.set(v.from, []); endLinks.get(v.from).push(i); }
    });

    const gs = new Float64Array(n + 2), seen = new Uint8Array(n + 2);
    const prev = new Int32Array(n + 2), piece = new Int32Array(n + 2), pdir = new Uint8Array(n + 2);   // piece >= 0: road edge; <= -2: virtual piece (-piece - 2)
    gs.fill(Infinity); prev.fill(-1); piece.fill(-1); gs[VS] = 0;
    const heap = new Heap();
    const xy = id => id === VS ? S.pt : id === VT ? T.pt : g.nodes[id];
    const goal = T.pt;
    const h = id => { const p = xy(id); return hav(p[0], p[1], goal[0], goal[1]) / P.maxSpeedMps; };
    heap.push(h(VS), VS);
    const relaxVirtual = (u, list) => {
      for (const vi of list) {
        const v = virt[vi], ng = gs[u] + v.sec;
        if (ng >= gs[v.to]) continue;
        gs[v.to] = ng; prev[v.to] = u; piece[v.to] = -vi - 2; heap.push(ng + h(v.to), v.to);
      }
    };
    while (heap.length) {
      const item = heap.pop(); if (!item) break; const u = item[1];
      if (seen[u]) continue; seen[u] = 1;
      if (u === VT) break;
      if (u === VS) { relaxVirtual(u, startLinks); continue; }
      for (const [v, ei] of P.adj[u]) {
        if (seen[v]) continue;
        const e = g.edges[ei];
        const forward = e.a === u && (e.b === v || e.a === e.b);          // travelling in the digitized direction
        if (forward ? !fwdOK(e) : !backOK(e)) continue;                   // wrong way up a one-way street
        const ng = gs[u] + e.d / (Math.max(5, Number(e.s) || 30) * P.mphToMps);
        if (ng >= gs[v]) continue;
        gs[v] = ng; prev[v] = u; piece[v] = ei; pdir[v] = forward ? 1 : 0;
        heap.push(ng + h(v), v);
      }
      const ends = endLinks.get(u); if (ends) relaxVirtual(u, ends);
    }
    if (!Number.isFinite(gs[VT])) return null;

    const parts = []; let cur = VT, roadDistance = 0;
    while (cur !== VS) {
      const pc = piece[cur]; if (pc === -1 || prev[cur] < 0) return null;
      if (pc <= -2) { const v = virt[-pc - 2]; parts.push(v.geom); roadDistance += v.len; }
      else { const e = g.edges[pc]; parts.push(pdir[cur] ? e.c : [...e.c].reverse()); roadDistance += e.d; }
      cur = prev[cur];
    }
    parts.reverse();
    const coords = [];
    for (const part of parts) for (const q of part) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) coords.push(q);
    }
    return {
      coords,
      distance: Math.round(roadDistance),
      duration: gs[VT],
      footStart: S.d, footEnd: T.d,
      startRoad: S.pt, endRoad: T.pt,
      connectedPct: g.connectedPct,
      source: g.source,
    };
  }

  async function status() {
    const g = await stored();
    return g ? { ready: true, version: g.version || 1, savedAt: g.savedAt, featureCount: g.featureCount, nodes: g.nodes.length, edges: g.edges.length, connectedPct: g.connectedPct, source: g.source }
      : { ready: false };
  }

  async function clear() {
    try {
      const d = await openDB();
      await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(GRAPH_ID);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } finally { graph = null; prepared = null; }
  }

  // read-only access to the saved graph (used by the offline road highlighter)
  root.FFRoads = { graph: stored, download, route, status, clear, buildGraph, _hav: hav, source: API, box: BOX };
})(typeof window !== 'undefined' ? window : globalThis);
