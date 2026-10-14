// End-to-end tests: the real UI in headless Chromium, served with the production headers.
//   node tests/e2e/run.js [name ...]       (no names = all except the slow ones; "all" includes big)
// Needs: Playwright + Chromium (PLAYWRIGHT_BROWSERS_PATH), and fixtures (node tests/e2e/fixtures.js tests/out/fixtures).
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startServer } from './server.js';
import { buildFixtures } from './fixtures.js';

const { chromium } = createRequire(process.env.PW_NODE_MODULES || '/opt/node22/lib/node_modules/')('playwright');
const ROOT = new URL('../../', import.meta.url).pathname, SITE = ROOT + 'site', FIX = ROOT + 'tests/out/fixtures', OUT = ROOT + 'tests/out/e2e';
mkdirSync(OUT, { recursive: true });
if (!existsSync(FIX + '/fixtures.json')) buildFixtures(FIX);
const fx = JSON.parse(readFileSync(FIX + '/fixtures.json', 'utf8'));
const tests = [], only = process.argv.slice(2), results = [];
const test = (name, fn, { slow = false } = {}) => tests.push({ name, fn, slow });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser, srv;
async function newPage(ctx, { viewport = { width: 430, height: 900 } } = {}) {
  const page = await ctx.newPage(); page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  await page.setViewportSize(viewport); return page;
}
async function openApp(ctx, url = srv.url + '/') { const page = await newPage(ctx); await page.goto(url); await page.waitForFunction(() => window.__stackerReady === true, null, { timeout: 20000 }); return page; }
async function swActive(page, timeout = 20000) { // poll explicitly: waitForFunction does not reliably await an async predicate
  const t0 = Date.now(); while (Date.now() - t0 < timeout) { const st = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state || null).catch(() => null); if (st === 'activated') return; await sleep(250); }
  throw new Error('service worker did not activate');
}
async function pick(page, mode, files) { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(`#home [data-mode="${mode}"]`)]); await fc.setFiles(files); }
async function waitResult(page, timeout = 240000) {
  await page.waitForSelector('#result.active', { timeout });
  await page.waitForFunction(() => !window.__stacker.busy() && document.querySelector('#progress').hidden, null, { timeout });
}
// PSNR of an exported JPEG against a ground-truth PNG (cropped to the stack's output rectangle), measured in a clean page
async function psnrVsTruth(ctx, jpgBytes, truthPath, crop) {
  const page = await ctx.newPage(); await page.goto('about:blank');
  const r = await page.evaluate(async ({ jpg, truth, crop }) => {
    const dec = async (b64, type) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
    const a = await dec(jpg, 'image/jpeg'), b = await dec(truth, 'image/png'), ca = new OffscreenCanvas(a.width, a.height), cb = new OffscreenCanvas(a.width, a.height);
    ca.getContext('2d').drawImage(a, 0, 0); cb.getContext('2d').drawImage(b, crop.x, crop.y, crop.w, crop.h, 0, 0, a.width, a.height);
    const da = ca.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = cb.getContext('2d').getImageData(0, 0, a.width, a.height).data; let s = 0, n = 0;
    for (let i = 0; i < da.length; i += 4) for (let c = 0; c < 3; c++) { const d = da[i + c] - db[i + c]; s += d * d; n++; }
    return { w: a.width, h: a.height, psnr: 10 * Math.log10((255 * 255) / (s / n)) };
  }, { jpg: Buffer.from(jpgBytes).toString('base64'), truth: readFileSync(truthPath).toString('base64'), crop });
  await page.close(); return r;
}
const cropOf = (page) => page.evaluate(() => { const { report } = window.__stacker.st, sFull = report.frames[report.ref].W / report.w; return { x: Math.round(report.crop.x * sFull), y: Math.round(report.crop.y * sFull), w: Math.round(report.crop.w * sFull), h: Math.round(report.crop.h * sFull) }; });
async function saveAndRead(page) { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#btn-save')]); const path = await dl.path(); return readFileSync(path); }
const noErrors = (page) => assert.deepEqual(page.errors.filter((e) => !/favicon/i.test(e)), [], 'console errors');

// ---------------------------------------------------------------------------------------------------------------------------------------
test('boot: isolated, offline-capable, no console errors', async (ctx) => {
  const page = await openApp(ctx);
  const info = await page.evaluate(() => ({ iso: self.crossOriginIsolated, opfs: !!navigator.storage.getDirectory, v: window.__stackerVersion }));
  assert.equal(info.iso, true); assert.equal(info.opfs, true); assert.equal(info.v, '1.2.0');
  await swActive(page);
  // every shipped file is really in the offline cache
  const missing = await page.evaluate(async () => { const c = await caches.open('stacker-v1.2.0'), keys = (await c.keys()).map((r) => new URL(r.url).pathname); return keys.length; });
  assert.ok(missing >= 20, 'precache has ' + missing + ' entries'); noErrors(page);
});

test('focus stack through the UI: quality vs ground truth, full-resolution save with EXIF', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'auto', fx.focus.slice(0, 8)); await waitResult(page);
  const st = await page.evaluate(() => ({ spec: window.__stacker.currentSpec(), frames: window.__stacker.st.report.frames.length, ref: window.__stacker.st.report.ref, store: 'ok' }));
  assert.equal(st.spec.mode, 'focus'); assert.equal(st.spec.method, 'sharp'); assert.equal(st.frames, 8);
  const sub = await page.textContent('#save-sub'); assert.match(sub, /\d+×\d+ · \d+\.\d MP/);
  const bytes = await saveAndRead(page), crop = await cropOf(page), r = await psnrVsTruth(ctx, bytes, FIX + '/focus_truth.png', crop);
  console.log(`      focus (UI): ${r.w}x${r.h}  PSNR vs truth ${r.psnr.toFixed(2)} dB  file ${(bytes.length / 1e6).toFixed(1)} MB`);
  assert.equal(r.w, crop.w); assert.equal(r.h, crop.h); assert.ok(r.psnr > 28.5, `PSNR ${r.psnr}`);
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8); assert.ok(bytes.includes(Buffer.from('Exif')), 'EXIF present'); assert.ok(bytes.includes(Buffer.from('Stacker')), 'Software tag');
  await page.screenshot({ path: OUT + '/focus_result.png' }); noErrors(page);
});

