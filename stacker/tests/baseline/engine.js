// engine.js — image-processing primitives (planar Float32, pure JS, no DOM).
// Runs in a Web Worker in the app and in Node for the test harness.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------- transfer curves ----------
export const LUT8 = new Float32Array(256);
for (let i = 0; i < 256; i++) { const v = i / 255; LUT8[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
let _lut16 = null;
export function lut16() { // 16-bit sRGB-encoded -> linear
  if (!_lut16) { _lut16 = new Float32Array(65536); for (let i = 0; i < 65536; i++) { const v = i / 65535; _lut16[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } }
  return _lut16;
}
export function linToSrgb(v) { if (v <= 0) return 0; if (v >= 1) return 1; return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
// fast OETF via table on [0,1]
const OETF_N = 4096; const OETF = new Float32Array(OETF_N + 1);
for (let i = 0; i <= OETF_N; i++) OETF[i] = linToSrgb(i / OETF_N);
export function oetfFast(v) { if (v <= 0) return 0; if (v >= 1) return 1; const f = v * OETF_N, i = f | 0, t = f - i; return OETF[i] + (OETF[i + 1] - OETF[i]) * t; }
// fast gamma P = x^(1/2.2) via sqrt-domain table (smooth near 0), and its inverse
const GN = 4096; const GT = new Float32Array(GN + 2), GI = new Float32Array(GN + 2);
for (let i = 0; i <= GN + 1; i++) { const t = i / GN; GT[i] = Math.pow(t, 2 / 2.2); GI[i] = Math.pow(t, 2.2); }
export function gammaFast(x) { if (x <= 0) return 0; if (x >= 1) return Math.pow(x, 1 / 2.2); const f = Math.sqrt(x) * GN, i = f | 0; return GT[i] + (GT[i + 1] - GT[i]) * (f - i); }
export function degammaFast(v) { if (v <= 0) return 0; if (v >= 1) return Math.pow(v, 2.2); const f = v * GN, i = f | 0; return GI[i] + (GI[i + 1] - GI[i]) * (f - i); }
export function eotf(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

// ---------- filters ----------
// Box mean with radius r (window 2r+1), edges normalised by valid count. O(N).
export function boxBlur(src, w, h, r, dst, tmp) {
  r = Math.max(0, Math.round(r));
  dst = dst || new Float32Array(w * h); tmp = tmp || new Float32Array(w * h);
  if (r === 0) { dst.set(src); return dst; }
  // horizontal
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0, n = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { s += src[o + x]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / n;
      const add = x + r + 1, rem = x - r;
      if (add < w) { s += src[o + add]; n++; }
      if (rem >= 0) { s -= src[o + rem]; n--; }
    }
  }
  // vertical (column sums in a row buffer for cache friendliness)
  const acc = new Float64Array(w); const cnt = new Int32Array(1);
  acc.fill(0); let n = 0;
  for (let y = 0; y <= Math.min(r, h - 1); y++) { const o = y * w; for (let x = 0; x < w; x++) acc[x] += tmp[o + x]; n++; }
  for (let y = 0; y < h; y++) {
    const o = y * w, inv = 1 / n;
    for (let x = 0; x < w; x++) dst[o + x] = acc[x] * inv;
    const add = y + r + 1, rem = y - r;
    if (add < h) { const oa = add * w; for (let x = 0; x < w; x++) acc[x] += tmp[oa + x]; n++; }
    if (rem >= 0) { const or = rem * w; for (let x = 0; x < w; x++) acc[x] -= tmp[or + x]; n--; }
  }
  cnt[0] = 0;
  return dst;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma)); const k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s; return k;
}
export function gaussBlur(src, w, h, sigma, dst) {
  dst = dst || new Float32Array(w * h);
  if (sigma <= 0.01) { dst.set(src); return dst; }
  if (sigma > 2.5) { // 3-pass box approximation (Kovesi)
    const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1); let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--; const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4); const m = Math.round(mIdeal);
    const tmp = new Float32Array(w * h), a = new Float32Array(w * h);
    let cur = src;
    for (let i = 0; i < n; i++) { const bw = i < m ? wl : wu; const out = i === n - 1 ? dst : (i % 2 === 0 ? a : dst); boxBlur(cur, w, h, (bw - 1) / 2, out, tmp); cur = out; }
    return dst;
  }
  const k = gaussKernel(sigma), r = (k.length - 1) >> 1; const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= r && x < w - r) { for (let i = -r; i <= r; i++) s += k[i + r] * src[o + x + i]; }
      else { for (let i = -r; i <= r; i++) { let xx = x + i; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx; s += k[i + r] * src[o + xx]; } }
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    if (y >= r && y < h - r) {
      for (let x = 0; x < w; x++) dst[o + x] = 0;
      for (let i = -r; i <= r; i++) { const kk = k[i + r], oo = (y + i) * w; for (let x = 0; x < w; x++) dst[o + x] += kk * tmp[oo + x]; }
    } else {
      for (let x = 0; x < w; x++) dst[o + x] = 0;
      for (let i = -r; i <= r; i++) { let yy = y + i; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy; const kk = k[i + r], oo = yy * w; for (let x = 0; x < w; x++) dst[o + x] += kk * tmp[oo + x]; }
    }
  }
  return dst;
}

