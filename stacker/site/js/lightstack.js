// lightstack.js — reflection-aware lighting stack (pure JS, planar Float32, no DOM).
//
// Port of the Swift SpecimenCore LightingAnalysisEngine / LightingFusionEngine (documented there with ground-truth tests).
// This is deliberately NOT exposure fusion, HDR, min, median or average. Real detail stays put while reflections move with
// the light, so frames are scored per region on how trustworthy they are as a record of the specimen (clipping and its spatial
// extent, local detail, colour contamination, exposure) and compared with each other. One natural BASE frame defines the
// lighting character; other frames replace it only where they are decisively better, so legitimate narrow polished
// highlights survive and the stone never goes matte.
//
//   analyzeLighting(prox, w, h, opts)  — proxy-resolution analysis → base, replacement weights, gains, tone
//   blendTile(A, L, aw, ah, frameLin, up) — full-resolution multiband blend of one tile in log light
import * as E from './engine.js';
import { focusMaps, estimateNoise } from './focusmap.js';

export const DEFAULTS = { levels: 5, narrowHighlightFraction: 0.012, qualityPower: 3, replaceMargin: [0.12, 0.45], matchLocalLighting: true, gainSigmaFraction: 0.04, preferredBase: null };
const LOG_FLOOR = 0.003; // offset of the log-light representation (linear units)
const ss = E.smoothstep, clamp01 = E.clamp01;

// sRGB transfer, table based (the analysis runs it on every proxy pixel of every frame)
const DEC = new Float32Array(4098);
for (let i = 0; i < DEC.length; i++) { const v = Math.min(1, i / 4096); DEC[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
const decode = (v) => { if (v <= 0) return 0; if (v >= 1) return 1; const f = v * 4096, i = f | 0; return DEC[i] + (DEC[i + 1] - DEC[i]) * (f - i); };
const encode = E.oetfFast;
const luma = (r, g, b, N) => { const y = new Float32Array(N); for (let i = 0; i < N; i++) y[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i]; return y; };
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };

// proxy size from the frame count: bounds the analysis memory (≈ 13 float planes per frame and proxy pixel)
export function proxyPixels(n, { budgetBytes = 160e6, maxPixels = 1.5e6, minPixels = 3e5 } = {}) { return Math.min(maxPixels, Math.max(minPixels, budgetBytes / (52 * Math.max(n, 1)))); }

// ---------------- exposure / lighting normalisation ----------------
const wellExposed = (y) => ss(0.04, 0.2, y) * (1 - ss(0.88, 0.99, y));
export function referenceFrame(Ys) { let best = 0, bs = -1; Ys.forEach((y, j) => { let t = 0; for (let i = 0; i < y.length; i++) t += wellExposed(y[i]); if (t > bs) { bs = t; best = j; } }); return best; }
// ln-gain field g such that frameLinear·exp(g) matches the reference's SMOOTH lighting; robust to glare, reflections, shadows
export function lnGainField(refY, refYL, frameY, frameYL, w, h) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 160));
  const rY = E.downArea(refY, w, h, f), rL = E.downArea(refYL, w, h, f), fY = E.downArea(frameY, w, h, f), fL = E.downArea(frameYL, w, h, f), sw = rY.w, sh = rY.h, n = sw * sh;
  const lr = new Float32Array(n), valid = new Float32Array(n);
  for (let i = 0; i < n; i++) { valid[i] = Math.min(wellExposed(rY.d[i]), wellExposed(fY.d[i])); lr[i] = Math.log(rL.d[i] + 0.004) - Math.log(fL.d[i] + 0.004); }
  let global = 0; const field = new Float32Array(n), sigma = Math.max(2, 0.18 * Math.max(sw, sh));
  for (let it = 0; it < 4; it++) {
    const num = new Float32Array(n), den = new Float32Array(n); let gn = 0, gd = 0;
    for (let i = 0; i < n; i++) { const r = lr[i] - field[i], wr = 1 / (1 + (r / 0.35) * (r / 0.35)); num[i] = valid[i] * wr * lr[i]; den[i] = valid[i] * wr; gn += num[i]; gd += den[i]; }
    if (gd > 1e-3) global = gn / gd;
    const nb = E.gaussBlur(num, sw, sh, sigma), db = E.gaussBlur(den, sw, sh, sigma), eps = 0.02; // pulls towards the global value where support is thin
    for (let i = 0; i < n; i++) { const v = (nb[i] + eps * global) / (db[i] + eps); field[i] = v < -4 ? -4 : v > 4 ? 4 : v; }
  }
  return E.resizeBilinear(field, sw, sh, w, h);
}