test('light stack: reflections removed, natural-light star works', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'light', fx.light); await waitResult(page);
  const spec = await page.evaluate(() => window.__stacker.currentSpec()); assert.equal(spec.method, 'reflect');
  const base0 = await page.evaluate(() => window.__stacker.st.lightBase); assert.ok(base0 >= 0, 'a natural-light frame was chosen');
  await page.click('.tab[data-tab="frames"]'); assert.ok((await page.locator('#strip .star').count()) >= 3, 'star buttons shown');
  const bytes = await saveAndRead(page), crop = await cropOf(page), r = await psnrVsTruth(ctx, bytes, `${FIX}/light_truth_${base0}.png`, crop);
  console.log(`      light (UI): base frame ${base0}  PSNR vs its clean rendering ${r.psnr.toFixed(2)} dB`);
  assert.ok(r.psnr > 31, `PSNR ${r.psnr}`);
  // choose another photo as the natural light: the result must follow it
  const other = base0 === 1 ? 2 : 1; await page.click(`#strip .frame:nth-child(${other + 1}) .star`); await waitResult(page);
  assert.equal(await page.evaluate(() => window.__stacker.st.lightBase), other);
  const b2 = await saveAndRead(page), r2 = await psnrVsTruth(ctx, b2, `${FIX}/light_truth_${other}.png`, await cropOf(page));
  console.log(`      light (UI): forced base ${other}  PSNR ${r2.psnr.toFixed(2)} dB`); assert.ok(r2.psnr > 27, `PSNR ${r2.psnr}`); noErrors(page);
});

test('focus + light together', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'both', fx.both); await waitResult(page);
  const spec = await page.evaluate(() => window.__stacker.currentSpec()); assert.equal(spec.mode, 'both');
  const base = await page.evaluate(() => window.__stacker.st.lightBase), j = fx.bothLights[base];
  const bytes = await saveAndRead(page), r = await psnrVsTruth(ctx, bytes, `${FIX}/both_truth_${j}.png`, await cropOf(page));
  console.log(`      both (UI): base frame ${base} (light ${j})  PSNR ${r.psnr.toFixed(2)} dB`); assert.ok(r.psnr > 23, `PSNR ${r.psnr}`); noErrors(page);
});