export function laplacian(src, w, h, dst) {
  dst = dst || new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1, c = src[y * w + x];
      dst[y * w + x] = src[y * w + xm] + src[y * w + xp] + src[ym * w + x] + src[yp * w + x] - 4 * c;
    }
  }
  return dst;
}

// Guided filter (He et al.). I guide, p input. Box radius r, regulariser eps.
export function guidedFilter(I, p, w, h, r, eps, meanI, varI) {
  const N = w * h, tmp = new Float32Array(N);
  if (!meanI) { meanI = boxBlur(I, w, h, r, null, tmp); }
  if (!varI) { const II = new Float32Array(N); for (let i = 0; i < N; i++) II[i] = I[i] * I[i]; varI = boxBlur(II, w, h, r, null, tmp); for (let i = 0; i < N; i++) varI[i] -= meanI[i] * meanI[i]; }
  const meanP = boxBlur(p, w, h, r, null, tmp);
  const Ip = new Float32Array(N); for (let i = 0; i < N; i++) Ip[i] = I[i] * p[i];
  const meanIp = boxBlur(Ip, w, h, r, null, tmp);
  const a = Ip, b = meanIp; // reuse
  for (let i = 0; i < N; i++) { const cov = meanIp[i] - meanI[i] * meanP[i]; const ai = cov / (varI[i] + eps); a[i] = ai; b[i] = meanP[i] - ai * meanI[i]; }
  const ma = boxBlur(a, w, h, r, null, tmp), mb = boxBlur(b, w, h, r, meanP, tmp);
  for (let i = 0; i < N; i++) ma[i] = ma[i] * I[i] + mb[i];
  return ma;
}
export function guideStats(I, w, h, r) {
  const N = w * h, tmp = new Float32Array(N);
  const meanI = boxBlur(I, w, h, r, null, tmp);
  const II = new Float32Array(N); for (let i = 0; i < N; i++) II[i] = I[i] * I[i];
  const varI = boxBlur(II, w, h, r, null, tmp); for (let i = 0; i < N; i++) varI[i] -= meanI[i] * meanI[i];
  return { meanI, varI };
}

