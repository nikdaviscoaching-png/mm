// pipeline.js — stacking session: ingest → analyse (align, normalise, detect) → weights → tiled render.
import * as E from './engine.js';

const LN2 = Math.LN2;
const LIGHT_THR = 0.08, MOVHI_THR = 0.0025; // combined.md starting value; see proof/ for the measured separation
export const PALETTE = [[255, 99, 71], [64, 160, 255], [80, 220, 120], [255, 200, 40], [190, 110, 255], [0, 220, 220], [255, 120, 200], [170, 200, 60], [255, 150, 60], [150, 150, 255]];

// Auto mode → concrete mode/method (SPEC §3.1)
export function autoSpec(d) {
  if (!d) return { mode: 'focus', method: 'depth' };
  if (d.kind === 'both') return { mode: 'both' };
  if (d.kind === 'light') {
    if (d.lightKind === 'exposure') return { mode: 'light', method: d.light ? 'glare' : 'hdr' };
    if (d.lightKind === 'direction') return { mode: 'light', method: 'glare' };
    return { mode: 'light', method: 'average' };
  }
  return { mode: 'focus', method: 'depth' };
}

export class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }

// keep all per-frame sharpness maps in RAM only while they total ≤ this; above it they are recomputed on demand
// (same numbers, ~0.5 s per frame slower, saves n × work-size floats — e.g. 126 MB for 10 frames)
const KEEPC_BYTES = 80e6;
export class Session {
  constructor(store, { workMax = 2048, progress = () => {}, log = () => {} } = {}) {
    this.store = store; this.workMax = workMax; this.progress = progress; this.log = log;
    // memory: when the store offers a synchronous spill (OPFS sync access handles in the worker), the 16-bit
    // aligned work frames live on disk instead of RAM and are read back plane-by-plane / row-range-by-row-range.
    this.spill = (store && store.spill) || null;
    this.frames = []; this.ww = 0; this.wh = 0; this.cancelFlag = false; this.ref = 0;
    this.override = null; this.undo = [];
  }
  checkCancel() { if (this.cancelFlag) { this.cancelFlag = false; throw new Cancelled(); } }
  // yield to the event loop now and then so a Cancel message can land
  async tick() { const now = Date.now(); if (!this._lt || now - this._lt > 60) { this._lt = now; await new Promise((r) => setTimeout(r, 0)); } this.checkCancel(); }

  // ---------------- ingest ----------------
  // meta: {name, W, H, bits(8|16), exif, linear(bool)}; rows(y0,n) -> {data, ch}
  async addFrame(meta, rows) {
    const id = this.frames.length; const { W, H } = meta; const bits = meta.bits || 8;
    let q = Math.max(1, Math.ceil(Math.max(W, H) / this.workMax));
    const fw = Math.ceil(W / q), fh = Math.ceil(H / q);
    const writer = await this.store.create(id, W, H, 3, bits === 16 ? 2 : 1);
    const acc = new Float32Array(fw * fh * 3), cnt = new Float32Array(fw * fh);
    const lut = bits === 16 ? E.lut16() : E.LUT8; const N = fw * fh;
    const STRIP = 256;
    for (let y0 = 0; y0 < H; y0 += STRIP) {
      const n = Math.min(STRIP, H - y0); const { data, ch } = await rows(y0, n);
      await writer.push(data, ch, n);
      for (let y = 0; y < n; y++) {
        const Y = ((y0 + y) / q) | 0, ro = Y * fw, so = y * W * ch;
        for (let x = 0; x < W; x++) { const X = (x / q) | 0, s = so + x * ch, i = ro + X; acc[i] += lut[data[s]]; acc[N + i] += lut[data[s + 1]]; acc[2 * N + i] += lut[data[s + 2]]; cnt[i]++; }
      }
      this.checkCancel();
    }
    await writer.finish();
    for (let i = 0; i < N; i++) { const c = 1 / cnt[i]; acc[i] *= c; acc[N + i] *= c; acc[2 * N + i] *= c; }
    let planes = [acc.subarray(0, N), acc.subarray(N, 2 * N), acc.subarray(2 * N)], pw = fw, ph = fh;
    if (!this.ww) { this.ww = fw; this.wh = fh; }
    if (fw !== this.ww || fh !== this.wh) { planes = planes.map((p) => E.resizeBilinear(p, fw, fh, this.ww, this.wh)); pw = this.ww; ph = this.wh; }
    const f = { id, name: meta.name, W, H, bits, exif: meta.exif || {}, include: true, note: meta.note || '',
      sx: W / pw, sy: H / ph, work: null, M: [1, 0, 0, 0, 1, 0], gain: { a: 0, b: 1 }, wb: [1, 1, 1], rho: 1, status: 'ok' };
    await this.putWork(f, encode16(planes, pw * ph));
    this.frames.push(f);
    return { id, w: this.ww, h: this.wh };
  }
  // slot 0/1: decode into a reusable scratch set (caller must not keep it); no slot: fresh arrays.
  // Cuts ~38 MB of garbage per call at 2048 px, which otherwise inflates peak memory until the next GC.
  workPlanes(f, slot) {
    const N = this.ww * this.wh; if (slot === undefined) return decode16(this.getWork(f), N);
    if (!this._scr || this._scr.N !== N) this._scr = { N, s: [null, null] };
    const sc = this._scr.s[slot] || (this._scr.s[slot] = [0, 1, 2].map(() => new Float32Array(N)));
    return decode16(this.getWork(f), N, sc);
  }
  getWork(f) { return f.spilled ? this.spill.get(f.id, 3 * this.ww * this.wh) : f.work; }
  async putWork(f, u16) { if (this.spill) { await this.spill.put(f.id, u16); f.work = null; f.spilled = true; } else f.work = u16; }
  activeIdx() { return this.frames.map((f, i) => (f.include && f.status !== 'failed' ? i : -1)).filter((i) => i >= 0); }

