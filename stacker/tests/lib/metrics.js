// metrics.js — image-quality measures on planar Float32 RGB images (see synth.js). Rect = {x, y, w, h}.
import { lumaOf, toLinear, toEncoded, makeImg } from './synth.js';

const full = (a) => ({ x: 0, y: 0, w: a.w, h: a.h });
export function mse(a, b, rect = full(a)) {
  let s = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    const i = y * a.w + x, dr = a.r[i] - b.r[i], dg = a.g[i] - b.g[i], db = a.b[i] - b.b[i]; s += (dr * dr + dg * dg + db * db) / 3; n++;
  }
  return n ? s / n : 0;
}
export const psnr = (a, b, rect) => { const m = mse(a, b, rect); return m <= 1e-12 ? 99 : -10 * Math.log10(m); };
// mean gradient magnitude of luma (central differences, edge replicate) — a crude sharpness number
export function sharpness(img, rect = full(img)) {
  const y = lumaOf(img), { w, h } = img; let s = 0, n = 0;
  for (let j = rect.y; j < rect.y + rect.h; j++) for (let i = rect.x; i < rect.x + rect.w; i++) {
    const gx = (y[j * w + Math.min(w - 1, i + 1)] - y[j * w + Math.max(0, i - 1)]) * 0.5, gy = (y[Math.min(h - 1, j + 1) * w + i] - y[Math.max(0, j - 1) * w + i]) * 0.5; s += Math.hypot(gx, gy); n++;
  }
  return n ? s / n : 0;
}
export function meanLuma(img, rect) { const y = lumaOf(img); let s = 0, n = 0; for (let j = rect.y; j < rect.y + rect.h; j++) for (let i = rect.x; i < rect.x + rect.w; i++) { s += y[j * img.w + i]; n++; } return s / n; }
export function maxLuma(img, rect) { const y = lumaOf(img); let m = 0; for (let j = rect.y; j < rect.y + rect.h; j++) for (let i = rect.x; i < rect.x + rect.w; i++) m = Math.max(m, y[j * img.w + i]); return m; }
export function meanColor(img, rect) { let r = 0, g = 0, b = 0, n = 0; for (let j = rect.y; j < rect.y + rect.h; j++) for (let i = rect.x; i < rect.x + rect.w; i++) { const k = j * img.w + i; r += img.r[k]; g += img.g[k]; b += img.b[k]; n++; } return [r / n, g / n, b / n]; }
// PSNR against `ideal` after one global linear-light gain fit (a fused picture may be globally brighter or darker)
export function fitPSNR(a, ideal, rect) {
  const la = toLinear(a), lb = toLinear(ideal); let num = 0, den = 0;
  for (const c of ['r', 'g', 'b']) for (let i = 0; i < la.r.length; i++) { num += la[c][i] * lb[c][i]; den += la[c][i] * la[c][i]; }
  const g = num / Math.max(den, 1e-9), s = makeImg(a.w, a.h);
  for (const c of ['r', 'g', 'b']) for (let i = 0; i < la.r.length; i++) s[c][i] = la[c][i] * g;
  return psnr(toEncoded(s), ideal, rect);
}
// shares of clipped / crushed / well-exposed pixels
export function exposureShares(img) {
  const y = lumaOf(img); let c = 0, k = 0, g = 0;
  for (let i = 0; i < y.length; i++) { if (Math.max(img.r[i], img.g[i], img.b[i]) >= 0.985) c++; if (y[i] <= 0.05) k++; if (y[i] >= 0.12 && y[i] <= 0.88) g++; }
  return { clipped: c / y.length, crushed: k / y.length, good: g / y.length };
}
// edge-band error: mean squared error only within `r` px of strong edges of the truth (where halos / seams live)
export function edgeBandMSE(a, truth, r = 3, thr = 0.08) {
  const y = lumaOf(truth), { w, h } = truth, band = new Uint8Array(w * h);
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const gx = (y[j * w + i + 1] - y[j * w + i - 1]) * 0.5, gy = (y[(j + 1) * w + i] - y[(j - 1) * w + i]) * 0.5;
    if (Math.hypot(gx, gy) > thr) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const jj = j + dj, ii = i + di; if (jj >= 0 && jj < h && ii >= 0 && ii < w) band[jj * w + ii] = 1; }
  }
  let s = 0, n = 0;
  for (let i = 0; i < w * h; i++) if (band[i]) { const dr = a.r[i] - truth.r[i], dg = a.g[i] - truth.g[i], db = a.b[i] - truth.b[i]; s += (dr * dr + dg * dg + db * db) / 3; n++; }
  return n ? -10 * Math.log10(Math.max(s / n, 1e-12)) : 99;
}