// ---------- pyramids (Burt–Adelson 5-tap, reflect-101 borders) ----------
function refl(k, n) { if (n === 1) return 0; while (k < 0 || k >= n) { if (k < 0) k = -k; if (k >= n) k = 2 * n - 2 - k; } return k; }
export function pyrDown(src, w, h) {
  const nw = (w + 1) >> 1, nh = (h + 1) >> 1;
  const tmp = new Float32Array(nw * h), out = new Float32Array(nw * nh);
  const ix = new Int32Array(nw * 5); for (let X = 0; X < nw; X++) for (let k = 0; k < 5; k++) ix[X * 5 + k] = refl(2 * X + k - 2, w);
  for (let y = 0; y < h; y++) {
    const o = y * w, oo = y * nw;
    for (let X = 0; X < nw; X++) { const j = X * 5; tmp[oo + X] = (src[o + ix[j]] + 4 * src[o + ix[j + 1]] + 6 * src[o + ix[j + 2]] + 4 * src[o + ix[j + 3]] + src[o + ix[j + 4]]) * 0.0625; }
  }
  for (let Y = 0; Y < nh; Y++) {
    const a = refl(2 * Y - 2, h) * nw, b = refl(2 * Y - 1, h) * nw, c = refl(2 * Y, h) * nw, d = refl(2 * Y + 1, h) * nw, e = refl(2 * Y + 2, h) * nw, o = Y * nw;
    for (let X = 0; X < nw; X++) out[o + X] = (tmp[a + X] + 4 * tmp[b + X] + 6 * tmp[c + X] + 4 * tmp[d + X] + tmp[e + X]) * 0.0625;
  }
  return out;
}
// expand coarse (cw x ch) to (tw x th)
export function pyrUp(src, cw, ch, tw, th, dst) {
  const tmp = new Float32Array(tw * ch); dst = dst || new Float32Array(tw * th);
  const ia = new Int32Array(tw), ib = new Int32Array(tw), ic = new Int32Array(tw);
  for (let x = 0; x < tw; x++) { const X = x >> 1; if ((x & 1) === 0) { ia[x] = refl(X - 1, cw); ib[x] = refl(X, cw); ic[x] = refl(X + 1, cw); } else { ia[x] = refl(X, cw); ib[x] = refl(X + 1, cw); ic[x] = -1; } }
  for (let y = 0; y < ch; y++) {
    const o = y * cw, oo = y * tw;
    for (let x = 0; x < tw; x++) tmp[oo + x] = ic[x] >= 0 ? (src[o + ia[x]] + 6 * src[o + ib[x]] + src[o + ic[x]]) * 0.125 : (src[o + ia[x]] + src[o + ib[x]]) * 0.5;
  }
  for (let y = 0; y < th; y++) {
    const Y = y >> 1, o = y * tw;
    if ((y & 1) === 0) { const a = refl(Y - 1, ch) * tw, b = refl(Y, ch) * tw, c = refl(Y + 1, ch) * tw; for (let x = 0; x < tw; x++) dst[o + x] = (tmp[a + x] + 6 * tmp[b + x] + tmp[c + x]) * 0.125; }
    else { const a = refl(Y, ch) * tw, b = refl(Y + 1, ch) * tw; for (let x = 0; x < tw; x++) dst[o + x] = (tmp[a + x] + tmp[b + x]) * 0.5; }
  }
  return dst;
}
export function gaussPyr(src, w, h, levels) {
  const out = [{ d: src, w, h }];
  for (let l = 1; l <= levels; l++) { const p = out[l - 1]; out.push({ d: pyrDown(p.d, p.w, p.h), w: (p.w + 1) >> 1, h: (p.h + 1) >> 1 }); }
  return out;
}
// Laplacian pyramid: levels detail bands + residual at index `levels`
export function lapPyr(src, w, h, levels) {
  const g = gaussPyr(src, w, h, levels);
  for (let l = 0; l < levels; l++) {
    const up = pyrUp(g[l + 1].d, g[l + 1].w, g[l + 1].h, g[l].w, g[l].h);
    const d = new Float32Array(g[l].d.length); const s = g[l].d;
    for (let i = 0; i < d.length; i++) d[i] = s[i] - up[i];
    g[l] = { d, w: g[l].w, h: g[l].h };
  }
  return g;
}
export function collapse(pyr) {
  let cur = pyr[pyr.length - 1].d;
  for (let l = pyr.length - 2; l >= 0; l--) {
    const p = pyr[l], c = pyr[l + 1];
    const up = pyrUp(cur, c.w, c.h, p.w, p.h);
    for (let i = 0; i < up.length; i++) up[i] += p.d[i];
    cur = up;
  }
  return cur;
}

// ---------- resampling ----------
export function sampleBilinear(src, w, h, x, y) {
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1) x = w - 1; if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = x - x0, fy = y - y0;
  const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
