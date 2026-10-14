// synth.js — deterministic synthetic specimens with ground truth.
// A JavaScript port of the Swift SpecimenTestKit (Procedural / SyntheticFocus / SyntheticLighting) from the
// Specimen Camera project, so the web engine can be scored on the same kinds of scenes as the native one.
// Images are planar Float32: { w, h, r, g, b }, display-encoded (sRGB transfer) unless stated otherwise.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const decode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const encode = (v) => { const c = clamp01(v); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };

export const makeImg = (w, h, v = 0) => ({ w, h, r: new Float32Array(w * h).fill(v), g: new Float32Array(w * h).fill(v), b: new Float32Array(w * h).fill(v) });
export const cloneImg = (a) => ({ w: a.w, h: a.h, r: a.r.slice(), g: a.g.slice(), b: a.b.slice() });
export const mapImg = (a, f) => { const o = makeImg(a.w, a.h); for (const c of ['r', 'g', 'b']) for (let i = 0; i < a.r.length; i++) o[c][i] = f(a[c][i]); return o; };
export const toLinear = (a) => mapImg(a, decode);
export const toEncoded = (a) => mapImg(a, encode);
export const lumaOf = (a, k = [0.2126, 0.7152, 0.0722]) => { const o = new Float32Array(a.r.length); for (let i = 0; i < o.length; i++) o[i] = k[0] * a.r[i] + k[1] * a.g[i] + k[2] * a.b[i]; return o; };
export function cropImg(a, x0, y0, w, h) {
  const o = makeImg(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y + y0) * a.w + x + x0, d = y * w + x; o.r[d] = a.r[s]; o.g[d] = a.g[s]; o.b[d] = a.b[s]; }
  return o;
}

// ---- deterministic randomness ----
export function rng(seed) {
  let a = seed | 0, spare = null;
  const uniform = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gaussian = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const u1 = Math.max(uniform(), 1e-7), u2 = uniform(), r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2); return r * Math.cos(2 * Math.PI * u2);
  };
  return { uniform, gaussian };
}
function hash(x, y, seed) {
  let h = Math.imul(x | 0, 0x9E3779B1) ^ Math.imul(y | 0, 0x85EBCA77) ^ Math.imul(seed | 0, 0xC2B2AE3D);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
function fbm(x, y, octaves, seed) {
  let amp = 0.5, f = 1, s = 0, norm = 0;
  for (let o = 0; o < octaves; o++) { s += amp * valueNoise(x * f, y * f, seed + o * 101); norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

// ---- exact separable Gaussian (edge replicate) — used only to build ground truth ----
export function gaussBlurExact(src, w, h, sigma) {
  if (sigma <= 0.01) return src.slice();
  const s = Math.max(sigma, 0.05), R = Math.max(1, Math.ceil(3 * s)), k = new Float64Array(2 * R + 1); let sum = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); k[i + R] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -R; i <= R; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); a += k[i + R] * src[y * w + xx]; } tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -R; i <= R; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); a += k[i + R] * tmp[yy * w + x]; } out[y * w + x] = a; }
  return out;
}

// ---- Catmull-Rom warp: out(x, y) = src(T(x, y)),  T = [a, b, tx, c, d, ty] (reference -> frame) ----
export function warpImg(src, T) {
  const { w, h } = src, out = makeImg(w, h);
  const cr = (t) => { const t2 = t * t, t3 = t2 * t; return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2]; };
  for (let oy = 0; oy < h; oy++) for (let ox = 0; ox < w; ox++) {
    const fx = T[0] * ox + T[1] * oy + T[2], fy = T[3] * ox + T[4] * oy + T[5];
    const x0 = Math.floor(fx), y0 = Math.floor(fy), wx = cr(fx - x0), wy = cr(fy - y0);
    for (const c of ['r', 'g', 'b']) {
      let acc = 0;
      for (let j = 0; j < 4; j++) {
        const yy = Math.min(h - 1, Math.max(0, y0 - 1 + j)) * w; let row = 0;
        for (let i = 0; i < 4; i++) row += wx[i] * src[c][yy + Math.min(w - 1, Math.max(0, x0 - 1 + i))];
        acc += wy[j] * row;
      }
      out[c][oy * w + ox] = clamp01(acc);
    }
  }
  return out;
}
// similarity about `center`, then translation:  p' = R S (p - c) + c + t
export function similarity(scale, rot, tx, ty, cx, cy) {
  const cs = scale * Math.cos(rot), sn = scale * Math.sin(rot);
  return [cs, -sn, cx + tx - (cs * cx - sn * cy), sn, cs, cy + ty - (sn * cx + cs * cy)];
}

