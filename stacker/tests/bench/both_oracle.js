import { makeCombinedSeries, standardSpecs, decode, encode, makeImg } from '../lib/synth.js';
import { fitPSNR } from '../lib/metrics.js';
const s = makeCombinedSeries({ specs: standardSpecs(), seed: 3, frames: 8 }), { w, h } = s.frames[0], N = w * h;
const lin = s.frames.map((im) => [im.r, im.g, im.b].map((c) => c.map(decode)));
for (const target of [0, 1, 2, 3]) {
  const tgt = s.cleanLins.find((_, k) => s.lights[k] === target), out = makeImg(w, h); let usedDefective = 0;
  for (let i = 0; i < N; i++) {
    let best = -1, bd = 9; for (let k = 0; k < 8; k++) { if (s.defects[k][i]) continue; const d = Math.abs(s.depth[i] - s.focusDepths[k]); if (d < bd) { bd = d; best = k; } }
    if (best < 0) { usedDefective++; for (let k = 0; k < 8; k++) { const d = Math.abs(s.depth[i] - s.focusDepths[k]); if (d < bd) { bd = d; best = k; } } }
    const cl = s.cleanLins[best]; // true lighting normalisation: frame × (target clean / frame's own clean)
    out.r[i] = encode(lin[best][0][i] * (tgt.r[i] / cl.r[i])); out.g[i] = encode(lin[best][1][i] * (tgt.g[i] / cl.g[i])); out.b[i] = encode(lin[best][2][i] * (tgt.b[i] / cl.b[i]));
  }
  console.log(`oracle (nearest-focus among truly clean frames, true lighting match) -> light ${target}: PSNR ${fitPSNR(out, s.clean[target]).toFixed(2)} dB  (pixels with no clean frame: ${(100 * usedDefective / N).toFixed(1)}%)`);
}
