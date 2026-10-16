// exporter.js — render the stack tile by tile and stream it into the JPEG encoder (pure JS, no DOM; runs in the worker and in Node tests).
//
// Memory: only one tile ROW of the output is held at a time (plus the encoder's few MCU rows and the compressed bytes), so the full source
// resolution (12–48 MP) can be saved on a phone. Tiles arrive left to right, top to bottom, which is exactly the order a baseline JPEG needs.
import { JpegEncoder } from './jpegenc.js';

function toBin(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; }

// Build a complete EXIF APP1 segment (FF E1 + length + "Exif\0\0" + TIFF) for the stacked image: the reference frame's own EXIF when its
// JPEG header is available, else tags rebuilt from the parsed values (HEIC / DNG reference). Returns null if metadata cannot be written.
export async function buildExifSegment(head, info, W, H, loadPiexif = () => import('../vendor/piexif.mjs')) {
  const { default: piexif } = await loadPiexif();
  let ex = null;
  if (head) { try { ex = piexif.load(toBin(new Uint8Array(head))); } catch (e) { ex = null; } }
  const I = piexif.ImageIFD, X = piexif.ExifIFD;
  if (!ex) {
    ex = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null }; const i = info || {};
    if (i.Make) ex['0th'][I.Make] = String(i.Make); if (i.Model) ex['0th'][I.Model] = String(i.Model);
    const rat = (v) => { const d = 10000; return [Math.round(v * d), d]; };
    if (i.ExposureTime) ex.Exif[X.ExposureTime] = rat(i.ExposureTime); if (i.FNumber) ex.Exif[X.FNumber] = rat(i.FNumber);
    if (i.ISO) ex.Exif[X.ISOSpeedRatings] = Math.round(i.ISO); if (i.FocalLength) ex.Exif[X.FocalLength] = rat(i.FocalLength);
    if (i.LensModel) ex.Exif[X.LensModel] = String(i.LensModel);
    if (i.DateTimeOriginal) ex.Exif[X.DateTimeOriginal] = String(i.DateTimeOriginal);
  }
  const now = new Date(), p = (n) => String(n).padStart(2, '0');
  ex['0th'][I.Orientation] = 1; ex['0th'][I.Software] = 'Stacker'; ex['0th'][I.DateTime] = `${now.getFullYear()}:${p(now.getMonth() + 1)}:${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  delete ex['0th'][I.XResolution]; delete ex['0th'][I.YResolution];
  ex.Exif = ex.Exif || {}; ex.Exif[X.PixelXDimension] = W; ex.Exif[X.PixelYDimension] = H; delete ex.Exif[X.MakerNote]; delete ex.Exif[X.ComponentsConfiguration];
  ex['1st'] = {}; ex.thumbnail = null; // the old thumbnail would show the un-stacked frame
  delete ex.Interop;
  const bytes = piexif.dump(ex); // "Exif\0\0" + TIFF
  if (bytes.length + 2 > 65535) return null;
  const app1 = new Uint8Array(bytes.length + 4); app1[0] = 0xff; app1[1] = 0xe1; app1[2] = ((bytes.length + 2) >> 8) & 0xff; app1[3] = (bytes.length + 2) & 0xff;
  for (let i = 0; i < bytes.length; i++) app1[4 + i] = bytes.charCodeAt(i);
  return app1;
}

// Renders the session at the requested size and returns { blob, w, h, bytes, ms }.
//   targetMP: output megapixels (null / 0 = the full source resolution)
export async function exportJpeg(S, { targetMP = null, quality = 95, subsample = false, exifHead = null, exifInfo = null } = {}, { progress = () => {}, log = () => {}, tile = 1024 } = {}) {
  const s = S.exportScale(targetMP), cr = S.crop, OW = Math.round(cr.w * s), OH = Math.round(cr.h * s), t0 = performance.now();
  let exif = null; try { exif = await buildExifSegment(exifHead, exifInfo, OW, OH); } catch (e) { log('EXIF skipped: ' + (e && e.message)); }
  const enc = new JpegEncoder({ width: OW, height: OH, quality, subsample, exif });
  let band = null, bandRows = 0;
  await S.render(s, {
    tile, full: true,
    onTile: (x, y, tw, th, rgba) => {
      if (x === 0) { bandRows = th; if (!band || band.length < OW * th * 4) band = new Uint8Array(OW * th * 4); }
      for (let r = 0; r < th; r++) band.set(rgba.subarray(r * tw * 4, (r + 1) * tw * 4), (r * OW + x) * 4);
      if (x + tw >= OW) enc.push(band, bandRows, 4); // the tile row is complete
    },
  });
  S.checkCancel(); progress('Finishing', 0.99);
  const { chunks, size } = enc.finish();
  return { blob: new Blob(chunks, { type: 'image/jpeg' }), w: OW, h: OH, bytes: size, ms: Math.round(performance.now() - t0) };
}
