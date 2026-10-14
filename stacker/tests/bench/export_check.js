// End to end: Session -> exportJpeg (streaming) -> file, for decoding/inspection by an independent decoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeFocusSeries } from '../lib/synth.js';
import { loadSession } from '../lib/run.js';
import { exportJpeg } from '../../site/js/exporter.js';
const mods = { ...(await import('../../site/js/pipeline.js')), ...(await import('../../site/js/store.js')) };
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const s = makeFocusSeries({ seed: 3, breathing: 0, width: 512, height: 384 });
const { S } = await loadSession(mods, s.frames, { bits: 8 }); await S.computeWeights({ mode: 'focus', method: 'sharp', glare: 0.6, detail: 0.5, brightness: 0 });
const prev = await S.renderPreview(); writeFileSync(`${out}/preview.rgba`, Buffer.from(prev.rgba)); console.log('preview', prev.w, 'x', prev.h);
for (const [name, targetMP] of [['full', null], ['small', 0.05]]) {
  const t = performance.now(), r = await exportJpeg(S, { targetMP, quality: 95, exifInfo: { Make: 'TestMake', Model: 'TestModel', ISO: 200, FNumber: 2.8, ExposureTime: 0.01 } });
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(await r.blob.arrayBuffer())); console.log(name, r.w, 'x', r.h, (r.bytes / 1e3).toFixed(0), 'KB', Math.round(performance.now() - t), 'ms');
}
