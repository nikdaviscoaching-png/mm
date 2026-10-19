// jpegenc.js — streaming baseline JPEG encoder (pure JS, no DOM).
//
// Why: the browser's canvas / WASM encoders need the WHOLE image in memory (and WASM needs a second copy). A 48 MP result is ~195 MB as RGBA,
// which an iPhone tab cannot afford. This encoder takes pixel rows as they are rendered (tile row by tile row) and emits the compressed bytes as
// it goes, so memory stays at a few MCU rows plus the (small) output, whatever the image size.
//
// Baseline sequential JPEG, standard Annex K Huffman tables (single pass: no whole-image statistics needed), 4:4:4 by default so saturated
// colour edges stay clean (4:2:0 optional), quality scaled exactly as libjpeg does. An EXIF APP1 segment can be supplied; it is written first.
// Standard (ITU-T T.81 Annex K) tables, taken from a reference libjpeg encoder.
const ZIGZAG = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
const BASE_Q = [new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]), new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99])];
const HUFF = {
  dc0: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ac0: { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125], vals: [
  1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7,
  34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240,
  36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40,
  41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73,
  74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105,
  106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137,
  138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167,
  168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197,
  198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226,
  227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248,
  249, 250] },
  dc1: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ac1: { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119], vals: [
  0, 1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113,
  19, 34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240,
  21, 98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38,
  39, 40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72,
  73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104,
  105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135,
  136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165,
  166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195,
  196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218,
  226, 227, 228, 229, 230, 231, 232, 233, 234, 242, 243, 244, 245, 246, 247, 248,
  249, 250] },
};

// AAN scale factors (libjpeg jfdctflt): the DCT below is the scaled float AAN transform; the scaling is folded into the quantiser divisors.
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];

function quantTable(quality, which) {
  const q = Math.min(100, Math.max(1, Math.round(quality))), scale = q < 50 ? 5000 / q : 200 - q * 2, out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.max(1, Math.floor((BASE_Q[which][i] * scale + 50) / 100)));
  return out; // natural (row-major) order
}
function huffTable(h) { // canonical codes, T.81 Annex C
  const code = new Uint16Array(256), size = new Uint8Array(256); let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) { for (let i = 0; i < h.bits[l - 1]; i++) { code[h.vals[k]] = c; size[h.vals[k]] = l; k++; c++; } c <<= 1; }
  return { code, size };
}
const bitLength = (v) => (v === 0 ? 0 : 32 - Math.clz32(v));

