// app.js — UI controller (main thread). Heavy work lives in worker.js.
import { decodeFile, maxCanvasArea } from './decode.js';
import { initCollage } from './collage.js';

const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const MAX_FRAMES = 10;
const MODE_LABEL = { auto: 'Auto', focus: 'Focus', light: 'Light', both: 'Focus + Light' };
class CancelledErr extends Error { constructor() { super('Cancelled'); this.cancelled = true; } }
const METHODS = {
  focus: [['depth', 'Clean'], ['detail', 'Max detail'], ['translucent', 'See-through']],
  light: [['glare', 'Less glare'], ['exposure', 'Balanced'], ['hdr', 'HDR'], ['lighten', 'Brightest'], ['darken', 'Darkest'], ['average', 'Less noise']],
  both: [],
};
const METHOD_HELP = { depth: 'Clean colours — best for solid stones', detail: 'Most fine detail — may add faint halos', translucent: 'For see-through stones with detail at many depths',
  glare: 'Keeps texture and drops glare that moves between shots', exposure: 'Evens out bright and dark shots', hdr: 'For RAW exposure brackets', lighten: 'Keeps the brightest version of each spot', darken: 'Keeps the darkest version — kills moving glare', average: 'Averages the shots to remove grain' };

const st = { mode: 'auto', method: null, sliders: { glare: 0.6, detail: 0.5, brightness: 0 }, report: null, auto: null, palette: [], thumbs: [], include: [],
  busy: false, rtFrame: 0, rtErase: false, tab: 'adjust', notes: [], refExif: null, refHead: null, lastJpeg: null, previewDims: null, exportScaleInfo: null };

// ---------------- worker RPC ----------------
let worker, nextId = 1; const pending = new Map(); let onProgress = null;
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'progress') { onProgress && onProgress(m); return; }
    if (m.type === 'log') { console.info('[worker]', m.msg); return; }
    if (m.type === 'ready') return;
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.type === 'error') { const e = new Error(m.msg); e.cancelled = m.cancelled; p.reject(e); } else p.resolve(m.out);
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error('Engine crashed: ' + (e.message || 'out of memory?'))); pending.clear(); };
}
function call(cmd, payload = {}, transfer = []) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ cmd, id, ...payload }, transfer); }); }

