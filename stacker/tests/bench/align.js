// Alignment accuracy against known motion. Error = worst corner displacement (px, work resolution) between the estimated
// reference->frame mapping and the true one.   node tests/bench/align.js [baseline|site]
import { makeFocusSeries } from '../lib/synth.js';
import { loadSession } from '../lib/run.js';
const which = process.argv[2] || 'site';
const mods = which === 'site' ? { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) } : { ...(await import('../baseline/pipeline.js')), ...(await import('../baseline/store.js')) };
const inv = (T) => { const [a, b, tx, c, d, ty] = T, det = a * d - b * c, ia = d / det, ib = -b / det, ic = -c / det, id = a / det; return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)]; };
const ap = (M, x, y) => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];
const err = (Me, Mt, w, h) => Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => { const a = ap(Me, x, y), b = ap(Mt, x, y); return Math.hypot(a[0] - b[0], a[1] - b[1]); }));
for (const [name, opts] of [['tripod: no motion, focus differences only', { jitter: false, breathing: 0 }], ['tripod + focus breathing (0.08%/frame)', { jitter: false, breathing: 0.0008 }], ['jitter ±1.5 px, ±0.06°, breathing', { jitter: true, breathing: 0.0008 }]]) {
  const s = makeFocusSeries({ seed: 3, ...opts }), { S, report } = await loadSession(mods, s.frames), ref = report.ref, { w, h } = s.frames[0];
  const errs = S.frames.map((f, i) => (i === ref ? 0 : err(f.M, inv(s.transforms[i]), w, h)));
  console.log(`${name.padEnd(46)} ref ${ref}  errors: ${errs.map((e) => e.toFixed(2)).join(' ')}   max ${Math.max(...errs).toFixed(2)}  mean ${(errs.reduce((a, b) => a + b, 0) / (errs.length - 1)).toFixed(2)}  failed: ${S.frames.filter((f) => f.status === 'failed').length}`);
}
