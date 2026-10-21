// Writes montages of the synthetic scenes to tests/out so they can be inspected by eye.
import { makeFocusSeries, standardLightingScenario, focusOracle } from '../lib/synth.js';
import { savePng, montage } from '../lib/png.js';
import { psnr } from '../lib/metrics.js';
const t0 = Date.now();
const f = makeFocusSeries({ seed: 3, breathing: 0 });
savePng('tests/out/scene_focus_frames.png', montage([f.groundTruth, ...f.frames.slice(0, 3), f.frames[4], f.frames[7]], 3));
const o = focusOracle(f);
console.log('focus: truth vs best single frame PSNR', Math.max(...f.frames.map((x) => psnr(x, f.groundTruth))).toFixed(2), ' oracle PSNR', psnr(o, f.groundTruth).toFixed(2), '(Swift reports oracle 30.85 dB)');
const l = standardLightingScenario();
savePng('tests/out/scene_light_frames.png', montage([l.diffuse, ...l.frames], 3));
console.log('light: frame0 vs clean0 PSNR', psnr(l.frames[0], l.clean[0]).toFixed(2), '(Swift reports 14.5 dB for the single base frame)');
console.log('generated in', Date.now() - t0, 'ms');