// ---------------- progress modal ----------------
const STEPS = ['Reading', 'Lining up', 'Merging'];
function showProgress(stepIdx, stage, frac = 0, detail = '') {
  $('#progress').hidden = false; $('#p-stage').textContent = stage; $('#p-bar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  $('#p-detail').textContent = detail || '';
  $('#p-steps').innerHTML = STEPS.map((s, i) => `<span class="${i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}">${i < stepIdx ? '✓ ' : ''}${s}</span>`).join('<span>›</span>');
}
function hideProgress() { $('#progress').hidden = true; onProgress = null; $('#p-eta').textContent = ''; }
$('#p-cancel').onclick = () => { worker.postMessage({ cmd: 'cancel' }); st.cancelReq = true; $('#p-detail').textContent = 'Cancelling…'; $('#p-cancel').disabled = true; };
const checkCancel = () => { if (st.cancelReq) throw new CancelledErr(); };
// rough time-left estimate from overall progress (smoothed)
function eta(overall) { const now = performance.now(); if (!eta.t0 || overall <= 0.001) { eta.t0 = now; eta.last = ''; return; } const el = (now - eta.t0) / 1000; if (el < 3 || overall < 0.04) return; const left = el * (1 - overall) / overall; const txt = left < 5 ? 'Almost done' : left < 60 ? `About ${Math.ceil(left / 5) * 5} s left` : `About ${Math.ceil(left / 60)} min left`; if (txt !== eta.last) { eta.last = txt; $('#p-eta').textContent = txt; } }

function toast(msg, ms = 4200, action) { const t = $('#toast'); t.textContent = msg; if (action) { const b = document.createElement('button'); b.className = 'tbtn'; b.textContent = action[0]; b.onclick = () => { t.hidden = true; action[1](); }; t.appendChild(b); } t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

// ---------------- navigation ----------------
function show(id) { const prev = $('.screen.active') && $('.screen.active').id; $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); if (id === 'result') requestAnimationFrame(() => viewer.resize()); if (id !== 'home' && prev === 'home') { try { history.pushState({ s: id }, ''); } catch (e) { } } }
window.addEventListener('popstate', () => { const cur = $('.screen.active').id; if (cur === 'result') { try { history.pushState({ s: cur }, ''); } catch (e) { } closeSheets(); openSheet('sheet-discard'); } else if (cur === 'collage') show('home'); });
function openSheet(id) { $('#scrim').hidden = false; $('#' + id).hidden = false; }
function closeSheets() { $('#scrim').hidden = true; $$('.sheet').forEach((s) => (s.hidden = true)); }
$('#scrim').onclick = closeSheets; $$('[data-close]').forEach((b) => (b.onclick = closeSheets));
$$('[data-open="tips"]').forEach((b) => (b.onclick = () => openSheet('sheet-tips')));

// ---------------- start flow ----------------
let pickMode = 'auto';
$$('#home [data-mode]').forEach((b) => b.onclick = () => {
  const m = b.dataset.mode; if (m === 'collage') { collage.open(); return; }
  pickMode = m; $('#picker').value = ''; $('#picker').click();
});
$('#picker').onchange = async (e) => { const files = [...e.target.files]; if (files.length) await runStack(files, pickMode); };

async function runStack(files, mode) {
  if (files.length < 2) { toast('Pick at least 2 photos of the same scene.'); return; }
  if (files.length > MAX_FRAMES) { toast(`Using the first ${MAX_FRAMES} of ${files.length} photos.`); files = files.slice(0, MAX_FRAMES); }
  st.mode = mode; st.method = null; st.sliders = { glare: 0.6, detail: 0.5, brightness: 0 }; st.notes = []; st.thumbs = []; st.cancelReq = false; st.frameMeta = []; $('#p-cancel').disabled = false; eta(0);
  invalidatePrep(); await stopPrep();
  const R = 0.25, A = 0.45; // share of the progress bar for reading / analysing (rest = blending)
  try {
    showProgress(0, 'Reading photos', 0, `0 of ${files.length}`);
    await call('new', { workMax: 2048 });
    for (let i = 0; i < files.length; i++) {
      checkCancel(); showProgress(0, 'Reading photos', i / files.length, `Photo ${i + 1} of ${files.length}`); eta(R * i / files.length);
      let d, derr; try { d = await decodeFile(files[i]); } catch (e) { console.warn(e); derr = e; }
      checkCancel();
      if (!d) { st.notes.push(`Skipped — ${derr.message}`); files.splice(i, 1); i--; if (files.length < 2) throw new Error(`${derr.message} Stacker needs at least 2 photos.`); continue; }
      if (d.note) st.notes.push(d.note);
      if (i === 0 || st.refExif == null) { st.refExif = d.exif; st.refHead = d.head; }
      st.frameMeta[i] = { exif: d.exif, head: d.head, name: d.name };
      onProgress = (m) => { const f = (i + (m.frac || 0)) / files.length; showProgress(0, 'Reading photos', f, `Photo ${i + 1} of ${files.length}`); eta(R * f); };
      const r = d.bitmap ? await call('addFrame', { bitmap: d.bitmap, name: d.name, exif: d.exif, note: d.note, first: i === 0 }, [d.bitmap])
        : await call('addFrame', { pixels: d.pixels, name: d.name, exif: d.exif, note: d.note, first: i === 0 }, [d.pixels.buf]);
      st.thumbs[r.id] = r.thumb; st.frameMeta[r.id] = st.frameMeta[i]; checkCancel();
    }
    onProgress = (m) => { const f = m.stage === 'Aligning' ? 0.15 + 0.85 * (m.frac || 0) : 0.15 * (m.frac || 0); showProgress(1, 'Lining up photos', f, m.stage === 'Aligning' ? 'Matching each photo to the first' : 'Comparing photos'); eta(R + (A - R) * f); };
    showProgress(1, 'Lining up photos', 0, 'Comparing photos');
    const a = await call('analyze'); checkCancel(); st.report = a.report; st.auto = a.auto; st.palette = a.palette;
    // EXIF/head of the reference frame for export
    const ref = st.report.ref; st.refExif = st.frameMeta[ref].exif; st.refHead = st.frameMeta[ref].head;
    const failed = st.report.frames.filter((f) => f.status === 'failed'); if (failed.length) st.notes.push(`Photo${failed.length > 1 ? 's' : ''} ${failed.map((f) => '#' + (f.i + 1)).join(', ')} didn’t match the others and ${failed.length > 1 ? 'were' : 'was'} left out. See Photos.`);
    const sizes = new Set(st.report.frames.map((f) => f.W + 'x' + f.H)); if (sizes.size > 1) st.notes.push('Your photos have different sizes — they were scaled to match.');
    await restack(true); checkCancel();
    show('result'); viewer.resetSplit(); setTab('adjust'); hideProgress(); viewer.hint('Drag the line to compare with the original', 3500);
    schedulePrep(300);
  } catch (err) { hideProgress(); if (err.cancelled) { show('home'); toast('Cancelled.'); return; } console.warn(err); toast(friendlyError(err), 8000); }
}

function friendlyError(err) {
  const m = (err && err.message) || String(err);
  if (/Add at least 2/.test(m)) return 'Pick at least 2 photos of the same scene.';
  if (/crash|memory/i.test(m)) return 'Your iPhone ran out of memory. Try fewer photos (5 is plenty) or save at 12 MP.';
  return m;
}
function currentSpec() {
  let mode = st.mode, method = st.method;
  if (mode === 'auto') { mode = st.auto.mode; method = method || st.auto.method; }
  if (!method && METHODS[mode] && METHODS[mode].length) method = METHODS[mode][0][0];
  return { mode, method, ...st.sliders };
}
let restackQueued = false, restacking = false;
async function restack(modal = false) {
  if (restacking) { restackQueued = true; return; }
  restacking = true;
  try {
    do {
      restackQueued = false;
      const spec = currentSpec();
      if (!modal) { $('#view-hint').textContent = 'Updating…'; $('#view-hint').style.opacity = 1; } // show feedback before waiting on a background save-prep to stop
      await stopPrep(); invalidatePrep();
      if (modal) { onProgress = (m) => { showProgress(2, 'Merging the best parts', m.frac, m.stage === 'Weighing frames' ? 'Finding the best parts of each photo' : 'Building the preview'); eta(0.45 + 0.55 * (m.frac || 0)); }; showProgress(2, 'Merging the best parts', 0, 'Finding the best parts of each photo'); }
      else { $('#view-hint').textContent = 'Updating…'; $('#view-hint').style.opacity = 1; onProgress = null; }
      const r = await call('stack', { spec });
      await viewer.setImages(r);
      st.share = r.share; st.lastStackMs = r.ms; st.cfg = r.cfg;
      renderChrome();
      modal = false;
    } while (restackQueued);
  } catch (err) { if (!err.cancelled) toast(friendlyError(err), 6000); else if (modal) throw err; }
  finally { restacking = false; $('#view-hint').style.opacity = 0; if (!$('#progress').hidden && !st.exporting) hideProgress(); if (!modal) schedulePrep(); }
}

// ---------------- chrome: chip, methods, sliders, frames, legend ----------------
function effMode() { return st.mode === 'auto' ? st.auto.mode : st.mode; }
function renderChrome() {
  const spec = currentSpec();
  $('#mode-chip-text').textContent = st.mode === 'auto' ? `Auto · ${MODE_LABEL[spec.mode]}` : MODE_LABEL[st.mode];
  // method segmented control
  const ms = METHODS[spec.mode] || []; const seg = $('#method-seg'); seg.hidden = !ms.length;
  seg.innerHTML = ms.map(([k, l]) => `<button data-m="${k}" class="${spec.method === k ? 'on' : ''}">${l}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => b.onclick = () => { st.method = b.dataset.m; renderChrome(); restack(); toast(METHOD_HELP[st.method] || '', 2200); });
  // sliders (max 3)
  const defs = [];
  if (spec.mode === 'both' || (spec.mode === 'light' && ['glare'].includes(spec.method))) defs.push(['glare', 'Glare', 0, 1, 0.05, (v) => Math.round(v * 100) + '%']);
  if (spec.mode === 'both' || spec.mode === 'focus') defs.push(['detail', 'Detail', 0, 1, 0.05, (v) => Math.round(v * 100) + '%']);
  defs.push(['brightness', 'Brightness', -1, 1, 0.05, (v) => (v > 0 ? '+' : '') + v.toFixed(1)]);
  $('#sliders').innerHTML = defs.map(([k, l, a, b, s, f]) => `<div class="slider-row"><label for="s-${k}">${l}</label><input type="range" id="s-${k}" min="${a}" max="${b}" step="${s}" value="${st.sliders[k]}"><span id="s-${k}-v">${f(st.sliders[k])}</span></div>`).join('');
  defs.forEach(([k, , , , , f]) => { const el = $('#s-' + k); el.oninput = () => { st.sliders[k] = +el.value; $('#s-' + k + '-v').textContent = f(+el.value); clearTimeout(renderChrome._t); renderChrome._t = setTimeout(() => restack(), 350); }; });
  // reasons + notes
  const d = st.report.detect; $('#reasons').textContent = (st.mode === 'auto' ? `Auto chose ${MODE_LABEL[spec.mode]} because ` : 'What Stacker sees: ') + plainReasons(d) + ' Tap ✓ to leave a photo out.';
  const nl = $('#note-line'); const notes = [...new Set(st.notes)]; nl.hidden = !notes.length; nl.textContent = notes[0] || ''; nl.title = notes.join('\n');
  renderStrips(); renderLegend();
}
function plainReasons(d) {
  const r = [];
  if (d.focus) r.push(`the sharp area moves between photos (${Math.round(d.focusFrac * 100)}% of the picture)`);
  if (d.exposure) r.push(`brightness differs by ${d.evSpread.toFixed(1)} stops`);
  if (d.light && !d.exposure) r.push(d.movHi > 0.004 ? 'glare moves between photos' : 'the light direction changes');
  if (!r.length) r.push('the photos look almost identical, so they are averaged to remove grain');
  const s = r.join(' and '); return s.charAt(0).toUpperCase() === s.charAt(0) ? s + '.' : s + '.';
}
function thumbCanvas(t) { const c = document.createElement('canvas'); c.width = t.w; c.height = t.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.buf.slice ? t.buf.slice(0) : t.buf), t.w, t.h), 0, 0); return c; }
function renderStrips() {
  const frames = st.report.frames; const pal = st.palette;
  const mk = (f, i, compact) => {
    const el = document.createElement('div'); el.className = 'frame' + (f.include && f.status !== 'failed' ? '' : ' off') + (compact && st.rtFrame === i && !st.rtErase ? ' sel' : '');
    el.appendChild(thumbCanvas(st.thumbs[i]));
    const col = pal[i % pal.length]; const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = `rgb(${col})`; el.appendChild(sw);
    const cap = document.createElement('div'); cap.className = 'cap'; const ev = -f.gainEV; cap.innerHTML = `<span>#${i + 1}${i === st.report.ref ? ' · base' : ''}</span><span>${Math.abs(ev) >= 0.05 ? (ev > 0 ? '+' : '') + ev.toFixed(1) + ' EV' : ''}</span>`; el.appendChild(cap);
    if (f.status === 'failed') { const b = document.createElement('div'); b.className = 'bad'; b.textContent = 'didn’t match'; el.appendChild(b); }
    if (!compact && f.status !== 'failed') {
      const t = document.createElement('button'); t.className = 'tog'; t.setAttribute('aria-label', (f.include ? 'Exclude' : 'Include') + ' frame ' + (i + 1)); t.textContent = f.include ? '✓' : '○';
      t.onclick = async () => { await stopPrep(); const r = await call('include', { i, on: !f.include }); if (!r.ok) { toast('Keep at least 2 photos.'); return; } st.report = r.report; st.auto = r.auto; restack(); };
      el.appendChild(t);
    }
    if (compact) el.onclick = () => { if (f.status === 'failed' || !f.include) return; st.rtFrame = i; st.rtErase = false; $('#rt-erase').classList.remove('on'); renderStrips(); };
    return el;
  };
  const s1 = $('#strip'); s1.innerHTML = ''; frames.forEach((f, i) => s1.appendChild(mk(f, i, false)));
  const s2 = $('#rt-strip'); s2.innerHTML = ''; frames.forEach((f, i) => s2.appendChild(mk(f, i, true)));
}
function renderLegend() {
  const pal = st.palette; $('#legend').innerHTML = (st.share || []).filter((s) => s.pct > 0).map((s) => `<span><i style="background:rgb(${pal[s.i % pal.length]})"></i>#${s.i + 1} · ${s.pct}%</span>`).join('') || '<span>Single source</span>';
}
function setTab(t) {
  st.tab = t; $$('#result .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t)); $$('#result .pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + t));
  viewer.setOverlay(t === 'map' ? 'map' : t === 'retouch' ? 'retouch' : null);
  if (t === 'retouch') { const act = st.report.frames.findIndex((f, i) => i === st.rtFrame && f.include); if (act < 0) st.rtFrame = st.report.frames.findIndex((f) => f.include && f.status !== 'failed'); renderStrips(); viewer.hint('Paint to use photo #' + (st.rtFrame + 1) + ' there'); }
}
$$('#result .tab').forEach((b) => b.onclick = () => setTab(b.dataset.tab));

// mode sheet
$('#mode-chip').onclick = () => {
  const d = st.report.detect; const items = [['auto', `Auto (recommended) — ${MODE_LABEL[st.auto.mode]}`, 'Stacker decides: ' + plainReasons(d)], ['focus', 'Focus', 'Sharp from front to back'], ['light', 'Light', 'Less glare, even brightness'], ['both', 'Focus + Light', 'Sharp everywhere and even light']];
  $('#mode-list').innerHTML = items.map(([k, t, s]) => `<button class="mode-item ${st.mode === k ? 'on' : ''}" data-k="${k}"><b>${t}</b><small>${s}</small></button>`).join('');
  $$('#mode-list .mode-item').forEach((b) => b.onclick = () => { st.mode = b.dataset.k; st.method = null; closeSheets(); renderChrome(); restack(); });
  openSheet('sheet-mode');
};
$('#btn-new').onclick = () => openSheet('sheet-discard');
$('#discard-yes').onclick = async () => { closeSheets(); invalidatePrep(); await stopPrep(); show('home'); };

// retouch controls
$('#rt-size').oninput = (e) => ($('#rt-size-v').textContent = e.target.value);
$('#rt-feather').oninput = (e) => ($('#rt-feather-v').textContent = e.target.value + '%');
$('#rt-erase').onclick = () => { st.rtErase = !st.rtErase; $('#rt-erase').classList.toggle('on', st.rtErase); renderStrips(); };
$('#rt-undo').onclick = async () => { await stopPrep(); invalidatePrep(); const r = await call('undo'); schedulePrep(); if (r) viewer.patch(r); else toast('Nothing to undo.'); };
$('#rt-clear').onclick = async () => { await stopPrep(); invalidatePrep(); const r = await call('clearRetouch'); schedulePrep(); await viewer.setImages(r); st.share = r.share; renderLegend(); };
async function sendStroke(pts) {
  const radius = +$('#rt-size').value / viewer.scale(); const feather = +$('#rt-feather').value / 100;
  await stopPrep(); invalidatePrep();
  const r = await call('stroke', { pts, radius, feather, frame: st.rtErase ? -1 : st.rtFrame }); schedulePrep();
  if (r) { viewer.patch(r); st.share = r.share; renderLegend(); st.lastRetouchMs = r.ms; }
}

// ---------------- viewer ----------------
const viewer = (() => {
  const cv = $('#view-canvas'), ctx = cv.getContext('2d'), box = $('#viewer');
  let W = 0, H = 0, dpr = 1, img = null, before = null, srcmap = null, iw = 0, ih = 0, s = 1, tx = 0, ty = 0, split = 0.3, overlay = null;
  const ptrs = new Map(); let drag = null, stroke = null, lastTap = 0, brush = null;
  function resize() { dpr = Math.min(3, window.devicePixelRatio || 1); W = box.clientWidth; H = box.clientHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); fit(); }
  function fit() { if (!iw) return; s = Math.min(W / iw, H / ih); tx = (W - iw * s) / 2; ty = (H - ih * s) / 2; draw(); }
  function clampView() { const minS = Math.min(W / iw, H / ih); if (s < minS) s = minS; if (s > 8) s = 8; const w = iw * s, h = ih * s; tx = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, tx)); ty = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, ty)); }
  function toCanvas(o) { const c = document.createElement('canvas'); c.width = o.w; c.height = o.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(o.buf), o.w, o.h), 0, 0); return c; }
  async function setImages(r) { const first = !img || iw !== r.preview.w || ih !== r.preview.h; img = toCanvas(r.preview); before = toCanvas(r.before); srcmap = toCanvas(r.srcmap); iw = r.preview.w; ih = r.preview.h; if (first) { resize(); } else draw(); }
  function patch(r) { const c = img.getContext('2d'); c.putImageData(new ImageData(new Uint8ClampedArray(r.buf), r.rect.w, r.rect.h), r.rect.x, r.rect.y); if (r.srcmap) srcmap = toCanvas(r.srcmap); draw(); }
  function draw() {
    if (!img) return; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = s < 2; ctx.imageSmoothingQuality = 'high';
    const sx = split * W, showSplit = overlay !== 'retouch';
    if (showSplit && sx > 1) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip(); ctx.drawImage(before, tx, ty, iw * s, ih * s); ctx.restore(); }
    ctx.save(); if (showSplit) { ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); } ctx.drawImage(img, tx, ty, iw * s, ih * s);
    if (overlay === 'map' || (overlay === 'retouch' && st.showMapInRetouch)) { ctx.globalAlpha = overlay === 'map' ? 0.6 : 0.35; ctx.drawImage(srcmap, tx, ty, iw * s, ih * s); ctx.globalAlpha = 1; }
    ctx.restore();
    if (brush) { ctx.beginPath(); ctx.arc(brush.x, brush.y, +$('#rt-size').value / 2, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (stroke && stroke.screen.length > 1) { ctx.beginPath(); stroke.screen.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); const col = st.rtErase ? '255,255,255' : st.palette[st.rtFrame % st.palette.length]; ctx.strokeStyle = `rgba(${col},.45)`; ctx.lineWidth = +$('#rt-size').value; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke(); }
    const hd = $('#split-handle'); hd.hidden = !showSplit; hd.style.left = sx + 'px';
    $('#tag-before').hidden = !showSplit || split < 0.18; $('#tag-after').hidden = !showSplit || split > 0.82;
  }
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toImg = (p) => ({ x: (p.x - tx) / s, y: (p.y - ty) / s });
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId); const p = pos(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) { stroke = null; const [a, b] = [...ptrs.values()]; drag = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx0: tx, ty0: ty }; return; }
    const now = Date.now(); if (now - lastTap < 300 && overlay !== 'retouch') { const ns = s > Math.min(W / iw, H / ih) * 1.05 ? 0 : 2.5; if (ns) { const ip = toImg(p); s = ns * Math.min(W / iw, H / ih); tx = p.x - ip.x * s; ty = p.y - ip.y * s; clampView(); } else fit(); lastTap = 0; draw(); return; } lastTap = now;
    if (overlay !== 'retouch' && Math.abs(p.x - split * W) < 28) { drag = { kind: 'split' }; return; }
    if (overlay === 'retouch') { stroke = { pts: [toImg(p)], screen: [p] }; brush = p; draw(); return; }
    drag = { kind: 'pan', x0: p.x, y0: p.y, tx0: tx, ty0: ty };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pos(e); if (!ptrs.has(e.pointerId)) { if (overlay === 'retouch' && e.pointerType === 'mouse') { brush = p; draw(); } return; } ptrs.set(e.pointerId, p);
    if (drag && drag.kind === 'pinch' && ptrs.size >= 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); const ns = Math.max(0.05, drag.s0 * d / drag.d0); const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2; const ix = (drag.cx - drag.tx0) / drag.s0, iy = (drag.cy - drag.ty0) / drag.s0; s = ns; tx = cx - ix * s; ty = cy - iy * s; clampView(); draw(); return; }
    if (stroke) { const last = stroke.screen[stroke.screen.length - 1]; if (Math.hypot(p.x - last.x, p.y - last.y) > 3) { stroke.pts.push(toImg(p)); stroke.screen.push(p); } brush = p; draw(); return; }
    if (!drag) return;
    if (drag.kind === 'split') { split = Math.max(0, Math.min(1, p.x / W)); draw(); }
    else if (drag.kind === 'pan') { tx = drag.tx0 + p.x - drag.x0; ty = drag.ty0 + p.y - drag.y0; clampView(); draw(); }
  });
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (stroke && ptrs.size === 0) { const pts = stroke.pts; stroke.screen = []; draw(); stroke = null; brush = null; sendStroke(pts.length === 1 ? [pts[0], pts[0]] : pts); }
    if (ptrs.size === 0) drag = null; else if (drag && drag.kind === 'pinch') drag = null;
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); const ip = toImg(p); s *= Math.exp(-e.deltaY * 0.002); s = Math.max(0.05, s); tx = p.x - ip.x * s; ty = p.y - ip.y * s; clampView(); draw(); }, { passive: false });
  window.addEventListener('resize', () => { if ($('#result').classList.contains('active')) resize(); });
  return { setImages, patch, resize, draw, setOverlay: (o) => { overlay = o; if (o === 'retouch') split = 0; else if (split === 0) split = 0.3; draw(); }, resetSplit: () => { split = 0.3; }, scale: () => s, hint: (t, ms = 2500) => { const h = $('#view-hint'); h.textContent = t; h.style.opacity = 1; clearTimeout(h._t); h._t = setTimeout(() => (h.style.opacity = 0), ms); } };
})();

