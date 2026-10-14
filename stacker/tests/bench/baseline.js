// Scores an engine (default: frozen v1.1.1) on the synthetic scenes with ground truth.
//   node tests/bench/baseline.js [baseline|site]
import { makeFocusSeries, standardLightingScenario, focusOracle, mapImg } from '../lib/synth.js';
import { psnr, fitPSNR, sharpness, meanLuma, maxLuma, meanColor, edgeBandMSE } from '../lib/metrics.js';
import { stack, cropTo } from '../lib/run.js';
import { savePng, montage } from '../lib/png.js';

const which = process.argv[2] || 'baseline';
const mods = which === 'site'
  ? { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) }
  : { ...(await import('../baseline/pipeline.js')), ...(await import('../baseline/store.js')) };
console.log('engine under test:', which);
const f2 = (v) => v.toFixed(2);

// ---------------- focus ----------------
{
  const s = makeFocusSeries({ seed: 3, breathing: 0 });
  console.log('\nFOCUS  8 frames, 512x384, noise 0.003 (Swift engine reports ~30.2 dB; oracle 30.85)');
  const rows = [];
  for (const [name, spec] of [...(which === 'site' ? [['sharp (new default)', { mode: 'focus', method: 'sharp' }]] : []), ['depth (Clean)', { mode: 'focus', method: 'depth' }], ['detail (Max detail)', { mode: 'focus', method: 'detail' }], ['translucent', { mode: 'focus', method: 'translucent' }], ['both', { mode: 'both' }]]) {
    const r = await stack(mods, s.frames, spec), truth = cropTo(s.groundTruth, r.crop);
    rows.push({ name, psnr: psnr(r.img, truth), edge: edgeBandMSE(r.img, truth), ms: r.ms.stack, img: r.img });
    savePng(`tests/out/${which}_focus_${name.split(' ')[0]}.png`, r.img);
  }
  const r0 = await stack(mods, s.frames, { mode: 'focus', method: 'depth' }), truth = cropTo(s.groundTruth, r0.crop);
  const best = Math.max(...s.frames.map((f) => psnr(cropTo(f, r0.crop), truth)));
  console.log('  best single frame:', f2(best), 'dB   oracle (true depth):', f2(psnr(cropTo(focusOracle(s), r0.crop), truth)), 'dB');
  for (const r of rows) console.log(`  ${r.name.padEnd(22)} PSNR ${f2(r.psnr)} dB   edge-band PSNR ${f2(r.edge)} dB   ${r.ms} ms`);
}

// ---------------- lighting ----------------
{
  const s = standardLightingScenario();
  console.log('\nLIGHTING  standard 4-frame scenario (Swift: single base 14.5 dB -> 31.7 forced base / 35.0 auto base)');
  const R = { core: { x: 130, y: 90, w: 50, h: 60 }, magenta: { x: 335, y: 255, w: 50, h: 40 }, streak: { x: 68, y: 128, w: 20, h: 22 }, far: { x: 8, y: 330, w: 100, h: 45 } };
  const rel = (r, c) => ({ x: r.x - c.x, y: r.y - c.y, w: r.w, h: r.h });
  const specs = [...(which === 'site' ? [['reflect (new default)', { mode: 'light', method: 'reflect' }]] : []), ['glare (Less glare)', { mode: 'light', method: 'glare' }], ['exposure (Balanced)', { mode: 'light', method: 'exposure' }], ['hdr', { mode: 'light', method: 'hdr' }], ['lighten', { mode: 'light', method: 'lighten' }], ['darken', { mode: 'light', method: 'darken' }], ['average', { mode: 'light', method: 'average' }], ['both', { mode: 'both' }]];
  for (const [name, spec] of specs) {
    const r = await stack(mods, s.frames, spec), c = r.crop;
    const fits = s.clean.map((cl) => fitPSNR(r.img, cropTo(cl, c))), j = fits.indexOf(Math.max(...fits));
    const cl = cropTo(s.clean[j], c), coreMean = meanLuma(r.img, rel(R.core, c)), cleanCore = meanLuma(cl, rel(R.core, c));
    const mg = meanColor(r.img, rel(R.magenta, c)), mgc = meanColor(cl, rel(R.magenta, c));
    console.log(`  ${name.padEnd(22)} best-fit PSNR ${f2(Math.max(...fits))} dB (vs clean[${j}])  glare-core luma ${f2(coreMean)} (clean ${f2(cleanCore)})  magenta B ${f2(mg[2])} (clean ${f2(mgc[2])})  max-luma ${f2(maxLuma(r.img, rel(R.core, c)))}  ${r.ms.stack} ms  base/ref=${r.report.ref}`);
    savePng(`tests/out/${which}_light_${name.split(' ')[0]}.png`, r.img);
  }
  console.log('  (single frames vs their clean version:', s.frames.map((f, i) => f2(psnr(f, s.clean[i]))).join(', '), 'dB)');
}
