// focusmap.js — multi-signal local focus measure (pure JS, planar Float32, no DOM).
// No single metric is trusted: fine modified Laplacian, colour gradient (so hue-only band edges count), band-pass
// energy at two scales and local contrast are each RMS-aggregated over a small window, corrected by a calibrated
// noise floor, scaled by fixed constants (so every region is measured identically, no seams) and combined.
// Ported from the Swift SpecimenCore FocusMapBuilder, where it is covered by ground-truth tests.
import * as E from './engine.js';

const SCALES = [0.20, 0.15, 0.06, 0.05, 0.12]; // roughly the response of a crisp, moderately contrasty edge region
const WTS = [0.30, 0.25, 0.20, 0.15, 0.10]; // modified Laplacian, gradient, fine band, medium band, local contrast
const FLOOR_FACTOR = 1.6;
const rmsAggregate = (a, w, h, sigma) => { const sq = new Float32Array(a.length); for (let i = 0; i < a.length; i++) sq[i] = a[i] * a[i]; const g = E.gaussBlur(sq, w, h, sigma); for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i] > 0 ? g[i] : 0); return g; };

// RMS-aggregated signal planes (display-encoded input): [modLaplacian, colourGradient, bandFine, bandMedium, localContrast]
export function signals(r, g, b, w, h, sigmaAgg = 2) {
  const N = w * h, y = new Float32Array(N);
  for (let i = 0; i < N; i++) y[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
  const ml = new Float32Array(N), gr = new Float32Array(N);
  for (let yy = 0; yy < h; yy++) {
    const y1 = yy > 0 ? yy - 1 : 0, y2 = yy < h - 1 ? yy + 1 : h - 1, y3 = yy > 1 ? yy - 2 : 0, y4 = yy < h - 2 ? yy + 2 : h - 1;
    for (let xx = 0; xx < w; xx++) {
      const x1 = xx > 0 ? xx - 1 : 0, x2 = xx < w - 1 ? xx + 1 : w - 1, x3 = xx > 1 ? xx - 2 : 0, x4 = xx < w - 2 ? xx + 2 : w - 1, o = yy * w + xx, c = 2 * y[o];
      const a1 = Math.abs(c - y[yy * w + x1] - y[yy * w + x2]) + Math.abs(c - y[y1 * w + xx] - y[y2 * w + xx]);
      const a2 = Math.abs(c - y[yy * w + x3] - y[yy * w + x4]) + Math.abs(c - y[y3 * w + xx] - y[y4 * w + xx]);
      ml[o] = 0.5 * (a1 + 0.7 * a2);
      let e = 0;
      for (let k = 0; k < 3; k++) {
        const ch = k === 0 ? r : k === 1 ? g : b;
        const gx = ch[y1 * w + x2] + 2 * ch[yy * w + x2] + ch[y2 * w + x2] - (ch[y1 * w + x1] + 2 * ch[yy * w + x1] + ch[y2 * w + x1]);
        const gy = ch[y2 * w + x1] + 2 * ch[y2 * w + xx] + ch[y2 * w + x2] - (ch[y1 * w + x1] + 2 * ch[y1 * w + xx] + ch[y1 * w + x2]);
        e += gx * gx + gy * gy;
      }
      gr[o] = Math.sqrt(e / 3) * 0.125;
    }
  }
  const g08 = E.gaussBlur(y, w, h, 0.8), g16 = E.gaussBlur(y, w, h, 1.6), g32 = E.gaussBlur(y, w, h, 3.2);
  const bf = new Float32Array(N), bm = new Float32Array(N);
  for (let i = 0; i < N; i++) { bf[i] = g08[i] - g16[i]; bm[i] = g16[i] - g32[i]; }
  const y2 = new Float32Array(N); for (let i = 0; i < N; i++) y2[i] = y[i] * y[i];
  const mean2 = E.gaussBlur(y, w, h, 2), meanSq2 = E.gaussBlur(y2, w, h, 2), lc = new Float32Array(N);
  for (let i = 0; i < N; i++) { const v = meanSq2[i] - mean2[i] * mean2[i]; lc[i] = Math.sqrt(v > 0 ? v : 0); }
  return [ml, gr, bf, bm, lc].map((a) => rmsAggregate(a, w, h, sigmaAgg));
}

// Mean response of the five signals to unit white noise (interior only): a noise floor is this × 1.6 × the image's noise σ.
const unitCache = new Map();
function unitResponse(sigmaAgg) {
  if (unitCache.has(sigmaAgg)) return unitCache.get(sigmaAgg);
  const S = 96, rnd = E.mulberry(12345), gauss = () => { const u1 = Math.max(rnd(), 1e-7), u2 = rnd(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
  const ch = [0, 1, 2].map(() => { const a = new Float32Array(S * S); for (let i = 0; i < a.length; i++) a[i] = gauss(); return a; });
  const sig = signals(ch[0], ch[1], ch[2], S, S, sigmaAgg);
  const means = sig.map((s) => { let acc = 0, n = 0; for (let y = 16; y < S - 16; y++) for (let x = 16; x < S - 16; x++) { acc += s[y * S + x]; n++; } return acc / n; });
  unitCache.set(sigmaAgg, means); return means;
}

// Immerkær fast noise estimate (σ of white noise, display-encoded domain) from a luma plane; median based.
export function estimateNoise(y, w, h) {
  const vals = new Float32Array(Math.ceil((w - 2) * (h - 2) / 3) + 1); let n = 0, t = 0;
  for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
    if (t++ % 3) continue;
    const o = yy * w + xx, v = y[o - w - 1] - 2 * y[o - w] + y[o - w + 1] - 2 * y[o - 1] + 4 * y[o] - 2 * y[o + 1] + y[o + w - 1] - 2 * y[o + w] + y[o + w + 1];
    vals[n++] = Math.abs(v);
  }
  return Math.max(0.0005, E.quantile(vals.subarray(0, n), 0.5) / (0.6745 * 6));
}

// focus: all signals combined (≥ 0; ≈ 0 for blur or flat, larger for crisp detail).
// fine:  only the finest-scale signals. Defocus *bleed* (a blurred bright neighbour leaking into a flat area) carries energy at
//        medium scales but almost none at the finest, so `fine` is what flat regions may safely inherit.
export function focusMaps(r, g, b, w, h, { noiseSigma, sigmaAgg = 2 }) {
  const sig = signals(r, g, b, w, h, sigmaAgg), unit = unitResponse(sigmaAgg), N = w * h, nz = Math.max(noiseSigma, 1e-4);
  const floors = unit.map((m) => m * FLOOR_FACTOR * nz), focus = new Float32Array(N), fine = new Float32Array(N);
  for (let k = 0; k < 5; k++) {
    const s = sig[k], f = floors[k], sc = SCALES[k], wt = WTS[k], wf = k === 0 ? 0.6 : k === 2 ? 0.4 : 0;
    for (let i = 0; i < N; i++) { const v = s[i] - f; if (v > 0) { focus[i] += (wt * v) / sc; if (wf) fine[i] += (wf * v) / sc; } }
  }
  return { focus, fine };
}
