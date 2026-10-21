import test from 'node:test';
import assert from 'node:assert/strict';
import { JpegEncoder, encodeJpeg } from '../../site/js/jpegenc.js';
import { specimenTexture } from '../lib/synth.js';

const rgba = (w, h, seed = 5) => { const t = specimenTexture(w, h, seed), a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = t.r[i] * 255; a[i * 4 + 1] = t.g[i] * 255; a[i * 4 + 2] = t.b[i] * 255; a[i * 4 + 3] = 255; } return a; };
const encodeIn = (px, w, h, step, opts = {}) => { const e = new JpegEncoder({ width: w, height: h, ...opts }); for (let y = 0; y < h; y += step) { const n = Math.min(step, h - y); e.push(px.subarray(y * w * 4, (y + n) * w * 4), n, 4); } return Buffer.concat(e.finish().chunks.map((c) => Buffer.from(c))); };

test('output is identical however the rows are pushed', () => {
  const w = 211, h = 163, px = rgba(w, h);
  const ref = encodeIn(px, w, h, h); for (const step of [1, 7, 16, 100]) assert.ok(ref.equals(encodeIn(px, w, h, step)), `step ${step}`);
  const sub = encodeIn(px, w, h, h, { subsample: true }); assert.ok(sub.equals(encodeIn(px, w, h, 5, { subsample: true })));
});

test('markers, dimensions and EXIF placement are valid', () => {
  const w = 333, h = 211, exif = new Uint8Array([0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0, 0]), j = Buffer.from(encodeJpeg(rgba(w, h), w, h, { quality: 92, exif }));
  assert.deepEqual([...j.subarray(0, 2)], [0xff, 0xd8]); assert.deepEqual([...j.subarray(j.length - 2)], [0xff, 0xd9]);
  assert.deepEqual([...j.subarray(2, 12)], [...exif], 'EXIF segment directly after SOI');
  const sof = j.indexOf(Buffer.from([0xff, 0xc0])); assert.equal(j.readUInt16BE(sof + 5), h); assert.equal(j.readUInt16BE(sof + 7), w); assert.equal(j[sof + 9], 3);
  // no stray marker bytes inside the entropy-coded data: every 0xFF is followed by 0x00 (or the final EOI)
  const sos = j.indexOf(Buffer.from([0xff, 0xda])), body = j.subarray(sos + 14, j.length - 2); for (let i = 0; i < body.length - 1; i++) if (body[i] === 0xff) assert.equal(body[i + 1], 0, 'byte stuffing at ' + i);
});

test('quality changes size; odd and tiny sizes work', () => {
  const w = 120, h = 90, px = rgba(w, h); assert.ok(encodeJpeg(px, w, h, { quality: 98 }).length > encodeJpeg(px, w, h, { quality: 60 }).length * 1.5);
  for (const [a, b] of [[1, 1], [8, 8], [9, 17], [17, 9]]) { const j = encodeJpeg(rgba(a, b), a, b, {}); assert.ok(j.length > 100 && j[0] === 0xff); }
  assert.throws(() => new JpegEncoder({ width: 0, height: 5 })); assert.throws(() => { const e = new JpegEncoder({ width: 4, height: 4 }); e.finish(); }, /rows/);
});
