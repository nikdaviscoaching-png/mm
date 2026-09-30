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
        edges.push({
          a, b, d: Math.round(d),
          s: Number.isFinite(sp) && sp >= 5 && sp <= 85 ? sp : 30,
          n: String(props.LSt_Name || props.St_Name || '').slice(0, 80),
          r: String(props.RoadClass || '').slice(0, 40),
          c,
        });
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
      id: GRAPH_ID, version: 1, savedAt: Date.now(), source: 'Kentucky 911 Road Centerlines',
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

  function prep(g) {
    if (!g) return null;
    if (prepared && prepared.graph === g) return prepared;
    const adj = Array.from({ length: g.nodes.length }, () => []);
    g.edges.forEach((e, i) => {
      adj[e.a].push([e.b, i]);
      adj[e.b].push([e.a, i]);
    });
    const cell = 0.01, grid = new Map();
    g.nodes.forEach((p, i) => {
      const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    });
    const mphToMps = 1609.344 / 3600;
    const maxSpeedMps = Math.max(1, ...g.edges.map(e => (Number(e.s) || 30) * mphToMps));
    prepared = { graph: g, adj, grid, cell, mphToMps, maxSpeedMps };
    return prepared;
  }

  function nearestNode(P, lon, lat) {
    const { graph: g, grid, cell } = P;
    const gx = Math.floor(lon / cell), gy = Math.floor(lat / cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= 8; ring++) {
      let touched = false;
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (ring && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const ids = grid.get(`${gx + dx},${gy + dy}`); if (!ids) continue; touched = true;
        for (const id of ids) {
          const p = g.nodes[id], d = hav(lon, lat, p[0], p[1]);
          if (d < bd) { bd = d; best = id; }
        }
      }
      if (best >= 0 && (touched || bd < ring * cell * 85000)) break;
    }
    return best >= 0 ? { id: best, d: bd } : null;
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

  async function route(fromLat, fromLon, toLat, toLon) {
    const g = await stored(); if (!g) return null;
    const P = prep(g);
    const S = nearestNode(P, fromLon, fromLat), T = nearestNode(P, toLon, toLat);
    if (!S || !T || S.d > 5000 || T.d > 5000) return null; // outside saved road area / too far from a road
    const n = g.nodes.length, gs = new Float64Array(n), seen = new Uint8Array(n);
    const prev = new Int32Array(n), prevEdge = new Int32Array(n);
    gs.fill(Infinity); prev.fill(-1); prevEdge.fill(-1); gs[S.id] = 0;
    const heap = new Heap();
    const goal = g.nodes[T.id];
    heap.push(hav(g.nodes[S.id][0], g.nodes[S.id][1], goal[0], goal[1]) / P.maxSpeedMps, S.id);

    while (heap.length) {
      const item = heap.pop(); if (!item) break; const u = item[1];
      if (seen[u]) continue; seen[u] = 1;
      if (u === T.id) break;
      for (const [v, ei] of P.adj[u]) {
        if (seen[v]) continue;
        const e = g.edges[ei];
        const edgeSeconds = e.d / (Math.max(5, Number(e.s) || 30) * P.mphToMps);
        const ng = gs[u] + edgeSeconds;
        if (ng >= gs[v]) continue;
        gs[v] = ng; prev[v] = u; prevEdge[v] = ei;
        const p = g.nodes[v];
        heap.push(ng + hav(p[0], p[1], goal[0], goal[1]) / P.maxSpeedMps, v);
      }
    }
    if (!Number.isFinite(gs[T.id])) return null;

    const steps = []; let cur = T.id;
    while (cur !== S.id) {
      const p = prev[cur], ei = prevEdge[cur];
      if (p < 0 || ei < 0) return null;
      steps.push([p, cur, ei]); cur = p;
    }
    steps.reverse();
    const coords = [];
    for (const [a, b, ei] of steps) {
      const e = g.edges[ei]; let c = e.c;
      if (e.a !== a || e.b !== b) c = [...c].reverse();
      if (coords.length && c.length && coords[coords.length - 1][0] === c[0][0] && coords[coords.length - 1][1] === c[0][1]) c = c.slice(1);
      coords.push(...c);
    }
    if (!coords.length) coords.push(g.nodes[S.id], g.nodes[T.id]);
    const roadDistance = steps.reduce((sum, step) => sum + g.edges[step[2]].d, 0);
    const footStart = S.d, footEnd = T.d;
    return {
      coords,
      distance: roadDistance,
      duration: gs[T.id],
      footStart, footEnd,
      startRoad: g.nodes[S.id], endRoad: g.nodes[T.id],
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
