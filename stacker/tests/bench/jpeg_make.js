// Writes JPEGs from the streaming encoder (various sizes/qualities/subsampling) plus the raw RGB they came from, for decoding by an independent decoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { JpegEncoder, encodeJpeg } from '../../site/js/jpegenc.js';
import { specimenTexture } from '../lib/synth.js';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const cases = [[512, 384, 95, false], [512, 384, 95, true], [333, 211, 92, false], [333, 211, 92, true], [17, 9, 95, false], [1, 1, 95, false], [16, 16, 100, false], [640, 480, 75, false], [1023, 767, 98, true]];
const meta = [];
for (const [w, h, q, sub] of cases) {
  const tex = specimenTexture(w, h, 5), rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = Math.round(tex.r[i] * 255); rgba[i * 4 + 1] = Math.round(tex.g[i] * 255); rgba[i * 4 + 2] = Math.round(tex.b[i] * 255); rgba[i * 4 + 3] = 255; }
  const name = `t_${w}x${h}_q${q}_${sub ? '420' : '444'}`;
  writeFileSync(`${out}/${name}.jpg`, encodeJpeg(rgba, w, h, { quality: q, subsample: sub })); writeFileSync(`${out}/${name}.rgb`, Buffer.from(rgba.filter((_, i) => i % 4 !== 3)));
  meta.push({ name, w, h, q, sub });
}
// streaming equivalence: pushing 1 row, 7 rows or 100 rows at a time must give byte-identical output
{ const w = 300, h = 250, tex = specimenTexture(w, h, 9), rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = tex.r[i] * 255; rgba[i * 4 + 1] = tex.g[i] * 255; rgba[i * 4 + 2] = tex.b[i] * 255; rgba[i * 4 + 3] = 255; }
  const enc = (step) => { const e = new JpegEncoder({ width: w, height: h, quality: 92 }); for (let y = 0; y < h; y += step) { const n = Math.min(step, h - y); e.push(rgba.subarray(y * w * 4, (y + n) * w * 4), n, 4); } const { chunks } = e.finish(); return Buffer.concat(chunks.map((c) => Buffer.from(c))); };
  const a = enc(1), b = enc(7), c = enc(100), d = enc(h); console.log('streaming equivalence (1/7/100/all rows per push):', a.equals(b) && b.equals(c) && c.equals(d) ? 'byte-identical' : 'DIFFERENT'); }
writeFileSync(`${out}/meta.json`, JSON.stringify(meta));
