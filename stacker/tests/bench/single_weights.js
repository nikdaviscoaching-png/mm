import { makeFocusSeries, makeCombinedSeries, standardSpecs, decode, lumaOf } from '../lib/synth.js';
import { psnr, fitPSNR, edgeBandMSE } from '../lib/metrics.js';
import { fuseFocusTile } from '../../site/js/focusfuse.js';
import { estimateNoise } from '../../site/js/focusmap.js';
import { analyzeLighting } from '../../site/js/lightstack.js';
import * as E from '../../site/js/engine.js';
const f2 = (v) => v.toFixed(2), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const enc = (o, w, h) => ({ w, h, r: o.r.map(E.oetfFast), g: o.g.map(E.oetfFast), b: o.b.map(E.oetfFast) });
{ const s = makeFocusSeries({ seed: 3, breathing: 0 }), { w, h } = s.frames[0], lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode))), ns = estimateNoise(lumaOf(s.frames[4]), w, h);
  console.log('PURE FOCUS');
  for (const [name, options] of [['per-band weights', {}], ['single weight map', { singleWeights: true }], ['single, energy bands<2', { singleWeights: true, energyLevels: 2 }]]) {
    const r = await fuseFocusTile(8, w, h, async (k) => lin[k], { noiseSigma: ns, options }), img = enc(r, w, h); console.log(`  ${name.padEnd(26)} PSNR ${f2(psnr(img, s.groundTruth))} dB  edge-band ${f2(edgeBandMSE(img, s.groundTruth))}`); } }
{ const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], N = w * h, lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode))), ns = estimateNoise(lumaOf(s.frames[4]), w, h), A = await analyzeLighting(s.frames, w, h, {});
  const gate = A.clean.map((c) => c.map((v) => ss(0.1, 0.5, v)));
  console.log('COMBINED (oracle ceiling 28.08; per-band reference 25.87)');
  for (const [name, options] of [['per-band, energy<1', { energyLevels: 1, gatePower: 0.5 }], ['single weight map', { singleWeights: true, energyLevels: 1, gatePower: 0.5 }], ['single, gate p=1', { singleWeights: true, energyLevels: 1, gatePower: 1 }], ['single, selection 12', { singleWeights: true, energyLevels: 1, gatePower: 0.5, selectionPower: 12 }]]) {
    const r = await fuseFocusTile(8, w, h, async (k) => lin[k], { noiseSigma: ns, gate: (k) => gate[k], gainOf: (k) => A.gains[k], options }), img = enc(r, w, h), fits = s.clean.map((c) => fitPSNR(img, c)); console.log(`  ${name.padEnd(26)} PSNR ${f2(Math.max(...fits))} dB`); } }
