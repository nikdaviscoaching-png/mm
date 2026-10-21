// Prototype: Swift-style per-band focus fusion, alone and gated by lighting cleanliness, on the pure-focus and combined scenes.
import { makeFocusSeries, makeCombinedSeries, standardSpecs, focusOracle, decode, lumaOf } from '../lib/synth.js';
import { psnr, fitPSNR, edgeBandMSE } from '../lib/metrics.js';
import { savePng } from '../lib/png.js';
import { fuseFocusTile } from '../../site/js/focusfuse.js';
import { estimateNoise } from '../../site/js/focusmap.js';
import { analyzeLighting } from '../../site/js/lightstack.js';
import { oetfFast } from '../../site/js/engine.js';
const f2 = (v) => v.toFixed(2), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const toLin = (im) => [im.r, im.g, im.b].map((c) => c.map(decode));
const toImg = (o, w, h) => { const e = (a) => a.map((v) => oetfFast(v)); return { w, h, r: e(o.r), g: e(o.g), b: e(o.b) }; };

// ---- pure focus: compare with the Swift engine (~30.2 dB) and v1.1.1 'detail' (30.42) ----
{
  const s = makeFocusSeries({ seed: 3, breathing: 0 }), { w, h } = s.frames[0], lin = s.frames.map(toLin), ns = estimateNoise(lumaOf(s.frames[4]), w, h);
  console.log(`PURE FOCUS (oracle ${f2(psnr(focusOracle(s), s.groundTruth))} dB, best single ${f2(Math.max(...s.frames.map((f) => psnr(f, s.groundTruth))))}); estimated noise sigma ${ns.toFixed(4)} (true 0.003)`);
  for (const [name, options] of [['default (selection 8)', {}], ['selection 4', { selectionPower: 4 }], ['selection 12', { selectionPower: 12 }], ['no wide term', { widePower: 0 }], ['levels 4', { levels: 4 }], ['levels 6', { levels: 6 }]]) {
    const t = performance.now(), r = await fuseFocusTile(s.frames.length, w, h, async (k) => lin[k].map((c) => c.slice()), { noiseSigma: ns, options }), img = toImg(r, w, h);
    console.log(`  ${name.padEnd(24)} PSNR ${f2(psnr(img, s.groundTruth))} dB  edge-band ${f2(edgeBandMSE(img, s.groundTruth))}  ${Math.round(performance.now() - t)} ms`);
    if (name.startsWith('default')) savePng('tests/out/proto_focus.png', img);
  }
}
// ---- combined: focus + lighting vary together ----
{
  const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], lin = s.frames.map(toLin), ns = estimateNoise(lumaOf(s.frames[4]), w, h);
  const A = await analyzeLighting(s.frames, w, h, {}), n = s.frames.length;
  console.log(`\nCOMBINED focus+lighting (v1.1.1 'both' 23.52 dB, focus-only 24.51); lighting analysis base = frame ${A.base} (light ${s.lights[A.base]})`);
  const gates = A.clean.map((c) => c.map((v) => ss(0.1, 0.5, v)));
  const gains = A.gains.map((g) => g || null);
  for (const [name, opt] of [['no gate, no gain', { gate: null, gains: null }], ['gain only', { gate: null, gains }], ['gate only', { gate: (k) => gates[k], gains: null }], ['gate + gain', { gate: (k) => gates[k], gains }], ['gate + gain (power 2)', { gate: (k) => gates[k], gains, options: { gatePower: 2 } }]]) {
    const t = performance.now(), r = await fuseFocusTile(n, w, h, async (k) => lin[k].map((c) => c.slice()), { noiseSigma: ns, gate: opt.gate, gainOf: opt.gains ? (k) => opt.gains[k] : null, options: opt.options || {} }), img = toImg(r, w, h);
    const fits = s.clean.map((c) => fitPSNR(img, c)), j = fits.indexOf(Math.max(...fits));
    console.log(`  ${name.padEnd(24)} best-fit PSNR ${f2(Math.max(...fits))} dB (light ${j})  edge-band ${f2(edgeBandMSE(img, s.clean[j]))}  ${Math.round(performance.now() - t)} ms`);
    savePng(`tests/out/proto_both_${name.replace(/[^a-z]+/g, '_')}.png`, img);
  }
}
