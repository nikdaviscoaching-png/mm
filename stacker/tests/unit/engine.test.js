import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../site/js/engine.js';
import { specimenTexture, lumaOf } from '../lib/synth.js';

const rand = (n, seed = 1) => { const r = E.mulberry(seed), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = r(); return a; };

test('morphology matches a naive square-window reference', () => {
  const w = 37, h = 29, p = rand(w * h);
  const naive = (r, isMax) => { const o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = isMax ? -1 : 2; for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) v = isMax ? Math.max(v, p[j * w + i]) : Math.min(v, p[j * w + i]); o[y * w + x] = v; } return o; };
  for (const r of [1, 2, 5, 11, 40]) { assert.deepEqual(E.dilate(p, w, h, r), naive(r, true), `dilate ${r}`); assert.deepEqual(E.erode(p, w, h, r), naive(r, false), `erode ${r}`); }
  assert.deepEqual(E.dilate(p, w, h, 0), p);
});

test('Laplacian pyramid reconstructs exactly, for odd sizes too', () => {
  for (const [w, h] of [[160, 120], [97, 61], [33, 17]]) { const x = rand(w * h, 3), back = E.collapse(E.lapPyr(x, w, h, 4)); let md = 0; for (let i = 0; i < x.length; i++) md = Math.max(md, Math.abs(back[i] - x[i])); assert.ok(md < 1e-5, `${w}x${h}: ${md}`); }
});

test('phase correlation and ECC recover a known shift', () => {
  const w = 256, h = 192, tex = specimenTexture(w, h, 4), a = lumaOf(tex);
  const T = [1, 0, 3.4, 0, 1, -2.2], b = E.warpAffine(a, w, h, T, w, h); // b(x) = a(T x)
  const pc = E.phaseCorrelate(a, b, w, h); assert.ok(Math.abs(pc.dx + 3.4) < 0.5 && Math.abs(pc.dy - 2.2) < 0.5, JSON.stringify(pc));
  const r = E.eccAlign(a, b, w, h, { model: 'similarity', init: [1, 0, -3.4, 0, 1, 2.2], minSize: 64 }), M = E.centredToPixel(r.A, w, h);
  assert.ok(r.ok && r.rho > 0.95, `rho ${r.rho}`); assert.ok(Math.abs(M[2] + 3.4) < 0.1 && Math.abs(M[5] - 2.2) < 0.1, `M=${M.map((v) => v.toFixed(3))}`); // template -> input mapping
});

test('guided filter keeps edges that the guide has', () => {
  const w = 64, h = 64, I = new Float32Array(w * h), P = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { I[y * w + x] = x < 32 ? 0.2 : 0.8; P[y * w + x] = x < 32 ? 0 : 1; }
  const q = E.guidedFilter(I, P, w, h, 4, 1e-3); assert.ok(q[10 * w + 30] < 0.05 && q[10 * w + 34] > 0.95);
});