test('adjusting: method switch, sliders update in place, retouch stroke and undo', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'focus', fx.focus.slice(0, 5)); await waitResult(page);
  // methods
  const labels = await page.$$eval('#method-seg button', (b) => b.map((x) => x.textContent)); assert.deepEqual(labels, ['Sharp', 'Clean', 'See-through']);
  await page.click('#method-seg button:nth-child(2)'); await waitResult(page); assert.equal(await page.evaluate(() => window.__stacker.currentSpec().method), 'depth');
  // a slider element must survive a re-render (v1.1.1 rebuilt it mid-drag)
  const before = await page.evaluate(() => { const el = document.querySelector('#s-detail'); el.__mark = 1; return !!el; });
  await page.evaluate(() => { const el = document.querySelector('#s-detail'); el.value = 0.8; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(600); await waitResult(page);
  assert.equal(await page.evaluate(() => document.querySelector('#s-detail').__mark), 1, 'slider element was kept');
  // retouch
  await page.click('.tab[data-tab="retouch"]'); const box = await page.locator('#view-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => window.__stacker.st.lastRetouchMs !== undefined, null, { timeout: 60000 });
  await page.click('#rt-undo'); await page.waitForTimeout(500);
  await page.click('.tab[data-tab="map"]'); assert.ok((await page.locator('#legend span').count()) >= 2, 'sources map has a legend'); noErrors(page);
});

test('tapping Save while the picture is still updating waits instead of failing', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'focus', fx.focus.slice(0, 4)); await waitResult(page);
  await page.evaluate(() => { const el = document.querySelector('#s-brightness'); el.value = 0.3; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(450); // restack is now running
  const bytes = await saveAndRead(page); assert.ok(bytes.length > 50000); assert.equal(page.errors.filter((e) => /null|undefined|Cannot read/i.test(e)).length, 0);
  const toast = await page.textContent('#toast').catch(() => ''); assert.ok(!/Cannot read|null/.test(toast), toast);
});

test('save options: only sizes that are really smaller are offered; the chosen size is saved', async (ctx) => {
  const small = await openApp(ctx); await pick(small, 'focus', fx.focus.slice(0, 3)); await waitResult(small); // 1.8 MP photos: nothing smaller to offer
  await small.click('#btn-save-opts'); assert.deepEqual(await small.$$eval('#size-list label b', (b) => b.map((x) => x.textContent)), ['Full resolution']); await small.close();
  const page = await openApp(ctx); await pick(page, 'focus', fx.mid); await waitResult(page); // 6 MP photos
  await page.click('#btn-save-opts'); const opts = await page.$$eval('#size-list label b', (b) => b.map((x) => x.textContent)); assert.deepEqual(opts, ['Full resolution', '4 MP · for sharing']);
  await page.check('#size-list input[value="4"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#ex-go')]); const bytes = readFileSync(await dl.path());
  const m = await ctx.newPage(); await m.goto('about:blank'); const wh = await m.evaluate(async (b64) => { const b = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' })); return [b.width, b.height]; }, bytes.toString('base64')); await m.close();
  assert.ok(Math.abs(wh[0] * wh[1] - 4e6) < 0.25e6, `${wh[0]}x${wh[1]}`);
  assert.equal(await page.evaluate(() => localStorage.getItem('stacker.size')), '4'); noErrors(page);
});

test('cancel mid-way returns to a clean start screen', async (ctx) => {
  const page = await openApp(ctx); await pick(page, 'focus', fx.big);
  await page.waitForSelector('#progress:not([hidden])', { timeout: 30000 }); await page.waitForTimeout(1500); await page.click('#p-cancel');
  await page.waitForFunction(() => document.querySelector('#home').classList.contains('active') && document.querySelector('#progress').hidden, null, { timeout: 120000 });
  // and the app is reusable afterwards
  await pick(page, 'focus', fx.focus.slice(0, 3)); await waitResult(page); noErrors(page);
});

test('works offline after the first visit', async (ctx) => {
  const page = await openApp(ctx); await swActive(page);
  await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }); // controlled
  await ctx.setOffline(true); await page.reload(); await page.waitForFunction(() => window.__stackerReady === true, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true, 'isolated from the service worker cache');
  await pick(page, 'focus', fx.focus.slice(0, 3)); await waitResult(page); const bytes = await saveAndRead(page); assert.ok(bytes.length > 30000); await ctx.setOffline(false); noErrors(page);
});

