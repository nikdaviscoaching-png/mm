// focusfuse.js — per-band soft-selection focus fusion with an optional cleanliness gate (pure JS, planar Float32, no DOM).
//
// Port of the Swift SpecimenCore FocusStackEngine.fuseTile (ground-truth tested there), extended with a per-frame, per-pixel GATE so one
// engine serves all three jobs:
//   focus only      gate = null
//   light + focus   gate = how trustworthy (glare-free, colour-true, well exposed) each frame is at each pixel, from the lighting analysis
// For every pyramid band and pixel a soft selection over the frames is made from (a) the band's own coefficient energy, (b) a multi-signal
// focus map, (c) a wide-window map of fine-scale signals only (so flat regions inherit the decision of the detail around them instead of
// averaging blurred and sharp frames — it also stops "defocus bleed" from a blurred bright neighbour winning locally) and (d) the gate.
// Everything is blended in linear light, so tiles agree with each other and with the whole image.
import * as E from './engine.js';
import { focusMaps } from './focusmap.js';

export const FOCUS_DEFAULTS = { singleWeights: false, energyLevels: 99, levels: 5, selectionPower: 8, focusMapPower: 1.5, saliencySigma: 1.5, aggSigma: 2, widePower: 3.5, wideSigma: 8, noiseDeadZone: 1.5, noiseSoftness: 2, gatePower: 1 };
const encode = E.oetfFast;

// Energy of unit white noise in each Laplacian band (after the saliency window): flat regions, where all frames hold only noise, get
// near-equal weights (noise averaging) instead of arbitrary picks.
const calibCache = new Map();
function bandNoiseEnergy(levels, sigma) {
  const key = levels + '|' + sigma; if (calibCache.has(key)) return calibCache.get(key);
  const S = 96, rnd = E.mulberry(12345), gauss = () => { const u1 = Math.max(rnd(), 1e-7), u2 = rnd(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
  const tile = [0, 1, 2].map(() => { const a = new Float32Array(S * S); for (let i = 0; i < a.length; i++) a[i] = gauss(); return a; });
  const W = 192, big = tile.map((p) => { const o = new Float32Array(W * W); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) o[y * W + x] = p[((x + Math.floor(y / S) * 37) % S) * 1 + (y % S) * S]; return o; });
  const lap = big.map((p) => E.lapPyr(p, W, W, levels)), out = [];
  for (let l = 0; l < levels; l++) {
    const { w, h } = lap[0][l], e = new Float32Array(w * h);
    for (let j = 0; j < e.length; j++) e[j] = (lap[0][l].d[j] ** 2 + lap[1][l].d[j] ** 2 + lap[2][l].d[j] ** 2) / 3;
    const s = E.gaussBlur(e, w, h, sigma), m = Math.max(2, Math.floor(w / 5)); let acc = 0, n = 0;
    for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) { acc += s[y * w + x]; n++; }
    out.push(acc / Math.max(n, 1));
  }
  calibCache.set(key, out); return out;
}

