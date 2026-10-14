// Builds the deployable release ZIP: the contents of site/ at the zip root (so index.html is at the top level), plus the README,
// CHANGELOG and third-party notices. Deterministic: sorted entries, fixed timestamps, so the same sources give the same bytes.
//   node tools/build-zip.mjs [out.zip]
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, resolve } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname, SITE = ROOT + 'site/';
const version = readFileSync(SITE + 'js/app.js', 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const out = resolve(process.argv[2] || `${ROOT}dist/stacker-v${version}.zip`);

const walk = (d, p = '') => readdirSync(d).flatMap((n) => (statSync(d + n).isDirectory() ? walk(d + n + '/', p + n + '/') : [p + n]));
const entries = new Map(walk(SITE).map((f) => [f, readFileSync(SITE + f)]));
for (const [name, src] of [['README.md', 'docs/README.md'], ['CHANGELOG.md', 'docs/CHANGELOG.md'], ['RESULTS.md', 'docs/RESULTS.md'], ['THIRD_PARTY_NOTICES.txt', 'docs/THIRD_PARTY_NOTICES.txt']]) entries.set(name, readFileSync(ROOT + src));

const names = [...entries.keys()].sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a < b ? -1 : a > b ? 1 : 0));
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00
const local = [], central = []; let offset = 0;
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }, u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
for (const name of names) {
  const data = entries.get(name), nm = Buffer.from(name), crc = crc32(data);
  const packed = /\.(png|wasm)$/.test(name) ? data : deflateRawSync(data, { level: 9 }), useDeflate = packed.length < data.length, body = useDeflate ? packed : data, method = useDeflate ? 8 : 0;
  const lh = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(body.length), u32(data.length), u16(nm.length), u16(0), nm]);
  local.push(lh, body);
  central.push(Buffer.concat([u32(0x02014b50), u16(0x031e), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(body.length), u32(data.length), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0o100644 << 16), u32(offset), nm]));
  offset += lh.length + body.length;
}
const cd = Buffer.concat(central), end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length), u32(cd.length), u32(offset), u16(0)]);
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`${out}\n  ${names.length} files, ${(statSync(out).size / 1048576).toFixed(2)} MB, version ${version}`);
