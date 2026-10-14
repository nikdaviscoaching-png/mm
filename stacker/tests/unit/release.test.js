// Release hygiene: what the service worker precaches is exactly what ships; versions agree; every script parses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const SITE = new URL('../../site/', import.meta.url).pathname;
const walk = (d, p = '') => readdirSync(d).flatMap((n) => (statSync(d + n).isDirectory() ? walk(d + n + '/', p + n + '/') : [p + n]));
const files = walk(SITE), sw = readFileSync(SITE + 'sw.js', 'utf8');
const assets = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));

test('the service worker precaches exactly the shipped files', () => {
  const shipped = files.filter((f) => !['sw.js', 'vercel.json', '_headers'].includes(f) && !/LICENSE/i.test(f)), cached = assets.filter((a) => a !== './');
  assert.deepEqual(cached.slice().sort(), shipped.slice().sort());
});
test('versions agree across the app, service worker and page', () => {
  const app = readFileSync(SITE + 'js/app.js', 'utf8').match(/APP_VERSION = '([^']+)'/)[1], swv = sw.match(/stacker-v([\d.]+)/)[1], html = readFileSync(SITE + 'index.html', 'utf8').match(/stacker-version" content="([^"]+)"/)[1];
  assert.equal(app, swv); assert.equal(app, html);
});
test('every script parses', () => {
  for (const f of files.filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('vendor/'))) execFileSync(process.execPath, ['--check', SITE + f]);
});
test('the page only references files that exist', () => {
  const html = readFileSync(SITE + 'index.html', 'utf8'); for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) if (!/^https?:|^data:/.test(m[1])) assert.ok(files.includes(m[1]), 'missing ' + m[1]);
});
test('hosting configs send the isolation headers and the service worker is never cached', () => {
  const v = JSON.parse(readFileSync(SITE + 'vercel.json', 'utf8')), all = v.headers.find((h) => h.source === '/(.*)').headers.map((h) => h.key);
  for (const k of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy']) assert.ok(all.includes(k), k);
  assert.ok(v.headers.some((h) => h.source === '/sw.js' && h.headers.some((x) => /no-cache/.test(x.value))));
  const h = readFileSync(SITE + '_headers', 'utf8'); assert.match(h, /Cross-Origin-Embedder-Policy: require-corp/); assert.match(h, /\/sw\.js\n\s+Cache-Control: no-cache/);
});