// ---- the specimen: banded, grainy, faceted, with hairlines and one deliberately smooth patch ----
const PALETTE = [[0.55, 0.10, 0.07], [0.85, 0.45, 0.12], [0.93, 0.88, 0.75], [0.35, 0.20, 0.12], [0.45, 0.55, 0.70], [0.90, 0.90, 0.88], [0.14, 0.09, 0.10], [0.70, 0.25, 0.45]];
export function specimenTexture(width, height, seed = 1) {
  const img = makeImg(width, height), W = width, H = height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / W, v = (y / H) * (H / W);
    const wx = u + 0.07 * (fbm(u * 3, v * 3, 3, seed) - 0.5), wy = v + 0.07 * (fbm(u * 3 + 17, v * 3 + 9, 3, seed + 1) - 0.5);
    const bands = Math.hypot(wx - 0.45, wy - 0.38) * 16, bi = Math.floor(bands), f = bands - bi;
    const col = PALETTE[Math.floor(hash(bi, 7, seed) * PALETTE.length) % PALETTE.length];
    const shade = 0.82 + 0.3 * f, edge = 1 - 0.7 * (1 - smoothstep(0, 0.05, f));
    const grain = 1 + 0.16 * (fbm(x / 2.4, y / 2.4, 2, seed + 5) - 0.5) * 2;
    let c = [col[0] * shade * edge * grain, col[1] * shade * edge * grain, col[2] * shade * edge * grain];
    if (u < 0.38 && y > Math.floor(height * 0.58)) { // Voronoi crystal facets (lower-left)
      const cell = 26, cx = Math.floor(x / cell), cy = Math.floor(y / cell); let d1 = 1e9, d2 = 1e9, nx = 0, ny = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox, gy = cy + oy, px = (gx + hash(gx, gy, seed + 11)) * cell, py = (gy + hash(gx, gy, seed + 12)) * cell, d = Math.hypot(x - px, y - py);
        if (d < d1) { d2 = d1; d1 = d; nx = gx; ny = gy; } else if (d < d2) d2 = d;
      }
      const base = PALETTE[Math.floor(hash(nx, ny, seed + 13) * PALETTE.length) % PALETTE.length], g2 = 0.7 + 0.45 * hash(nx, ny, seed + 14), line = smoothstep(0, 2.2, d2 - d1);
      c = [base[0] * g2 * line * grain, base[1] * g2 * line * grain, base[2] * g2 * line * grain];
    }
    if (u > 0.68 && y < Math.floor(height * 0.42)) { // hairlines (upper-right)
      const ang = 0.5, t = (x * Math.cos(ang) + y * Math.sin(ang)) / 9, d = Math.abs(t - Math.floor(t) - 0.5) * 9, line = smoothstep(0.35, 1.1, d);
      c = [0.9 * line + 0.05, 0.86 * line + 0.05, 0.78 * line + 0.05];
    }
    if (u > 0.62 && y > Math.floor(height * 0.62)) { // smooth, low-texture patch (lower-right)
      const g = 0.45 + (0.12 * (u - 0.62)) / 0.38 + (0.04 * (y - Math.floor(height * 0.62))) / H;
      c = [g * 0.95, g * 0.55, g * 0.35];
    }
    const i = y * width + x; img.r[i] = clamp01(c[0]); img.g[i] = clamp01(c[1]); img.b[i] = clamp01(c[2]);
  }
  return img;
}