// ---------------- tone adjustment of the extended range that repairs bring in ----------------
// Monotonic, luminance-driven, colour kept. Highlights above `knee` are compressed just far enough that the brightest repaired pixel
// lands below white; crushed shadows are lifted. Both are the identity over the range the base already shows.
export function fitTone(hi, lo) {
  const t = { knee: 1, beta: 1, shadowKnee: 0, gamma: 1 }, k = 0.62, target = 0.985;
  if (hi > target) { t.knee = k; t.beta = Math.min(1, Math.max(0.3, Math.log(target / k) / Math.log(hi / k))); }
  const f1 = 0.004; if (lo < f1 * 0.8) { t.shadowKnee = f1; t.gamma = 0.6; }
  return t;
}
export const toneIsIdentity = (t) => t.beta >= 0.999 && t.gamma >= 0.999;
export function toneMultiplier(t, v, lnRestore) {
  let m = 1;
  if (t.beta < 0.999) { const u = v / t.knee, u2 = u * u; m = Math.max(Math.pow(1 + u2 * u2, (t.beta - 1) * 0.25), Math.exp(Math.min(lnRestore, 0))); }
  if (t.gamma < 0.999) { const u = t.shadowKnee / Math.max(v, 1e-5), u2 = u * u; m *= Math.min(Math.pow(1 + u2 * u2, (1 - t.gamma) * 0.25), Math.exp(Math.max(lnRestore, 0))); }
  return m;
}