export class JpegEncoder {
  // exif: Uint8Array holding a complete APP1 segment (FF E1 + length + "Exif\0\0" + TIFF), or null
  constructor({ width, height, quality = 95, subsample = false, exif = null, chunkSize = 1 << 17 }) {
    if (!(width > 0 && height > 0) || width > 65535 || height > 65535) throw new Error('JPEG size out of range');
    this.w = width; this.h = height; this.sub = !!subsample; this.mcuW = this.sub ? 16 : 8; this.mcuH = this.mcuW;
    this.bw = Math.ceil(width / this.mcuW); this.pw = this.bw * this.mcuW; this.rows = 0; this.mcuRows = Math.ceil(height / this.mcuH); this.mcuRowDone = 0;
    this.Y = new Float32Array(this.pw * this.mcuH); this.Cb = new Float32Array(this.pw * this.mcuH); this.Cr = new Float32Array(this.pw * this.mcuH);
    this.qt = [quantTable(quality, 0), quantTable(quality, 1)];
    this.fd = this.qt.map((t) => { const f = new Float64Array(64); for (let i = 0; i < 64; i++) f[i] = 1 / (t[i] * AAN[i >> 3] * AAN[i & 7] * 8); return f; });
    this.dcH = [huffTable(HUFF.dc0), huffTable(HUFF.dc1)]; this.acH = [huffTable(HUFF.ac0), huffTable(HUFF.ac1)];
    this.blk = new Float64Array(64); this.q = new Int32Array(64); this.pred = [0, 0, 0];
    this.chunks = []; this.cs = chunkSize; this.cur = new Uint8Array(chunkSize); this.cp = 0; this.size = 0; this.acc = 0; this.nb = 0; this.done = false;
    this.header(exif);
  }
  byte(b) { if (this.cp === this.cs) { this.chunks.push(this.cur); this.size += this.cp; this.cur = new Uint8Array(this.cs); this.cp = 0; } this.cur[this.cp++] = b; }
  bytes(a) { for (let i = 0; i < a.length; i++) this.byte(a[i]); }
  u16(v) { this.byte(v >> 8); this.byte(v & 255); }
  header(exif) {
    this.u16(0xFFD8); if (exif) this.bytes(exif);
    for (let t = 0; t < 2; t++) { this.u16(0xFFDB); this.u16(67); this.byte(t); for (let k = 0; k < 64; k++) this.byte(this.qt[t][ZIGZAG[k]]); }
    this.u16(0xFFC0); this.u16(17); this.byte(8); this.u16(this.h); this.u16(this.w); this.byte(3);
    this.byte(1); this.byte(this.sub ? 0x22 : 0x11); this.byte(0); this.byte(2); this.byte(0x11); this.byte(1); this.byte(3); this.byte(0x11); this.byte(1);
    for (const [cls, id, key] of [[0, 0, 'dc0'], [1, 0, 'ac0'], [0, 1, 'dc1'], [1, 1, 'ac1']]) { const h = HUFF[key]; this.u16(0xFFC4); this.u16(2 + 1 + 16 + h.vals.length); this.byte((cls << 4) | id); this.bytes(h.bits); this.bytes(h.vals); }
    this.u16(0xFFDA); this.u16(12); this.byte(3); this.byte(1); this.byte(0x00); this.byte(2); this.byte(0x11); this.byte(3); this.byte(0x11); this.byte(0); this.byte(63); this.byte(0);
  }
  put(code, size) { // append `size` (≤ 16) bits, with 0xFF byte stuffing
    this.acc = (this.acc << size) | code; this.nb += size;
    while (this.nb >= 8) { const b = (this.acc >> (this.nb - 8)) & 255; this.byte(b); if (b === 255) this.byte(0); this.nb -= 8; }
    this.acc &= (1 << this.nb) - 1;
  }
  // Append `n` rows of interleaved pixels (RGBA when stride = 4, RGB when 3) — any number of rows at a time.
  push(px, n, stride = 4) {
    if (this.done) throw new Error('encoder already finished');
    const { w, pw, mcuH } = this;
    for (let r = 0; r < n && this.rows < this.h; r++) {
      const base = r * w * stride, ro = (this.rows % mcuH) * pw;
      for (let x = 0; x < w; x++) {
        const o = base + x * stride, R = px[o], G = px[o + 1], B = px[o + 2], i = ro + x;
        this.Y[i] = 0.299 * R + 0.587 * G + 0.114 * B - 128; this.Cb[i] = -0.168736 * R - 0.331264 * G + 0.5 * B; this.Cr[i] = 0.5 * R - 0.418688 * G - 0.081312 * B;
      }
      for (let x = w; x < pw; x++) { const i = ro + x, s = ro + w - 1; this.Y[i] = this.Y[s]; this.Cb[i] = this.Cb[s]; this.Cr[i] = this.Cr[s]; }
      this.rows++;
      if (this.rows % mcuH === 0 || this.rows === this.h) this.flushMcuRow(this.rows % mcuH === 0 ? mcuH : this.rows % mcuH);
    }
  }
  flushMcuRow(have) {
    const { pw, mcuH } = this;
    for (let r = have; r < mcuH; r++) { const s = (have - 1) * pw, d = r * pw; this.Y.copyWithin(d, s, s + pw); this.Cb.copyWithin(d, s, s + pw); this.Cr.copyWithin(d, s, s + pw); } // bottom edge: replicate the last row
    for (let m = 0; m < this.bw; m++) {
      if (!this.sub) { const x0 = m * 8; this.block(this.Y, x0, 0, 1, 0, 0); this.block(this.Cb, x0, 0, 1, 1, 1); this.block(this.Cr, x0, 0, 1, 1, 2); }
      else {
        const x0 = m * 16; this.block(this.Y, x0, 0, 1, 0, 0); this.block(this.Y, x0 + 8, 0, 1, 0, 0); this.block(this.Y, x0, 8, 1, 0, 0); this.block(this.Y, x0 + 8, 8, 1, 0, 0);
        this.block(this.Cb, x0, 0, 2, 1, 1); this.block(this.Cr, x0, 0, 2, 1, 2);
      }
    }
    this.mcuRowDone++;
  }
  // load an 8×8 block (step = 1: as is; step = 2: 2×2 average), DCT, quantise, entropy-code
  block(plane, x0, y0, step, tq, comp) {
    const { blk, q, pw } = this;
    if (step === 1) { for (let y = 0; y < 8; y++) { const o = (y0 + y) * pw + x0; for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[o + x]; } }
    else { for (let y = 0; y < 8; y++) { const o = (y0 + 2 * y) * pw + x0 + 0; for (let x = 0; x < 8; x++) { const i = o + 2 * x; blk[y * 8 + x] = 0.25 * (plane[i] + plane[i + 1] + plane[i + pw] + plane[i + pw + 1]); } } }
    // scaled AAN forward DCT (rows, then columns)
    for (let p = 0; p < 64; p += 8) {
      const t0 = blk[p] + blk[p + 7], t7 = blk[p] - blk[p + 7], t1 = blk[p + 1] + blk[p + 6], t6 = blk[p + 1] - blk[p + 6], t2 = blk[p + 2] + blk[p + 5], t5 = blk[p + 2] - blk[p + 5], t3 = blk[p + 3] + blk[p + 4], t4 = blk[p + 3] - blk[p + 4];
      let a = t0 + t3, b = t0 - t3, c = t1 + t2, d = t1 - t2; blk[p] = a + c; blk[p + 4] = a - c;
      let z1 = (d + b) * 0.707106781; blk[p + 2] = b + z1; blk[p + 6] = b - z1;
      a = t4 + t5; b = t5 + t6; c = t6 + t7; const z5 = (a - c) * 0.382683433, z2 = 0.541196100 * a + z5, z4 = 1.306562965 * c + z5, z3 = b * 0.707106781, z11 = t7 + z3, z13 = t7 - z3;
      blk[p + 5] = z13 + z2; blk[p + 3] = z13 - z2; blk[p + 1] = z11 + z4; blk[p + 7] = z11 - z4;
    }
    for (let p = 0; p < 8; p++) {
      const t0 = blk[p] + blk[p + 56], t7 = blk[p] - blk[p + 56], t1 = blk[p + 8] + blk[p + 48], t6 = blk[p + 8] - blk[p + 48], t2 = blk[p + 16] + blk[p + 40], t5 = blk[p + 16] - blk[p + 40], t3 = blk[p + 24] + blk[p + 32], t4 = blk[p + 24] - blk[p + 32];
      let a = t0 + t3, b = t0 - t3, c = t1 + t2, d = t1 - t2; blk[p] = a + c; blk[p + 32] = a - c;
      let z1 = (d + b) * 0.707106781; blk[p + 16] = b + z1; blk[p + 48] = b - z1;
      a = t4 + t5; b = t5 + t6; c = t6 + t7; const z5 = (a - c) * 0.382683433, z2 = 0.541196100 * a + z5, z4 = 1.306562965 * c + z5, z3 = b * 0.707106781, z11 = t7 + z3, z13 = t7 - z3;
      blk[p + 40] = z13 + z2; blk[p + 24] = z13 - z2; blk[p + 8] = z11 + z4; blk[p + 56] = z11 - z4;
    }
    const fd = this.fd[tq];
    for (let k = 0; k < 64; k++) { const z = ZIGZAG[k]; q[k] = Math.floor(blk[z] * fd[z] + 0.5); }
    // DC (differential) then AC (run-length) with the standard Huffman tables
    const dcT = this.dcH[tq], acT = this.acH[tq]; let diff = q[0] - this.pred[comp]; this.pred[comp] = q[0];
    const adiff = diff < 0 ? -diff : diff, ds = bitLength(adiff); this.put(dcT.code[ds], dcT.size[ds]); if (ds) this.put(diff < 0 ? diff + (1 << ds) - 1 : diff, ds);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = q[k]; if (v === 0) { run++; continue; }
      while (run > 15) { this.put(acT.code[0xF0], acT.size[0xF0]); run -= 16; }
      const av = v < 0 ? -v : v, s = bitLength(av), sym = (run << 4) | s; this.put(acT.code[sym], acT.size[sym]); this.put(v < 0 ? v + (1 << s) - 1 : v, s); run = 0;
    }
    if (run > 0) this.put(acT.code[0], acT.size[0]);
  }
  // Finish and return the compressed bytes as a list of chunks (the caller makes a Blob or concatenates).
  finish() {
    if (this.rows !== this.h) throw new Error(`JPEG encoder got ${this.rows} of ${this.h} rows`);
    if (this.nb) this.put((1 << (8 - this.nb)) - 1, 8 - this.nb); // pad the last byte with 1-bits
    this.u16(0xFFD9); this.done = true;
    this.chunks.push(this.cur.subarray(0, this.cp)); this.size += this.cp; this.cur = null;
    return { chunks: this.chunks, size: this.size };
  }
}
// Convenience: encode a complete RGBA image (tests, small outputs)
export function encodeJpeg(rgba, width, height, opts = {}) {
  const enc = new JpegEncoder({ width, height, ...opts }), strip = 64;
  for (let y = 0; y < height; y += strip) { const n = Math.min(strip, height - y); enc.push(rgba.subarray(y * width * 4, (y + n) * width * 4), n, 4); }
  const { chunks, size } = enc.finish(), out = new Uint8Array(size); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; } return out;
}
