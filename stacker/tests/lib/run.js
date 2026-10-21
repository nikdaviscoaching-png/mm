// run.js — feed float RGB frames to a Session exactly as the app does, and bring the result back as a float image.
import { makeImg, cropImg } from './synth.js';

// Pack a float image (display-encoded) into interleaved 8- or 16-bit rows, like a decoded JPEG / RAW.
function rowsOf(img, bits) {
  const T = bits === 16 ? Uint16Array : Uint8Array, mx = bits === 16 ? 65535 : 255, W = img.w;
  return async (y0, n) => {
    const d = new T(W * n * 3);
    for (let y = 0; y < n; y++) for (let x = 0; x < W; x++) { const s = (y0 + y) * W + x, o = (y * W + x) * 3; d[o] = Math.round(img.r[s] * mx); d[o + 1] = Math.round(img.g[s] * mx); d[o + 2] = Math.round(img.b[s] * mx); }
    return { data: d, ch: 3 };
  };
}
export function rgbaToImg(rgba, w, h) {
  const o = makeImg(w, h);
  for (let i = 0; i < w * h; i++) { o.r[i] = rgba[i * 4] / 255; o.g[i] = rgba[i * 4 + 1] / 255; o.b[i] = rgba[i * 4 + 2] / 255; }
  return o;
}
// mods = { Session, MemStore }  (the engine under test: baseline v1.1.1 or the current site/js)
export async function loadSession(mods, frames, { bits = 8, workMax = 2048, exifs = null } = {}) {
  const S = new mods.Session(new mods.MemStore(), { workMax, progress: () => {} });
  for (let i = 0; i < frames.length; i++) await S.addFrame({ name: 'f' + i, W: frames[i].w, H: frames[i].h, bits, exif: exifs ? exifs[i] : {} }, rowsOf(frames[i], bits));
  const report = await S.analyze();
  return { S, report };
}
export async function renderWith(S, spec) {
  await S.computeWeights(spec);
  const prev = await S.renderPreview();
  return { img: rgbaToImg(prev.rgba, prev.w, prev.h), crop: S.crop };
}
// one-shot: load, analyse, weigh and render; also returns the truth cropped to the output rectangle
export async function stack(mods, frames, spec, opts = {}) {
  const t0 = performance.now(), { S, report } = await loadSession(mods, frames, opts), t1 = performance.now();
  const { img, crop } = await renderWith(S, spec), t2 = performance.now();
  return { S, report, img, crop, ms: { analyze: Math.round(t1 - t0), stack: Math.round(t2 - t1) } };
}
export const cropTo = (img, crop) => cropImg(img, crop.x, crop.y, crop.w, crop.h);
