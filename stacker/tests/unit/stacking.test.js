// Quality guards: the engines are scored against ground truth on the synthetic scenes (thresholds sit ~1 dB under what they achieve),
// through the real Session (alignment, 16-bit work frames, tiled render) — not just the isolated modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFocusSeries, standardLightingScenario, makeCombinedSeries, standardSpecs, makeLightingSeries, frameSpec, glare, streak } from '../lib/synth.js';
import { psnr, fitPSNR, maxLuma, sharpness, meanColor } from '../lib/metrics.js';
import { loadSession, renderWith, cropTo, stack } from '../lib/run.js';
import * as P from '../../site/js/pipeline.js';
import { MemStore } from '../../site/js/store.js';
import { exportJpeg } from '../../site/js/exporter.js';

const mods = { Session: P.Session, MemStore };

test('focus: the default "sharp" method beats the old default and approaches the depth oracle', async () => {
  const s = makeFocusSeries({ seed: 3, breathing: 0 }), r = await stack(mods, s.frames, { mode: 'focus', method: 'sharp' }), truth = cropTo(s.groundTruth, r.crop);
  const best = Math.max(...s.frames.map((f) => psnr(cropTo(f, r.crop), truth))), got = psnr(r.img, truth);
  assert.ok(got > 29.8, `sharp ${got.toFixed(2)} dB`); assert.ok(got > best + 6, 'clearly beats the best single frame');
  const old = await stack(mods, s.frames, { mode: 'focus', method: 'depth' }); assert.ok(got > psnr(old.img, truth) + 0.5, 'beats the v1.1.1 default method');
});

test('lighting: glare, magenta reflection and shadow are replaced; the natural light is kept', async () => {
  const s = standardLightingScenario(), { S } = await loadSession(mods, s.frames); assert.equal(P.autoSpec(S.detect).method, 'reflect', 'auto picks the reflection-aware method');
  const { img, crop } = await renderWith(S, { mode: 'light', method: 'reflect' }), base = S.light.baseFrame, clean = cropTo(s.clean[base], crop);
  assert.ok(psnr(img, clean) > 33, `${psnr(img, clean).toFixed(2)} dB vs clean[${base}]`);
  const mg = meanColor(img, { x: 335 - crop.x, y: 255 - crop.y, w: 50, h: 40 }), mc = meanColor(clean, { x: 335 - crop.x, y: 255 - crop.y, w: 50, h: 40 });
  assert.ok(Math.abs(mg[2] - mc[2]) < 0.05, 'magenta tint removed');
  // the user can choose the natural light: the result then follows that photo
  const forced = await renderWith(S, { mode: 'light', method: 'reflect', base: 0 }); assert.equal(S.light.baseFrame, 0);
  assert.ok(psnr(forced.img, cropTo(s.clean[0], forced.crop)) > 27, 'forced base 0');
});

test('lighting: a narrow polished highlight in the base survives', async () => {
  const sp = makeLightingSeries({ specs: [frameSpec({ shadeAngle: 0, streaks: [streak(0.45, 0.38, 0.30, 2.2, 3.4, 3.5, 0.45)] }), frameSpec({ shadeAngle: 1.6, glares: [glare(0.72, 0.30, 0.07, 3.5)] }), frameSpec({ shadeAngle: 3.1, glares: [glare(0.30, 0.80, 0.06, 3.0)] }), frameSpec({ shadeAngle: 4.7 })] });
  const { S } = await loadSession(mods, sp.frames), { img, crop } = await renderWith(S, { mode: 'light', method: 'reflect', base: 0 }), R = { x: 68 - crop.x, y: 128 - crop.y, w: 20, h: 22 };
  const baseMax = maxLuma(cropTo(sp.frames[0], crop), R), cleanMax = maxLuma(cropTo(sp.clean[0], crop), R);
  assert.ok((maxLuma(img, R) - cleanMax) / (baseMax - cleanMax) > 0.85, 'highlight kept at >= 85% of its excess brightness');
  assert.ok(sharpness(img, R) > 0.9 * sharpness(cropTo(sp.frames[0], crop), R), 'and still crisp');
});

test('focus + lighting together beats v1.1.1 and either single-purpose mode', async () => {
  const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { S } = await loadSession(mods, s.frames);
  const fit = (img, crop) => Math.max(...s.clean.map((c) => fitPSNR(img, cropTo(c, crop))));
  const both = await renderWith(S, { mode: 'both', glare: 0.6, detail: 0.5, brightness: 0 }), focusOnly = await renderWith(S, { mode: 'focus', method: 'sharp', glare: 0.6, detail: 0.5, brightness: 0 });
  const g = fit(both.img, both.crop), f = fit(focusOnly.img, focusOnly.crop);
  assert.ok(g > 24.5, `both ${g.toFixed(2)} dB (v1.1.1: 23.5)`); assert.ok(g > f + 0.5, `both ${g.toFixed(2)} vs focus-only ${f.toFixed(2)}`);
});

test('export: full-resolution JPEG matches the preview, with EXIF', async () => {
  const s = makeFocusSeries({ seed: 3, breathing: 0, width: 256, height: 192 }), { S } = await loadSession(mods, s.frames); await S.computeWeights({ mode: 'focus', method: 'sharp', glare: 0.6, detail: 0.5, brightness: 0 });
  const r = await exportJpeg(S, { targetMP: null, quality: 95, exifInfo: { Make: 'X', Model: 'Y', ISO: 100 } }), bytes = Buffer.from(await r.blob.arrayBuffer());
  assert.equal(r.w, S.crop.w); assert.equal(r.h, S.crop.h); assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]); assert.ok(bytes.includes(Buffer.from('Exif')) && bytes.includes(Buffer.from('Stacker')));
  const small = await exportJpeg(S, { targetMP: 0.02 }); assert.ok(small.w * small.h < 0.03e6 && small.w * small.h > 0.015e6, `${small.w}x${small.h}`);
});

test('retouch: painting a frame into a region changes that region and undo restores it', async () => {
  const s = makeFocusSeries({ seed: 3, breathing: 0, width: 256, height: 192 }), { S } = await loadSession(mods, s.frames); await S.computeWeights({ mode: 'focus', method: 'sharp', glare: 0.6, detail: 0.5, brightness: 0 });
  const before = (await S.renderPreview()).rgba.slice(), res = await S.stroke([{ x: 60, y: 60 }, { x: 140, y: 80 }], 20, 0.3, 0);
  assert.ok(res && res.rect.w > 0); const after = S.preview; let diff = 0; for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i]); assert.ok(diff > 1000, 'region changed');
  await S.undoStroke(); let diff2 = 0; for (let i = 0; i < before.length; i++) diff2 += Math.abs(before[i] - S.preview[i]); assert.ok(diff2 < diff * 0.05, 'undo restores');
});
