import { standardLightingScenario } from '../lib/synth.js';
import { psnr, meanColor, maxLuma, meanLuma } from '../lib/metrics.js';
import { loadSession, renderWith, cropTo } from '../lib/run.js';
import { savePng } from '../lib/png.js';
const mods = { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) };
const s = standardLightingScenario(), f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3);
const t0 = performance.now(); const { S, report } = await loadSession(mods, s.frames); console.log('load+analyze', Math.round(performance.now() - t0), 'ms; auto spec ->', JSON.stringify(mods.autoSpec(report.detect)), '| detect:', report.detect.kind, report.detect.lightKind);
for (const base of [undefined, 0, 2]) {
  const t = performance.now(); const { img, crop } = await renderWith(S, { mode: 'light', method: 'reflect', base });
  const fits = s.clean.map((c) => psnr(img, cropTo(c, crop))); const bj = S.light.baseFrame;
  console.log(`reflect base=${base ?? 'auto'} -> chosen base ${bj}: PSNR vs clean[base] ${f2(psnr(img, cropTo(s.clean[bj], crop)))} dB  (best of all cleans ${f2(Math.max(...fits))})  magenta B ${f3(meanColor(img, { x: 335 - crop.x, y: 255 - crop.y, w: 50, h: 40 })[2])}  ${Math.round(performance.now() - t)} ms`);
  savePng(`tests/out/session_reflect_${base ?? 'auto'}.png`, img);
}