// ---- focus series: depth-dependent defocus (blur stack interpolated per pixel), optional jitter / breathing / noise ----
export function depthMap(width, height) {
  const d = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height; let z = 0.15 + 0.7 * u; // tilted plane
    if (Math.hypot(u - 0.42, ((v - 0.45) * height) / width) < 0.2) z = 0.1; // near mesa with a hard step edge
    if (u > 0.72 && v > 0.55) z = 0.9 - 0.4 * (v - 0.55); // far shelf, ramped
    d[y * width + x] = clamp01(z);
  }
  return d;
}
export function makeFocusSeries({ width = 512, height = 384, frames: n = 8, seed = 3, maxSigma = 4.5, noise = 0.003, jitter = false, breathing = 0.0006, refIndex = (n - 1) >> 1, texture = null } = {}) {
  const truth = texture || specimenTexture(width, height, seed), depth = depthMap(width, height), lin = toLinear(truth), levels = 10, blurred = [];
  for (let k = 0; k < levels; k++) { const s = (maxSigma * k) / (levels - 1); blurred.push({ r: gaussBlurExact(lin.r, width, height, s), g: gaussBlurExact(lin.g, width, height, s), b: gaussBlurExact(lin.b, width, height, s) }); }
  const R = rng(seed + 99), out = [], depths = [], transforms = [];
  for (let i = 0; i < n; i++) {
    const fd = (i / Math.max(1, n - 1)) * 0.9 + 0.05; depths.push(fd);
    let img = makeImg(width, height);
    for (let j = 0; j < width * height; j++) {
      const s = Math.min(Math.abs(depth[j] - fd) * 1.15, 1) * (levels - 1), k0 = Math.min(Math.floor(s), levels - 2), t = s - k0;
      img.r[j] = blurred[k0].r[j] * (1 - t) + blurred[k0 + 1].r[j] * t; img.g[j] = blurred[k0].g[j] * (1 - t) + blurred[k0 + 1].g[j] * t; img.b[j] = blurred[k0].b[j] * (1 - t) + blurred[k0 + 1].b[j] * t;
    }
    let T = [1, 0, 0, 0, 1, 0];
    if ((jitter || breathing > 0) && i !== refIndex) { // the reference frame keeps the identity so the ground truth is in its geometry
      const sc = 1 + breathing * (i - refIndex), tx = jitter ? (R.uniform() - 0.5) * 3 : 0, ty = jitter ? (R.uniform() - 0.5) * 3 : 0, rot = jitter ? (R.uniform() - 0.5) * 0.002 : 0;
      T = similarity(sc, rot, tx, ty, width / 2, height / 2); img = warpImg(img, T);
    }
    const enc = toEncoded(img);
    if (noise > 0) for (let j = 0; j < width * height; j++) { enc.r[j] += noise * R.gaussian(); enc.g[j] += noise * R.gaussian(); enc.b[j] += noise * R.gaussian(); }
    out.push(mapImg(enc, clamp01)); transforms.push(T);
  }
  return { frames: out, groundTruth: truth, depth, focusDepths: depths, transforms, refIndex };
}
// hard-selection oracle: per pixel take the frame whose focus depth is closest to the true depth
export function focusOracle(series) {
  const { frames, depth, focusDepths } = series, o = makeImg(frames[0].w, frames[0].h);
  for (let j = 0; j < depth.length; j++) { let bi = 0, bd = 9; focusDepths.forEach((fd, i) => { const d = Math.abs(fd - depth[j]); if (d < bd) { bd = d; bi = i; } }); o.r[j] = frames[bi].r[j]; o.g[j] = frames[bi].g[j]; o.b[j] = frames[bi].b[j]; }
  return o;
}