  // ---------------- analysis ----------------
  async analyze() {
    const n = this.frames.length, w = this.ww, h = this.wh, N = w * h;
    if (n < 2) throw new Error('Add at least 2 photos');
    this.progress('Analysing', 0);
    // brightness & EXIF EV
    const feats = [], bright = []; // memory: luminance planes are turned into alignment features one at a time
    for (const f of this.frames) {
      const [R, G, Bp] = this.workPlanes(f, 0); const Y = new Float32Array(N);
      for (let i = 0; i < N; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * Bp[i];
      bright.push(Math.log2(Math.max(1e-6, E.quantile(Y, 0.5, 7)))); feats.push(alignFeature(Y, w, h));
      const ex = f.exif || {}; f.ev = (ex.FNumber && ex.ExposureTime) ? Math.log2(ex.FNumber * ex.FNumber / ex.ExposureTime) - Math.log2((ex.ISO || ex.ISOSpeedRatings || 100) / 100) : null;
      f.focusDist = ex.FocusDistance || ex.SubjectDistance || null;
    }
    // reference frame
    const order = [...Array(n).keys()];
    let ref;
    const fd = this.frames.map((f) => f.focusDist);
    if (fd.every((v) => v != null) && new Set(fd).size > 1) { const s = order.slice().sort((a, b) => fd[a] - fd[b]); ref = s[(n - 1) >> 1]; }
    else if (Math.max(...bright) - Math.min(...bright) > 0.3) { const s = order.slice().sort((a, b) => bright[a] - bright[b]); ref = s[(n - 1) >> 1]; }
    else ref = (n - 1) >> 1;
    this.ref = ref; this.ref0 = ref;
    // alignment features: blurred gradient magnitude of log luminance
    this.checkCancel();
    const small = (p) => { const f = Math.max(1, Math.ceil(Math.max(w, h) / 512)); return E.downArea(p, w, h, f); };
    const fRefS = small(feats[ref]);
    const byDist = order.filter((i) => i !== ref).sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
    const results = {}; results[ref] = { A: [1, 0, 0, 0, 1, 0], rho: 1, method: 'reference' };
    let k = 0;
    for (const i of byDist) {
      this.progress('Aligning', (k++) / byDist.length, `frame ${i + 1}`);
      const fs = small(feats[i]); const pc = E.phaseCorrelate(fRefS.d, fs.d, fRefS.w, fRefS.h);
      const sc = w / fRefS.w; const initPC = [1, 0, pc.dx * sc, 0, 1, pc.dy * sc];
      const nb = i < ref ? i + 1 : i - 1; const initNB = results[nb] ? results[nb].A : null;
      const tryEcc = (init) => E.eccAlign(feats[ref], feats[i], w, h, { model: 'similarity', init, iters: [60, 30, 12], eps: 1e-4 });
      const good = (r) => r && r.ok && r.rho >= 0.7 && Math.abs(Math.sqrt(Math.abs(r.A[0] * r.A[4] - r.A[1] * r.A[3])) - 1) < 0.05;
      let r = tryEcc(initPC); let method = 'ECC';
      if (!good(r) && initNB) { const r2 = tryEcc(initNB); if (r2.rho > (r.rho || 0)) r = r2; }
      if (!good(r)) { // feature fallback
        const fa = E.featureAlign(feats[ref], feats[i], w, h, E.centredToPixel(initPC, w, h));
        if (fa) { const r3 = tryEcc(E.pixelToCentred(fa.M, w, h)); if (good(r3)) { r = r3; method = 'features+ECC'; } else if (!good(r)) { r = { A: E.pixelToCentred(fa.M, w, h), rho: r3.rho || 0, ok: true }; method = 'features'; } }
      }
      results[i] = { A: r.A, rho: r.rho, method }; await this.tick();
      const f = this.frames[i];
      if (!good(r) && method !== 'features') { f.status = 'failed'; f.note = `Couldn’t align (match ${(r.rho || 0).toFixed(2)}) — left out`; }
      this.checkCancel();
    }
    feats.length = 0; // free the alignment features before warping
    // warp work frames to the reference (bicubic) and build validity
    const valid = new Uint8Array(N).fill(1);
    for (let i = 0; i < n; i++) {
      const f = this.frames[i], r = results[i];
      f.M = E.centredToPixel(r.A, w, h); f.rho = r.rho; f.alignMethod = r.method;
      const s = Math.sqrt(Math.abs(f.M[0] * f.M[4] - f.M[1] * f.M[3]));
      f.align = { dx: +(f.M[2]).toFixed(2), dy: +(f.M[5]).toFixed(2), scale: +s.toFixed(4), rot: +(Math.atan2(f.M[3], f.M[0]) * 180 / Math.PI).toFixed(3), rho: +(r.rho || 0).toFixed(3), method: r.method };
      if (i !== ref) {
        const pl = this.workPlanes(f, 0); const vm = new Uint8Array(N);
        const out = warpBicubic(pl, w, h, f.M, w, h, vm);
        await this.putWork(f, encode16(out, N));
        if (f.status !== 'failed') for (let j = 0; j < N; j++) valid[j] &= vm[j];
        f.validFrac = vm.reduce((a, b) => a + b, 0) / N; f.valid = packBits(vm); // 1 bit per pixel (was 1 byte)
      }
      await this.tick();
      this.progress('Aligning', 1);
    }
    this.valid = valid; this.crop = largestRect(valid, w, h);
    // photometric normalisation (gain/contrast on log-luminance, then WB) against the reference
    const refPl = this.workPlanes(this.frames[ref]); const Yr = lum(refPl, N);
    for (let i = 0; i < n; i++) {
      const f = this.frames[i]; if (i === ref) { f.gain = { a: 0, b: 1 }; f.wb = [1, 1, 1]; continue; }
      const pl = this.workPlanes(f, 0); const Yi = lum(pl, N);
      f.gain = fitGain(Yr, Yi, valid, N); f.wb = fitWB(refPl, Yr, pl, Yi, f.gain, valid, N); await this.tick();
    }
    this.checkCancel();
    this.detect = this.detectVariation(); this.detect0 = this.detect; this._scr = null; // release decode scratch
    return this.report();
  }

  setInclude(i, on) {
    this.frames[i].include = !!on;
    const act = this.activeIdx(); if (act.length < 2) { this.frames[i].include = true; return false; }
    // QA BUG-3: excluding the base (reference) frame crashed detection/render. Frames are already warped into the
    // base's coordinates, so pick the nearest included frame as the new base; the original returns when re-included.
    const r0 = this.ref0 != null ? this.ref0 : this.ref;
    this.ref = act.includes(r0) ? r0 : act.slice().sort((a, b) => Math.abs(a - r0) - Math.abs(b - r0))[0];
    this.recomputeCrop(); const d = this.detectVariation();
    // QA BUG-4: a subset of a focus bracket is still a focus bracket. Leaving one photo out could flip Auto from
    // Focus + Light to Light/HDR (a blurry result). Keep the focus decision from the full set while focus evidence remains.
    if (this.detect0 && this.detect0.focus && !d.focus && d.strongTiles > 0.25) { d.focus = true; d.kind = (d.exposure || d.light) ? 'both' : 'focus'; d.reasons[1] = `focus changes across ${Math.round(d.focusFrac * 100)}% of the image`; }
    this.detect = d; this._scr = null; return true;
  }
  recomputeCrop() {
    const N = this.ww * this.wh, v = new Uint8Array(N).fill(1);
    for (const i of this.activeIdx()) { const f = this.frames[i]; if (f.valid) { const b = f.valid; for (let j = 0; j < N; j++) v[j] &= (b[j >> 3] >> (j & 7)) & 1; } }
    this.valid = v; this.crop = largestRect(v, this.ww, this.wh);
  }
  // normalised linear RGB of frame i at work res
  normPlanes(i, norm = 'full', slot) {
    const f = this.frames[i], N = this.ww * this.wh; const pl = this.workPlanes(f, slot);
    if (norm === 'none') return pl;
    applyNorm(pl, N, norm === 'wb' ? { a: 0, b: 1 } : f.gain, f.wb);
    return pl;
  }

  detectVariation() {
    const act = this.activeIdx(); const w = this.ww, h = this.wh, N = w * h;
    const fs = Math.max(1, Math.ceil(Math.max(w, h) / 512));
    // exposure
    const evs = act.map((i) => this.frames[i].gain.a / LN2 / (this.frames[i].gain.b || 1));
    const exifEV = act.map((i) => this.frames[i].ev);
    let evSpread = Math.max(...evs) - Math.min(...evs);
    if (exifEV.every((v) => v != null)) evSpread = Math.max(evSpread, Math.max(...exifEV) - Math.min(...exifEV));
    // focus: tile sharpness on normalised P at <=512
    const T = 8, tiles = act.map(() => new Float64Array(T * T)); let sw = 0, sh = 0; const tilesClip = [];
    const logs = [];
    act.forEach((i, k) => {
      const pl = this.normPlanes(i, 'full', 0); const Y = lum(pl, N); const raw = this.workPlanes(this.frames[i], 1);
      const clip = clipMask(raw, N);
      const ds = E.downArea(Y, w, h, fs); sw = ds.w; sh = ds.h; const P = ds.d.map((v) => E.gammaFast(v));
      const cl = E.downArea(Float32Array.from(clip), w, h, fs).d;
      const C = sharpness(P, sw, sh, 1, cl).C; tilesClip.push({ C, cl, Y: ds.d });
      // light: blurred log lum
      const L = new Float32Array(ds.d.length); for (let j = 0; j < L.length; j++) L[j] = Math.log(ds.d[j] + 0.01);
      logs.push({ L: E.gaussBlur(L, sw, sh, 0.02 * sw), clip: cl, Y: ds.d });
    });
    // focus evidence only where every frame is unclipped and above the noise floor
    { const M = sw * sh; const common = new Uint8Array(M).fill(1); for (const t of tilesClip) for (let j = 0; j < M; j++) if (t.cl[j] > 0.05 || t.Y[j] < 0.02) common[j] = 0;
      tilesClip.forEach((t, k) => { for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const j = y * sw + x; if (common[j]) tiles[k][Math.min(T - 1, (y * T / sh) | 0) * T + Math.min(T - 1, (x * T / sw) | 0)] += t.C[j]; } }); }
    const amax = []; let changes = 0, considered = 0;
    for (let t = 0; t < T * T; t++) { let b = -1, bi = 0, mn = 1e30; tiles.forEach((tt, k) => { if (tt[t] > b) { b = tt[t]; bi = k; } mn = Math.min(mn, tt[t]); }); amax.push({ bi, ratio: b / (mn + 1e-9) }); }
    const counts = {}; amax.forEach((a) => (counts[a.bi] = (counts[a.bi] || 0) + 1)); const mode = +Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    for (const a of amax) { considered++; if (a.ratio > 1.5 && a.bi !== mode) changes++; }
    const strongTiles = amax.filter((a) => a.ratio > 1.5).length / amax.length;
    const focusFrac = changes / considered;
    // light-direction residual: spatial std of the blurred log-ratio to the reference, over pixels
    // well exposed in both (a pure exposure change is a constant ratio → ~0; moving light/glare is not)
    const kr = act.indexOf(this.ref); let lsum = 0, lcnt = 0; const sig = 0.02 * sw;
    logs.forEach((l, k) => {
      if (k === kr) return; const R = logs[kr];
      const m = new Float32Array(l.L.length), v = new Float32Array(l.L.length);
      for (let j = 0; j < m.length; j++) { const ok = l.clip[j] < 0.1 && R.clip[j] < 0.1 && l.Y[j] > 0.03 && R.Y[j] > 0.03 && l.Y[j] < 0.85 && R.Y[j] < 0.85; m[j] = ok ? 1 : 0; v[j] = ok ? Math.log(l.Y[j] / R.Y[j]) : 0; }
      const bm = E.gaussBlur(m, sw, sh, sig), bv = E.gaussBlur(v, sw, sh, sig); let s1 = 0, s2 = 0, n = 0;
      for (let j = 0; j < m.length; j++) if (m[j] && bm[j] > 0.2) { const r = bv[j] / bm[j]; s1 += r; s2 += r * r; n++; }
      if (n > 100) { const mu = s1 / n; lsum += Math.sqrt(Math.max(0, s2 / n - mu * mu)); lcnt++; }
      // moving highlights: pixels much brighter than the reference (after normalisation)
    });
    const lightStd = lcnt ? lsum / lcnt : 0;
    // moving highlights: bright pixels >1 EV above the per-pixel median of the normalised frames
    let movHi = 0; { const M = logs[0].Y.length, tmp = new Float32Array(logs.length); const fr = new Float64Array(logs.length);
      for (let j = 0; j < M; j += 2) { for (let k = 0; k < logs.length; k++) tmp[k] = logs[k].Y[j]; const srt = Array.from(tmp).sort((a, b) => a - b); const med = srt[srt.length >> 1];
        for (let k = 0; k < logs.length; k++) if (tmp[k] > 0.45 && tmp[k] > 1.4 * med) fr[k]++; }
      movHi = Math.max(...fr) / (M / 2); }
    const fdist = act.map((i) => this.frames[i].focusDist); const fVaries = fdist.every((v) => v != null) && new Set(fdist).size > 1;
    const exposure = evSpread > 0.5, focus = fVaries || (focusFrac > 0.25 && strongTiles > 0.25), light = lightStd > LIGHT_THR || movHi > MOVHI_THR;
    let kind = 'focus';
    if ((exposure || light) && focus) kind = 'both'; else if (exposure || light) kind = 'light'; else kind = 'focus';
    const identical = !exposure && !light && !fVaries && strongTiles < 0.1;
    if (identical) kind = 'light';
    const reasons = [];
    reasons.push(exposure ? `Exposure differs by ${evSpread.toFixed(1)} EV` : `Exposure steady (${evSpread.toFixed(1)} EV)`);
    reasons.push(focus ? `focus changes across ${Math.round(focusFrac * 100)}% of the image` : `focus steady`);
    if (light) reasons.push(movHi > MOVHI_THR ? `glare moves between frames (${(movHi * 100).toFixed(1)}% of pixels)` : `light direction changes (${lightStd.toFixed(2)})`);
    const lightKind = exposure ? 'exposure' : light ? 'direction' : 'same';
    if (identical) reasons.push('frames look identical → noise-reduction average');
    return { kind, exposure, focus, light, lightKind, evSpread, focusFrac, strongTiles, lightStd, movHi, reasons, allRaw: act.every((i) => this.frames[i].bits === 16) };
  }

  report() {
    return { ref: this.ref, w: this.ww, h: this.wh, crop: this.crop, detect: this.detect,
      frames: this.frames.map((f, i) => ({ i, name: f.name, W: f.W, H: f.H, include: f.include, status: f.status, note: f.note, align: f.align, ev: f.ev, gainEV: +(f.gain.a / LN2).toFixed(2), wb: f.wb.map((v) => +v.toFixed(3)) })) };
  }

