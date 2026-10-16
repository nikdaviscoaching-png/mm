// store.js — full-resolution frame storage in 256×256 blocks (OPFS when available, else RAM).
// Frames are written once (row strips) and read back as small regions per render tile,
// so full-res frames are never all resident in memory at once.
export const B = 256;

class FrameLayout {
  constructor(W, H, ch, bytes) { this.W = W; this.H = H; this.ch = ch; this.bytes = bytes; this.nbx = Math.ceil(W / B); this.nby = Math.ceil(H / B); this.blockBytes = B * B * ch * bytes; this.rowBytes = this.blockBytes * this.nbx; }
}

// Accepts arbitrary row strips; emits complete block rows.
class Writer {
  constructor(layout, sink) { this.L = layout; this.sink = sink; const T = layout.bytes === 2 ? Uint16Array : Uint8Array; this.buf = new T(layout.nbx * B * B * layout.ch); this.T = T; this.br = 0; this.filled = 0; }
  // data: interleaved with srcCh channels (3 or 4), `rows` rows of width W
  async push(data, srcCh, rows) {
    const L = this.L, W = L.W, ch = L.ch; let r = 0;
    while (r < rows) {
      const take = Math.min(rows - r, B - this.filled);
      for (let k = 0; k < take; k++) {
        const yIn = this.filled + k, so = (r + k) * W * srcCh;
        for (let bx = 0; bx < L.nbx; bx++) {
          const x0 = bx * B, x1 = Math.min(W, x0 + B), bo = bx * B * B * ch + yIn * B * ch;
          for (let x = x0, j = bo; x < x1; x++, j += ch) { const s = so + x * srcCh; this.buf[j] = data[s]; this.buf[j + 1] = data[s + 1]; this.buf[j + 2] = data[s + 2]; }
        }
      }
      this.filled += take; r += take;
      if (this.filled === B || (this.br * B + this.filled) >= L.H) await this.flush();
    }
  }
  async flush() { if (!this.filled) return; await this.sink(this.br, this.buf); this.br++; this.filled = 0; this.buf = new this.T(this.buf.length); }
}

export class MemStore {
  constructor() { this.frames = new Map(); this.kind = 'memory'; }
  async create(id, W, H, ch, bytes) { const L = new FrameLayout(W, H, ch, bytes); const rows = []; this.frames.set(id, { L, rows }); return new Writer(L, async (br, buf) => { rows[br] = buf; }); }
  async readRegion(id, x0, y0, w, h) {
    const f = this.frames.get(id); const L = f.L; return readFromRows(L, (br) => f.rows[br], x0, y0, w, h);
  }
  async remove(id) { this.frames.delete(id); }
  async clear() { this.frames.clear(); }
}
function readFromRows(L, getRow, x0, y0, w, h) {
  const ch = L.ch, T = L.bytes === 2 ? Uint16Array : Uint8Array, out = new T(w * h * ch);
  const by0 = Math.floor(y0 / B), by1 = Math.floor((y0 + h - 1) / B);
  for (let by = by0; by <= by1; by++) {
    const got = getRow(by); if (!got) continue; const row = got.buf || got, rb = got.bx0 || 0;
    const ya = Math.max(y0, by * B), yb = Math.min(y0 + h, by * B + B);
    for (let y = ya; y < yb; y++) {
      const yi = y - by * B, oo = (y - y0) * w * ch;
      const bx0 = Math.floor(x0 / B), bx1 = Math.floor((x0 + w - 1) / B);
      for (let bx = bx0; bx <= bx1; bx++) {
        const xa = Math.max(x0, bx * B), xb = Math.min(x0 + w, bx * B + B, L.W);
        const bo = (bx - rb) * B * B * ch + yi * B * ch;
        for (let x = xa; x < xb; x++) { const s = bo + (x - bx * B) * ch, d = oo + (x - x0) * ch; out[d] = row[s]; out[d + 1] = row[s + 1]; out[d + 2] = row[s + 2]; }
      }
    }
  }
  return out;
}

