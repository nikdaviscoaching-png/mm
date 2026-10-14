// Builds JPEG test photos (with ground truth PNGs) for the browser tests.  node tests/e2e/fixtures.js [outdir]
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { makeFocusSeries, makeCombinedSeries, standardSpecs, standardLightingScenario, makeImg } from '../lib/synth.js';
import { savePng } from '../lib/png.js';
import { encodeJpeg } from '../../site/js/jpegenc.js';
import * as E from '../../site/js/engine.js';

const up = (im, W, H) => { const o = makeImg(W, H); for (const c of ['r', 'g', 'b']) o[c] = E.resizeBilinear(im[c], im.w, im.h, W, H); return o; };
const jpg = (im, q = 95) => { const n = im.w * im.h, a = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = Math.round(Math.min(1, Math.max(0, im.r[i])) * 255); a[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, im.g[i])) * 255); a[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, im.b[i])) * 255); a[i * 4 + 3] = 255; } return encodeJpeg(a, im.w, im.h, { quality: q }); };
export function buildFixtures(dir, { big = true } = {}) {
  mkdirSync(dir, { recursive: true }); const out = {};
  const W = 1536, H = 1152;
  { const s = makeFocusSeries({ seed: 3, breathing: 0 }); out.focus = s.frames.map((f, i) => { const p = `${dir}/focus_${i}.jpg`; writeFileSync(p, jpg(up(f, W, H))); return p; }); savePng(`${dir}/focus_truth.png`, up(s.groundTruth, W, H)); }
  { const s = standardLightingScenario(); out.light = s.frames.map((f, i) => { const p = `${dir}/light_${i}.jpg`; writeFileSync(p, jpg(up(f, W, H))); return p; }); s.clean.forEach((c, j) => savePng(`${dir}/light_truth_${j}.png`, up(c, W, H))); }
  { const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }); out.both = s.frames.map((f, i) => { const p = `${dir}/both_${i}.jpg`; writeFileSync(p, jpg(up(f, W, H))); return p; }); s.clean.forEach((c, j) => savePng(`${dir}/both_truth_${j}.png`, up(c, W, H))); out.bothLights = s.lights; }
  { const s = makeFocusSeries({ seed: 3, breathing: 0, frames: 3 }); out.mid = s.frames.map((f, i) => { const p = `${dir}/mid_${i}.jpg`; writeFileSync(p, jpg(up(f, 3000, 2000))); return p; }); } // 6 MP: enough for the smaller save sizes to be offered
  if (big) { // 24 MP: the focus scene enlarged
    const s = makeFocusSeries({ seed: 3, breathing: 0, frames: 5 }), BW = 6000, BH = 4000;
    out.big = s.frames.map((f, i) => { const p = `${dir}/big_${i}.jpg`; writeFileSync(p, jpg(up(f, BW, BH), 92)); return p; });
  }
  writeFileSync(`${dir}/fixtures.json`, JSON.stringify(out)); return out;
}
if (import.meta.url === `file://${process.argv[1]}`) { const dir = process.argv[2] || 'tests/out/fixtures'; const t = Date.now(); const o = buildFixtures(dir); console.log('fixtures in', dir, Object.entries(o).map(([k, v]) => `${k}:${v.length}`).join(' '), `(${Date.now() - t} ms)`); }