// ---------------- analysis ----------------
// prox: [{r, g, b}] display-encoded planes (w × h) of the aligned frames. Returns everything the blend needs, at proxy resolution.
export async function analyzeLighting(prox, w, h, opts = {}, hooks = {}) {
  const o = { ...DEFAULTS, ...opts }, n = prox.length, N = w * h, longSide = Math.max(w, h), tick = hooks.tick || (async () => {});
  if (n < 2) throw new Error('A lighting stack needs at least 2 photos');
  const rN = Math.max(1, Math.round(o.narrowHighlightFraction * longSide));
  // fine dark structure inside a BLOWN-OUT area must not turn an overexposed patch into "thin highlights": gaps up to ~2·rc are closed first
  const rc = Math.max(1, Math.round(0.004 * longSide));
  const dil = (p, r) => E.dilate(p, w, h, r), ero = (p, r) => E.erode(p, w, h, r), blur = (p, s) => E.gaussBlur(p, w, h, s);
  const opening = (p) => dil(ero(p, rN), rN);
  const broadRegions = (m, closing = false) => opening(closing ? ero(dil(m, rc), rc) : m);

  // Exposure / lighting normalisation: every frame is put on the reference frame's SMOOTH lighting scale, so only local anomalies
  // (glare, reflections, shadows) stand out. Clipping and exposure quality keep using the real, un-normalised values.
  const lin = prox.map((p) => ({ r: p.r.map(decode), g: p.g.map(decode), b: p.b.map(decode) }));
  const Y0 = prox.map((p) => luma(p.r, p.g, p.b, N)), YL0 = lin.map((p) => luma(p.r, p.g, p.b, N));
  const refIdx = referenceFrame(Y0);
  const scales = Y0.map((_, j) => { if (j === refIdx) return null; const g = lnGainField(Y0[refIdx], YL0[refIdx], Y0[j], YL0[j], w, h); for (let i = 0; i < N; i++) g[i] = Math.exp(g[i]); return g; });
  await tick(0.05);

  // Per-frame features
  const noise = estimateNoise(Y0[n >> 1], w, h);
  const Y = [], Yn = [], YL = [], detail = [], chromaR = [], chromaB = [], broadClip = [], broadBright = [], thinClip = [], informative = [];
  for (let j = 0; j < n; j++) {
    const p = prox[j], y = Y0[j]; Y.push(y); YL.push(YL0[j]);
    detail.push(focusMaps(p.r, p.g, p.b, w, h, { noiseSigma: noise, sigmaAgg: 2 }).focus);
    const sc = scales[j], pe = { r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
    for (let i = 0; i < N; i++) { const s = sc ? sc[i] : 1; pe.r[i] = encode(lin[j].r[i] * s); pe.g[i] = encode(lin[j].g[i] * s); pe.b[i] = encode(lin[j].b[i] * s); }
    const yn = luma(pe.r, pe.g, pe.b, N); Yn.push(yn);
    const cr = new Float32Array(N), cb = new Float32Array(N), hard = new Float32Array(N), bright = new Float32Array(N); let info = 0;
    for (let i = 0; i < N; i++) {
      const d = yn[i] + 0.1; cr[i] = (pe.r[i] - yn[i]) / d; cb[i] = (pe.b[i] - yn[i]) / d;
      const clipped = Math.max(p.r[i], p.g[i], p.b[i]) >= 0.985; hard[i] = clipped ? 1 : 0; bright[i] = y[i] >= 0.88 ? 1 : 0;
      info += ss(0.03, 0.08, y[i]) * (clipped ? 0 : 1);
    }
    chromaR.push(cr); chromaB.push(cb); informative.push(info / N);
    // opening (erode then dilate) keeps broad regions and removes anything narrower than ~2·rN: thin polished highlights are not glare
    const bc = broadRegions(hard, true); broadClip.push(bc); broadBright.push(broadRegions(bright));
    const tc = new Float32Array(N); for (let i = 0; i < N; i++) tc[i] = Math.max(0, hard[i] - bc[i]); thinClip.push(tc);
    await tick(0.05 + 0.4 * (j + 1) / n);
  }
  lin.length = 0; scales.length = 0;

  // Cross-frame references. Reflections and glare only ever ADD light, so body colour and "normal" brightness are read from the DARKEST
  // frame — except a frame lying in shadow (with >= 3 frames, a frame below half the second-darkest value is skipped).
  const yDark = new Float32Array(N), yChroma = yDark, crRef = new Float32Array(N), cbRef = new Float32Array(N), dMax = new Float32Array(N), yMed = new Float32Array(N);
  const order = new Int32Array(n);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < n; j++) order[j] = j;
    for (let a = 1; a < n; a++) { const v = order[a], vv = Yn[v][i]; let q = a - 1; while (q >= 0 && Yn[order[q]][i] > vv) { order[q + 1] = order[q]; q--; } order[q + 1] = v; }
    yMed[i] = Yn[order[n >> 1]][i];
    let refFrame = order[0];
    if (n >= 3) { const second = Yn[order[1]][i]; refFrame = order[n - 1]; for (let a = 0; a < n; a++) if (Yn[order[a]][i] >= 0.5 * second) { refFrame = order[a]; break; } }
    yDark[i] = Yn[refFrame][i]; crRef[i] = chromaR[refFrame][i]; cbRef[i] = chromaB[refFrame][i];
    let m = 0; for (let j = 0; j < n; j++) if (detail[j][i] > m) m = detail[j][i]; dMax[i] = m;
  }
  const dMaxB = blur(dMax, 2);
  await tick(0.5);

  // Per-frame quality
  const Q = [], Qv = [], Clean = [], qSigma = Math.max(0.8, longSide * 0.002); // Clean: trustworthiness only (no detail term) — used to gate focus selection
  for (let j = 0; j < n; j++) {
    // Broad regions much brighter than the darkest unshadowed frame are a wash of added light (glare tails, reflections of bright objects)
    // even when nothing clips. Thin additions are legitimate highlights and are removed by the opening, exactly as for clipped areas.
    const added = new Float32Array(N), yn = Yn[j];
    for (let i = 0; i < N; i++) { const dd = decode(yDark[i]), rel = (decode(yn[i]) - dd) / (dd + 0.06); added[i] = ss(0.5, 1.0, rel) >= 0.5 ? 1 : 0; }
    const broadAdd = opening(added), gl = new Float32Array(N);
    for (let i = 0; i < N; i++) { const excess = ss(0.04, 0.22, yn[i] - yDark[i]); gl[i] = Math.max(broadClip[j][i], broadBright[j][i] * excess, broadAdd[i]); }
    const zone = blur(dil(gl, rN), rN); // bloom: washed colour extends past the clipped core
    // Colour deviation from the darkest frame (washed-out or tinted colour); like clipping it only counts when it is BROAD
    const dev = new Float32Array(N), cr = chromaR[j], cb = chromaB[j];
    for (let i = 0; i < N; i++) {
      const conf = ss(0.03, 0.12, Math.max(yn[i], yMed[i])), dcr = cr[i] - crRef[i], dcb = cb[i] - cbRef[i];
      dev[i] = Math.sqrt(dcr * dcr + dcb * dcb) * conf * ss(0, 0.06, yn[i] - yChroma[i]);
    }
    const devBroad = opening(dev), nearWhite = new Float32Array(N);
    for (let i = 0; i < N; i++) nearWhite[i] = Y[j][i] >= 0.92 ? 1 : 0;
    const nearWhiteBroad = blur(broadRegions(nearWhite), rN), q = new Float32Array(N), qv = new Float32Array(N), qc = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const gz = Math.min(1, zone[i] * 1.25), qClip = 1 - 0.98 * gz - 0.10 * thinClip[j][i];
      const rel = (detail[j][i] + 0.15) / (dMaxB[i] + 0.15), qDetail = 0.55 + 0.45 * ss(0.15, 0.7, rel);
      const qColor = 0.03 + 0.97 * (1 - ss(0.10, 0.40, devBroad[i]));
      const qExpo = 0.06 + 0.94 * ss(0.04, 0.22, Y[j][i]); // dark regions are noisy and lack detail
      const qHigh = 1 - 0.4 * Math.min(1, nearWhiteBroad[i] * 1.2);
      let qRel = 1; // a frame much darker than the others at the same spot is shadowed or muddy there (needs >= 3 frames to tell shadow from glare)
      if (n >= 3) qRel = 0.15 + 0.85 * ss(0.12, 0.55, decode(yn[i]) / (decode(yMed[i]) + 0.01));
      qc[i] = Math.max(qClip, 0.02) * qColor * qExpo * qHigh * qRel; q[i] = qc[i] * qDetail; qv[i] = Math.max(qClip, 0.02) * qColor;
    }
    Qv.push(blur(qv, qSigma)); Q.push(blur(q, qSigma)); Clean.push(blur(qc, qSigma));
    broadClip[j] = broadBright[j] = thinClip[j] = detail[j] = chromaR[j] = chromaB[j] = null;
    await tick(0.5 + 0.3 * (j + 1) / n);
  }

  // Base frame: the cleanest (mean quality), weighted by how much of the scene it actually records (neither crushed nor clipped)
  const scores = Q.map(mean), baseScore = scores.map((s, j) => s * informative[j] * informative[j]);
  let base = 0; for (let j = 1; j < n; j++) if (baseScore[j] > baseScore[base]) base = j;
  if (o.preferredBase !== null && o.preferredBase >= 0 && o.preferredBase < n) base = o.preferredBase;

  // Replacement weights: a frame replaces the base only where its quality beats the base's by a margin; donors share by Q^power
  const [m0, m1] = o.replaceMargin, weights = Array.from({ length: n }, () => new Float32Array(N)), u = new Float32Array(n);
  for (let i = 0; i < N; i++) {
    const qb = Q[base][i]; let rMax = 0, norm = 0;
    for (let j = 0; j < n; j++) { if (j === base) continue; const a = ss(m0, m1, Q[j][i] - qb); if (a > rMax) rMax = a; u[j] = a * Math.pow(Math.max(Q[j][i], 1e-4), o.qualityPower); norm += u[j]; }
    for (let j = 0; j < n; j++) if (j !== base) weights[j][i] = norm > 0 ? (rMax * u[j]) / norm : 0;
    weights[base][i] = 1 - rMax;
  }
  // spatial coherence: drop specks, then edge-aware smoothing guided by the base's own structure
  const replaceMass = new Float32Array(N);
  for (let j = 0; j < n; j++) if (j !== base) for (let i = 0; i < N; i++) replaceMass[i] += weights[j][i];
  const cleaned = blur(replaceMass, Math.max(1.0, longSide * 0.004)); for (let i = 0; i < N; i++) cleaned[i] = ss(0.2, 0.7, cleaned[i]);
  for (let i = 0; i < N; i++) if (replaceMass[i] > 1e-6) { const s = Math.min(replaceMass[i], cleaned[i]) / replaceMass[i]; for (let j = 0; j < n; j++) if (j !== base) weights[j][i] *= s; }
  const gr = Math.max(2, Math.floor(longSide * 0.008));
  for (let j = 0; j < n; j++) if (j !== base) { const f = E.guidedFilter(Y[base], weights[j], w, h, gr, 2e-3); for (let i = 0; i < N; i++) f[i] = clamp01(f[i]); weights[j] = f; }
  for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < n; j++) if (j !== base) s += weights[j][i]; if (s > 1) { for (let j = 0; j < n; j++) if (j !== base) weights[j][i] /= s; s = 1; } weights[base][i] = 1 - s; }
  await tick(0.85);

  // Lighting match: a smooth multiplicative gain bringing frame j's lighting and exposure in line with the base's. Broad part: robust field over
  // well-exposed pixels of both frames. Local part: residual estimated only where BOTH frames are trustworthy, extrapolated smoothly into the defect.
  const gains = Array.from({ length: n }, () => null), lnGains = Array.from({ length: n }, () => null);
  if (o.matchLocalLighting) {
    const sg = Math.max(2, longSide * o.gainSigmaFraction);
    for (let j = 0; j < n; j++) {
      if (j === base) continue;
      const broad = lnGainField(Y[base], YL[base], Y[j], YL[j], w, h), num = new Float32Array(N), den = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const vb = YL[base][i], vj = YL[j][i];
        const sb = ss(0.002, 0.012, vb) * (1 - ss(0.8, 0.95, vb)), sj = ss(0.002, 0.012, vj) * (1 - ss(0.8, 0.95, vj));
        const trust = ss(0.3, 0.7, Qv[j][i]) * ss(0.3, 0.7, Qv[base][i]) * sb * sj;
        const r = Math.log(vb + 0.002) - Math.log(vj + 0.002) - broad[i];
        num[i] = trust * (r < -1.5 ? -1.5 : r > 1.5 ? 1.5 : r); den[i] = trust;
      }
      const nb = blur(num, sg), db = blur(den, sg), g = new Float32Array(N), lg = new Float32Array(N);
      for (let i = 0; i < N; i++) { let r = broad[i] + nb[i] / (db[i] + 0.02); r = r < -4.2 ? -4.2 : r > 4.2 ? 4.2 : r; lg[i] = r; g[i] = Math.exp(r); }
      gains[j] = g; lnGains[j] = lg;
    }
  }
  // Tone adjustment: content brought in from a better exposed frame sits on the base's scale, so a recovered highlight lies ABOVE white and a
  // recovered shadow far below black. Only that extended range is compressed / lifted, only where a repair happened.
  const restore = new Float32Array(N), repaired = new Float32Array(N); let tone = { knee: 1, beta: 1, shadowKnee: 0, gamma: 1 };
  if (o.matchLocalLighting) {
    const sl = Math.max(1.5, longSide * 0.012);
    for (let j = 0; j < n; j++) { if (j === base) continue; const ws = blur(weights[j], sl); for (let i = 0; i < N; i++) { restore[i] -= ws[i] * lnGains[j][i]; repaired[i] += ws[i]; } }
    for (let i = 0; i < N; i++) repaired[i] = clamp01(repaired[i]);
    const vals = [];
    for (let i = 0; i < N; i++) if (repaired[i] > 0.5) { let v = weights[base][i] * YL[base][i]; for (let j = 0; j < n; j++) if (j !== base) v += weights[j][i] * gains[j][i] * YL[j][i]; vals.push(v); }
    if (vals.length >= Math.max(50, N / 2000)) { const s = Float32Array.from(vals).sort(); tone = fitTone(s[Math.min(s.length - 1, Math.floor(s.length * 0.97))], s[Math.floor(s.length * 0.03)]); }
  }
  await tick(1);
  return { n, w, h, base, scores, quality: Q, clean: Clean, weights, gains, restore, repaired, tone, options: o, contribution: weights.map(mean) };
}