// ---------------- export: one-tap save ----------------
// The 12 MP JPEG is prepared in the background as soon as the result is on screen, so tapping
// "Save to Photos" can open the iOS share sheet immediately (Safari needs that tap for navigator.share).
st.prep = null; let prepTimer = 0, prepGen = 0;
function invalidatePrep() { prepGen++; st.prep = null; clearTimeout(prepTimer); setSaveLabel(); }
function schedulePrep(ms = 900) { clearTimeout(prepTimer); prepTimer = setTimeout(() => startPrep(12), ms); }
async function stopPrep() { clearTimeout(prepTimer); const p = st.prep; if (p && p.running) { worker.postMessage({ cmd: 'cancel' }); await p.promise.catch(() => {}); } }
function setSaveLabel() { const l = $('#save-label'); if (l) l.textContent = 'Save to Photos'; }
function exportName() { return `stack-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.jpg`; }
function startPrep(targetMP, visible = false) {
  if (!st.report || !$('#result').classList.contains('active') && !visible) return null;
  if (st.prep && st.prep.targetMP === targetMP && (st.prep.running || st.prep.file)) return st.prep;
  if (restacking) { schedulePrep(); return null; }
  const gen = prepGen; const p = { targetMP, running: true, file: null, gen };
  p.promise = call('export', { targetMP, quality: 92, exifHead: st.refHead ? st.refHead.slice(0) : null, exifInfo: st.refExif }, []).then((r) => {
    p.running = false; if (gen !== prepGen) throw new CancelledErr();
    const blob = new Blob([r.jpeg], { type: 'image/jpeg' }); p.file = new File([blob], exportName(), { type: 'image/jpeg' }); p.r = r; p.blob = blob;
    window.__lastExport = { w: r.w, h: r.h, bytes: blob.size, ms: r.ms, encoder: r.encoder }; return p;
  }, (e) => { p.running = false; if (st.prep === p) st.prep = null; throw e; });
  p.promise.catch(() => {}); st.prep = p; return p;
}
const canShareFiles = (file) => !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
function downloadFile(file) { const u = URL.createObjectURL(file); const a = document.createElement('a'); a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 15000); }
// hand a finished file to iOS: share sheet (Save Image) when allowed, else the "ready" sheet / download
async function deliver(file, info) {
  st.lastJpeg = file;
  if (canShareFiles(file)) {
    try { await navigator.share({ files: [file] }); closeSheets(); toast('Done — check your Photos.', 3000); return; }
    catch (e) { if (e.name === 'AbortError') return; if (e.name !== 'NotAllowedError') { toast('Sharing failed — use Download.'); } }
    offerReady(file, info); return; // lost the tap (took too long): one more tap needed
  }
  downloadFile(file); toast('Downloaded ' + file.name, 3500);
}
function offerReady(file, info) {
  const a = $('#ex-download'); if (a.href) URL.revokeObjectURL(a.href); a.href = URL.createObjectURL(file); a.download = file.name;
  $('#ex-info').textContent = info || ''; $('#ex-share').hidden = !canShareFiles(file);
  $$('#sheet-export .opt').forEach((o) => (o.hidden = true)); $('#ex-go').hidden = true; $('#ex-warn').hidden = true; $('#sheet-export h2').hidden = true; $('#ex-done').hidden = false;
  closeSheets(); openSheet('sheet-export'); st.readyFile = file;
}
const infoOf = (p) => `${p.r.w}×${p.r.h} · ${(p.blob.size / 1e6).toFixed(1)} MB JPEG`;
// QA BUG-5: a rapid double-tap on Save opened the share sheet twice. Ignore taps while a save is in flight.
let saving = false;
async function saveWith(targetMP) {
  if (saving) return; saving = true;
  try { await saveWithInner(targetMP); } finally { saving = false; }
}
async function saveWithInner(targetMP) {
  let p = st.prep && st.prep.targetMP === targetMP ? st.prep : null;
  if (p && p.file) { await deliver(p.file, infoOf(p)); return; } // instant path, still inside the tap
  st.exporting = true; $('#p-cancel').disabled = false; st.cancelReq = false; eta(0);
  try {
    if (!p) { await stopPrep(); p = startPrep(targetMP, true); }
    onProgress = (m) => { const f = m.stage === 'Encoding JPEG' ? 0.85 : m.stage === 'Writing metadata' ? 0.97 : 0.85 * (m.frac || 0); showProgress(2, 'Preparing your photo', f, targetMP ? '12 MP JPEG' : 'Full resolution JPEG'); eta(f); };
    showProgress(2, 'Preparing your photo', 0, targetMP ? '12 MP JPEG' : 'Full resolution JPEG');
    await p.promise; hideProgress(); await deliver(p.file, infoOf(p));
  } catch (err) { hideProgress(); if (!err.cancelled) toast(friendlyError(err), 7000); }
  finally { st.exporting = false; }
}
$('#btn-save').onclick = () => saveWith(12);
$('#btn-save-opts').onclick = () => {
  const c = st.report.crop, ref = st.report.frames[st.report.ref]; const sFull = ref.W / st.report.w;
  const fw = Math.round(c.w * sFull), fh = Math.round(c.h * sFull), fmp = fw * fh / 1e6;
  const s12 = Math.min(sFull, Math.sqrt(12e6 / (c.w * c.h))); const w12 = Math.round(c.w * s12), h12 = Math.round(c.h * s12);
  $('#ex-12').textContent = `${w12}×${h12} · recommended`; $('#ex-full').textContent = `${fw}×${fh} · ${fmp.toFixed(1)} MP · slower`;
  const fullOpt = document.querySelector('input[name=size][value=full]'); $$('#sheet-export .opt').forEach((o) => (o.hidden = false)); fullOpt.parentElement.hidden = fmp <= 12.5;
  document.querySelector('input[name=size][value="12"]').checked = true; $('#sheet-export h2').hidden = false;
  const warn = $('#ex-warn'); warn.hidden = true;
  fullOpt.onchange = () => { warn.hidden = !(fmp > 20); warn.textContent = `Full resolution takes longer and needs a lot of memory. If the app restarts, use 12 MP.`; };
  document.querySelector('input[name=size][value="12"]').onchange = () => (warn.hidden = true);
  $('#ex-done').hidden = true; $('#ex-go').hidden = false; openSheet('sheet-export');
};
$('#ex-go').onclick = () => { const full = document.querySelector('input[name=size]:checked').value === 'full'; closeSheets(); saveWith(full ? null : 12); };
$('#ex-share').onclick = async () => {
  try { await navigator.share({ files: [st.readyFile || st.lastJpeg] }); closeSheets(); toast('Done — check your Photos.', 3000); }
  catch (e) { if (e.name !== 'AbortError') toast('Sharing failed — use Download instead.'); }
};

// ---------------- boot ----------------
startWorker();
const collage = initCollage({ show, toast, openSheet, closeSheets, deliver });
$('#cl-back').onclick = () => { if (history.state && history.state.s === 'collage') history.back(); else show('home'); };
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
window.__stackerReady = true;
// test hooks (used by the headless test-suite; harmless in production)
window.__stacker = { collage, busy: () => restacking || restackQueued || !!(st.prep && st.prep.running && 0), st, call, runStack, restack, setTab, viewer, maxCanvasArea, currentSpec, show, saveWith };
