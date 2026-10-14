// worker.js — owns the stacking Session; all heavy work happens here (off the UI thread).
import { Session, Cancelled, autoSpec, PALETTE } from './pipeline.js';
import { MemStore, OpfsStore } from './store.js';
import * as E from './engine.js';

let S = null, storeKind = 'memory';
const post = (m, t) => self.postMessage(m, t || []);
const progress = (stage, frac, detail) => post({ type: 'progress', stage, frac, detail });

async function newSession(workMax) {
  if (S) { try { await S.store.clear(); } catch (e) { /* ignore */ } }
  let store = await OpfsStore.open(); storeKind = store ? 'opfs' : 'memory'; if (!store) store = new MemStore();
  S = new Session(store, { workMax, progress });
}
function imgMsg(o) { return { w: o.w, h: o.h, buf: o.rgba.buffer }; }
function thumb(f) {
  const w = S.ww, h = S.wh, t = 160, sc = Math.max(w, h) / t, tw = Math.round(w / sc), th = Math.round(h / sc);
  const pl = S.workPlanes(f); const rgba = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const q = Math.min(h - 1, Math.round((y + 0.5) * sc)) * w + Math.min(w - 1, Math.round((x + 0.5) * sc)), o = (y * tw + x) * 4; rgba[o] = E.oetfFast(pl[0][q]) * 255; rgba[o + 1] = E.oetfFast(pl[1][q]) * 255; rgba[o + 2] = E.oetfFast(pl[2][q]) * 255; rgba[o + 3] = 255; }
  return { w: tw, h: th, rgba };
}

// read rows from an ImageBitmap through a small OffscreenCanvas strip (never a full-size canvas)
function bitmapRows(bmp) {
  const W = bmp.width; const cv = new OffscreenCanvas(W, 256); const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  return async (y0, n) => { ctx.clearRect(0, 0, W, 256); ctx.drawImage(bmp, 0, y0, W, n, 0, 0, W, n); return { data: ctx.getImageData(0, 0, W, n).data, ch: 4 }; };
}

async function renderAll() {
  const t0 = performance.now();
  const prev = await S.renderPreview(); const before = S.beforeImage(); const sm = S.sourceMap();
  return { preview: { w: prev.w, h: prev.h, buf: prev.rgba.slice().buffer }, before: imgMsg(before), srcmap: imgMsg(sm), share: sm.share, ms: Math.round(performance.now() - t0) };
}