export function resizeBilinear(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) { const fy = (y + 0.5) * sy - 0.5; for (let x = 0; x < nw; x++) out[y * nw + x] = sampleBilinear(src, w, h, (x + 0.5) * sx - 0.5, fy); }
  return out;
}
// integer area downscale by factor f
export function downArea(src, w, h, f) {
  const nw = Math.ceil(w / f), nh = Math.ceil(h / f), out = new Float32Array(nw * nh), cnt = new Float32Array(nw * nh);
  for (let y = 0; y < h; y++) { const Y = (y / f) | 0; for (let x = 0; x < w; x++) { const i = Y * nw + ((x / f) | 0); out[i] += src[y * w + x]; cnt[i]++; } }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i];
  return { d: out, w: nw, h: nh };
}
// Warp plane by affine M (dst coords -> src coords): [a,b,c,d,e,f] => xs=a*x+b*y+c, ys=d*x+e*y+f
export function warpAffine(src, w, h, M, ow, oh, out, valid) {
  out = out || new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const xs = M[0] * x + M[1] * y + M[2], ys = M[3] * x + M[4] * y + M[5];
    out[y * ow + x] = sampleBilinear(src, w, h, xs, ys);
    if (valid) valid[y * ow + x] = (xs >= -0.5 && ys >= -0.5 && xs <= w - 0.5 && ys <= h - 0.5) ? 1 : 0;
  }
  return out;
}
export function cubicW(t) { // Catmull-Rom weights for offsets -1,0,1,2
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) * 0.5, (3 * t3 - 5 * t2 + 2) * 0.5, (-3 * t3 + 4 * t2 + t) * 0.5, (t3 - t2) * 0.5];
}

// ---------- stats ----------
export function quantile(arr, q, stride = 1) {
  const n = Math.floor(arr.length / stride); const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = arr[i * stride];
  a.sort(); return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))] : 0;
}
export function medianOf(list) { const a = Float64Array.from(list).sort(); const n = a.length; if (!n) return 0; return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]); }

// ---------- FFT phase correlation ----------
function fft1(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } }
  }
}
function fft2(re, im, n, inv) {
  const r = new Float64Array(n), i2 = new Float64Array(n);
  for (let y = 0; y < n; y++) { for (let x = 0; x < n; x++) { r[x] = re[y * n + x]; i2[x] = im[y * n + x]; } fft1(r, i2, inv); for (let x = 0; x < n; x++) { re[y * n + x] = r[x]; im[y * n + x] = i2[x]; } }
  for (let x = 0; x < n; x++) { for (let y = 0; y < n; y++) { r[y] = re[y * n + x]; i2[y] = im[y * n + x]; } fft1(r, i2, inv); for (let y = 0; y < n; y++) { re[y * n + x] = r[y]; im[y * n + x] = i2[y]; } }
}
// returns shift (dx,dy) such that b(x) ≈ a(x - d)... i.e. a pixel at x in A appears at x+d in B
export function phaseCorrelate(a, b, w, h) {
  let n = 1; while (n < Math.max(w, h)) n <<= 1;
  const ar = new Float64Array(n * n), ai = new Float64Array(n * n), br = new Float64Array(n * n), bi = new Float64Array(n * n);
  let ma = 0, mb = 0; for (let i = 0; i < w * h; i++) { ma += a[i]; mb += b[i]; } ma /= w * h; mb /= w * h;
  for (let y = 0; y < h; y++) { const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / h); for (let x = 0; x < w; x++) { const wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / w), win = wx * wy; ar[y * n + x] = (a[y * w + x] - ma) * win; br[y * n + x] = (b[y * w + x] - mb) * win; } }
  fft2(ar, ai, n, false); fft2(br, bi, n, false);
  for (let i = 0; i < n * n; i++) { // B * conj(A)
    const re = br[i] * ar[i] + bi[i] * ai[i], im = bi[i] * ar[i] - br[i] * ai[i]; const m = Math.hypot(re, im) + 1e-12; ar[i] = re / m; ai[i] = im / m;
  }
  fft2(ar, ai, n, true);
  let best = -1e30, bx = 0, by = 0;
  for (let i = 0; i < n * n; i++) if (ar[i] > best) { best = ar[i]; bx = i % n; by = (i / n) | 0; }
  const v = (x, y) => ar[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  const sx = (v(bx - 1, by) - v(bx + 1, by)) / (2 * (v(bx - 1, by) - 2 * best + v(bx + 1, by)) || 1);
  const sy = (v(bx, by - 1) - v(bx, by + 1)) / (2 * (v(bx, by - 1) - 2 * best + v(bx, by + 1)) || 1);
  let dx = bx + (Math.abs(sx) < 1 ? sx : 0), dy = by + (Math.abs(sy) < 1 ? sy : 0);
  if (dx > n / 2) dx -= n; if (dy > n / 2) dy -= n;
  return { dx, dy, peak: best / (n * n) };
}