// frameLin(k) → [r, g, b] linear Float32Arrays (aw·ah) of the ALIGNED frame k over the tile (not modified).
// gate(k) → plane (aw·ah, 0..1) or null; gainOf(k) → plane or null (smooth lighting match to a common scale).
// Returns linear planes {r, g, b} and `dominant` (how many pixels each frame won at the finest band).
export async function fuseFocusTile(n, aw, ah, frameLin, { noiseSigma, options = {}, gate = null, gainOf = null, override = null, tick = null } = {}) {
  const o = { ...FOCUS_DEFAULTS, ...options }, L = o.levels, AN = aw * ah;
  const sizes = E.gaussPyr(new Float32Array(AN), aw, ah, L).map((g) => ({ w: g.w, h: g.h })), nBands = L, calib = bandNoiseEnergy(L, o.saliencySigma);
  const lin = [], focusPyr = [], widePyr = [], sal = [], gatePyr = [];
  // pass 1: focus maps, per-band saliency, gate pyramids (encoded domain)
  for (let k = 0; k < n; k++) {
    const src = await frameLin(k), gn = gainOf ? gainOf(k) : null; // (the planes are shared with other consumers: gain is applied to a copy)
    const p = gn ? src.map((c) => { const q = new Float32Array(AN); for (let i = 0; i < AN; i++) q[i] = c[i] * gn[i]; return q; }) : src;
    lin.push(p);
    const enc = p.map((c) => { const e = new Float32Array(AN); for (let i = 0; i < AN; i++) e[i] = encode(c[i]); return e; });
    const fm = focusMaps(enc[0], enc[1], enc[2], aw, ah, { noiseSigma, sigmaAgg: o.aggSigma });
    focusPyr.push(E.gaussPyr(fm.focus, aw, ah, L).map((g) => g.d));
    if (o.widePower > 0) widePyr.push(E.gaussPyr(E.gaussBlur(fm.fine, aw, ah, o.wideSigma), aw, ah, L).map((g) => g.d));
    const lap = enc.map((c) => E.lapPyr(c, aw, ah, L)), s = [];
    for (let l = 0; l < nBands; l++) { const e = new Float32Array(lap[0][l].d.length); for (let j = 0; j < e.length; j++) e[j] = (lap[0][l].d[j] ** 2 + lap[1][l].d[j] ** 2 + lap[2][l].d[j] ** 2) / 3; s.push(E.gaussBlur(e, sizes[l].w, sizes[l].h, o.saliencySigma)); }
    sal.push(s);
    const g = gate ? gate(k) : null; gatePyr.push(g ? E.gaussPyr(g, aw, ah, L).map((q) => q.d) : null);
    if (tick) await tick(k, n);
  }
  // retouch override: painted pixels take their frame (alpha-mixed) — applied to the finest weights; coarser levels follow through the pyramid of the mixing mask
  // (handled below by mixing at every level with the pyramid of `override.a`)
  const ovPyr = override ? E.gaussPyr(override.a, aw, ah, L).map((g) => g.d) : null;
  // per-band weights: softmax over frames of (focus map, wide map, band saliency, gate)
  const weights = Array.from({ length: n }, () => []), epsF = 0.05;
  for (let l = 0; l <= L; l++) {
    const { w, h } = sizes[l], M = w * h, isRes = l === nBands, noiseE = isRes ? 0 : calib[l] * noiseSigma * noiseSigma, eps = isRes ? 1e-4 : Math.max(noiseE * o.noiseSoftness, 1e-10), dead = noiseE * o.noiseDeadZone;
    const logits = Array.from({ length: n }, () => new Float32Array(M)), maxL = new Float32Array(M).fill(-Infinity);
    for (let k = 0; k < n; k++) {
      const fl = focusPyr[k][l], wl = o.widePower > 0 ? widePyr[k][l] : null, sl = isRes ? null : sal[k][l], gl = gatePyr[k] ? gatePyr[k][l] : null, lg = logits[k];
      for (let j = 0; j < M; j++) {
        let u = o.focusMapPower * Math.log(Math.max(fl[j], 0) + epsF);
        if (wl) u += o.widePower * Math.log(Math.max(wl[j], 0) + epsF);
        if (sl && l < o.energyLevels) u += o.selectionPower * 0.5 * Math.log(Math.max(sl[j] - dead, 0) + eps);
        if (gl) u += o.gatePower * o.selectionPower * 0.5 * Math.log(gl[j] + 0.02);
        lg[j] = u; if (u > maxL[j]) maxL[j] = u;
      }
    }
    const sum = new Float32Array(M);
    for (let k = 0; k < n; k++) { const lg = logits[k]; for (let j = 0; j < M; j++) { const e = Math.exp(lg[j] - maxL[j]); lg[j] = e; sum[j] += e; } }
    for (let k = 0; k < n; k++) { const lg = logits[k]; for (let j = 0; j < M; j++) lg[j] /= sum[j]; weights[k].push(lg); }
    if (ovPyr) { // painted pixels: mix towards the chosen frame at this level's resolution
      const a = ovPyr[l], kf = override.kAt(l, w, h);
      for (let j = 0; j < M; j++) { const m = a[j]; if (m <= 0) continue; const kk = kf[j]; if (kk < 0) continue; for (let k = 0; k < n; k++) { const v = weights[k][l][j]; weights[k][l][j] = k === kk ? v + (1 - v) * m : v * (1 - m); } }
    }
  }
  if (o.singleWeights) { // one decision per pixel (from the finest band), carried to coarser bands by the Gaussian pyramid of the weight map
    for (let k = 0; k < n; k++) { const pyr = E.gaussPyr(weights[k][0], aw, ah, L); for (let l = 1; l <= L; l++) weights[k][l] = pyr[l].d; }
  }
  focusPyr.length = widePyr.length = sal.length = gatePyr.length = 0;
  const dominant = new Float64Array(n);
  for (let j = 0; j < AN; j++) { let b = -1, bk = 0; for (let k = 0; k < n; k++) if (weights[k][0][j] > b) { b = weights[k][0][j]; bk = k; } dominant[bk]++; }
  // pass 2: blend linear-light Laplacian coefficients
  const acc = [0, 1, 2].map(() => sizes.map((s) => new Float32Array(s.w * s.h)));
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) {
      const pyr = E.lapPyr(lin[k][c], aw, ah, L);
      for (let l = 0; l <= L; l++) { const a = acc[c][l], q = pyr[l].d, wk = weights[k][l]; for (let i = 0; i < a.length; i++) a[i] += q[i] * wk[i]; }
    }
    lin[k] = null;
  }
  const out = acc.map((a) => { const f = E.collapse(a.map((d, l) => ({ d, w: sizes[l].w, h: sizes[l].h }))); for (let i = 0; i < f.length; i++) if (f[i] < 0) f[i] = 0; return f; });
  return { r: out[0], g: out[1], b: out[2], dominant, weightsFinest: weights.map((w) => w[0]), weightsAll: o.debug ? weights : undefined };
}