  // ---------------- weights ----------------
  // spec: {mode:'focus'|'light'|'both'|'base-sharpest'|'base-mertens'|'base-average', method, glare, detail, brightness}
  async computeWeights(spec) {
    this.spec = spec = Object.assign({ glare: 0.6, detail: 0.5, brightness: 0 }, spec);
    const act = this.activeIdx(); const w = this.ww, h = this.wh, N = w * h; const sc = Math.max(w, h) / 2048;
    const qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
    const det = this.detect || {}; const mode = spec.mode;
    const cfg = { space: 'gamma', norm: 'full', kSplit: 99, pixelOp: null, pmax: false, shift: null };
    this.wd = new Array(this.frames.length).fill(null); this.wb = new Array(this.frames.length).fill(null);
    this.qw = qw; this.qh = qh;
    const refP = (() => { const Y = lum(this.normPlanes(this.ref, 'full', 0), N); for (let i = 0; i < N; i++) Y[i] = E.gammaFast(Y[i]); return Y; })();
    const p = 2 + 4 * spec.detail; // selectivity exponent (default 4, combined.md)
    this.progress('Weighing frames', 0);

    if (mode === 'base-average') { cfg.pixelOp = 'average-mean'; cfg.norm = 'none'; }
    else if (mode === 'base-sharpest') {
      cfg.pixelOp = 'pick'; cfg.norm = 'none';
      act.forEach((i) => { const Y = lum(this.workPlanes(this.frames[i], 0), N); const L = E.laplacian(Y, w, h); for (let j = 0; j < N; j++) L[j] = Math.abs(L[j]); this.wd[i] = E.boxBlur(L, w, h, 2); });
    } else if (mode === 'base-mertens') {
      cfg.space = 'srgb'; cfg.norm = 'none';
      act.forEach((i) => { this.wd[i] = mertensWeights(this.workPlanes(this.frames[i], 0), w, h, { wc: 1, ws: 1, we: 1 }); });
      normalize(this.wd, act, N); act.forEach((i) => { this.wb[i] = E.downArea(this.wd[i], w, h, 4).d; });
    } else if (mode === 'light' && ['hdr', 'lighten', 'darken', 'average'].includes(spec.method)) {
      cfg.pixelOp = spec.method; cfg.norm = spec.method === 'hdr' ? 'full' : 'wb';
      if (spec.method === 'darken') cfg.lift = this.darkenLift(act);
    } else if (mode === 'light' && spec.method === 'exposure') {
      cfg.space = 'srgb'; cfg.norm = 'wb';
      act.forEach((i) => { this.wd[i] = mertensWeights(this.normPlanes(i, 'wb', 0), w, h, { wc: 1, ws: 1, we: 1 }); });
      normalize(this.wd, act, N); act.forEach((i) => { this.wb[i] = E.downArea(this.wd[i], w, h, 4).d; });
    } else if (mode === 'light') { // glare-aware fusion (default)
      cfg.space = 'gamma'; cfg.norm = 'full'; cfg.kSplit = 4;
      const g = spec.glare; const maps = await this.sharedMaps(act, { needC: false });
      act.forEach((i, k) => {
        const pl = this.normPlanes(i, 'full', 0); const wgt = mertensWeights(pl, w, h, { wc: 1.5, ws: 0.5, we: 0.3, glare: g, display: true });
        const Hq = maps.H[k]; for (let j = 0; j < N; j++) { const x = j % w, y = (j / w) | 0; wgt[j] *= Math.pow(sampleQ(Hq, maps.hw, maps.hh, x, y, 2), 2 * g) ; }
        this.wd[i] = wgt;
      });
      normalize(this.wd, act, N);
      act.forEach((i) => { this.wd[i] = E.gaussBlur(this.wd[i], w, h, 1.0 * sc + 0.5); });
      normalize(this.wd, act, N);
      // base layer: blend of smoothed fusion weights and a glare soft-min
      const sm = this.softMin(act, maps, qw, qh);
      act.forEach((i, k) => { const b = E.downArea(this.wd[i], w, h, 4).d; for (let j = 0; j < b.length; j++) b[j] = (1 - g) * b[j] + g * sm[k][j]; this.wb[i] = b; });
      normalizeQ(this.wb, act);
    } else if (mode === 'focus') {
      cfg.space = 'gamma'; cfg.norm = 'full';
      const method = spec.method || 'depth';
      const maps = await this.sharedMaps(act, { needC: true, keepC: act.length * N * 4 <= KEEPC_BYTES });
      const Hexp = det.light ? 1 : 0;
      if (method === 'translucent') {
        act.forEach((i, k) => { const C = maps.C ? maps.C[k] : maps.getC(k), Wt = new Float32Array(N); for (let j = 0; j < N; j++) Wt[j] = Math.pow(C[j] / (maps.Cmax[j] + 1e-6), 2) + 1e-4; this.wd[i] = Wt; });
      } else { // depth map (also the base of 'detail')
        this.depthWeights(act, maps, w, h, sc, spec.detail);
      }
      maps.C = null; maps.Cmax = null; // memory: no longer needed
      if (Hexp) act.forEach((i, k) => { const W = this.wd[i]; for (let j = 0; j < N; j++) W[j] *= sampleQ(maps.H[k], maps.hw, maps.hh, j % w, (j / w) | 0, 2); });
      normalize(this.wd, act, N);
      const r = Math.max(2, Math.round((4 + 12 * (1 - spec.detail)) * sc)); const st = E.guideStats(refP, w, h, r);
      act.forEach((i) => { this.wd[i] = E.guidedFilter(refP, this.wd[i], w, h, r, 1e-3, st.meanI, st.varI); clampPos(this.wd[i]); });
      normalize(this.wd, act, N);
      act.forEach((i) => { this.wb[i] = E.downArea(this.wd[i], w, h, 4).d; });
      if (method === 'detail') cfg.pmax = true;
    } else { // 'both' — combined.md §4.4 two-band fusion
      const X = spec.x || {};
      // moving light (speculars/shading that change between frames): hand mid frequencies to the base band so
      // shading rims and glare are averaged by the soft-min instead of picked by the sharpness argmax
      const movingLight = !!(det.light && (det.lightKind === 'direction' || (det.movHi || 0) > (X.movTh ?? 0.02)));
      cfg.space = X.space || 'gamma'; cfg.norm = 'full'; cfg.kSplit = X.kSplit ?? (movingLight ? 2 : 4);
      if (X.depth === undefined) X.depth = 1;
      const maps = await this.sharedMaps(act, { needC: true, needW: true, keepC: !X.depth || act.length * N * 4 <= KEEPC_BYTES });
      const gam = 0.5 + 2.5 * spec.glare; // highlight-avoidance exponent (default γ≈2)
      const pp = X.p ?? p; const baseC = X.baseC ?? 1; if (X.depth === undefined) X.depth = 1;
      let CsQ = null;
      const csq = (C) => { const R = new Float32Array(N); for (let j = 0; j < N; j++) R[j] = C[j] / (maps.Cmax[j] + 1e-6); return E.downArea(E.boxBlur(R, w, h, Math.max(2, Math.round(16 * sc))), w, h, 4).d; };
      if (X.depth) { // depth weights first (independent of the base band), computing CsQ from the same on-demand sharpness map
        CsQ = baseC ? new Array(act.length) : null;
        this.depthWeights(act, maps, w, h, sc, spec.detail, baseC ? (k, C) => { CsQ[k] = csq(C); } : null);
      } else if (baseC) { // coarse focus evidence for the base band: relative sharpness smoothed to the base scale
        CsQ = act.map((i, k) => csq(maps.C[k]));
      }
      act.forEach((i, k) => {
        if (!X.depth) { // (with X.depth these are recomputed by depthWeights below, so skip the work and the memory)
          const C = maps.C[k], Wd = new Float32Array(N);
          for (let j = 0; j < N; j++) { const x = j % w, y = (j / w) | 0; const Hv = sampleQ(maps.H[k], maps.hw, maps.hh, x, y, 2); Wd[j] = (Math.pow(C[j] / (maps.Cmax[j] + 1e-6), pp) + 1e-4) * Math.pow(Hv, gam); }
          this.wd[i] = Wd;
        }
        const Wb = new Float32Array(qw * qh); const Wq = maps.W[k];
        for (let j = 0; j < qw * qh; j++) { const x = j % qw, y = (j / qw) | 0; Wb[j] = Wq[j] * Math.pow(sampleQ(maps.H[k], maps.hw, maps.hh, x * 4 + 1.5, y * 4 + 1.5, 2), gam) * (CsQ ? Math.pow(CsQ[k][j] + 1e-3, baseC) : 1) + 1e-6; }
        this.wb[i] = Wb;
      });
      if (X.depth) { // detail weights from the consistency-filtered depth map (soft one-hot, computed above), times highlight avoidance
        act.forEach((i, k) => { const D = this.wd[i]; for (let j = 0; j < N; j++) { const Hv = sampleQ(maps.H[k], maps.hw, maps.hh, j % w, (j / w) | 0, 2); D[j] *= Math.pow(Hv, gam); } });
      }
      maps.C = null; maps.Cmax = null; CsQ = null; // memory
      normalize(this.wd, act, N); normalizeQ(this.wb, act);
      if (movingLight && spec.glare > 0.3) {
        const sm = this.softMin(act, maps, qw, qh); const g = (spec.glare - 0.3) / 0.7;
        act.forEach((i, k) => { const b = this.wb[i]; for (let j = 0; j < b.length; j++) b[j] = (1 - g) * b[j] + g * sm[k][j]; });
      }
      // GFF-style smoothing: detail r=8, eps=1e-3 ; base r=45, eps=0.3 (scaled to 2K)
      const r1 = Math.max(2, Math.round((4 + 8 * (1 - spec.detail)) * sc)); const st = E.guideStats(refP, w, h, r1);
      act.forEach((i) => { this.wd[i] = E.guidedFilter(refP, this.wd[i], w, h, r1, 1e-3, st.meanI, st.varI); clampPos(this.wd[i]); });
      normalize(this.wd, act, N);
      const refQ = E.downArea(refP, w, h, 4).d; const r2 = Math.max(2, Math.round(45 * sc / 4)); const st2 = E.guideStats(refQ, qw, qh, r2);
      act.forEach((i) => { this.wb[i] = E.guidedFilter(refQ, this.wb[i], qw, qh, r2, 0.3, st2.meanI, st2.varI); clampPos(this.wb[i]); });
      normalizeQ(this.wb, act);
      cfg.shift = {}; // tone: base taken from gain-normalised radiance (shift 0); brightness slider handles exposure
    }
    this.cfg = cfg; this._cf = null; this.progress('Weighing frames', 1);
    this.override = this.override && this.override.w === w ? this.override : null;
    this.computeCoarse();
    this.computeTone(); this._scr = null; // release decode scratch
  }

