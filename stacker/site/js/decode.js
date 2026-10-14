// decode.js — turn a picked File into pixels for the worker (main thread: Safari decodes HEIC natively here).
import exifr from '../vendor/exifr/exifr.mjs';

export const PRORAW_TIP = 'Tip: Settings › Camera › Formats › ProRAW Format → “JPEG Lossless (Most Compatible)”.';
const isDng = (f) => /\.dng$/i.test(f.name) || f.type === 'image/x-adobe-dng' || f.type === 'image/dng';
const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type);

export async function readExif(file) {
  try {
    const e = await exifr.parse(file, { tiff: true, exif: true, gps: false, interop: false, ifd1: false, makerNote: false, translateValues: false,
      pick: ['Make', 'Model', 'ExposureTime', 'FNumber', 'ISO', 'ISOSpeedRatings', 'ExposureBiasValue', 'ExposureCompensation', 'FocalLength', 'LensModel', 'DateTimeOriginal', 'Orientation', 'SubjectDistance', 'Compression'] });
    if (!e) return {};
    const out = {}; for (const [k, v] of Object.entries(e)) out[k] = v instanceof Date ? fmtDate(v) : Array.isArray(v) ? v[0] : v;
    return out;
  } catch (err) { return {}; }
}
function fmtDate(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

async function bitmapFrom(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { // fallback through an <img> (older Safari, odd JPEGs)
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode(); return await createImageBitmap(img); }
    finally { URL.revokeObjectURL(url); }
  }
}

// largest embedded JPEG in a TIFF/DNG (IFD0, SubIFDs, JPEGInterchangeFormat), verified by SOI marker
export function largestEmbeddedJpeg(buf) {
  const dv = new DataView(buf); const le = dv.getUint16(0) === 0x4949; const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const seen = new Set(), cands = [];
  const val = (o, type, count) => { const sz = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] * count; const p = sz > 4 ? u32(o + 8) : o + 8; const rd = (i) => (type === 3 ? u16(p + 2 * i) : u32(p + 4 * i)); return Array.from({ length: count }, (_, i) => rd(i)); };
  const walk = (off, depth) => {
    if (!off || off + 2 > buf.byteLength || seen.has(off) || depth > 4) return; seen.add(off);
    const n = u16(off); const t = {};
    for (let i = 0; i < n; i++) { const e = off + 2 + 12 * i; if (e + 12 > buf.byteLength) break; const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4); if ([3, 4].includes(type) && cnt < 4096) t[tag] = val(e, type, cnt); }
    if (t[0x201] && t[0x202]) cands.push([t[0x201][0], t[0x202][0]]);
    if (t[0x103] && (t[0x103][0] === 7 || t[0x103][0] === 6) && t[0x111] && t[0x117] && t[0x111].length === 1 && (!t[0x106] || t[0x106][0] === 6)) cands.push([t[0x111][0], t[0x117][0]]);
    if (t[0x14a]) for (const s of t[0x14a]) walk(s, depth + 1);
    const next = off + 2 + 12 * n; if (next + 4 <= buf.byteLength) walk(u32(next), depth + 1);
  };
  walk(u32(4), 0);
  const u8 = new Uint8Array(buf); let best = null;
  for (const [o, l] of cands) if (o + l <= buf.byteLength && u8[o] === 0xff && u8[o + 1] === 0xd8 && (!best || l > best[1])) best = [o, l];
  return best ? new Blob([u8.subarray(best[0], best[0] + best[1])], { type: 'image/jpeg' }) : null;
}

let librawOk = null;
async function decodeDngLibRaw(file) {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('RAW engine needs cross-origin isolation');
  const { default: LibRaw } = await import('../vendor/libraw/index.js');
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(await file.arrayBuffer()), { outputBps: 16, useCameraWb: true, noAutoBright: true, outputColor: 1, gamm: [1 / 2.4, 12.92], userQual: 3 });
    const img = await raw.imageData();
    if (!img || !img.data || img.colors < 3) throw new Error('LibRaw returned no image');
    const data = img.data instanceof Uint16Array ? img.data : new Uint16Array(img.data.buffer || img.data);
    return { pixels: { W: img.width, H: img.height, ch: img.colors, bits: 16, buf: data.buffer } };
  } finally { try { raw.dispose(); } catch (e) { /* ignore */ } }
}

// returns { name, bitmap | pixels, exif, head(ArrayBuffer|null), note }
export async function decodeFile(file) {
  const exif = await readExif(file); let note = '';
  if (isDng(file)) {
    const jxl = exif.Compression === 52546; // DNG 1.7 JPEG XL (iPhone 16 Pro+ ProRAW option)
    if (!jxl) {
      try { const r = await decodeDngLibRaw(file); librawOk = true; return { name: file.name, ...r, exif, head: null, note: '', raw: true }; }
      catch (e) { note = 'RAW decode failed — used the embedded preview. ' + PRORAW_TIP; }
    } else note = 'JPEG XL ProRAW — used the embedded preview. ' + PRORAW_TIP;
    const prev = largestEmbeddedJpeg(await file.arrayBuffer());
    if (!prev) throw new Error(`${file.name}: no decodable image inside this DNG. ${PRORAW_TIP}`);
    return { name: file.name, bitmap: await bitmapFrom(prev), exif, head: null, note };
  }
  let bitmap;
  try { bitmap = await bitmapFrom(file); }
  catch (e) { throw new Error(isHeic(file) ? `${file.name}: this browser can’t open HEIC. Open Stacker in Safari on iPhone, or export as JPEG.` : `${file.name}: couldn’t read this image.`); }
  const head = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name) ? await file.slice(0, 256 * 1024).arrayBuffer() : null;
  return { name: file.name, bitmap, exif, head, note };
}

// largest 2D-canvas area this browser allows (iOS ≤17: 16.7 MP, iOS 18+: 67 MP)
export function maxCanvasArea() {
  const tryArea = (w, h) => { try { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); if (!x) return false; x.fillStyle = '#f00'; x.fillRect(w - 1, h - 1, 1, 1); const ok = x.getImageData(w - 1, h - 1, 1, 1).data[0] === 255; c.width = c.height = 0; return ok; } catch (e) { return false; } };
  for (const s of [8192, 6144, 4096, 2048]) if (tryArea(s, s)) return s * s;
  return 2048 * 2048;
}