// OPFS-backed store: block rows streamed to disk; reads use File.slice (async, shareable).
export class OpfsStore {
  constructor(dir) { this.dir = dir; this.frames = new Map(); this.kind = 'opfs'; }
  static async open() {
    if (!(globalThis.navigator && navigator.storage && navigator.storage.getDirectory)) return null;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('stacker-frames', { create: true });
      // clean leftovers from previous sessions
      try { for await (const name of dir.keys()) await dir.removeEntry(name); } catch (e) { /* ignore */ }
      // probe that writing works (Safari private mode etc.)
      const fh = await dir.getFileHandle('probe.bin', { create: true });
      if (fh.createSyncAccessHandle) { const h = await fh.createSyncAccessHandle(); h.write(new Uint8Array(16), { at: 0 }); h.flush(); h.close(); }
      else { const w = await fh.createWritable(); await w.write(new Uint8Array(16)); await w.close(); }
      await dir.removeEntry('probe.bin');
      const st = new OpfsStore(dir); st.spill = await OpfsSpill.open(dir); return st;
    } catch (e) { return null; }
  }
  async create(id, W, H, ch, bytes) {
    const L = new FrameLayout(W, H, ch, bytes); const name = 'f' + id + '.bin';
    const fh = await this.dir.getFileHandle(name, { create: true });
    // Prefer the synchronous access handle (Safari 15.2+/16.4+ workers); fall back to a writable stream.
    let sync = null, ws = null;
    try { if (fh.createSyncAccessHandle) sync = await fh.createSyncAccessHandle(); } catch (e) { sync = null; }
    if (!sync) ws = await fh.createWritable();
    const rec = { L, fh, file: null }; this.frames.set(id, rec);
    const wr = new Writer(L, async (br, buf) => {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if (sync) sync.write(bytes, { at: br * L.rowBytes }); else await ws.write({ type: 'write', position: br * L.rowBytes, data: bytes });
    });
    const origFlush = wr.flush.bind(wr);
    wr.finish = async () => { await origFlush(); if (sync) { sync.flush(); sync.close(); } else await ws.close(); rec.file = await fh.getFile(); };
    return wr;
  }
  async readRegion(id, x0, y0, w, h) {
    const f = this.frames.get(id); const L = f.L; if (!f.file) f.file = await f.fh.getFile();
    const by0 = Math.floor(y0 / B), by1 = Math.floor((y0 + h - 1) / B), rows = {};
    const bx0 = Math.max(0, Math.floor(x0 / B)), bx1 = Math.min(L.nbx - 1, Math.floor((x0 + w - 1) / B));
    const T = L.bytes === 2 ? Uint16Array : Uint8Array;
    const reads = [];
    for (let by = Math.max(0, by0); by <= Math.min(L.nby - 1, by1); by++) {
      const off = by * L.rowBytes + bx0 * L.blockBytes;
      reads.push(f.file.slice(off, off + (bx1 - bx0 + 1) * L.blockBytes).arrayBuffer().then((ab) => { rows[by] = { buf: new T(ab), bx0 }; }));
    }
    await Promise.all(reads);
    return readFromRows(L, (br) => rows[br], x0, y0, w, h);
  }
  dropCaches() { for (const f of this.frames.values()) f.cache = new Map(); }
  async remove(id) { const f = this.frames.get(id); if (!f) return; this.frames.delete(id); try { await this.dir.removeEntry('f' + id + '.bin'); } catch (e) { } }
  async clear() { if (this.spill) await this.spill.clear(); for (const id of [...this.frames.keys()]) await this.remove(id); }
}

// Synchronous on-disk home for the 16-bit work frames (planar RGB), via OPFS sync access handles (worker only).
// Only enabled if a write → read-back round trip works synchronously on this browser.
export class OpfsSpill {
  constructor(dir) { this.dir = dir; this.h = new Map(); this.kind = 'opfs-sync'; }
  static async open(dir) {
    try {
      const fh = await dir.getFileHandle('spillprobe.bin', { create: true }); if (!fh.createSyncAccessHandle) return null;
      const h = await fh.createSyncAccessHandle(); const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); const b = new Uint8Array(8);
      const nw = h.write(a, { at: 0 }); const nr = h.read(b, { at: 0 }); const ok = nw === 8 && nr === 8 && b.every((v, i) => v === a[i]);
      const c = h.close(); if (c && c.then) await c; await dir.removeEntry('spillprobe.bin');
      return ok ? new OpfsSpill(dir) : null;
    } catch (e) { return null; }
  }
  async put(id, u16) {
    let h = this.h.get(id);
    if (!h) { const fh = await this.dir.getFileHandle('w' + id + '.bin', { create: true }); h = await fh.createSyncAccessHandle(); this.h.set(id, h); }
    const bytes = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength); if (h.write(bytes, { at: 0 }) !== bytes.length) throw new Error('Storage full');
  }
  get(id, len) { const out = new Uint16Array(len); this.h.get(id).read(new Uint8Array(out.buffer), { at: 0 }); return out; }
  getRows(id, w, hgt, y0, n) { const out = new Uint16Array(3 * n * w), H = this.h.get(id); for (let c = 0; c < 3; c++) H.read(new Uint8Array(out.buffer, c * n * w * 2, n * w * 2), { at: (c * w * hgt + y0 * w) * 2 }); return out; }
  async clear() { for (const [id, h] of this.h) { try { const c = h.close(); if (c && c.then) await c; } catch (e) { } try { await this.dir.removeEntry('w' + id + '.bin'); } catch (e) { } } this.h.clear(); }
}
// writers from MemStore need finish() too
const _create = MemStore.prototype.create;
MemStore.prototype.create = async function (...a) { const w = await _create.apply(this, a); const fl = w.flush.bind(w); w.finish = async () => { await fl(); }; return w; };