  // maps shared by focus / both / glare: sharpness C (+max), well-exposedness W (quarter res), highlight avoidance H (half res)
  // memory: with keepC=false the per-frame sharpness maps are not kept (n × work-size floats); only their running
  // max (Cmax) and argmax (idx) are, and maps.getC(k) recomputes frame k's map on demand (deterministic → identical).
  sharpnessOf(i) {
    const w = this.ww, h = this.wh, N = w * h, sc = Math.max(w, h) / 2048;
    const raw = this.workPlanes(this.frames[i], 1); const clipD = blownMask(clipMask(raw, N, true), w, h, sc);
    const pl = this.normPlanes(i, 'full', 0); const Y = lum(pl, N);
    const P = new Float32Array(N); for (let j = 0; j < N; j++) P[j] = E.gammaFast(Y[j]);
    return sharpness(P, w, h, sc, clipD).C;
  }
  async sharedMaps(act, { needC = true, needW = false, keepC = true } = {}) {
    const w = this.ww, h = this.wh, N = w * h, sc = Math.max(w, h) / 2048;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    const out = { C: keepC ? [] : null, W: [], H: [], hw, hh, Cmax: null };
    let best = null; if (needC && !keepC) { out.Cmax = new Float32Array(N); out.idx = new Uint8Array(N); best = new Float32Array(N).fill(-1); out.getC = (k) => this.sharpnessOf(act[k]); } const Ls = [], desat = []; // desat < 0 marks clipped (was a separate clip map)
    for (let k = 0; k < act.length; k++) { const i = act[k];
      this.progress('Weighing frames', k / act.length * 0.7); await this.tick();
      const raw = this.workPlanes(this.frames[i], 1); const clip = clipMask(raw, N); const clipD = blownMask(clipMask(raw, N, true), w, h, sc);
      const pl = this.normPlanes(i, 'full', 0); const Y = lum(pl, N);
      if (needC) {
        const P = new Float32Array(N); for (let j = 0; j < N; j++) P[j] = E.gammaFast(Y[j]);
        const { C } = sharpness(P, w, h, sc, clipD);
        if (keepC) out.C.push(C);
        else { const Cm = out.Cmax, ix = out.idx; for (let j = 0; j < N; j++) { const v = C[j]; if (v > best[j]) { best[j] = v; ix[j] = k; } if (v > Cm[j]) Cm[j] = v; } }
      }
      if (needW) { // well-exposedness on own (un-normalised) display values, smoothed sigma 8, at quarter res
        const Wq = new Float32Array(Math.ceil(w / 4) * Math.ceil(h / 4)).fill(1); let qq;
        for (let c = 0; c < 3; c++) { const v = new Float32Array(N); for (let j = 0; j < N; j++) v[j] = E.oetfFast(raw[c][j]); qq = E.downArea(E.gaussBlur(v, w, h, 8 * sc), w, h, 4); for (let j = 0; j < Wq.length; j++) { const d = qq.d[j] - 0.5; Wq[j] *= Math.exp(-(d * d) / (2 * 0.2 * 0.2)); } }
        const cq = E.downArea(clip, w, h, 4).d; for (let j = 0; j < Wq.length; j++) Wq[j] = Math.max(0.05, Wq[j]) * (cq[j] > 0.5 ? 0.05 : 1);
        out.W.push(Wq);
      }
      // half-res log luminance etc. for highlight avoidance
      const Yh = E.downArea(Y, w, h, 2).d, L = new Float32Array(Yh.length);
      for (let j = 0; j < L.length; j++) L[j] = Math.log(Math.max(Yh[j], 1e-4));
      const Lb = E.gaussBlur(L, hw, hh, 1.0);
      Ls.push(Lb); const clipH = E.downArea(clip, w, h, 2).d;
      const sat = new Float32Array(Yh.length); const R2 = E.downArea(pl[0], w, h, 2).d, G2 = E.downArea(pl[1], w, h, 2).d, B2 = E.downArea(pl[2], w, h, 2).d;
      for (let j = 0; j < sat.length; j++) { const mx = Math.max(R2[j], G2[j], B2[j]), mn = Math.min(R2[j], G2[j], B2[j]); sat[j] = clipH[j] > 0.25 ? -1 : mx > 1e-4 ? (mx - mn) / mx : 0; }
      desat.push(sat);
    }
    best = null;
    if (needC && keepC) { out.Cmax = new Float32Array(N); for (const C of out.C) for (let j = 0; j < N; j++) if (C[j] > out.Cmax[j]) out.Cmax[j] = C[j]; }
    const M = hw * hh, tmp = new Float32Array(act.length);
    out.med = new Float32Array(M);
    const nA = act.length;
    for (let j = 0; j < M; j++) { for (let k = 0; k < nA; k++) { const v = Ls[k][j]; let q = k - 1; while (q >= 0 && tmp[q] > v) { tmp[q + 1] = tmp[q]; q--; } tmp[q + 1] = v; } out.med[j] = nA % 2 ? tmp[(nA - 1) >> 1] : 0.5 * (tmp[nA / 2 - 1] + tmp[nA / 2]); }
    act.forEach((i, k) => {
      const H = new Float32Array(M);
      const D = desat[k];
      for (let j = 0; j < M; j++) {
        if (D[j] < 0) { H[j] = 0.02; continue; } // clipped
        const dEV = (Ls[k][j] - out.med[j]) / LN2; const P = Math.exp(Ls[k][j] / 2.2);
        const gate = E.smoothstep(0.3, 0.6, P) * (1 - E.smoothstep(0.3, 0.6, D[j]));
        let v = 1 - gate * E.smoothstep(0.5, 1.5, dEV);
        H[j] = Math.max(0.02, v);
      }
      out.H.push(E.gaussBlur(H, hw, hh, 1.5)); desat[k] = null;
    });
    out.L = Ls;
    return out;
  }

  // soft-min over normalised log luminance among non-dark frames (temperature 0.3 EV), quarter res
  softMin(act, maps, qw, qh) {
    const { hw, hh } = maps; const out = act.map(() => new Float32Array(qw * qh));
    for (let j = 0; j < qw * qh; j++) {
      const x = (j % qw) * 2 + 0.5, y = ((j / qw) | 0) * 2 + 0.5; const vals = act.map((_, k) => E.sampleBilinear(maps.L[k], hw, hh, x, y));
      const med = E.sampleBilinear(maps.med, hw, hh, x, y); let mn = 1e9; vals.forEach((v) => { if (v > med - 1.5 * LN2 && v < mn) mn = v; });
      let s = 0; const ws = vals.map((v) => { const ww = v < med - 1.5 * LN2 ? 0 : Math.exp(-(v - mn) / (0.3 * LN2)); s += ww; return ww; });
      ws.forEach((ww, k) => (out[k][j] = s > 0 ? ww / s : 1 / act.length));
    }
    return out;
  }

  depthWeights(act, maps, w, h, sc, detail, perK = null) {
    const N = w * h; const n = act.length;
    // argmax + DMap-style contrast threshold (percentile of max energy); low-contrast pixels filled from neighbours
    const thr = E.quantile(maps.Cmax, 0.35, 5);
    const known = new Float32Array(N); let idx;
    if (maps.idx) { idx = maps.idx; for (let j = 0; j < N; j++) known[j] = maps.Cmax[j] > thr ? 1 : 0; }
    else { idx = new Uint8Array(N); for (let j = 0; j < N; j++) { let b = -1, bi = 0; for (let k = 0; k < n; k++) { const v = maps.C[k][j]; if (v > b) { b = v; bi = k; } } idx[j] = bi; known[j] = maps.Cmax[j] > thr ? 1 : 0; } }
    const R = Math.max(4, Math.round(32 * sc)); const kb = E.boxBlur(known, w, h, R);
    act.forEach((i, k) => {
      const O = new Float32Array(N); for (let j = 0; j < N; j++) O[j] = idx[j] === k && known[j] ? 1 : 0;
      const S = E.boxBlur(O, w, h, R); const Wt = new Float32Array(N);
      const Ck = maps.C ? maps.C[k] : maps.getC(k); if (perK) perK(k, Ck);
      // soft one-hot: blend with relative sharpness so near-ties share weight
      for (let j = 0; j < N; j++) { let rel = Ck[j] / (maps.Cmax[j] + 1e-6); rel *= rel; rel *= rel; rel *= rel; const fill = kb[j] > 1e-3 ? S[j] / kb[j] : 1 / n; Wt[j] = known[j] ? 0.7 * O[j] + 0.3 * rel : fill; Wt[j] += 1e-4; }
      this.wd[i] = Wt;
    });
  }

  darkenLift(act) {
    const N = this.ww * this.wh; const planes = act.map((i) => lum(this.normPlanes(i, 'wb', 0), N));
    const mn = new Float32Array(N).fill(1e9); planes.forEach((Y) => { for (let j = 0; j < N; j++) if (Y[j] < mn[j]) mn[j] = Y[j]; });
    const ref = planes[act.indexOf(this.ref)] || planes[0];
    return Math.min(4, E.quantile(ref, 0.5, 7) / Math.max(1e-4, E.quantile(mn, 0.5, 7)));
  }

