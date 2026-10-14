// Checks the JS port of the Swift lighting stack against the Swift acceptance protocol (same scenes, same regions).
import { standardLightingScenario, makeLightingSeries, frameSpec, glare, streak, region } from '../lib/synth.js';
import { psnr, meanLuma, maxLuma, meanColor, sharpness } from '../lib/metrics.js';
import { lightStackImage } from '../../site/js/lightstack.js';
import { savePng, montage } from '../lib/png.js';
const f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3);
const R = { core: { x: 130, y: 90, w: 50, h: 60 }, magenta: { x: 335, y: 255, w: 50, h: 40 }, spot: { x: 68, y: 128, w: 20, h: 22 }, far: { x: 8, y: 330, w: 100, h: 45 } };
const run = async (s, opts = {}) => { const t = performance.now(); const r = await lightStackImage(s.frames, s.frames[0].w, s.frames[0].h, opts); r.ms = Math.round(performance.now() - t); return r; };

const s = standardLightingScenario();
let r = await run(s, { preferredBase: 0 });
console.log(`forced base 0: PSNR vs clean[0] ${f2(psnr(r.img, s.clean[0]))} dB (frame 0 alone ${f2(psnr(s.frames[0], s.clean[0]))})   [Swift: 14.5 -> 31.7]   ${r.ms} ms`);
console.log(`   glare core luma ${f3(meanLuma(r.img, R.core))} (clean ${f3(meanLuma(s.clean[0], R.core))}, base frame ${f3(meanLuma(s.frames[0], R.core))})  max ${f3(maxLuma(r.img, R.core))}`);
const spot = r.img; console.log(`   polished streak: max luma ${f3(maxLuma(spot, R.spot))} (base ${f3(maxLuma(s.frames[0], R.spot))}, clean ${f3(maxLuma(s.clean[0], R.spot))}); sharpness ${f3(sharpness(spot, R.spot))} vs base ${f3(sharpness(s.frames[0], R.spot))}`);
console.log(`   contributions ${r.A.contribution.map(f2).join(' ')}   base ${r.A.base}`);
savePng('tests/out/port_light_base0.png', r.img);

r = await run(s);
console.log(`auto base ${r.A.base}: PSNR vs clean[base] ${f2(psnr(r.img, s.clean[r.A.base]))} dB (base frame alone ${f2(psnr(s.frames[r.A.base], s.clean[r.A.base]))})   [Swift: 23.1 -> 35.0]   ${r.ms} ms`);
console.log(`   frame scores ${r.A.scores.map(f2).join(' ')}   tone beta ${f2(r.A.tone.beta)} gamma ${f2(r.A.tone.gamma)}`);
savePng('tests/out/port_light_auto.png', r.img);

r = await run(s, { preferredBase: 2 });
const mg = meanColor(r.img, R.magenta), mc = meanColor(s.clean[2], R.magenta), mb = meanColor(s.frames[2], R.magenta);
console.log(`magenta reflection (base 2): blue ${f3(mg[2])} (clean ${f3(mc[2])}, base frame ${f3(mb[2])})   [Swift: 0.165 vs 0.161, base 0.568]`);

// narrow polished highlight survives
const streak0 = streak(0.45, 0.38, 0.30, 2.2, 3.4, 3.5, 0.45);
const sp2 = makeLightingSeries({ specs: [frameSpec({ shadeAngle: 0, streaks: [streak0] }), frameSpec({ shadeAngle: 1.6, glares: [glare(0.72, 0.30, 0.07, 3.5)] }), frameSpec({ shadeAngle: 3.1, glares: [glare(0.30, 0.80, 0.06, 3.0)] }), frameSpec({ shadeAngle: 4.7 })] });
r = await run(sp2, { preferredBase: 0 });
const bm = maxLuma(sp2.frames[0], R.spot), cm = maxLuma(sp2.clean[0], R.spot), gm = maxLuma(r.img, R.spot);
console.log(`narrow highlight kept: excess brightness kept ${(100 * (gm - cm) / (bm - cm)).toFixed(0)}% (need >= 85%)  sharpness ${f3(sharpness(r.img, R.spot))} vs ${f3(sharpness(sp2.frames[0], R.spot))}`);

// muddy shadowed frame must not be preferred
const hole = region(0.2, 0.2, 0.5, 0.55, { gain: 0.07, feather: 10 });
const sp3 = makeLightingSeries({ specs: [frameSpec({ shadeAngle: 0, glares: [glare(0.35, 0.37, 0.06, 3.5)] }), frameSpec({ shadeAngle: 3.0, regions: [hole] }), frameSpec({ shadeAngle: 1.5 }), frameSpec({ shadeAngle: 4.5 })] });
r = await run(sp3, { preferredBase: 0 }); const spot3 = { x: 150, y: 110, w: 60, h: 60 };
console.log(`muddy frame avoided: luma ${f3(meanLuma(r.img, spot3))} vs clean ${f3(meanLuma(sp3.clean[0], spot3))} (need >= 80% of clean)`);
console.log(`undamaged areas untouched: PSNR vs base frame in far region ${f2(psnr(r.img, sp3.frames[0], R.far))} dB`);
