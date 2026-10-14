// Stage timings at the app's working size (2048x1536, 8 frames). Scenes are the synthetic ones, enlarged (timing does not depend on content).
//   node tests/bench/perf.js [baseline|site] [W] [H] [n]
import { makeFocusSeries, makeCombinedSeries, standardSpecs, makeImg } from '../lib/synth.js';
import { loadSession, renderWith } from '../lib/run.js';
import * as E from '../../site/js/engine.js';
const which = process.argv[2] || 'site', W = +(process.argv[3] || 2048), H = +(process.argv[4] || 1536), n = +(process.argv[5] || 8);
const mods = which === 'site' ? { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) } : { ...(await import('../baseline/pipeline.js')), ...(await import('../baseline/store.js')) };
const up = (im) => { const o = makeImg(W, H); for (const c of ['r', 'g', 'b']) o[c] = E.resizeBilinear(im[c], im.w, im.h, W, H); return o; };
const ms = (t) => Math.round(performance.now() - t) + ' ms';
const focusFrames = makeCombinedSeries({ specs: standardSpecs().slice(0, 1), seed: 3, frames: n }).frames.map(up); // focus sweep, constant light
const bothFrames = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: n }).frames.map(up);
console.log(`engine: ${which}   ${W}x${H} (${(W * H / 1e6).toFixed(1)} MP), ${n} frames`);
for (const [label, frames, specs] of [['focus set', focusFrames, which === 'site' ? [['sharp', { mode: 'focus', method: 'sharp' }], ['depth', { mode: 'focus', method: 'depth' }]] : [['depth', { mode: 'focus', method: 'depth' }]]], ['light+focus set', bothFrames, [['both', { mode: 'both' }], ...(which === 'site' ? [['reflect', { mode: 'light', method: 'reflect' }]] : [['glare', { mode: 'light', method: 'glare' }]])]]]) {
  let t = performance.now(); const { S } = await loadSession(mods, frames); console.log(`\n${label}: load + align + detect: ${ms(t)}`);
  for (const [name, spec] of specs) {
    t = performance.now(); await S.computeWeights(spec); const tw = ms(t); t = performance.now(); const prev = await S.renderPreview(); const tr = ms(t);
    console.log(`  ${name.padEnd(8)} weights ${tw.padStart(9)}   preview render ${tr.padStart(9)}   (crop ${S.crop.w}x${S.crop.h})`);
  }
  // full-resolution tiled render (what export does), without encoding
  t = performance.now(); const sc = S.exportScale(null); let px = 0; await S.render(sc, { tile: 1024, full: true, onTile: (x, y, tw, th) => { px += tw * th; } }); console.log(`  full-res render of ${(px / 1e6).toFixed(1)} MP: ${ms(t)}  (last mode)`);
}
