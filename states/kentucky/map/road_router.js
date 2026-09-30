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

    // Property names come back in whatever case the server uses, so look them up case-insensitively.
    let keyMap = {};
    const gp = (props, name) => {
      if (props[name] !== undefined) return props[name];                       // exact name (the normal case)
      const lk = name.toLowerCase();
      if (keyMap[lk] === undefined || props[keyMap[lk]] === undefined) {       // otherwise find it ignoring case
        keyMap[lk] = undefined;
        for (const k of Object.keys(props)) if (k.toLowerCase() === lk) { keyMap[lk] = k; break; }
      }
      return keyMap[lk] === undefined ? undefined : props[keyMap[lk]];
    };
    const text = v => (v == null ? '' : String(v).trim());
    const posNum = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
    const parity = v => { const c = text(v).charAt(0).toUpperCase(); return c === 'E' ? 'E' : c === 'O' ? 'O' : 'B'; };   // even / odd / both (or unknown)
    let seen = 0, addrEdges = 0;
    for (const f of features || []) {
      const props0 = f.properties || {};
      const props = new Proxy(props0, { get: (t, k) => (typeof k === 'string' ? gp(t, k) : undefined) });
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
        // street name (full, as written on a mailing label) and the house-number ranges on each side
        const full = [props.St_PreDir, props.St_Name, props.St_PosTyp, props.St_PosDir].map(text).filter(Boolean).join(' ');
        const lname = text(props.LSt_Name);
        if (full) e.sn = full.slice(0, 80);
        if (lname && lname.toLowerCase() !== full.toLowerCase()) e.ln = lname.slice(0, 80);
        const fl = posNum(props.FromAddr_L), tl = posNum(props.ToAddr_L), fr = posNum(props.FromAddr_R), tr = posNum(props.ToAddr_R);
        if (fl || tl) { e.fl = fl; e.tl = tl; e.pl = parity(props.Parity_L); }
        if (fr || tr) { e.fr = fr; e.tr = tr; e.pr = parity(props.Parity_R); }
        if (fl || tl || fr || tr) addrEdges++;
        const cl = text(props.PostComm_L), cr = text(props.PostComm_R), zl = text(props.PostCode_L).slice(0, 5), zr = text(props.PostCode_R).slice(0, 5);
        if (cl) e.cl = cl.slice(0, 40); if (cr) e.cr = cr.slice(0, 40); if (zl) e.zl = zl; if (zr) e.zr = zr;
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
      id: GRAPH_ID, version: 3, savedAt: Date.now(), source: 'Kentucky 911 Road Centerlines',
      box: BOX, featureCount: features.length, nodes, edges, connectedPct, addrEdges,
    };
  }

  const FIELDS_BASE = 'OBJECTID,LSt_Name,St_Name,RoadClass,SpeedLimit,OneWay';
  const FIELDS_ADDR = FIELDS_BASE + ',St_PreDir,St_PosTyp,St_PosDir,FromAddr_L,ToAddr_L,FromAddr_R,ToAddr_R,Parity_L,Parity_R,PostComm_L,PostComm_R,PostCode_L,PostCode_R';
  async function fetchRoads(progress) {
    if (navigator.onLine === false) throw new Error('Connect to the internet once to download the road network');
    const features = []; let complete = false, fields = FIELDS_ADDR;
    for (let offset = 0, page = 0; page < 100; page++, offset += PAGE) {
      const q = new URLSearchParams({
        where: '1=1', geometry: BOX.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: fields,
        returnGeometry: 'true', outSR: '4326', geometryPrecision: '5', maxAllowableOffset: '0.00002',
        orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'geojson'
      });
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
      let r, j;
      try { r = await fetch(API + '?' + q.toString(), { mode: 'cors', cache: 'no-store', signal: ctl.signal }); }
      finally { clearTimeout(timer); }
      if (r.ok) j = await r.json();
      if ((!r.ok || j.error) && fields !== FIELDS_BASE && page === 0) {     // a field name the server does not know: keep the roads, drop the addresses
        fields = FIELDS_BASE; page = -1; offset = -PAGE; continue;
      }
      if (!r.ok) throw new Error(`road server returned ${r.status}`);
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

  /* ------------------------------------------------------------------ offline addresses
     Street names and house-number ranges come from the same Kentucky 911 download. An
     address like "412 Main St Irvine" is found by matching the street, choosing the
     road segment whose range (on the side with the right odd/even parity) holds the
     number, interpolating along that segment, and stepping ~12 m to that side. */
  const ABBR = { st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', ln: 'lane', ct: 'court', cir: 'circle',
    blvd: 'boulevard', hwy: 'highway', pkwy: 'parkway', pl: 'place', trl: 'trail', ter: 'terrace', terr: 'terrace', n: 'north', s: 'south',
    e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' };
  const DIRW = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
  const tokensOf = str => String(str || '').toLowerCase().replace(/[.,'#]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(t => ABBR[t] || t);
  function coreKey(tokens) {                              // "N Main St" and "Main Street" are the same street
    const t = tokens.slice();
    while (t.length > 1 && DIRW.has(t[0])) t.shift();
    while (t.length > 1 && DIRW.has(t[t.length - 1])) t.pop();
    return t.join(' ');
  }
  function addrIndex(P) {
    if (P.addr) return P.addr;
    const map = new Map();
    P.graph.edges.forEach((e, i) => {
      const seenKeys = new Set();
      for (const nm of [e.sn, e.ln, e.n]) {
        if (!nm) continue;
        const k = coreKey(tokensOf(nm)); if (!k || seenKeys.has(k)) continue; seenKeys.add(k);
        let ent = map.get(k); if (!ent) map.set(k, ent = { key: k, display: e.sn || e.ln || e.n, edges: [] });
        ent.edges.push(i);
      }
    });
    return (P.addr = { map, keys: [...map.keys()].sort() });
  }
  function pointAlong(c, dist) {                         // [lon, lat] and the direction of travel there, in local metres (east, north)
    let acc = 0;
    for (let k = 1; k < c.length; k++) {
      const seg = hav(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1]);
      if (acc + seg >= dist || k === c.length - 1) {
        const t = seg ? Math.max(0, Math.min(1, (dist - acc) / seg)) : 0;
        const kx = 111320 * Math.cos(rad(c[k - 1][1])), ky = 110540;
        const ux = (c[k][0] - c[k - 1][0]) * kx, uy = (c[k][1] - c[k - 1][1]) * ky, ul = Math.hypot(ux, uy) || 1;
        return { lon: c[k - 1][0] + t * (c[k][0] - c[k - 1][0]), lat: c[k - 1][1] + t * (c[k][1] - c[k - 1][1]), ux: ux / ul, uy: uy / ul, kx, ky };
      }
      acc += seg;
    }
    return { lon: c[0][0], lat: c[0][1], ux: 1, uy: 0, kx: 111320 * Math.cos(rad(c[0][1])), ky: 110540 };
  }
  function edgeMid(e) { const m = e.c[e.c.length >> 1]; return m; }
  function nearestOf(P, ids, near) {                       // the edge in `ids` closest to `near` ([lat, lon])
    if (!near) return ids[0];
    let best = ids[0], bd = Infinity;
    for (const i of ids) { const m = edgeMid(P.graph.edges[i]), d = hav(near[1], near[0], m[0], m[1]); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function streetRow(P, ent, near, num) {
    const e = P.graph.edges[nearestOf(P, ent.edges, near)], m = edgeMid(e);
    const town = e.cl || e.cr || '';
    const same = ent.edges.map(i => P.graph.edges[i]).filter(x => (x.cl || x.cr || '') === town);
    let w = 180, s = 90, ea = -180, n = -90;
    same.forEach(x => x.c.forEach(q => { if (q[0] < w) w = q[0]; if (q[0] > ea) ea = q[0]; if (q[1] < s) s = q[1]; if (q[1] > n) n = q[1]; }));
    return { name: ent.display, town, lat: m[1], lng: m[0], bounds: [[s, w], [n, ea]], num: num || null };
  }
  // Returns { addresses: [{name, town, lat, lng}], streets: [{name, town, lat, lng, bounds, num}] }
  async function geocode(query, opts) {
    const out = { addresses: [], streets: [] };
    const g = await stored(); if (!g || !g.edges.length) return out;
    const P = prep(g), idx = addrIndex(P), near = opts && opts.near ? [opts.near.lat, opts.near.lng] : null, limit = (opts && opts.limit) || 6;
    const mm = String(query || '').trim().match(/^(\d{1,6})\s+(.+)$/);
    const num = mm ? +mm[1] : null, rest = mm ? mm[2] : String(query || '').trim();
    const comma = rest.indexOf(','), streetText = comma >= 0 ? rest.slice(0, comma) : rest, townText = comma >= 0 ? rest.slice(comma + 1) : '';
    const tokens = tokensOf(streetText); if (!tokens.length) return out;
    let key = null, townTokens = tokensOf(townText);
    for (let k = tokens.length; k >= 1; k--) {              // longest run of words that is a known street; the rest is town / ZIP
      const cand = coreKey(tokens.slice(0, k));
      if (idx.map.has(cand)) { key = cand; if (!townTokens.length) townTokens = tokens.slice(k); break; }
    }
    if (key && num !== null) {
      let ids = idx.map.get(key).edges;
      const tt = townTokens.join(' '), zip = /^\d{5}$/.test(tt) ? tt : '';
      if (tt) {
        const ok = i => { const e = g.edges[i]; return zip ? (e.zl === zip || e.zr === zip)
          : [e.cl, e.cr].some(c => c && tokensOf(c).join(' ').startsWith(tt)); };
        const f = ids.filter(ok); if (f.length) ids = f;
      }
      const found = [];
      for (const i of ids) {
        const e = g.edges[i];
        for (const side of ['l', 'r']) {
          const f = e['f' + side], t = e['t' + side], par = e['p' + side];
          if (!(f > 0 || t > 0)) continue;
          const lo = Math.min(...[f, t].filter(x => x > 0)), hi = Math.max(f, t);
          if (num < lo || num > hi) continue;
          if ((par === 'E' && num % 2) || (par === 'O' && !(num % 2))) continue;
          const frac = f > 0 && t > 0 && f !== t ? Math.max(0, Math.min(1, (num - f) / (t - f))) : 0.5;
          const at = pointAlong(e.c, frac * lineLength(e.c));
          const sign = side === 'l' ? 1 : -1;                                           // left of the direction of travel, or right
          const lat = at.lat + sign * at.ux * 12 / at.ky, lon = at.lon + sign * -at.uy * 12 / at.kx;
          found.push({ name: `${num} ${idx.map.get(key).display}`, town: (side === 'l' ? e.cl || e.cr : e.cr || e.cl) || '',
            lat: +lat.toFixed(6), lng: +lon.toFixed(6) });
        }
      }
      if (near) found.sort((a, b) => hav(near[1], near[0], a.lng, a.lat) - hav(near[1], near[0], b.lng, b.lat));
      const seenPt = new Set();
      out.addresses = found.filter(x => { const k = x.lat.toFixed(4) + ',' + x.lng.toFixed(4); if (seenPt.has(k)) return false; seenPt.add(k); return true; }).slice(0, limit);
    }
    // street-name suggestions while typing (words that START a street name or one of its words)
    const prefix = coreKey(tokens);
    if (prefix.length >= 2 || key) {
      const keys = idx.keys.filter(k => k.startsWith(prefix) || k.split(' ').some(w => w.startsWith(prefix)));
      const rows = keys.slice(0, 60).map(k => streetRow(P, idx.map.get(k), near, num));
      if (near) rows.sort((a, b) => hav(near[1], near[0], a.lng, a.lat) - hav(near[1], near[0], b.lng, b.lat));
      out.streets = rows.slice(0, limit);
    }
    return out;
  }

  async function status() {
    const g = await stored();
    return g ? { ready: true, version: g.version || 1, hasAddresses: !!(g.addrEdges > 0), savedAt: g.savedAt, featureCount: g.featureCount, nodes: g.nodes.length, edges: g.edges.length, connectedPct: g.connectedPct, source: g.source }
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
  root.FFRoads = { graph: stored, download, route, geocode, status, clear, buildGraph, _hav: hav, source: API, box: BOX };
})(typeof window !== 'undefined' ? window : globalThis);