// ---- lighting series: one fixed diffuse specimen, per-frame shading + glare / streaks / coloured reflections / shadows ----
export const glare = (cx, cy, sigma, amplitude, tint = [1, 1, 1]) => ({ cx, cy, sigma, amplitude, tint });
export const streak = (cx, cy, radius, startAngle, endAngle, thickness, peak) => ({ cx, cy, radius, startAngle, endAngle, thickness, peak });
export const region = (x0, y0, x1, y1, o = {}) => ({ x0, y0, x1, y1, gain: o.gain ?? 1, add: o.add ?? [0, 0, 0], feather: o.feather ?? 6 });
export const frameSpec = (o = {}) => ({ shadeAngle: 0, shadeAmount: 0.18, gain: 1, glares: [], streaks: [], regions: [], ...o });
function rectMask(x, y, r, W, H) {
  const f = Math.max(r.feather, 0.5);
  return smoothstep(r.x0 * W - f, r.x0 * W + f, x) * (1 - smoothstep(r.x1 * W - f, r.x1 * W + f, x)) * smoothstep(r.y0 * H - f, r.y0 * H + f, y) * (1 - smoothstep(r.y1 * H - f, r.y1 * H + f, y));
}
// linear-light rendering of one lighting condition (diffuse × shading, plus glare / streak / region defects); `clean` has no defects
export function renderLightingFrame(spec, lin, width, height) {
  const img = makeImg(width, height), clean = makeImg(width, height), W = width, H = height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, u = x / W - 0.5, v = y / H - 0.5;
    const sh = spec.gain * (1 + spec.shadeAmount * (Math.cos(spec.shadeAngle) * u + Math.sin(spec.shadeAngle) * v) * 2);
    let c = [lin.r[i] * sh, lin.g[i] * sh, lin.b[i] * sh]; clean.r[i] = c[0]; clean.g[i] = c[1]; clean.b[i] = c[2];
    for (const r of spec.regions) { const m = rectMask(x, y, r, W, H); c = c.map((q, k) => q * (1 + (r.gain - 1) * m) + r.add[k] * m); }
    for (const g of spec.glares) { const dx = x - g.cx * W, dy = y - g.cy * H, s = g.sigma * W, a = g.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * s * s)); c = c.map((q, k) => q + a * g.tint[k]); }
    for (const st of spec.streaks) {
      const dx = x - st.cx * W, dy = y - st.cy * H, d = Math.hypot(dx, dy) - st.radius * W, sigma = st.thickness / 2.355;
      let prof = Math.exp((-d * d) / (2 * sigma * sigma)); const t = (Math.atan2(dy, dx) - st.startAngle) / Math.max(st.endAngle - st.startAngle, 1e-3);
      prof *= smoothstep(0, 0.12, t) * (1 - smoothstep(0.88, 1, t)); const a = st.peak * prof; c = c.map((q) => q + a);
    }
    img.r[i] = c[0]; img.g[i] = c[1]; img.b[i] = c[2];
  }
  return { img, clean };
}
export function makeLightingSeries({ width = 512, height = 384, specs, seed = 7, noise = 0.002, texture = null } = {}) {
  const diffuse = texture || specimenTexture(width, height, seed), lin = toLinear(diffuse), R = rng(seed + 5), frames = [], cleans = [];
  for (const spec of specs) {
    const { img, clean } = renderLightingFrame(spec, lin, width, height), enc = toEncoded(img);
    for (let j = 0; j < width * height; j++) { enc.r[j] += noise * R.gaussian(); enc.g[j] += noise * R.gaussian(); enc.b[j] += noise * R.gaussian(); }
    frames.push(mapImg(enc, clamp01)); cleans.push(mapImg(toEncoded(clean), clamp01));
  }
  return { frames, specs, diffuse, clean: cleans };
}
// Focus AND lighting vary together: frame i has its own focus depth AND its own lighting condition (glare, reflection, shadow),
// then defocus blur is applied to the lit image (a reflection is blurred exactly like the surface it sits on).
export function makeCombinedSeries({ width = 512, height = 384, frames: n = 8, specs, seed = 3, maxSigma = 4.5, noise = 0.003, texture = null } = {}) {
  const diffuse = texture || specimenTexture(width, height, seed), lin = toLinear(diffuse), depth = depthMap(width, height), levels = 10, R = rng(seed + 77), frames = [], lights = [], cleanLins = [], defects = [], focusDepths = [];
  for (let i = 0; i < n; i++) {
    const spec = specs[i % specs.length], { img, clean: cleanLin } = renderLightingFrame(spec, lin, width, height), fd = (i / Math.max(1, n - 1)) * 0.9 + 0.05, blurred = [];
    cleanLins.push(cleanLin); const dm = new Uint8Array(width * height); // truly defective pixels (defect adds > 5 % of the clean value)
    for (let j = 0; j < width * height; j++) dm[j] = Math.abs(img.r[j] - cleanLin.r[j]) / (cleanLin.r[j] + 0.02) > 0.05 || Math.abs(img.g[j] - cleanLin.g[j]) / (cleanLin.g[j] + 0.02) > 0.05 || Math.abs(img.b[j] - cleanLin.b[j]) / (cleanLin.b[j] + 0.02) > 0.05 ? 1 : 0;
    defects.push(dm);
    for (let k = 0; k < levels; k++) { const sg = (maxSigma * k) / (levels - 1); blurred.push({ r: gaussBlurExact(img.r, width, height, sg), g: gaussBlurExact(img.g, width, height, sg), b: gaussBlurExact(img.b, width, height, sg) }); }
    const out = makeImg(width, height);
    for (let j = 0; j < width * height; j++) {
      const sv = Math.min(Math.abs(depth[j] - fd) * 1.15, 1) * (levels - 1), k0 = Math.min(Math.floor(sv), levels - 2), t = sv - k0;
      for (const c of ['r', 'g', 'b']) out[c][j] = blurred[k0][c][j] * (1 - t) + blurred[k0 + 1][c][j] * t;
    }
    const enc = toEncoded(out); for (let j = 0; j < width * height; j++) { enc.r[j] += noise * R.gaussian(); enc.g[j] += noise * R.gaussian(); enc.b[j] += noise * R.gaussian(); }
    frames.push(mapImg(enc, clamp01)); lights.push(i % specs.length); focusDepths.push(fd);
  }
  // the defect-free, all-in-focus rendering for each lighting condition (what a perfect stack of that look would be)
  const cleans = specs.map((sp) => mapImg(toEncoded(renderLightingFrame({ ...sp, glares: [], streaks: [], regions: [] }, lin, width, height).clean), clamp01));
  return { frames, lights, clean: cleans, depth, diffuse, specs, cleanLins, defects, focusDepths };
}
// Four light positions. Frame 0 (natural base) has a broad clipped glare + a thin polished highlight; the others are clean
// there but have their own problems: glare (1, 3), a magenta phone reflection (2) and a muddy shadow over the base's glare (3).
export function standardSpecs() {
  const s0 = streak(0.45, 0.38, 0.30, 2.2, 3.4, 3.5, 0.45);
  return [
    frameSpec({ shadeAngle: 0.0, glares: [glare(0.30, 0.32, 0.07, 3.5)], streaks: [s0] }),
    frameSpec({ shadeAngle: 1.6, glares: [glare(0.72, 0.30, 0.07, 3.5)] }),
    frameSpec({ shadeAngle: 3.1, regions: [region(0.52, 0.50, 0.78, 0.80, { add: [0.30, 0.0, 0.26] })] }),
    frameSpec({ shadeAngle: 4.7, gain: 0.95, glares: [glare(0.72, 0.74, 0.06, 3.0)], regions: [region(0.12, 0.14, 0.46, 0.52, { gain: 0.07, feather: 10 })] }),
  ];
}
export function standardLightingScenario({ width = 512, height = 384, seed = 7 } = {}) { return makeLightingSeries({ width, height, specs: standardSpecs(), seed }); }
