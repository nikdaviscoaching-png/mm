// worker.js — owns the stacking Session; all heavy work happens here (off the UI thread).
import { Session, Cancelled, autoSpec, PALETTE } from './pipeline.js';
import { MemStore, OpfsStore } from './store.js';
import * as E from './engine.js';
import { exportJpeg } from './exporter.js';

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

// ---- export: tiled full-resolution render streamed into the JPEG encoder (see exporter.js) ----
async function doExport({ targetMP, quality = 95, exifHead, exifInfo }) {
  const r = await exportJpeg(S, { targetMP, quality, exifHead: exifHead ? new Uint8Array(exifHead) : null, exifInfo }, { progress, log: (msg) => post({ type: 'log', msg }) });
  return { jpeg: r.blob, w: r.w, h: r.h, encoder: 'stream', bytes: r.bytes, ms: { total: r.ms } };
}

// A cancel only targets work that is running right now. A cancel that arrives while the worker is idle
// (e.g. Cancel tapped just as a job finished) must not leak into the next job (QA BUG-2).
let running = 0, chain = Promise.resolve();
// Commands run strictly one after another: a retouch stroke must never interleave with a render or another stroke (they share the override
// map and the preview buffer). Only 'cancel' jumps the queue, and it only ever targets the command that is running right now.
self.onmessage = ({ data: m }) => {
  if (m.cmd === 'cancel') { if (S && running > 0) S.cancelFlag = true; return; }
  chain = chain.then(() => handle(m));
};
async function handle(m) {
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
        r.lightBase = (m.spec.mode === 'both' || (m.spec.mode === 'light' && m.spec.method === 'reflect')) && S.light ? S.light.baseFrame : null; // the frame whose lighting the result follows
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
      case 'export': { S.cancelFlag = false; const r = await doExport(m); reply(r); break; }
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
}
post({ type: 'ready' });
