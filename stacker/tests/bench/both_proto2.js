// Single gated focus fusion for all bands; band-energy selection only for the finest `energyLevels` bands.
import { makeCombinedSeries, standardSpecs, decode, lumaOf } from '../lib/synth.js';
import { fitPSNR, edgeBandMSE } from '../lib/metrics.js';
import { savePng } from '../lib/png.js';
import { fuseFocusTile } from '../../site/js/focusfuse.js';
import { estimateNoise } from '../../site/js/focusmap.js';
import { analyzeLighting } from '../../site/js/lightstack.js';
import * as E from '../../site/js/engine.js';
const f2 = (v) => v.toFixed(2), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], n = 8, N = w * h;
const lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode))), ns = estimateNoise(lumaOf(s.frames[4]), w, h), A = await analyzeLighting(s.frames, w, h, {});
const enc = (o) => ({ w, h, r: o.r.map(E.oetfFast), g: o.g.map(E.oetfFast), b: o.b.map(E.oetfFast) });
const maxClean = new Float32Array(N); for (const c of A.clean) for (let i = 0; i < N; i++) if (c[i] > maxClean[i]) maxClean[i] = c[i];
const gates = { abs: A.clean.map((c) => c.map((v) => ss(0.1, 0.5, v))), rel: A.clean.map((c) => c.map((v, i) => ss(0.35, 0.8, v / (maxClean[i] + 1e-3)))) };
console.log("COMBINED single gated fusion (reference: split prototype 25.45; v1.1.1 'both' 23.52)");
for (const [gname, gp] of [['abs', 1], ['abs', 0.5], ['rel', 1]]) for (const energyLevels of [1, 2, 3, 99]) {
  const t = performance.now(), r = await fuseFocusTile(n, w, h, async (k) => lin[k], { noiseSigma: ns, gate: (k) => gates[gname][k], gainOf: (k) => A.gains[k], options: { energyLevels, gatePower: gp } }), img = enc(r);
  const fits = s.clean.map((c) => fitPSNR(img, c)), j = fits.indexOf(Math.max(...fits));
  console.log(`  gate ${gname} p=${gp} energy bands<${String(energyLevels).padEnd(2)}  PSNR ${f2(Math.max(...fits))} dB (light ${j}) edge-band ${f2(edgeBandMSE(img, s.clean[j]))}  ${Math.round(performance.now() - t)} ms`);
  if (gname === 'abs' && gp === 1 && energyLevels === 3) savePng('tests/out/bp2_abs_e3.png', img);
}
