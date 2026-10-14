// Screenshots of the main screens (phone + desktop) for visual review.  node tests/e2e/shots.js
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { startServer } from './server.js';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const ROOT = new URL('../../', import.meta.url).pathname, OUT = ROOT + 'tests/out/shots'; mkdirSync(OUT, { recursive: true });
const fx = JSON.parse(readFileSync(ROOT + 'tests/out/fixtures/fixtures.json', 'utf8'));
const srv = await startServer(ROOT + 'site'), browser = await chromium.launch({ args: ['--no-sandbox'] });
const waitResult = async (p) => { await p.waitForSelector('#result.active', { timeout: 240000 }); await p.waitForFunction(() => !window.__stacker.busy() && document.querySelector('#progress').hidden, null, { timeout: 240000 }); };
for (const [tag, vp, dpr] of [['phone', { width: 390, height: 844 }, 2], ['desk', { width: 1280, height: 800 }, 1]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, hasTouch: tag === 'phone', isMobile: tag === 'phone' }), page = await ctx.newPage();
  await page.goto(srv.url + '/'); await page.waitForFunction(() => window.__stackerReady === true);
  await page.screenshot({ path: `${OUT}/${tag}_1_home.png` });
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#home [data-mode="auto"]')]); await fc.setFiles(fx.light); await waitResult(page); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${tag}_2_result_adjust.png` });
  await page.click('.tab[data-tab="frames"]'); await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${tag}_3_photos.png` });
  await page.click('.tab[data-tab="map"]'); await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${tag}_4_sources.png` });
  await page.click('#btn-save-opts'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/${tag}_5_saveopts.png` }); await page.keyboard.press('Escape');
  await page.click('#mode-chip'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/${tag}_6_mode.png` }); await page.keyboard.press('Escape');
  await ctx.close();
}
await browser.close(); await srv.close(); console.log('shots in', OUT);
