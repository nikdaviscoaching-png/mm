// png.js — tiny PNG writer so synthetic scenes and results can be looked at (RGB8, no dependencies).
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { clamp01, makeImg } from './synth.js';

const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, crc]); };
export function pngBuffer(w, h, rgb8) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb8.copy ? rgb8.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb8.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
export function savePng(path, img) {
  mkdirSync(dirname(path), { recursive: true });
  const o = Buffer.alloc(img.w * img.h * 3);
  for (let i = 0; i < img.w * img.h; i++) { o[i * 3] = Math.round(clamp01(img.r[i]) * 255); o[i * 3 + 1] = Math.round(clamp01(img.g[i]) * 255); o[i * 3 + 2] = Math.round(clamp01(img.b[i]) * 255); }
  writeFileSync(path, pngBuffer(img.w, img.h, o));
}
// grid montage for eyeballing; cells are cropped/padded to the first image's size
export function montage(images, columns, bg = 0.1) {
  const cw = images[0].w, ch = images[0].h, rows = Math.ceil(images.length / columns), out = makeImg(cw * columns, ch * rows, bg);
  images.forEach((im, k) => { const ox = (k % columns) * cw, oy = Math.floor(k / columns) * ch; for (let y = 0; y < Math.min(ch, im.h); y++) for (let x = 0; x < Math.min(cw, im.w); x++) { const s = y * im.w + x, d = (oy + y) * out.w + ox + x; out.r[d] = im.r[s]; out.g[d] = im.g[s]; out.b[d] = im.b[s]; } });
  return out;
}
