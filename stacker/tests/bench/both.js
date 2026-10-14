// Focus AND lighting vary together. Truth = defect-free all-in-focus rendering of the lighting the engine ends up on.
//   node tests/bench/both.js [baseline|site]
import { makeCombinedSeries, standardSpecs } from '../lib/synth.js';
import { psnr, fitPSNR, meanColor, meanLuma, edgeBandMSE } from '../lib/metrics.js';
import { stack, cropTo } from '../lib/run.js';
import { savePng, montage } from '../lib/png.js';
const which = process.argv[2] || 'site';
const mods = which === 'site' ? { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) } : { ...(await import('../baseline/pipeline.js')), ...(await import('../baseline/store.js')) };
const f2 = (v) => v.toFixed(2);
const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 });
savePng('tests/out/scene_both_frames.png', montage(s.frames.slice(0, 6), 3));
const DEF = { glare0: { x: 130, y: 100, w: 50, h: 50 }, glare1: { x: 345, y: 90, w: 50, h: 50 }, magenta: { x: 335, y: 255, w: 50, h: 40 }, glare3: { x: 345, y: 260, w: 50, h: 50 }, shadow: { x: 80, y: 80, w: 100, h: 60 } };
const rel = (r, c) => ({ x: r.x - c.x, y: r.y - c.y, w: r.w, h: r.h });
const mae = (a, b, r) => { let t = 0, n = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = y * a.w + x; t += (Math.abs(a.r[i] - b.r[i]) + Math.abs(a.g[i] - b.g[i]) + Math.abs(a.b[i] - b.b[i])) / 3; n++; } return t / n; };
console.log('engine:', which, ' | 8 frames: focus depth sweeps 0.05..0.95 AND lighting cycles through 4 conditions with defects');
const specs = which === 'baseline'
  ? [['both', { mode: 'both' }], ['focus detail only', { mode: 'focus', method: 'detail' }], ['light glare only', { mode: 'light', method: 'glare' }]]
  : [['both', { mode: 'both' }], ['focus detail only', { mode: 'focus', method: 'detail' }], ['light reflect only', { mode: 'light', method: 'reflect' }]];
for (const [name, spec] of specs) {
  const r = await stack(mods, s.frames, spec), c = r.crop;
  const fits = s.clean.map((cl) => fitPSNR(r.img, cropTo(cl, c))), j = fits.indexOf(Math.max(...fits)), cl = cropTo(s.clean[j], c);
  const errs = Object.entries(DEF).map(([k, rc]) => `${k} ${mae(r.img, cl, rel(rc, c)).toFixed(3)}`).join('  ');
  console.log(`${name.padEnd(20)} best-fit PSNR ${f2(Math.max(...fits))} dB (light ${j})  edge-band ${f2(edgeBandMSE(r.img, cl))} dB  ${r.ms.stack} ms\n    region abs-error: ${errs}`);
  savePng(`tests/out/${which}_both_${name.split(' ')[0]}_${name.split(' ')[1] || ''}.png`, r.img);
}
