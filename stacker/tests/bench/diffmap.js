// usage: node tests/bench/diffmap.js out.png  (reuses the combined prototype; writes [result | error x5 | truth] for inspection)
import { makeCombinedSeries, standardSpecs, decode, lumaOf, makeImg } from '../lib/synth.js';
import { fitPSNR } from '../lib/metrics.js';
import { savePng, montage } from '../lib/png.js';
import { fuseFocusTile } from '../../site/js/focusfuse.js';
import { estimateNoise } from '../../site/js/focusmap.js';
import { analyzeLighting } from '../../site/js/lightstack.js';
import { oetfFast } from '../../site/js/engine.js';
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode)));
const A = await analyzeLighting(s.frames, w, h, {}), ns = estimateNoise(lumaOf(s.frames[4]), w, h), gates = A.clean.map((c) => c.map((v) => ss(0.1, 0.5, v)));
const r = await fuseFocusTile(8, w, h, async (k) => lin[k].map((c) => c.slice()), { noiseSigma: ns, gate: (k) => gates[k], gainOf: (k) => A.gains[k] });
const img = { w, h, r: r.r.map(oetfFast), g: r.g.map(oetfFast), b: r.b.map(oetfFast) }, j = 2, cl = s.clean[j];
const err = makeImg(w, h); for (let i = 0; i < w * h; i++) { const e = (Math.abs(img.r[i] - cl.r[i]) + Math.abs(img.g[i] - cl.g[i]) + Math.abs(img.b[i] - cl.b[i])) / 3 * 5; err.r[i] = err.g[i] = err.b[i] = e; }
savePng(process.argv[2] || 'tests/out/diff.png', montage([img, err, cl], 3));
// what each frame contributed (finest band) and gate coverage
console.log('dominant pixels per frame:', Array.from(r.dominant).map((v) => Math.round(100 * v / (w * h)) + '%').join(' '), '| base', A.base, '| gains present for', A.gains.map((g) => (g ? 'y' : '-')).join(''));
console.log('mean gate per frame:', gates.map((g) => (g.reduce((a, b) => a + b, 0) / g.length).toFixed(2)).join(' '));