  // ---------------- global coarse base (work/8) ----------------
  computeCoarse() {
    const cfg = this.cfg; if (cfg.pixelOp) { this.coarse = null; return; }
    const w = this.ww, h = this.wh, N = w * h, F = 8; let cw = w, ch = h; for (let t = 0; t < 3; t++) { cw = (cw + 1) >> 1; ch = (ch + 1) >> 1; }
    const act = this.activeIdx(); const L = Math.max(1, Math.floor(Math.log2(Math.min(cw, ch))) - 2);
    const acc = [0, 1, 2].map(() => Array.from({ length: L + 1 }, (_, l) => null)); const ws = Array.from({ length: L + 1 }, () => null);
    const eff = this.effectiveWeights(act);
    // per-frame coarse Laplacian pyramids don't depend on the weights → cache them (retouch only re-weights)
    const key = act.join(',') + '|' + cfg.space + '|' + cfg.norm;
    if (!this._cf || this._cf.key !== key) {
      this._cf = { key, pyr: act.map((i) => this.normPlanes(i, cfg.norm, 0).map((p) => { const g = E.gaussPyr(toSpace(p, cfg.space), w, h, 3); return E.lapPyr(g[3].d, cw, ch, L); })) };
    }
    act.forEach((i, k) => {
      const Wd = E.gaussPyr(eff.wd[k], w, h, 3)[3].d; const Wb = E.resizeBilinear(eff.wb[k], this.qw, this.qh, cw, ch);
      const gd = E.gaussPyr(Wd, cw, ch, L), gb = E.gaussPyr(Wb, cw, ch, L);
      for (let c = 0; c < 3; c++) {
        const lp = this._cf.pyr[k][c];
        for (let l = 0; l <= L; l++) {
          const wl = (l + 3 < cfg.kSplit ? gd : gb)[l].d; const d = lp[l].d;
          if (!acc[c][l]) acc[c][l] = new Float32Array(d.length); const a = acc[c][l];
          for (let j = 0; j < d.length; j++) a[j] += wl[j] * d[j];
          if (c === 0) { if (!ws[l]) ws[l] = new Float32Array(d.length); for (let j = 0; j < d.length; j++) ws[l][j] += wl[j]; }
        }
      }
    });
    const sizes = E.gaussPyr(new Float32Array(cw * ch), cw, ch, L).map((g) => ({ w: g.w, h: g.h }));
    this.coarse = { w: cw, h: ch, F, planes: [0, 1, 2].map((c) => E.collapse(acc[c].map((a, l) => { for (let j = 0; j < a.length; j++) a[j] /= ws[l][j] + 1e-12; return { d: a, w: sizes[l].w, h: sizes[l].h }; }))) };
  }

  // weights with retouch override applied (returns arrays aligned with act order)
  effectiveWeights(act) {
    const ov = this.override; const N = this.ww * this.wh;
    if (!ov || !ov.any) return { wd: act.map((i) => this.wd[i] || new Float32Array(N).fill(1 / act.length)), wb: act.map((i) => this.wb[i] || new Float32Array(this.qw * this.qh).fill(1 / act.length)) };
    const wd = act.map((i) => Float32Array.from(this.wd[i] || new Float32Array(N).fill(1 / act.length)));
    for (let j = 0; j < N; j++) { const m = ov.a[j]; if (m <= 0) continue; const k = act.indexOf(ov.f[j]); if (k < 0) continue; for (let t = 0; t < wd.length; t++) wd[t][j] = t === k ? wd[t][j] + (1 - wd[t][j]) * m : wd[t][j] * (1 - m); }
    const aq = E.downArea(ov.a, this.ww, this.wh, 4).d; const wb = act.map((i) => Float32Array.from(this.wb[i] || new Float32Array(this.qw * this.qh).fill(1 / act.length)));
    // base override: use dominant painted frame per quarter pixel
    const fq = new Int16Array(aq.length).fill(-1); for (let j = 0; j < N; j++) if (ov.a[j] > 0) fq[((j / this.ww / 4) | 0) * this.qw + (((j % this.ww) / 4) | 0)] = ov.f[j];
    for (let j = 0; j < aq.length; j++) { const m = aq[j]; if (m <= 0) continue; const k = act.indexOf(fq[j]); if (k < 0) continue; for (let t = 0; t < wb.length; t++) wb[t][j] = t === k ? wb[t][j] + (1 - wb[t][j]) * m : wb[t][j] * (1 - m); }
    return { wd, wb };
  }

  computeTone() {
    this.tone = { gain: Math.pow(2, this.spec.brightness || 0), shoulder: false };
    // decide on highlight shoulder from a quick coarse render
    if (this.coarse) {
      const P = this.coarse.planes; let over = 0; const n = P[0].length;
      for (let j = 0; j < n; j++) { const r = fromSpace1(P[0][j], this.cfg.space), g = fromSpace1(P[1][j], this.cfg.space), b = fromSpace1(P[2][j], this.cfg.space); if (Math.max(r, g, b) * this.tone.gain > 1.0) over++; }
      this.tone.shoulder = over / n > 0.002;
    } else if (this.cfg.pixelOp === 'hdr') this.tone.shoulder = true;
    if (this.cfg.lift) this.tone.gain *= this.cfg.lift;
  }

  // ---------------- tiled render ----------------
  // s: output pixels per work pixel. Output covers crop rect. Returns RGBA8 via writer(x,y,w,h,rgba)
  async render(s, { tile = 512, onTile = null, region = null, full = false } = {}) {
    const cr = this.crop; const OW = Math.max(1, Math.round(cr.w * s)), OH = Math.max(1, Math.round(cr.h * s));
    const K = Math.max(1, Math.round(Math.log2(8 * s))); const step = 1 << K; tile = Math.max(step, Math.round(tile / step) * step);
    const reg = region || { x: 0, y: 0, w: OW, h: OH };
    const tx0 = Math.floor(reg.x / tile) * tile, ty0 = Math.floor(reg.y / tile) * tile;
    const tiles = []; for (let y = ty0; y < reg.y + reg.h; y += tile) for (let x = tx0; x < reg.x + reg.w; x += tile) tiles.push([x, y]);
    let k = 0;
    for (const [x, y] of tiles) {
      const tw = Math.min(tile, OW - x), th = Math.min(tile, OH - y); if (tw <= 0 || th <= 0) continue;
      const rgba = await this.renderTile(s, K, x, y, tw, th, full);
      if (onTile) await onTile(x, y, tw, th, rgba);
      this.progress(full ? 'Rendering full resolution' : 'Rendering', ++k / tiles.length);
      this.checkCancel();
    }
    return { OW, OH };
  }

