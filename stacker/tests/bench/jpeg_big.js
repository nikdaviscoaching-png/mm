// Streams a very large image through the encoder strip by strip, as the tiled renderer will, and reports time and peak memory.
import { JpegEncoder } from '../../site/js/jpegenc.js';
import { specimenTexture } from '../lib/synth.js';
const [W, H] = (process.argv[2] || '8064x6048').split('x').map(Number), tex = specimenTexture(512, 384, 5), strip = 128;
const row = new Uint8Array(W * strip * 4);
for (let y = 0; y < strip; y++) for (let x = 0; x < W; x++) { const i = (y % 384) * 512 + (x % 512), o = (y * W + x) * 4; row[o] = tex.r[i] * 255; row[o + 1] = tex.g[i] * 255; row[o + 2] = tex.b[i] * 255; row[o + 3] = 255; }
const t0 = performance.now(), enc = new JpegEncoder({ width: W, height: H, quality: 95 }); let peak = 0;
for (let y = 0; y < H; y += strip) { const n = Math.min(strip, H - y); enc.push(row.subarray(0, n * W * 4), n, 4); peak = Math.max(peak, process.memoryUsage().rss); }
const { size, chunks } = enc.finish(); const dt = (performance.now() - t0) / 1000;
console.log(`${W}x${H} (${(W * H / 1e6).toFixed(1)} MP): ${dt.toFixed(1)} s  (${(W * H / 1e6 / dt).toFixed(1)} MP/s)  output ${(size / 1e6).toFixed(1)} MB in ${chunks.length} chunks   peak RSS ${(peak / 1e6).toFixed(0)} MB`);