// ---------- ECC (Evangelidis & Psarakis 2008), similarity or affine ----------
// T: template (reference) plane, I: input plane; returns params in centred coordinates.
// Model: xs = A*(x-c) + t + c  where A = [[1+p0, ...]]
function gradients(src, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    gx[i] = 0.5 * (src[y * w + (x < w - 1 ? x + 1 : x)] - src[y * w + (x > 0 ? x - 1 : x)]);
    gy[i] = 0.5 * (src[(y < h - 1 ? y + 1 : y) * w + x] - src[(y > 0 ? y - 1 : y) * w + x]);
  }
  return { gx, gy };
}
function solveSym(Hm, b, P) { // Gaussian elimination with partial pivoting
  const A = []; for (let i = 0; i < P; i++) { A.push(Array.from(Hm.slice(i * P, i * P + P))); A[i].push(b[i]); }
  for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c]; if (Math.abs(d) < 1e-18) return null; for (let r = 0; r < P; r++) if (r !== c) { const f = A[r][c] / d; for (let k = c; k <= P; k++) A[r][k] -= f * A[c][k]; } }
  return A.map((row, i) => row[P] / row[i]);
}
// matrix from params (centred). returns [a,b,tx, d,e,ty] for centred coords
export function paramsToA(p, model) {
  if (model === 'affine') return [1 + p[0], p[2], p[4], p[1], 1 + p[3], p[5]];
  return [1 + p[0], -p[1], p[2], p[1], 1 + p[0], p[3]];
}
function eccLevel(T, I, w, h, model, p, iters, eps, stride, validMask) {
  const P = model === 'affine' ? 6 : 4; const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const { gx, gy } = gradients(I, w, h);
  let rho = 0; const margin = 2;
  const J = new Float64Array(P);
  for (let it = 0; it < iters; it++) {
    const A = paramsToA(p, model);
    const H = new Float64Array(P * P), jT = new Float64Array(P), jI = new Float64Array(P), j1 = new Float64Array(P);
    let n = 0, sT = 0, sT2 = 0, sI = 0, sI2 = 0, sTI = 0;
    for (let y = margin; y < h - margin; y += stride) {
      const yc = y - cy;
      for (let x = margin; x < w - margin; x += stride) {
        const idx = y * w + x; if (validMask && !validMask[idx]) continue;
        const xc = x - cx;
        const xs = A[0] * xc + A[1] * yc + A[2] + cx, ys = A[3] * xc + A[4] * yc + A[5] + cy;
        if (xs < 0 || ys < 0 || xs > w - 1 || ys > h - 1) continue;
        const iv = sampleBilinear(I, w, h, xs, ys), gxv = sampleBilinear(gx, w, h, xs, ys), gyv = sampleBilinear(gy, w, h, xs, ys);
        const tv = T[idx];
        if (model === 'affine') { J[0] = gxv * xc; J[1] = gyv * xc; J[2] = gxv * yc; J[3] = gyv * yc; J[4] = gxv; J[5] = gyv; }
        else { J[0] = gxv * xc + gyv * yc; J[1] = -gxv * yc + gyv * xc; J[2] = gxv; J[3] = gyv; }
        for (let a = 0; a < P; a++) { const ja = J[a]; jT[a] += ja * tv; jI[a] += ja * iv; j1[a] += ja; for (let b = a; b < P; b++) H[a * P + b] += ja * J[b]; }
        n++; sT += tv; sT2 += tv * tv; sI += iv; sI2 += iv * iv; sTI += tv * iv;
      }
    }
    if (n < 100) return { p, rho: 0, ok: false };
    for (let a = 0; a < P; a++) for (let b = 0; b < a; b++) H[a * P + b] = H[b * P + a];
    const mT = sT / n, mI = sI / n;
    const tNorm = Math.sqrt(Math.max(1e-20, sT2 - n * mT * mT)), iNorm2 = Math.max(1e-20, sI2 - n * mI * mI);
    const corr = sTI - n * mT * mI; rho = corr / (Math.sqrt(iNorm2) * tNorm);
    const imgProj = new Float64Array(P), tplProj = new Float64Array(P);
    for (let a = 0; a < P; a++) { imgProj[a] = jI[a] - mI * j1[a]; tplProj[a] = jT[a] - mT * j1[a]; }
    const ipH = solveSym(H, imgProj, P); if (!ipH) return { p, rho, ok: false };
    let ln = iNorm2, ld = corr; for (let a = 0; a < P; a++) { ln -= imgProj[a] * ipH[a]; ld -= tplProj[a] * ipH[a]; }
    if (ld <= 0) return { p, rho, ok: false };
    const lambda = ln / ld;
    const errProj = new Float64Array(P); for (let a = 0; a < P; a++) errProj[a] = lambda * tplProj[a] - imgProj[a];
    const dp = solveSym(H, errProj, P); if (!dp) return { p, rho, ok: false };
    let nrm = 0; for (let a = 0; a < P; a++) { p[a] += dp[a]; nrm += dp[a] * dp[a]; }
    if (Math.sqrt(nrm) < eps) break;
  }
  return { p, rho, ok: true };
}
// Multi-level ECC. T/I are full-size planes (already preprocessed). init: centred affine [a,b,tx,d,e,ty] at full size.
export function eccAlign(T, I, w, h, { model = 'similarity', init = null, minSize = 200, iters = [80, 40, 15], eps = 1e-4, maxPix = 700000 } = {}) {
  const pt = gaussPyr(T, w, h, 6), pi = gaussPyr(I, w, h, 6);
  let L = 0; while (L < 5 && Math.max(pt[L + 1].w, pt[L + 1].h) >= minSize) L++;
  // initial params at level L
  let pSim = [0, 0, 0, 0];
  if (init) { const s = Math.pow(2, L); pSim = [((init[0] + init[4]) / 2) - 1, (init[3] - init[1]) / 2, init[2] / s, init[5] / s]; }
  let p = pSim.slice(), curModel = 'similarity', rho = 0, ok = true;
  for (let l = L; l >= 0; l--) {
    const lw = pt[l].w, lh = pt[l].h; const stride = lw * lh > maxPix ? Math.ceil(Math.sqrt(lw * lh / maxPix)) : 1;
    const nIt = iters[Math.min(iters.length - 1, Math.max(0, iters.length - 1 - l))] ?? 20;
    if (model === 'affine' && l === 0 && curModel === 'similarity') { p = [p[0], p[1], -p[1], p[0], p[2], p[3]]; curModel = 'affine'; }
    const r = eccLevel(pt[l].d, pi[l].d, lw, lh, curModel, p, l === L ? Math.max(nIt, iters[0]) : nIt, eps, stride);
    rho = r.rho; ok = r.ok;
    if (!ok) break;
    if (l > 0) { if (curModel === 'affine') { p[4] *= 2; p[5] *= 2; } else { p[2] *= 2; p[3] *= 2; } }
  }
  return { A: paramsToA(p, curModel), rho, ok };
}
// Convert centred A (for size w,h) to pixel-coordinate matrix M (dst->src)
export function centredToPixel(A, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  return [A[0], A[1], A[2] + cx - A[0] * cx - A[1] * cy, A[3], A[4], A[5] + cy - A[3] * cx - A[4] * cy];
}
export function pixelToCentred(M, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  return [M[0], M[1], M[2] - cx + M[0] * cx + M[1] * cy, M[3], M[4], M[5] - cy + M[3] * cx + M[4] * cy];
}