// ---------------- blend (one tile) ----------------
// A: analysis; L: pyramid bands; (aw × ah): the tile incl. its halo.
// frameLin(j) → fresh [r, g, b] linear Float32Arrays (aw·ah) of the ALIGNED frame j over the tile (the caller owns them; they are modified).
// up(plane) → the proxy plane resampled to the tile (aw·ah).
// Returns linear planes {r, g, b}. Everything is blended in LOG light: a few percent of gain mismatch beside a bright region is far more
// than a dark band next to it contains in linear light, but in log light a mismatch is always relative to the pixel it lands on.
export async function blendTile(A, L, aw, ah, frameLin, up, { override = null, tick = null } = {}) {
  const n = A.n, base = A.base, AN = aw * ah, eps = LOG_FLOOR;
  const sizes = E.gaussPyr(new Float32Array(AN), aw, ah, L).map((g) => ({ w: g.w, h: g.h }));
  const used = Array.from({ length: n }, (_, j) => j !== base && A.weights[j].some((v) => v > 0.002));
  const wPyr = new Array(n).fill(null), wFull = new Array(n).fill(null), replaceSum = sizes.map((s) => new Float32Array(s.w * s.h));
  // retouch: painted pixels take their frame (alpha-mixed) — a donor that was only painted in, never chosen by the analysis, still takes part
  const ovFrames = new Set(); if (override) for (let i = 0; i < AN; i++) if (override.a[i] > 0 && override.k[i] >= 0) ovFrames.add(override.k[i]);
  for (let j = 0; j < n; j++) {
    const viaOv = j !== base && ovFrames.has(j);
    if (!used[j] && !viaOv) continue;
    const wf = used[j] ? up(A.weights[j]) : new Float32Array(AN);
    if (override) for (let i = 0; i < AN; i++) { const a = override.a[i]; if (a > 0) { const k = override.k[i]; if (k < 0) continue; wf[i] = k === j ? wf[i] + (1 - wf[i]) * a : wf[i] * (1 - a); } }
    let any = false; for (let i = 0; i < AN; i++) if (wf[i] >= 1e-5) { any = true; break; }
    if (!any) continue;
    wFull[j] = wf;
    const qp = up(A.quality[j]); if (viaOv) for (let i = 0; i < AN; i++) if (override.k[i] === j && override.a[i] > qp[i]) qp[i] = override.a[i];
    const lv = E.gaussPyr(wf, aw, ah, L).map((g) => g.d), ql = E.gaussPyr(qp, aw, ah, L);
    // At coarse levels the Gaussian-blurred mask would let some of the base's low-frequency contamination (a tint, a glare wash) leak into the
    // middle of a defect only a few transition-widths wide, so coarse replacement masks are dilated; a donor may only spread where it is itself
    // trustworthy at that scale (its own glare / tint must not leak into the defect it is meant to repair).
    for (let l = 1; l <= L; l++) {
      const { w: lw, h: lh } = sizes[l], trust = ql[l].d, d = E.boxBlur(E.dilate(lv[l], lw, lh, l >= 3 ? 3 : 2), lw, lh, 1);
      for (let i = 0; i < d.length; i++) d[i] = Math.min(d[i] * ss(0.3, 0.6, trust[i]) * 1.6, 1);
      lv[l] = d;
    }
    wPyr[j] = lv; for (let l = 0; l <= L; l++) { const a = replaceSum[l], b = lv[l]; for (let i = 0; i < a.length; i++) a[i] += b[i]; }
  }
  for (let l = 0; l <= L; l++) for (let i = 0; i < replaceSum[l].length; i++) if (replaceSum[l][i] > 1) { const inv = 1 / replaceSum[l][i]; for (let j = 0; j < n; j++) if (wPyr[j]) wPyr[j][l][i] *= inv; }

  const bl = await frameLin(base), baseLog = bl.map((p) => { const o = new Float32Array(AN); for (let i = 0; i < AN; i++) o[i] = Math.log(p[i] + eps); return o; });
  const acc = [0, 1, 2].map(() => sizes.map((s) => new Float32Array(s.w * s.h)));
  for (let j = 0; j < n; j++) {
    if (!wPyr[j]) continue;
    const lin = await frameLin(j), g = up(A.gains[j] || new Float32Array(A.w * A.h).fill(1)), m = wFull[j];
    for (let c = 0; c < 3; c++) {
      // The difference is taken only inside the donor's own support, so nothing from the donor outside it (its own clipped, glared or tinted
      // surroundings) can leak into a narrow repair through the coarse bands.
      const p = lin[c], d = new Float32Array(AN), bLog = baseLog[c];
      for (let i = 0; i < AN; i++) { const sup = m[i] * 4 > 1 ? 1 : m[i] * 4; d[i] = sup * (Math.log(p[i] * g[i] + eps) - bLog[i]); }
      const pyr = E.lapPyr(d, aw, ah, L);
      for (let l = 0; l <= L; l++) { const a = acc[c][l], q = pyr[l].d, wp = wPyr[j][l]; for (let i = 0; i < a.length; i++) a[i] += q[i] * wp[i]; }
    }
  }
  const out = [0, 1, 2].map((c) => {
    const fused = E.collapse(acc[c].map((a, l) => ({ d: a, w: sizes[l].w, h: sizes[l].h }))), o = new Float32Array(AN);
    for (let i = 0; i < AN; i++) { const v = Math.exp(baseLog[c][i] + fused[i]) - eps; o[i] = v > 0 ? v : 0; }
    return o;
  });
  // extended-range tone adjustment (only where a repair brought in highlights above white / shadows below black)
  if (A.options.matchLocalLighting && !toneIsIdentity(A.tone)) {
    const rs = up(A.restore), gate = up(A.repaired), y = E.gaussBlur(luma(out[0], out[1], out[2], AN), aw, ah, 1);
    for (let i = 0; i < AN; i++) {
      if (gate[i] <= 0.2) continue;
      const mm = toneMultiplier(A.tone, y[i], rs[i]); if (mm === 1) continue;
      const k = Math.pow(mm, ss(0.2, 0.7, gate[i])); out[0][i] *= k; out[1][i] *= k; out[2][i] *= k;
    }
  }
  return { r: out[0], g: out[1], b: out[2] };
}

// Convenience for tests and the Node harness: analyse + blend whole-frame (single tile). frames: [{r,g,b}] display-encoded, same size.
export async function lightStackImage(frames, w, h, opts = {}) {
  const N = w * h, A = await analyzeLighting(frames, w, h, opts), lin = frames.map((f) => ({ r: f.r.map(decode), g: f.g.map(decode), b: f.b.map(decode) }));
  const out = await blendTile(A, opts.levels || DEFAULTS.levels, w, h, (j) => [lin[j].r.slice(), lin[j].g.slice(), lin[j].b.slice()], (plane) => plane);
  const enc = { w, h, r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
  for (let i = 0; i < N; i++) { enc.r[i] = encode(out.r[i]); enc.g[i] = encode(out.g[i]); enc.b[i] = encode(out.b[i]); }
  return { img: enc, A };
}