// ---- export: full-res tiled render → RGBA buffer → MozJPEG (jSquash) → EXIF (piexif) ----
async function doExport({ targetMP, quality = 92, exifHead, exifInfo }) {
  const s = S.exportScale(targetMP); const cr = S.crop; const OW = Math.round(cr.w * s), OH = Math.round(cr.h * s);
  const t0 = performance.now(); const out = new Uint8ClampedArray(OW * OH * 4);
  await S.render(s, { tile: 1024, full: true, onTile: (x, y, tw, th, t) => { for (let r = 0; r < th; r++) out.set(t.subarray(r * tw * 4, (r + 1) * tw * 4), ((y + r) * OW + x) * 4); } });
  const tRender = performance.now() - t0; S.checkCancel(); progress('Encoding JPEG', 0.2);
  let jpeg, encoder = 'mozjpeg';
  try {
    const { default: encode } = await import('../vendor/jsquash/encode.js');
    jpeg = new Uint8Array(await encode({ data: out, width: OW, height: OH }, { quality, auto_subsample: false, chroma_subsample: 1, progressive: true, optimize_coding: true }));
  } catch (e) {
    encoder = 'canvas';
    const cv = new OffscreenCanvas(OW, OH); cv.getContext('2d').putImageData(new ImageData(out, OW, OH), 0, 0);
    jpeg = new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })).arrayBuffer());
  }
  S.checkCancel(); progress('Writing metadata', 0.8);
  try { jpeg = await withExif(jpeg, OW, OH, exifHead, exifInfo); } catch (e) { post({ type: 'log', msg: 'EXIF skipped: ' + e.message }); }
  return { jpeg: jpeg.buffer, w: OW, h: OH, encoder, ms: { render: Math.round(tRender), total: Math.round(performance.now() - t0) } };
}
function toBin(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; }
async function withExif(jpeg, W, H, head, info) {
  const { default: piexif } = await import('../vendor/piexif.mjs');
  let ex = null;
  if (head) { try { ex = piexif.load(toBin(new Uint8Array(head))); } catch (e) { ex = null; } }
  if (!ex) { // build from parsed tags (HEIC / DNG reference)
    ex = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null }; const i = info || {}; const I = piexif.ImageIFD, X = piexif.ExifIFD;
    if (i.Make) ex['0th'][I.Make] = String(i.Make); if (i.Model) ex['0th'][I.Model] = String(i.Model);
    const rat = (v) => { const d = 10000; return [Math.round(v * d), d]; };
    if (i.ExposureTime) ex.Exif[X.ExposureTime] = rat(i.ExposureTime); if (i.FNumber) ex.Exif[X.FNumber] = rat(i.FNumber);
    if (i.ISO) ex.Exif[X.ISOSpeedRatings] = Math.round(i.ISO); if (i.FocalLength) ex.Exif[X.FocalLength] = rat(i.FocalLength);
    if (i.LensModel) ex.Exif[X.LensModel] = String(i.LensModel);
    if (i.DateTimeOriginal) ex.Exif[X.DateTimeOriginal] = String(i.DateTimeOriginal);
  }
  const I = piexif.ImageIFD, X = piexif.ExifIFD; const now = new Date(); const p = (n) => String(n).padStart(2, '0');
  ex['0th'][I.Orientation] = 1; ex['0th'][I.Software] = 'Stacker PWA'; ex['0th'][I.DateTime] = `${now.getFullYear()}:${p(now.getMonth() + 1)}:${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  delete ex['0th'][I.XResolution]; delete ex['0th'][I.YResolution];
  ex.Exif = ex.Exif || {}; ex.Exif[X.PixelXDimension] = W; ex.Exif[X.PixelYDimension] = H; delete ex.Exif[X.MakerNote]; delete ex.Exif[X.ComponentsConfiguration];
  ex['1st'] = {}; ex.thumbnail = null; // drop the old thumbnail (it would show the un-stacked frame)
  for (const k of ['Interop']) delete ex[k];
  let bytes = piexif.dump(ex); // "Exif\0\0" + TIFF
  const app1 = new Uint8Array(bytes.length + 4); app1[0] = 0xff; app1[1] = 0xe1; app1[2] = ((bytes.length + 2) >> 8) & 0xff; app1[3] = (bytes.length + 2) & 0xff;
  for (let i = 0; i < bytes.length; i++) app1[4 + i] = bytes.charCodeAt(i);
  // insert right after SOI, dropping an existing APP0/APP1 so EXIF comes first
  let pos = 2; while (jpeg[pos] === 0xff && (jpeg[pos + 1] === 0xe0 || jpeg[pos + 1] === 0xe1)) { pos += 2 + ((jpeg[pos + 2] << 8) | jpeg[pos + 3]); }
  const outb = new Uint8Array(2 + app1.length + jpeg.length - pos); outb[0] = 0xff; outb[1] = 0xd8; outb.set(app1, 2); outb.set(jpeg.subarray(pos), 2 + app1.length);
  return outb;
}

// A cancel only targets work that is running right now. A cancel that arrives while the worker is idle
// (e.g. Cancel tapped just as a job finished) must not leak into the next job (QA BUG-2).
let running = 0;
self.onmessage = async ({ data: m }) => {
  if (m.cmd === 'cancel') { if (S && running > 0) S.cancelFlag = true; return; }
  running++;
  const reply = (out, t) => post({ type: 'result', id: m.id, out }, t);
  try {
    switch (m.cmd) {
      case 'new': await newSession(m.workMax || 2048); reply({ store: storeKind }); break;
      case 'addFrame': {
        if (m.first) S.cancelFlag = false; let rows, W, H, bits = 8;
        if (m.bitmap) { rows = bitmapRows(m.bitmap); W = m.bitmap.width; H = m.bitmap.height; }
        else { const px = m.pixels; W = px.W; H = px.H; bits = px.bits; const T = bits === 16 ? Uint16Array : Uint8Array; const data = new T(px.buf); rows = async (y0, n) => ({ data: data.subarray(y0 * W * px.ch, (y0 + n) * W * px.ch), ch: px.ch }); }
        const r = await S.addFrame({ name: m.name, W, H, bits, exif: m.exif, note: m.note }, rows);
        if (m.bitmap) m.bitmap.close();
        const f = S.frames[r.id]; const t = thumb(f); reply({ id: r.id, W, H, thumb: imgMsg(t) }, [t.rgba.buffer]); break;
      }
      case 'analyze': { S.checkCancel(); const rep = await S.analyze(); reply({ report: rep, auto: autoSpec(rep.detect), palette: PALETTE }); break; }
      case 'include': { const ok = S.setInclude(m.i, m.on); reply({ ok, report: S.report(), auto: autoSpec(S.detect) }); break; }
      case 'stack': {
        S.cancelFlag = false; const t0 = performance.now(); await S.computeWeights(m.spec); const tw = performance.now() - t0;
        const r = await renderAll(); r.ms = { weights: Math.round(tw), render: r.ms }; r.cfg = { space: S.cfg.space, pixelOp: S.cfg.pixelOp, crop: S.crop };
        reply(r, [r.preview.buf, r.before.buf, r.srcmap.buf]); break;
      }
      case 'before': { const b = S.beforeImage(m.i); const o = imgMsg(b); reply(o, [o.buf]); break; }
      case 'stroke': case 'undo': {
        const res = m.cmd === 'stroke' ? await S.stroke(m.pts, m.radius, m.feather, m.frame) : await S.undoStroke();
        if (!res) { reply(null); break; }
        const cr = S.crop, r = res.rect; const sub = new Uint8ClampedArray(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) sub.set(S.preview.subarray(((y + r.y) * cr.w + r.x) * 4, ((y + r.y) * cr.w + r.x + r.w) * 4), y * r.w * 4);
        const sm = S.sourceMap(); reply({ rect: r, buf: sub.buffer, ms: res.ms, srcmap: imgMsg(sm), share: sm.share, undo: S.undo.length }, [sub.buffer]); break;
      }
      case 'clearRetouch': { S.override = null; S.undo = []; S.computeCoarse(); const r = await renderAll(); reply(r, [r.preview.buf, r.before.buf, r.srcmap.buf]); break; }
      case 'export': { S.cancelFlag = false; const r = await doExport(m); reply(r, [r.jpeg]); break; }
      case 'renderRaw': { // test hook: full-res RGBA for scoring against ground truth
        const cr = S.crop; const sc = m.scale || 1; const OW = Math.round(cr.w * sc), OH = Math.round(cr.h * sc); const out = new Uint8ClampedArray(OW * OH * 4); const t0 = performance.now();
        await S.render(sc, { tile: 1024, full: true, onTile: (x, y, tw, th, t) => { for (let r = 0; r < th; r++) out.set(t.subarray(r * tw * 4, (r + 1) * tw * 4), ((y + r) * OW + x) * 4); } });
        reply({ W: OW, H: OH, crop: cr, ref: S.ref, buf: out.buffer, ms: Math.round(performance.now() - t0) }, [out.buffer]); break;
      }
      case 'info': reply({ store: storeKind, frames: S ? S.frames.length : 0, undo: S && S.undo ? S.undo.length : 0 }); break;
      default: reply(null);
    }
  } catch (e) {
    post({ type: 'error', id: m.id, cancelled: e instanceof Cancelled || e.name === 'Cancelled', msg: e.message || String(e) });
  } finally { running--; if (!running && S) S.cancelFlag = false; }
};
post({ type: 'ready' });