  async renderTile(s, K, X0, Y0, tw, th, full) {
    const cfg = this.cfg; const act = this.activeIdx(); const step = 1 << K;
    const apron = cfg.pixelOp ? 0 : 4 * step;
    const ax = X0 - apron, ay = Y0 - apron, aw = tw + 2 * apron, ah = th + 2 * apron, AN = aw * ah;
    const cr = this.crop; const toWork = (X, Y) => [cr.x + (X + 0.5) / s - 0.5, cr.y + (Y + 0.5) / s - 0.5];
    const eff = this.effectiveWeightsTile ? null : null;
    // weight sampling helpers
    const ov = this.override && this.override.any ? this.override : null;
    const sampleW = (k, i, arr, aw2, ah2, fac) => {
      const out = new Float32Array(AN);
      for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const [u, v] = toWork(ax + x, ay + y); out[y * aw + x] = E.sampleBilinear(arr, aw2, ah2, (u + 0.5) / fac - 0.5, (v + 0.5) / fac - 0.5); }
      return out;
    };
    let ovA = null, ovF = null;
    if (ov) { ovA = new Float32Array(AN); ovF = new Int16Array(AN); for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const [u, v] = toWork(ax + x, ay + y); ovA[y * aw + x] = E.sampleBilinear(ov.a, this.ww, this.wh, u, v); const xi = Math.min(this.ww - 1, Math.max(0, Math.round(u))), yi = Math.min(this.wh - 1, Math.max(0, Math.round(v))); ovF[y * aw + x] = ov.f[yi * this.ww + xi]; } }
    const applyOv = (W, i) => { if (!ov) return W; for (let j = 0; j < AN; j++) { const m = ovA[j]; if (m > 0) W[j] = ovF[j] === i ? W[j] + (1 - W[j]) * m : W[j] * (1 - m); } return W; };

    if (cfg.pixelOp) {
      const frames = [], raws = [], wts = [];
      for (const i of act) {
        const { norm, raw } = await this.frameTile(i, s, ax, ay, aw, ah, full, cfg.norm, cfg.pixelOp === 'hdr');
        frames.push(norm); raws.push(raw);
        if (cfg.pixelOp === 'pick') wts.push(applyOv(sampleW(0, i, this.wd[i], this.ww, this.wh, 1), i));
      }
      const out = pixelOp(cfg.pixelOp, frames, raws, wts, AN, act.length);
      return this.finish(out, aw, ah, apron, tw, th, X0, Y0);
    }
    const L = K; const acc = [0, 1, 2].map(() => new Array(L).fill(null)); const ws = new Array(L).fill(null);
    let best = null; // pmax state
    const log2s = Math.log2(s);
    for (const i of act) {
      const { norm } = await this.frameTile(i, s, ax, ay, aw, ah, full, cfg.norm, false);
      const Wd = applyOv(sampleW(0, i, this.wd[i], this.ww, this.wh, 1), i);
      const Wb = applyOv(sampleW(0, i, this.wb[i], this.qw, this.qh, 4), i);
      const gd = E.gaussPyr(Wd, aw, ah, L), gb = E.gaussPyr(Wb, aw, ah, L);
      const lps = norm.map((p) => E.lapPyr(toSpace(p, cfg.space), aw, ah, L));
      if (cfg.pmax) {
        if (!best) best = { e: [], c: [0, 1, 2].map(() => []) };
        for (let l = 0; l < L; l++) {
          const n = lps[0][l].d.length, lw = lps[0][l].w, lh = lps[0][l].h; const Ylap = new Float32Array(n);
          for (let j = 0; j < n; j++) Ylap[j] = Math.abs(0.2126 * lps[0][l].d[j] + 0.7152 * lps[1][l].d[j] + 0.0722 * lps[2][l].d[j]);
          const en = E.boxBlur(Ylap, lw, lh, 1); const wl = gd[l].d;
          for (let j = 0; j < n; j++) en[j] *= 0.25 + wl[j]; // gently favour the depth-map choice; retouch overrides win
          if (!best.e[l]) { best.e[l] = en; for (let c = 0; c < 3; c++) best.c[c][l] = Float32Array.from(lps[c][l].d); }
          else { const be = best.e[l]; for (let j = 0; j < n; j++) if (en[j] > be[j]) { be[j] = en[j]; for (let c = 0; c < 3; c++) best.c[c][l][j] = lps[c][l].d[j]; } }
        }
      } else {
        for (let l = 0; l < L; l++) {
          const wl = (l - log2s < cfg.kSplit ? gd : gb)[l].d;
          for (let c = 0; c < 3; c++) { const d = lps[c][l].d; if (!acc[c][l]) acc[c][l] = new Float32Array(d.length); const a = acc[c][l]; for (let j = 0; j < d.length; j++) a[j] += wl[j] * d[j]; }
          if (!ws[l]) ws[l] = new Float32Array(wl.length); const wsl = ws[l]; for (let j = 0; j < wl.length; j++) wsl[j] += wl[j];
        }
      }
    }
    // residual from the global coarse base
    const g = E.gaussPyr(new Float32Array(AN), aw, ah, L); const rw = g[L].w, rh = g[L].h; const co = this.coarse;
    const res = [0, 1, 2].map(() => new Float32Array(rw * rh));
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const [u, v] = toWork(ax + x * step, ay + y * step); const cu = u / co.F, cv = v / co.F;
      for (let c = 0; c < 3; c++) res[c][y * rw + x] = E.sampleBilinear(co.planes[c], co.w, co.h, cu, cv);
    }
    const out = [0, 1, 2].map((c) => {
      const pyr = [];
      for (let l = 0; l < L; l++) {
        let d; if (cfg.pmax) d = best.c[c][l]; else { d = acc[c][l]; const wsl = ws[l]; for (let j = 0; j < d.length; j++) d[j] /= wsl[j] + 1e-12; }
        pyr.push({ d, w: g[l].w, h: g[l].h });
      }
      pyr.push({ d: res[c], w: rw, h: rh });
      return fromSpace(E.collapse(pyr), cfg.space);
    });
    return this.finish(out, aw, ah, apron, tw, th, X0, Y0);
  }

  // tone + OETF + dither → RGBA8 for the core region
  finish(planes, aw, ah, apron, tw, th, X0, Y0) {
    const rgba = new Uint8ClampedArray(tw * th * 4); const t = this.tone; const rnd = E.mulberry((X0 * 73856093) ^ (Y0 * 19349663));
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const j = (y + apron) * aw + x + apron; let r = Math.max(0, planes[0][j] * t.gain), g = Math.max(0, planes[1][j] * t.gain), b = Math.max(0, planes[2][j] * t.gain);
      if (t.shoulder) { const m = Math.max(r, g, b); const k = 0.8; if (m > k) { const nm = k + (1 - k) * (1 - Math.exp(-(m - k) / (1 - k))); const f = nm / m; r *= f; g *= f; b *= f; } }
      const o = (y * tw + x) * 4; const d = rnd() - rnd();
      rgba[o] = E.oetfFast(r) * 255 + 0.5 + d * 0.5; rgba[o + 1] = E.oetfFast(g) * 255 + 0.5 + d * 0.5; rgba[o + 2] = E.oetfFast(b) * 255 + 0.5 + d * 0.5; rgba[o + 3] = 255;
    }
    return rgba;
  }

  // fetch frame i over output-tile rect (apron incl.) as linear planes (normalised per `norm`)
  async frameTile(i, s, ax, ay, aw, ah, full, norm, wantRaw) {
    const f = this.frames[i]; const cr = this.crop; const AN = aw * ah;
    let planes;
    if (!full) { // preview path: sample aligned work frames
      // sample the 16-bit work frame through the LUT directly (bit-identical to decoding the whole frame first,
      // but without allocating 3 full work-size float planes per tile)
      const lut = E.lut16(); let u16 = f.work, WN = this.ww * this.wh, rb = 0; planes = [0, 1, 2].map(() => new Float32Array(AN));
      const integer = Math.abs(s - 1) < 1e-9;
      if (f.spilled) { // read only the work rows this tile touches
        const vAt = (y) => cr.y + (ay + y + 0.5) / s - 0.5, cl = (v) => Math.min(this.wh - 1, Math.max(0, v));
        const y0 = cl(Math.floor(cl(vAt(0)))), y1 = cl(Math.floor(cl(vAt(ah - 1))) + 1);
        u16 = this.spill.getRows(f.id, this.ww, this.wh, y0, y1 - y0 + 1); WN = (y1 - y0 + 1) * this.ww; rb = y0;
      }
      for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        const u = cr.x + (ax + x + 0.5) / s - 0.5, v = cr.y + (ay + y + 0.5) / s - 0.5; const j = y * aw + x;
        if (integer) { const xi = Math.min(this.ww - 1, Math.max(0, Math.round(u))), yi = Math.min(this.wh - 1, Math.max(0, Math.round(v))); const q = (yi - rb) * this.ww + xi; planes[0][j] = lut[u16[q]]; planes[1][j] = lut[u16[WN + q]]; planes[2][j] = lut[u16[2 * WN + q]]; }
        else for (let c = 0; c < 3; c++) planes[c][j] = sampleBilinearU16(u16, c * WN, lut, this.ww, this.wh, u, v, rb);
      }
    } else planes = await this.fullResTile(f, s, ax, ay, aw, ah);
    let raw = null; if (wantRaw) raw = planes.map((p) => Float32Array.from(p));
    if (norm !== 'none') applyNorm(planes, AN, norm === 'wb' ? { a: 0, b: 1 } : f.gain, f.wb);
    return { norm: planes, raw };
  }

  async fullResTile(f, s, ax, ay, aw, ah) {
    const cr = this.crop, M = f.M, AN = aw * ah;
    // map output px -> ref work -> frame work (M) -> frame full
    const map = (X, Y) => { const u = cr.x + (X + 0.5) / s - 0.5, v = cr.y + (Y + 0.5) / s - 0.5; const fu = M[0] * u + M[1] * v + M[2], fv = M[3] * u + M[4] * v + M[5]; return [(fu + 0.5) * f.sx - 0.5, (fv + 0.5) * f.sy - 0.5]; };
    const c = [map(ax, ay), map(ax + aw, ay), map(ax, ay + ah), map(ax + aw, ay + ah)];
    const x0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p[0]))) - 3), y0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p[1]))) - 3);
    const x1 = Math.min(f.W - 1, Math.ceil(Math.max(...c.map((p) => p[0]))) + 3), y1 = Math.min(f.H - 1, Math.ceil(Math.max(...c.map((p) => p[1]))) + 3);
    const planes = [0, 1, 2].map(() => new Float32Array(AN));
    if (x1 < x0 || y1 < y0) return planes;
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1; const buf = await this.store.readRegion(f.id, x0, y0, rw, rh);
    const lut = f.bits === 16 ? E.lut16() : E.LUT8; const RN = rw * rh; const src = [new Float32Array(RN), new Float32Array(RN), new Float32Array(RN)];
    for (let j = 0, o = 0; j < RN; j++, o += 3) { src[0][j] = lut[buf[o]]; src[1][j] = lut[buf[o + 1]]; src[2][j] = lut[buf[o + 2]]; }
    const ratio = f.sx / s; // full px per output px
    const ss = ratio > 1.5 ? Math.ceil(ratio) : 1;
    // incremental affine mapping
    const [px0, py0] = map(ax, ay), [px1, py1] = map(ax + 1, ay), [px2, py2] = map(ax, ay + 1);
    const dxx = px1 - px0, dxy = py1 - py0, dyx = px2 - px0, dyy = py2 - py0;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const j = y * aw + x;
      if (ss === 1) {
        const u = px0 + dxx * x + dyx * y - x0, v = py0 + dxy * x + dyy * y - y0;
        bicubic3(src, rw, rh, u, v, planes, j);
      } else {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const ox = (sx + 0.5) / ss - 0.5, oy = (sy + 0.5) / ss - 0.5;
          const u = px0 + dxx * (x + ox) + dyx * (y + oy) - x0, v = py0 + dxy * (x + ox) + dyy * (y + oy) - y0;
          r += E.sampleBilinear(src[0], rw, rh, u, v); g += E.sampleBilinear(src[1], rw, rh, u, v); b += E.sampleBilinear(src[2], rw, rh, u, v);
        }
        const inv = 1 / (ss * ss); planes[0][j] = r * inv; planes[1][j] = g * inv; planes[2][j] = b * inv;
      }
    }
    return planes;
  }

  // ---------------- previews & diagnostics ----------------
  async renderPreview() {
    const cr = this.crop; const rgba = new Uint8ClampedArray(cr.w * cr.h * 4);
    await this.render(1, { tile: 512, onTile: (x, y, tw, th, t) => blit(rgba, cr.w, x, y, tw, th, t) });
    this.preview = rgba; return { w: cr.w, h: cr.h, rgba };
  }
  async rerenderRegion(rect) { // rect in preview coords
    const cr = this.crop; const K = 3, step = 8;
    await this.render(1, { tile: 256, region: rect, onTile: (x, y, tw, th, t) => blit(this.preview, cr.w, x, y, tw, th, t) });
    return this.preview;
  }
  beforeImage(i = this.ref) {
    const cr = this.crop, f = this.frames[i], wp = this.workPlanes(f); const rgba = new Uint8ClampedArray(cr.w * cr.h * 4);
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) { const q = (y + cr.y) * this.ww + x + cr.x, o = (y * cr.w + x) * 4; rgba[o] = E.oetfFast(wp[0][q]) * 255 + 0.5; rgba[o + 1] = E.oetfFast(wp[1][q]) * 255 + 0.5; rgba[o + 2] = E.oetfFast(wp[2][q]) * 255 + 0.5; rgba[o + 3] = 255; }
    return { w: cr.w, h: cr.h, rgba };
  }
  sourceMap() {
    const cr = this.crop, act = this.activeIdx(); const rgba = new Uint8ClampedArray(cr.w * cr.h * 4); const N = this.ww * this.wh;
    let wd;
    if (this.cfg.pixelOp && this.cfg.pixelOp !== 'pick') wd = this.pixelOpMap(act); else wd = this.effectiveWeights(act).wd;
    const share = new Float64Array(act.length);
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) {
      const q = (y + cr.y) * this.ww + x + cr.x; let b = -1, bk = 0; for (let k = 0; k < act.length; k++) if (wd[k][q] > b) { b = wd[k][q]; bk = k; }
      share[bk]++; const col = PALETTE[act[bk] % PALETTE.length], o = (y * cr.w + x) * 4; const conf = Math.min(1, Math.max(0.35, b));
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = Math.round(200 * conf);
    }
    const tot = cr.w * cr.h; return { w: cr.w, h: cr.h, rgba, share: act.map((i, k) => ({ i, pct: Math.round(100 * share[k] / tot) })) };
  }
  pixelOpMap(act) {
    const N = this.ww * this.wh; const Ys = act.map((i) => lum(this.normPlanes(i, this.cfg.norm, 0), N)); const op = this.cfg.pixelOp;
    return Ys.map((Y, k) => { const m = new Float32Array(N); for (let j = 0; j < N; j++) { let ext = Ys[0][j]; for (const Z of Ys) ext = op === 'darken' ? Math.min(ext, Z[j]) : op === 'lighten' ? Math.max(ext, Z[j]) : ext; m[j] = (op === 'darken' || op === 'lighten') ? (Y[j] === ext ? 1 : 0) : 1 / Ys.length; } return m; });
  }

  // ---------------- retouch ----------------
  ensureOverride() { const N = this.ww * this.wh; if (!this.override || this.override.w !== this.ww) this.override = { w: this.ww, a: new Float32Array(N), f: new Int16Array(N).fill(-1), any: false }; return this.override; }
  // pts in preview (crop) coords; radius px; feather 0..1; frame index or -1 to erase
  async stroke(pts, radius, feather, frame) {
    const ov = this.ensureOverride(); const cr = this.crop; const w = this.ww;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const p of pts) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
    const bx0 = Math.max(0, Math.floor(minx - radius) + cr.x), by0 = Math.max(0, Math.floor(miny - radius) + cr.y), bx1 = Math.min(w - 1, Math.ceil(maxx + radius) + cr.x), by1 = Math.min(this.wh - 1, Math.ceil(maxy + radius) + cr.y);
    // undo snapshot of the affected box
    const snap = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 }; snap.a = new Float32Array(snap.w * snap.h); snap.f = new Int16Array(snap.w * snap.h);
    for (let y = 0; y < snap.h; y++) for (let x = 0; x < snap.w; x++) { const q = (y + by0) * w + x + bx0; snap.a[y * snap.w + x] = ov.a[q]; snap.f[y * snap.w + x] = ov.f[q]; }
    this.undo.push(snap); if (this.undo.length > 40) this.undo.shift();
    const inner = radius * (1 - Math.min(0.95, feather));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      let d = 1e9; const px = x - cr.x, py = y - cr.y;
      for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[Math.min(pts.length - 1, k + 1)]; d = Math.min(d, segDist(px, py, a.x, a.y, b.x, b.y)); }
      if (d > radius) continue; const m = d <= inner ? 1 : 1 - E.smoothstep(inner, radius, d); const q = y * w + x;
      if (frame < 0) { ov.a[q] = Math.max(0, ov.a[q] - m); if (ov.a[q] === 0) ov.f[q] = -1; }
      else { if (ov.f[q] !== frame) { ov.a[q] = m; ov.f[q] = frame; } else ov.a[q] = Math.max(ov.a[q], m); }
    }
    ov.any = true;
    return this.refreshAfterRetouch({ x: bx0 - cr.x, y: by0 - cr.y, w: snap.w, h: snap.h });
  }
  async undoStroke() { const s = this.undo.pop(); if (!s) return null; const ov = this.override; for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const q = (y + s.y) * this.ww + x + s.x; ov.a[q] = s.a[y * s.w + x]; ov.f[q] = s.f[y * s.w + x]; } return this.refreshAfterRetouch({ x: s.x - this.crop.x, y: s.y - this.crop.y, w: s.w, h: s.h }); }
  async refreshAfterRetouch(rect) {
    const t0 = Date.now(); this.computeCoarse(); this._scr = null; const pad = 64; const cr = this.crop;
    const r = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad) }; r.w = Math.min(cr.w, rect.x + rect.w + pad) - r.x; r.h = Math.min(cr.h, rect.y + rect.h + pad) - r.y;
    if (r.w > 0 && r.h > 0) await this.rerenderRegion(r);
    return { rect: r, ms: Date.now() - t0 };
  }

  // output size for a target megapixel count (null = full)
  exportScale(targetMP) {
    const ref = this.frames[this.ref]; const sFull = ref.sx; const cr = this.crop;
    if (!targetMP) return sFull;
    const s = Math.sqrt(targetMP * 1e6 / (cr.w * cr.h)); return Math.min(sFull, s);
  }
}

