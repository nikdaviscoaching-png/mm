// Prototype of "both": fine bands from gated focus selection, coarse bands + lighting from the reflection-aware (base + donors) blend.
import { makeCombinedSeries, standardSpecs, decode, lumaOf } from '../lib/synth.js';
import { fitPSNR, edgeBandMSE } from '../lib/metrics.js';
import { savePng, montage } from '../lib/png.js';
import { fuseFocusTile } from '../../site/js/focusfuse.js';
import { estimateNoise } from '../../site/js/focusmap.js';
import { analyzeLighting, blendTile } from '../../site/js/lightstack.js';
import * as E from '../../site/js/engine.js';
const f2 = (v) => v.toFixed(2), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], n = 8, N = w * h, L = 5;
const lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode))), ns = estimateNoise(lumaOf(s.frames[4]), w, h);
const A = await analyzeLighting(s.frames, w, h, {});
const frameLin = async (k) => lin[k];
const R = await blendTile(A, L, w, h, async (k) => lin[k].map((c) => c.slice()), (p) => p);            // lighting-clean, base look
const maxClean = new Float32Array(N); for (const c of A.clean) for (let i = 0; i < N; i++) if (c[i] > maxClean[i]) maxClean[i] = c[i];
const gateAbs = A.clean.map((c) => c.map((v) => ss(0.1, 0.5, v))), gateRel = A.clean.map((c) => c.map((v, i) => ss(0.35, 0.8, v / (maxClean[i] + 1e-3))));
const enc = (o) => ({ w, h, r: o.r.map(E.oetfFast), g: o.g.map(E.oetfFast), b: o.b.map(E.oetfFast) });
const split = (F, Rr, kS) => { // fine bands (< kS) from F, everything coarser from R
  return ['r', 'g', 'b'].reduce((out, c) => { const lf = E.lapPyr(F[c], w, h, L), lr = E.lapPyr(Rr[c], w, h, L); out[c] = E.collapse(lf.map((b, l) => (l < kS ? b : lr[l]))).map((v) => (v > 0 ? v : 0)); return out; }, {});
};
const report = (name, o) => { const img = enc(o), fits = s.clean.map((c) => fitPSNR(img, c)), j = fits.indexOf(Math.max(...fits)); console.log(`  ${name.padEnd(34)} best-fit PSNR ${f2(Math.max(...fits))} dB (light ${j})  edge-band ${f2(edgeBandMSE(img, s.clean[j]))}`); savePng(`tests/out/bp_${name.replace(/[^a-z0-9]+/gi, '_')}.png`, img); return img; };
console.log(`COMBINED (v1.1.1 'both' 23.52 / focus-only 24.51 / reflect-only 20.65); lighting base = frame ${A.base}`);
report('reflect only (R)', R);
const gain = (k) => A.gains[k];
for (const [gname, gate] of [['abs gate', gateAbs], ['rel gate', gateRel]]) {
  const F = await fuseFocusTile(n, w, h, frameLin, { noiseSigma: ns, gate: (k) => gate[k], gainOf: gain });
  for (const kS of [2, 3, 4]) report(`F fine<${kS} + R coarse, ${gname}`, split(F, R, kS));
}
{ // error map of the best configuration
  const F = await fuseFocusTile(n, w, h, frameLin, { noiseSigma: ns, gate: (k) => gateAbs[k], gainOf: gain }), img = enc(split(F, R, 3)), cl = s.clean[2];
  const err = { w, h, r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
  for (let i = 0; i < N; i++) { const e = (Math.abs(img.r[i] - cl.r[i]) + Math.abs(img.g[i] - cl.g[i]) + Math.abs(img.b[i] - cl.b[i])) / 3 * 5; err.r[i] = err.g[i] = err.b[i] = e; }
  savePng('tests/out/bp_best_diff.png', montage([img, err, cl], 3));
}
