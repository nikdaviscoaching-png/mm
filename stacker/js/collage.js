// collage.js — simple collage maker: templates (2–9), drag-to-swap, two-finger pan/zoom inside a cell,
// border / corner radius / background, aspect presets, high-res JPEG export.
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const ASPECTS = [['1:1', 1, 1], ['4:5', 4, 5], ['9:16', 9, 16], ['3:2', 3, 2]];
const COLORS = ['#ffffff', '#000000', '#f3ead8', '#1c1f26', '#c47a2c', '#6b8f71'];

// ---- templates: rect lists in unit coordinates ----
const grid = (r, c) => { const o = []; for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) o.push([x / c, y / r, 1 / c, 1 / r]); return o; };
const rows = (counts, hs) => { const o = []; let y = 0; const H = hs || counts.map(() => 1 / counts.length); counts.forEach((n, i) => { for (let x = 0; x < n; x++) o.push([x / n, y, 1 / n, H[i]]); y += H[i]; }); return o; };
const cols = (counts, ws) => rows(counts, ws).map(([x, y, w, h]) => [y, x, h, w]);
const bigLeft = (k, f = 0.62) => [[0, 0, f, 1], ...Array.from({ length: k }, (_, i) => [f, i / k, 1 - f, 1 / k])];
const bigTop = (k, f = 0.62) => [[0, 0, 1, f], ...Array.from({ length: k }, (_, i) => [i / k, f, 1 / k, 1 - f])];
const bigLeftGrid = (r, c, f = 0.5) => [[0, 0, f, 1], ...grid(r, c).map(([x, y, w, h]) => [f + x * (1 - f), y, w * (1 - f), h])];
export const TEMPLATES = {
  2: [cols([1, 1]), rows([1, 1]), cols([1, 1], [0.64, 0.36])],
  3: [cols([1, 1, 1]), rows([1, 1, 1]), bigLeft(2), bigTop(2)],
  4: [grid(2, 2), bigLeft(3), bigTop(3), cols([1, 1, 1, 1])],
  5: [bigLeftGrid(2, 2), rows([2, 3]), rows([3, 2]), bigTop(4, 0.58)],
  6: [grid(3, 2), grid(2, 3), rows([1, 2, 3], [0.45, 0.3, 0.25])],
  7: [rows([3, 4]), rows([2, 3, 2]), bigLeftGrid(3, 2, 0.45)],
  8: [grid(4, 2), grid(2, 4), rows([3, 2, 3])],
  9: [grid(3, 3), rows([2, 3, 4], [0.4, 0.32, 0.28]), rows([4, 1, 4], [0.25, 0.5, 0.25])],
};