// ---------------- helpers ----------------
// E.sampleBilinear over lut[u16[off + i]] (same arithmetic → same result as on the decoded float plane)
function sampleBilinearU16(src, off, lut, w, h, x, y, rb = 0) {
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1) x = w - 1; if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = x - x0, fy = y - y0;
  const r0 = off + (y0 - rb) * w, r1 = off + (y1 - rb) * w;
  const a = lut[src[r0 + x0]], b = lut[src[r0 + x1]], c = lut[src[r1 + x0]], d = lut[src[r1 + x1]];
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function packBits(u8) { const b = new Uint8Array((u8.length + 7) >> 3); for (let j = 0; j < u8.length; j++) if (u8[j]) b[j >> 3] |= 1 << (j & 7); return b; }
function blit(dst, dw, x, y, tw, th, src) { for (let r = 0; r < th; r++) dst.set(src.subarray(r * tw * 4, (r + 1) * tw * 4), ((y + r) * dw + x) * 4); }
function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(px - ax - t * dx, py - ay - t * dy); }
export function encode16(planes, N) { const out = new Uint16Array(3 * N); for (let c = 0; c < 3; c++) { const p = planes[c], o = c * N; for (let j = 0; j < N; j++) out[o + j] = Math.round(E.oetfFast(p[j]) * 65535); } return out; }
export function decode16(u, N, into) { const lut = E.lut16(); return [0, 1, 2].map((c) => { const p = into ? into[c] : new Float32Array(N), o = c * N; for (let j = 0; j < N; j++) p[j] = lut[u[o + j]]; return p; }); }
function lum(pl, N) { const Y = new Float32Array(N); for (let i = 0; i < N; i++) Y[i] = 0.2126 * pl[0][i] + 0.7152 * pl[1][i] + 0.0722 * pl[2][i]; return Y; }
function clampPos(a) { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; }
function normalize(arrs, act, N) { const s = new Float32Array(N); for (const i of act) { const a = arrs[i]; for (let j = 0; j < N; j++) s[j] += a[j]; } for (const i of act) { const a = arrs[i]; for (let j = 0; j < N; j++) a[j] = s[j] > 1e-12 ? a[j] / s[j] : 1 / act.length; } }
function normalizeQ(arrs, act) { normalize(arrs, act, arrs[act[0]].length); }
function sampleQ(arr, w, h, x, y, fac) { return E.sampleBilinear(arr, w, h, (x + 0.5) / fac - 0.5, (y + 0.5) / fac - 0.5); }
function clipMask(raw, N, highOnly = false) { const m = new Float32Array(N); for (let j = 0; j < N; j++) { const r = raw[0][j], g = raw[1][j], b = raw[2][j]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); m[j] = mx > 0.955 || (!highOnly && mx < 0.0008) ? 1 : 0; } return m; } // any channel blown (sRGB>0.98) or fully black (all <0.01)
// blown regions only: >50% of a 5x5 window clipped, then dilated 3 px (isolated clipped texels keep their evidence)
function blownMask(m, w, h, sc) { const f = E.boxBlur(m, w, h, 2); for (let j = 0; j < f.length; j++) f[j] = f[j] > 0.5 ? 1 : 0; return dilate(f, w, h, Math.max(1, Math.round(3 * sc))); }
function dilate(m, w, h, r) { const b = E.boxBlur(m, w, h, r); for (let j = 0; j < b.length; j++) b[j] = b[j] > 1e-6 ? 1 : 0; return b; }
// Alignment feature (combined.md §4.1): blurred log-luminance, locally normalised to zero mean / unit
// variance. The local normalisation removes the "sharp-region envelope" that otherwise biases ECC
// between frames focused at different depths (measured: 1–7 px → <0.5 px corner error).
function alignFeature(Y, w, h) {
  const N = w * h, sc = Math.max(w, h) / 2048; const L = new Float32Array(N); for (let i = 0; i < N; i++) L[i] = Math.log(Y[i] + 0.01);
  const Lb = E.gaussBlur(L, w, h, 2 * Math.max(0.6, sc)); const r = Math.max(8, Math.round(31 * Math.max(0.5, sc)));
  const m = E.boxBlur(Lb, w, h, r); const sq = new Float32Array(N); for (let i = 0; i < N; i++) sq[i] = (Lb[i] - m[i]) ** 2;
  const v = E.boxBlur(sq, w, h, r); for (let i = 0; i < N; i++) sq[i] = (Lb[i] - m[i]) / Math.sqrt(v[i] + 1e-4);
  return sq;
}
// sharpness: abs LoG energy, divided by local brightness, minus noise floor (combined.md §4.4.1)
export function sharpness(P, w, h, sc, clipD) {
  const N = w * h; const Pb = E.gaussBlur(P, w, h, 1.0); const lap = E.laplacian(Pb, w, h);
  const sq = new Float32Array(N); for (let j = 0; j < N; j++) sq[j] = lap[j] * lap[j];
  const En = E.gaussBlur(sq, w, h, Math.max(1.5, 4 * sc)); const Mloc = E.gaussBlur(P, w, h, 5 * Math.max(0.5, sc));
  for (let j = 0; j < N; j++) En[j] = Math.sqrt(En[j]);
  // noise: robust sigma of the Laplacian in the flattest half of the image
  const thr = E.quantile(En, 0.3, 11); const absl = []; for (let j = 0; j < N; j += 7) if (En[j] <= thr) absl.push(Math.abs(lap[j]));
  const sig = 1.4826 * E.medianOf(absl);
  const C = new Float32Array(N); const k = 2;
  for (let j = 0; j < N; j++) { let c = (En[j] - k * sig) / (Mloc[j] + 0.02); if (c < 0) c = 0; if (clipD && clipD[j] > 0.5) c = 0; C[j] = c; }
  return { C, sigma: sig };
}
function mertensWeights(pl, w, h, { wc = 1, ws = 1, we = 1, glare = 0, display = true }) {
  const N = w * h; const v = pl.map((p) => { const o = new Float32Array(N); for (let j = 0; j < N; j++) o[j] = E.oetfFast(p[j]); return o; });
  const gray = new Float32Array(N); for (let j = 0; j < N; j++) gray[j] = (v[0][j] + v[1][j] + v[2][j]) / 3;
  const lap = E.laplacian(gray, w, h); const W = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    const r = v[0][j], g = v[1][j], b = v[2][j], m = (r + g + b) / 3; const sat = Math.sqrt(((r - m) ** 2 + (g - m) ** 2 + (b - m) ** 2) / 3);
    const ex = Math.exp(-((r - 0.5) ** 2) / 0.08) * Math.exp(-((g - 0.5) ** 2) / 0.08) * Math.exp(-((b - 0.5) ** 2) / 0.08);
    let wt = Math.pow(Math.abs(lap[j]) + 1e-12, wc) * Math.pow(sat + 1e-12, ws) * Math.pow(ex + 1e-12, we);
    if (glare > 0) { const mx = Math.max(r, g, b); const desat = 1 - (mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0); wt *= (1 - glare * E.smoothstep(0.85, 0.98, mx)) * (1 - 0.5 * glare * desat * E.smoothstep(0.6, 0.9, m)); }
    W[j] = wt + 1e-12;
  }
  return W;
}
function toSpace(p, space) {
  const o = new Float32Array(p.length);
  if (space === 'gamma') for (let j = 0; j < p.length; j++) o[j] = E.gammaFast(p[j]);
  else if (space === 'log') for (let j = 0; j < p.length; j++) o[j] = Math.log((p[j] > 0 ? p[j] : 0) + 2e-3);
  else if (space === 'srgb') for (let j = 0; j < p.length; j++) o[j] = p[j] >= 1 ? Math.pow(p[j], 1 / 2.4) : E.oetfFast(p[j]);
  else o.set(p);
  return o;
}
function fromSpace1(v, space) { if (space === 'gamma') return E.degammaFast(v); if (space === 'log') return Math.exp(v) - 2e-3; if (space === 'srgb') return v > 1 ? Math.pow(v, 2.4) : E.eotf(v > 0 ? v : 0); return v; }
function fromSpace(p, space) { const o = new Float32Array(p.length); for (let j = 0; j < p.length; j++) o[j] = fromSpace1(p[j], space); return o; }
function applyNorm(pl, N, gain, wb) {
  const ea = Math.exp(gain.a), b1 = gain.b - 1;
  for (let j = 0; j < N; j++) {
    let f = ea; if (b1 !== 0) { const Y = Math.max(1e-4, 0.2126 * pl[0][j] + 0.7152 * pl[1][j] + 0.0722 * pl[2][j]); f *= Math.pow(Y, b1); }
    pl[0][j] *= f * wb[0]; pl[1][j] *= f * wb[1]; pl[2][j] *= f * wb[2];
  }
}
function fitGain(Yr, Yi, valid, N) {
  const xs = [], ys = [];
  for (let j = 0; j < N; j += 5) if (valid[j] && Yr[j] > 0.05 && Yr[j] < 0.9 && Yi[j] > 0.05 && Yi[j] < 0.9) { xs.push(Math.log(Yi[j])); ys.push(Math.log(Yr[j])); }
  if (xs.length < 200) { // fall back to median ratio over anything non-clipped in both
    const r = []; for (let j = 0; j < N; j += 3) if (valid[j] && Yr[j] > 0.01 && Yr[j] < 0.95 && Yi[j] > 0.01 && Yi[j] < 0.95) r.push(Math.log(Yr[j] / Yi[j]));
    return { a: r.length ? E.medianOf(r) : 0, b: 1 };
  }
  // Gain only (b = 1): a free log-log slope is biased by defocus (regression dilution) — measured
  // 0.83–1.09 on a pure focus set — so we use a robust, trimmed median of log ratios instead.
  let a = E.medianOf(ys.map((y, k) => y - xs[k]));
  for (let pass = 0; pass < 2; pass++) {
    const res = ys.map((y, k) => y - xs[k] - a); const s = 1.4826 * E.medianOf(res.map(Math.abs)) + 1e-6;
    const keep = []; for (let k = 0; k < xs.length; k++) if (Math.abs(res[k]) < 3 * s) keep.push(ys[k] - xs[k]);
    if (keep.length < 50) break; a = E.medianOf(keep);
  }
  return { a, b: 1 };
}
function fitWB(refPl, Yr, pl, Yi, gain, valid, N) {
  const k = [[], [], []];
  for (let j = 0; j < N; j += 3) {
    if (!valid[j] || Yr[j] < 0.03 || Yr[j] > 0.85 || Yi[j] < 0.03 || Yi[j] > 0.85) continue;
    for (let c = 0; c < 3; c++) { const a = refPl[c][j] / Yr[j], b = pl[c][j] / Yi[j]; if (a > 1e-3 && b > 1e-3) k[c].push(Math.log(a / b)); }
  }
  if (k[0].length < 100) return [1, 1, 1];
  const g = k.map((arr) => Math.exp(E.medianOf(arr)));
  const y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]; return g.map((v) => v / y);
}
function largestRect(valid, w, h) {
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
  const colBad = (x) => { let c = 0; for (let y = y0; y <= y1; y++) if (!valid[y * w + x]) c++; return c; };
  const rowBad = (y) => { let c = 0; for (let x = x0; x <= x1; x++) if (!valid[y * w + x]) c++; return c; };
  for (let it = 0; it < w + h; it++) {
    const l = colBad(x0), r = colBad(x1), t = rowBad(y0), b = rowBad(y1);
    const m = Math.max(l / (y1 - y0 + 1), r / (y1 - y0 + 1), t / (x1 - x0 + 1), b / (x1 - x0 + 1)); if (m === 0) break;
    if (m === l / (y1 - y0 + 1)) x0++; else if (m === r / (y1 - y0 + 1)) x1--; else if (m === t / (x1 - x0 + 1)) y0++; else y1--;
    if (x1 - x0 < 16 || y1 - y0 < 16) break;
  }
  // trim to even sizes and add a 1px safety margin
  x0 += 1; y0 += 1; x1 -= 1; y1 -= 1;
  // snap the origin to the 8-px coarse grid so preview tiles and the global base share sample positions
  x0 = Math.ceil(x0 / 8) * 8; y0 = Math.ceil(y0 / 8) * 8;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function warpBicubic(pl, w, h, M, ow, oh, valid) {
  const out = pl.map(() => new Float32Array(ow * oh));
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const xs = M[0] * x + M[1] * y + M[2], ys = M[3] * x + M[4] * y + M[5]; const j = y * ow + x;
    bicubic3(pl, w, h, xs, ys, out, j);
    if (valid) valid[j] = (xs >= 0 && ys >= 0 && xs <= w - 1 && ys <= h - 1) ? 1 : 0;
  }
  return out;
}
function bicubic3(src, w, h, u, v, dst, j) {
  if (u < 0) u = 0; if (v < 0) v = 0; if (u > w - 1) u = w - 1; if (v > h - 1) v = h - 1;
  const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
  const fx2 = fx * fx, fx3 = fx2 * fx, fy2 = fy * fy, fy3 = fy2 * fy;
  const ax0 = (-fx3 + 2 * fx2 - fx) * 0.5, ax1 = (3 * fx3 - 5 * fx2 + 2) * 0.5, ax2 = (-3 * fx3 + 4 * fx2 + fx) * 0.5, ax3 = (fx3 - fx2) * 0.5;
  const ay0 = (-fy3 + 2 * fy2 - fy) * 0.5, ay1 = (3 * fy3 - 5 * fy2 + 2) * 0.5, ay2 = (-3 * fy3 + 4 * fy2 + fy) * 0.5, ay3 = (fy3 - fy2) * 0.5;
  const xa = x0 > 0 ? x0 - 1 : 0, xc = x0 + 1 < w ? x0 + 1 : w - 1, xd = x0 + 2 < w ? x0 + 2 : w - 1;
  const r0 = (y0 > 0 ? y0 - 1 : 0) * w, r1 = y0 * w, r2 = (y0 + 1 < h ? y0 + 1 : h - 1) * w, r3 = (y0 + 2 < h ? y0 + 2 : h - 1) * w;
  for (let c = 0; c < src.length; c++) {
    const s = src[c];
    const acc = ay0 * (ax0 * s[r0 + xa] + ax1 * s[r0 + x0] + ax2 * s[r0 + xc] + ax3 * s[r0 + xd])
      + ay1 * (ax0 * s[r1 + xa] + ax1 * s[r1 + x0] + ax2 * s[r1 + xc] + ax3 * s[r1 + xd])
      + ay2 * (ax0 * s[r2 + xa] + ax1 * s[r2 + x0] + ax2 * s[r2 + xc] + ax3 * s[r2 + xd])
      + ay3 * (ax0 * s[r3 + xa] + ax1 * s[r3 + x0] + ax2 * s[r3 + xc] + ax3 * s[r3 + xd]);
    dst[c][j] = acc < 0 ? 0 : acc;
  }
}
function pixelOp(op, frames, raws, wts, AN, n) {
  const out = [0, 1, 2].map(() => new Float32Array(AN)); const vals = new Float32Array(n);
  for (let j = 0; j < AN; j++) {
    if (op === 'pick') { let b = -1, bk = 0; for (let k = 0; k < n; k++) if (wts[k][j] > b) { b = wts[k][j]; bk = k; } for (let c = 0; c < 3; c++) out[c][j] = frames[bk][c][j]; continue; }
    if (op === 'lighten' || op === 'darken') { let bk = 0, bv = op === 'lighten' ? -1 : 1e9; for (let k = 0; k < n; k++) { const Y = 0.2126 * frames[k][0][j] + 0.7152 * frames[k][1][j] + 0.0722 * frames[k][2][j]; if (op === 'lighten' ? Y > bv : Y < bv) { bv = Y; bk = k; } } for (let c = 0; c < 3; c++) out[c][j] = frames[bk][c][j]; continue; }
    if (op === 'hdr') { let s = 0; const acc = [0, 0, 0]; for (let k = 0; k < n; k++) { const z = Math.max(raws[k][0][j], raws[k][1][j], raws[k][2][j]); let wgt = z >= 0.95 || z <= 0.002 ? 0 : (z < 0.5 ? (z - 0.002) / 0.498 : (0.95 - z) / 0.45); wgt = Math.max(wgt, 1e-6 * (z < 0.95 ? 1 : 0)); s += wgt; for (let c = 0; c < 3; c++) acc[c] += wgt * frames[k][c][j]; }
      if (s <= 0) { let mn = 0, mv = 1e9; for (let k = 0; k < n; k++) { const z = raws[k][1][j]; if (z < mv) { mv = z; mn = k; } } for (let c = 0; c < 3; c++) out[c][j] = frames[mn][c][j]; } else for (let c = 0; c < 3; c++) out[c][j] = acc[c] / s; continue; }
    // average: sigma-clipped mean (n>=5) else median; 'average-mean' = plain mean (baseline)
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < n; k++) vals[k] = frames[k][c][j];
      if (op === 'average-mean') { let s = 0; for (let k = 0; k < n; k++) s += vals[k]; out[c][j] = s / n; continue; }
      if (n < 5) { const s = Array.from(vals).sort((a, b) => a - b); out[c][j] = n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]); continue; }
      let m = 0; for (let k = 0; k < n; k++) m += vals[k]; m /= n; let sd = 0; for (let k = 0; k < n; k++) sd += (vals[k] - m) ** 2; sd = Math.sqrt(sd / n) + 1e-6;
      let s = 0, cnt = 0; for (let k = 0; k < n; k++) if (Math.abs(vals[k] - m) <= 2.5 * sd) { s += vals[k]; cnt++; } out[c][j] = cnt ? s / cnt : m;
    }
  }
  return out;
}