// ---------------- production weight stage ----------------
// One selection decision per pixel and frame, taken from the FINEST band and carried to coarser bands by the Gaussian pyramid of the weight
// map (measured: no loss on pure focus, 0.5 dB on the hardest focus+lighting scene, and it lets the weights be computed once at preview size
// and reused for tiled preview and full-resolution export). Returns the finest-band LOGITS of one tile for one frame; the caller takes the
// softmax over frames (and may add a spatial prior).
//   enc    [r, g, b]  display-encoded planes of the (lighting-matched) frame over the tile, aw × ah
//   gate   plane 0..1 (how trustworthy this frame is at each pixel) or null
export function sharpLogits(enc, aw, ah, { noiseSigma, gate = null, options = {} }) {
  const o = { ...FOCUS_DEFAULTS, ...options }, AN = aw * ah;
  const fm = focusMaps(enc[0], enc[1], enc[2], aw, ah, { noiseSigma, sigmaAgg: o.aggSigma });
  const wide = o.widePower > 0 ? E.gaussBlur(fm.fine, aw, ah, o.wideSigma) : null;
  const e = new Float32Array(AN);
  for (let c = 0; c < 3; c++) { const b0 = E.lapPyr(enc[c], aw, ah, 1)[0].d; for (let i = 0; i < AN; i++) e[i] += (b0[i] * b0[i]) / 3; }
  const sal = E.gaussBlur(e, aw, ah, o.saliencySigma), noiseE = bandNoiseEnergy(1, o.saliencySigma)[0] * noiseSigma * noiseSigma, eps = Math.max(noiseE * o.noiseSoftness, 1e-10), dead = noiseE * o.noiseDeadZone, epsF = 0.05;
  const u = new Float32Array(AN), gk = o.gatePower * o.selectionPower * 0.5;
  for (let i = 0; i < AN; i++) {
    let v = o.focusMapPower * Math.log(Math.max(fm.focus[i], 0) + epsF) + o.selectionPower * 0.5 * Math.log(Math.max(sal[i] - dead, 0) + eps);
    if (wide) v += o.widePower * Math.log(Math.max(wide[i], 0) + epsF);
    if (gate) v += gk * Math.log(gate[i] + 0.02);
    u[i] = v;
  }
  return u;
}