// ---------- feature fallback: Harris corners + NCC patch match + RANSAC similarity ----------
export function featureAlign(T, I, w, h, initM) {
  const { gx, gy } = gradients(T, w, h); const N = w * h;
  const xx = new Float32Array(N), yy = new Float32Array(N), xy = new Float32Array(N);
  for (let i = 0; i < N; i++) { xx[i] = gx[i] * gx[i]; yy[i] = gy[i] * gy[i]; xy[i] = gx[i] * gy[i]; }
  const sxx = gaussBlur(xx, w, h, 2), syy = gaussBlur(yy, w, h, 2), sxy = gaussBlur(xy, w, h, 2);
  const R = new Float32Array(N); for (let i = 0; i < N; i++) R[i] = sxx[i] * syy[i] - sxy[i] * sxy[i] - 0.04 * (sxx[i] + syy[i]) ** 2;
  const cand = []; const cell = 32, P = 7, S = 12;
  for (let cyy = 0; cyy < h; cyy += cell) for (let cxx = 0; cxx < w; cxx += cell) {
    let best = 0, bi = -1;
    for (let y = Math.max(P + S + 2, cyy); y < Math.min(h - P - S - 2, cyy + cell); y++) for (let x = Math.max(P + S + 2, cxx); x < Math.min(w - P - S - 2, cxx + cell); x++) { const v = R[y * w + x]; if (v > best) { best = v; bi = y * w + x; } }
    if (bi >= 0) cand.push([best, bi % w, (bi / w) | 0]);
  }
  cand.sort((a, b) => b[0] - a[0]); const pts = cand.slice(0, 300);
  const matches = [];
  for (const [, x, y] of pts) {
    const px = initM[0] * x + initM[1] * y + initM[2], py = initM[3] * x + initM[4] * y + initM[5];
    let tm = 0, tv = 0; for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) { const v = T[(y + j) * w + x + i]; tm += v; tv += v * v; }
    const n = (2 * P + 1) ** 2; tm /= n; tv = Math.sqrt(Math.max(1e-12, tv / n - tm * tm));
    let best = -2, bx = 0, by = 0;
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      const qx = Math.round(px) + dx, qy = Math.round(py) + dy; if (qx - P < 0 || qy - P < 0 || qx + P >= w || qy + P >= h) continue;
      let im = 0, iv = 0, c = 0;
      for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) { const a = T[(y + j) * w + x + i] - tm, b = I[(qy + j) * w + qx + i]; im += b; iv += b * b; c += a * b; }
      im /= n; const sd = Math.sqrt(Math.max(1e-12, iv / n - im * im)); const ncc = c / (n * tv * sd);
      if (ncc > best) { best = ncc; bx = qx; by = qy; }
    }
    if (best > 0.8) matches.push([x, y, bx, by]);
  }
  if (matches.length < 6) return null;
  // RANSAC similarity
  let bestM = null, bestIn = 0; const rnd = mulberry(7);
  const fit = (ms) => { // least squares similarity xs = a x - b y + c ; ys = b x + a y + d
    let A = new Float64Array(16), B = new Float64Array(4);
    for (const [x, y, u, v] of ms) { const r1 = [x, -y, 1, 0], r2 = [y, x, 0, 1]; for (let i = 0; i < 4; i++) { B[i] += r1[i] * u + r2[i] * v; for (let j = 0; j < 4; j++) A[i * 4 + j] += r1[i] * r1[j] + r2[i] * r2[j]; } }
    const s = solveSym(A, B, 4); if (!s) return null; return [s[0], -s[1], s[2], s[1], s[0], s[3]];
  };
  for (let it = 0; it < 300; it++) {
    const a = matches[(rnd() * matches.length) | 0], b = matches[(rnd() * matches.length) | 0]; if (a === b) continue;
    const M = fit([a, b]); if (!M) continue; let inl = 0;
    for (const [x, y, u, v] of matches) { if (Math.hypot(M[0] * x + M[1] * y + M[2] - u, M[3] * x + M[4] * y + M[5] - v) < 1.5) inl++; }
    if (inl > bestIn) { bestIn = inl; bestM = M; }
  }
  if (!bestM || bestIn < 6) return null;
  const inliers = matches.filter(([x, y, u, v]) => Math.hypot(bestM[0] * x + bestM[1] * y + bestM[2] - u, bestM[3] * x + bestM[4] * y + bestM[5] - v) < 1.5);
  return { M: fit(inliers) || bestM, inliers: inliers.length, total: matches.length };
}
export function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