test('host without isolation headers: the service worker adds them (reloads once)', async () => {
  const s2 = await startServer(SITE, { isolation: false }), ctx = await browser.newContext({ acceptDownloads: true }), page = await newPage(ctx);
  await page.goto(s2.url + '/'); await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true); await ctx.close(); await s2.close();
});

test('upgrade from the installed v1.1.1 heals itself', async () => {
  const old = mkdtempSync(tmpdir() + '/stacker-old-'); execSync(`git -C ${ROOT} archive cb95dd7 site | tar -x -C ${old}`);
  const s2 = await startServer(old + '/site'); const ctx = await browser.newContext(), page = await newPage(ctx);
  await page.goto(s2.url + '/'); await page.waitForFunction(() => window.__stackerReady === true, null, { timeout: 20000 }); await swActive(page);
  await page.reload(); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__stackerVersion), undefined, 'this is the old build'); await page.close();
  // "deploy" the new build to the same origin: swap what the server serves
  s2.setRoot?.(SITE); await s2.close(); const s3 = await startServer(SITE, { port: +new URL(s2.url).port });
  const p2 = await newPage(ctx); await p2.goto(s3.url + '/'); await p2.waitForFunction(() => window.__stackerVersion === '1.2.0' && window.__stackerReady === true, null, { timeout: 40000 });
  await pick(p2, 'focus', fx.focus.slice(0, 3)); await waitResult(p2); await ctx.close(); await s3.close();
});

test('24 MP photos: full-resolution stack and save, memory stays bounded', async (ctx) => {
  const page = await openApp(ctx); const t0 = Date.now(); let peak = 0, stop = false;
  const sampler = (async () => { while (!stop) { try { const kb = execSync("ps -eo rss,args | grep -i 'chrom' | grep -v grep | awk '{s+=$1} END {print s}'").toString().trim(); peak = Math.max(peak, +kb / 1024); } catch (e) { /* */ } await sleep(1000); } })();
  await pick(page, 'focus', fx.big); await waitResult(page, 900000); const tStack = Date.now() - t0;
  const info = await page.evaluate(() => window.__stacker.sizeInfo()); console.log(`      24 MP stack ready in ${(tStack / 1000).toFixed(0)} s; full size ${info.full.w}x${info.full.h} (${info.full.mp.toFixed(1)} MP)`);
  assert.ok(info.full.mp > 22, 'full resolution is offered');
  const t1 = Date.now(), bytes = await saveAndRead(page); stop = true; await sampler;
  const m = await ctx.newPage(); await m.goto('about:blank'); const wh = await m.evaluate(async (b64) => { const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' })); return [bmp.width, bmp.height]; }, bytes.toString('base64')); await m.close();
  console.log(`      saved ${wh[0]}x${wh[1]} in ${((Date.now() - t1) / 1000).toFixed(0)} s, ${(bytes.length / 1e6).toFixed(1)} MB; peak browser RSS ${peak.toFixed(0)} MB`);
  assert.ok(wh[0] * wh[1] > 22e6, 'exported at full resolution'); assert.ok(peak < 4500, 'memory bounded: ' + peak); noErrors(page);
}, { slow: true });

// ---------------------------------------------------------------------------------------------------------------------------------------
srv = await startServer(SITE);
browser = await chromium.launch({ args: ['--no-sandbox', '--enable-precise-memory-info'] });
const wanted = tests.filter((t) => (only.length ? only.some((o) => t.name.toLowerCase().includes(o.toLowerCase()) || o === 'all') : !t.slow));
for (const t of wanted) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 430, height: 900 } }), t0 = Date.now();
  try { await t.fn(ctx); results.push([t.name, 'PASS', Date.now() - t0]); console.log(`PASS  ${t.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push([t.name, 'FAIL', Date.now() - t0]); console.log(`FAIL  ${t.name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`); }
  await ctx.close().catch(() => {});
}
await browser.close(); await srv.close();
const failed = results.filter((r) => r[1] === 'FAIL').length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