export function initCollage({ show, toast, deliver }) {
  const st = { photos: [], tpl: 0, aspect: 1, border: 12, radius: 16, bg: '#ffffff', cells: [] };
  const stage = $('#cl-stage'), cv = $('#cl-canvas'), ctx = cv.getContext('2d');
  let view = { W: 0, H: 0, dpr: 1, ox: 0, oy: 0, cw: 0, ch: 0 };

  function tplList() { const n = Math.max(2, Math.min(9, st.photos.length || 2)); return TEMPLATES[n]; }
  function layout() { return tplList()[Math.min(st.tpl, tplList().length - 1)]; }
  function ensureCells() { const L = layout(); while (st.cells.length < L.length) st.cells.push({ p: st.cells.length < st.photos.length ? st.cells.length : -1, zoom: 1, cx: 0.5, cy: 0.5 }); st.cells.length = L.length; st.cells.forEach((c, i) => { if (c.p >= st.photos.length) c.p = -1; }); const used = new Set(st.cells.map((c) => c.p)); st.cells.forEach((c) => { if (c.p < 0) { for (let k = 0; k < st.photos.length; k++) if (!used.has(k)) { c.p = k; used.add(k); break; } } }); }
  function dims(longEdge) { const [, a, b] = ASPECTS[st.aspect]; return a >= b ? [longEdge, Math.round(longEdge * b / a)] : [Math.round(longEdge * a / b), longEdge]; }
  function cellRect(r, OW, OH, b) { const [x, y, w, h] = r; const L = b + x * (OW - b), T = b + y * (OH - b), R = b + (x + w) * (OW - b) - b, B = b + (y + h) * (OH - b) - b; return [L, T, Math.max(1, R - L), Math.max(1, B - T)]; }
  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function cover(cell, ph, w, h) { const s = Math.max(w / ph.w, h / ph.h) * cell.zoom; const vw = w / s, vh = h / s; let cx = cell.cx * ph.w, cy = cell.cy * ph.h; cx = Math.min(ph.w - vw / 2, Math.max(vw / 2, cx)); cy = Math.min(ph.h - vh / 2, Math.max(vh / 2, cy)); cell.cx = cx / ph.w; cell.cy = cy / ph.h; return [cx - vw / 2, cy - vh / 2, vw, vh]; }
  function paint(c, OW, OH, unit, opts = {}) {
    const b = st.border * unit, rad = st.radius * unit; c.fillStyle = st.bg; c.fillRect(0, 0, OW, OH);
    layout().forEach((r, i) => {
      const [x, y, w, h] = cellRect(r, OW, OH, b); const cell = st.cells[i];
      c.save(); rr(c, x, y, w, h, rad); c.clip();
      if (cell && cell.p >= 0 && st.photos[cell.p]) { const ph = st.photos[cell.p]; const [sx, sy, sw, sh] = cover(cell, ph, w, h); c.imageSmoothingQuality = 'high'; c.drawImage(ph.bmp, sx, sy, sw, sh, x, y, w, h); }
      else { c.fillStyle = '#2a2e37'; c.fillRect(x, y, w, h); c.fillStyle = '#9aa1ad'; c.font = `${Math.round(18 * unit)}px -apple-system,sans-serif`; c.textAlign = 'center'; c.fillText('+ photo', x + w / 2, y + h / 2); }
      if (opts.hl === i) { c.fillStyle = 'rgba(240,160,64,.35)'; c.fillRect(x, y, w, h); }
      if (opts.lift === i) { c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(x, y, w, h); }
      c.restore();
    });
  }
  function resize() { view.dpr = Math.min(3, devicePixelRatio || 1); view.W = stage.clientWidth; view.H = stage.clientHeight; cv.width = Math.round(view.W * view.dpr); cv.height = Math.round(view.H * view.dpr); draw(); }
  let dragState = null;
  function draw() {
    if (!view.W) return; ensureCells(); const pad = 16; const [a, b] = dims(1000); const s = Math.min((view.W - 2 * pad) / a, (view.H - 2 * pad - 30) / b);
    view.cw = a * s; view.ch = b * s; view.ox = (view.W - view.cw) / 2; view.oy = (view.H - 30 - view.ch) / 2;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); ctx.fillStyle = '#050506'; ctx.fillRect(0, 0, view.W, view.H);
    ctx.save(); ctx.translate(view.ox, view.oy); paint(ctx, view.cw, view.ch, view.cw / 1080, { hl: dragState && dragState.kind === 'swap' ? dragState.over : -1, lift: dragState && dragState.kind === 'swap' ? dragState.cell : -1 }); ctx.restore();
    if (dragState && dragState.kind === 'swap' && dragState.p) { const cell = st.cells[dragState.cell]; const ph = st.photos[cell.p]; if (ph) { const w = 90, h = 90 * ph.h / ph.w; ctx.globalAlpha = 0.85; ctx.drawImage(ph.bmp, dragState.p.x - w / 2, dragState.p.y - h / 2, w, h); ctx.globalAlpha = 1; } }
  }
  function hit(p) { const b = st.border * view.cw / 1080; const L = layout(); for (let i = 0; i < L.length; i++) { const [x, y, w, h] = cellRect(L[i], view.cw, view.ch, b); if (p.x >= view.ox + x && p.x <= view.ox + x + w && p.y >= view.oy + y && p.y <= view.oy + y + h) return { i, rect: [view.ox + x, view.oy + y, w, h] }; } return null; }
  // ---- gestures: 1 finger = drag to swap; 2 fingers in a cell = pan + zoom ----
  const ptrs = new Map();
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId); const p = pos(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; const h = hit(m) || (dragState && { i: dragState.cell }); if (!h) return; const cell = st.cells[h.i]; dragState = { kind: 'pinch', cell: h.i, d0: Math.hypot(a.x - b.x, a.y - b.y), z0: cell.zoom, m0: m, cx0: cell.cx, cy0: cell.cy }; draw(); return; }
    const h = hit(p); if (!h) return; const cell = st.cells[h.i];
    if (cell.p < 0) { $('#cl-picker').click(); return; }
    dragState = { kind: 'press', cell: h.i, start: p };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return; const p = pos(e); ptrs.set(e.pointerId, p); if (!dragState) return;
    if (dragState.kind === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const cell = st.cells[dragState.cell]; const ph = st.photos[cell.p]; if (!ph) return;
      cell.zoom = Math.max(1, Math.min(6, dragState.z0 * d / dragState.d0));
      const r = cellRect(layout()[dragState.cell], view.cw, view.ch, st.border * view.cw / 1080); const sc = Math.max(r[2] / ph.w, r[3] / ph.h) * cell.zoom;
      cell.cx = dragState.cx0 - (m.x - dragState.m0.x) / sc / ph.w; cell.cy = dragState.cy0 - (m.y - dragState.m0.y) / sc / ph.h; draw(); return;
    }
    if (dragState.kind === 'press' && Math.hypot(p.x - dragState.start.x, p.y - dragState.start.y) > 8) dragState.kind = 'swap';
    if (dragState.kind === 'swap') { const h = hit(p); dragState.over = h && h.i !== dragState.cell ? h.i : -1; dragState.p = p; draw(); }
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); if (!dragState) return;
    if (dragState.kind === 'swap' && ptrs.size === 0) { const o = dragState.over; if (o >= 0) { const A = st.cells[dragState.cell], Bc = st.cells[o]; [A.p, Bc.p] = [Bc.p, A.p]; A.zoom = Bc.zoom = 1; A.cx = A.cy = Bc.cx = Bc.cy = 0.5; } }
    if (ptrs.size === 0) dragState = null; draw();
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

  // ---- controls ----
  function renderTemplates() {
    const strip = $('#tpl-strip'); strip.innerHTML = '';
    tplList().forEach((L, k) => {
      const b = document.createElement('button'); b.className = 'tpl' + (k === st.tpl ? ' on' : ''); b.setAttribute('aria-label', 'Template ' + (k + 1));
      const c = document.createElement('canvas'); c.width = 104; c.height = 104; const x = c.getContext('2d'); x.fillStyle = '#9aa1ad';
      L.forEach((r) => { const [L0, T, W, H] = cellRect(r, 104, 104, 6); x.fillRect(L0, T, W, H); }); b.appendChild(c);
      b.onclick = () => { st.tpl = k; renderTemplates(); draw(); }; strip.appendChild(b);
    });
  }
  $('#ratio-seg').innerHTML = ASPECTS.map(([l], i) => `<button data-a="${i}" class="${i === st.aspect ? 'on' : ''}">${l}</button>`).join('');
  $$('#ratio-seg button').forEach((b) => b.onclick = () => { st.aspect = +b.dataset.a; $$('#ratio-seg button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('#cl-border').oninput = (e) => { st.border = +e.target.value; $('#cl-border-v').textContent = st.border; draw(); };
  $('#cl-radius').oninput = (e) => { st.radius = +e.target.value; $('#cl-radius-v').textContent = st.radius; draw(); };
  const sw = $('#cl-swatches'); sw.innerHTML = COLORS.map((c) => `<button style="background:${c}" data-c="${c}" aria-label="Background ${c}" class="${c === st.bg ? 'on' : ''}"></button>`).join('') + `<input type="color" id="cl-color" value="#ffffff" aria-label="Custom background">`;
  $$('#cl-swatches button').forEach((b) => b.onclick = () => { st.bg = b.dataset.c; $$('#cl-swatches button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('#cl-color').oninput = (e) => { st.bg = e.target.value; $$('#cl-swatches button').forEach((x) => x.classList.remove('on')); draw(); };
  $$('#collage .tab').forEach((t) => t.onclick = () => { $$('#collage .tab').forEach((x) => x.classList.toggle('active', x === t)); $$('.cpane').forEach((p) => p.classList.toggle('active', p.id === 'cpane-' + t.dataset.ctab)); });
  $('#cl-add').onclick = () => $('#cl-picker').click();
  $('#cl-shuffle').onclick = () => { const ps = st.cells.map((c) => c.p); for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; } st.cells.forEach((c, i) => { c.p = ps[i]; c.zoom = 1; c.cx = c.cy = 0.5; }); draw(); };
  $('#cl-picker').onchange = async (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await load(files); }; // QA BUG-6: was sliced to 9 first, so the 'up to 9' toast never showed
  async function load(files) {
    if (files.length > 9) { toast(`Collages take up to 9 photos — using the first 9 of ${files.length}.`); files = files.slice(0, 9); }
    const out = [];
    for (const f of files) {
      try {
        let bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); const L = Math.max(bmp.width, bmp.height), cap = 2400;
        if (L > cap) { const s = cap / L, c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close(); bmp = await createImageBitmap(c); }
        out.push({ bmp, w: bmp.width, h: bmp.height, name: f.name });
      } catch (err) { toast(`${f.name}: couldn’t open this image.`); }
    }
    st.photos.forEach((p) => p.bmp.close && p.bmp.close());
    st.photos = out; st.cells = []; st.tpl = 0; renderTemplates(); draw(); emptyState();
  }
  function emptyState() { const e = !st.photos.length; $('#cl-empty').hidden = !e; $('#cl-hint').hidden = e; }
  $('#cl-empty').onclick = () => $('#cl-picker').click();
  // ---- export ----
  let saving = false; // QA BUG-5 (collage): ignore a double-tap while a save is in flight
  $('#cl-save').onclick = async () => {
    if (!st.photos.length) { $('#cl-picker').click(); return; }
    if (saving) return; saving = true; try { await saveCollage(); } finally { saving = false; }
  };
  async function saveCollage() {
    const [a, b] = dims(1); let L = 4096; const maxA = 16.0e6; while ((a >= b ? L * L * b / a : L * L * a / b) > maxA) L -= 128;
    const [OW, OH] = dims(L); const c = document.createElement('canvas'); c.width = OW; c.height = OH; const x = c.getContext('2d');
    paint(x, OW, OH, OW / 1080);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)); c.width = c.height = 0;
    if (!blob) { toast('Export failed (canvas too large for this device).'); return; }
    const file = new File([blob], `collage-${Date.now()}.jpg`, { type: 'image/jpeg' }); window.__lastCollage = { w: OW, h: OH, bytes: blob.size };
    await deliver(file, `${OW}×${OH} · ${(blob.size / 1e6).toFixed(1)} MB JPEG`);
  }
  window.addEventListener('resize', () => { if ($('#collage').classList.contains('active')) resize(); });
  return {
    open() { show('collage'); renderTemplates(); emptyState(); requestAnimationFrame(resize); if (!st.photos.length) $('#cl-picker').click(); },
    load, state: st,
  };
}
