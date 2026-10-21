/* Mineral Murals — public site script. One file for every page; the page type is <body data-page="…">. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const paras = (t) => String(t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const page = document.body.dataset.page || '';
  let C = null;             // public catalog
  let IMGOPT = false;       // Vercel Image Optimization available

  // ---------- images: resized copies for grids (no colour/sharpness changes), originals for full-size views
  const img = (src, w) => (IMGOPT && src && !src.startsWith('blob:') ? `/_vercel/image?url=${encodeURIComponent(src)}&w=${w}&q=82` : src);
  document.addEventListener('error', (e) => {      // if a resized copy fails, fall back to the original once
    const t = e.target;
    if (t.tagName === 'IMG' && t.dataset.orig && t.src.indexOf('/_vercel/image') > -1) t.src = t.dataset.orig;
  }, true);
  const pic = (p, w, alt = '', extra = '') => (p ? `<img src="${esc(img(p.src, w))}" data-orig="${esc(p.src)}" alt="${esc(alt)}" loading="lazy" decoding="async"${p.w ? ` width="${p.w}" height="${p.h}"` : ''} ${extra}>` : '');

  // ---------- cart (one of each piece; stored on this device)
  const cart = {
    get: () => { try { return JSON.parse(localStorage.getItem('mm_cart') || '[]').filter((x) => typeof x === 'string'); } catch { return []; } },
    set: (ids) => { localStorage.setItem('mm_cart', JSON.stringify([...new Set(ids)])); paintCount(); },
    add: (id) => cart.set([...cart.get(), id]),
    remove: (id) => cart.set(cart.get().filter((x) => x !== id)),
    has: (id) => cart.get().includes(id),
  };
  function paintCount() { const n = cart.get().length; $$('.count').forEach((el) => { el.textContent = n; el.hidden = !n; }); }
  window.addEventListener('storage', (e) => { if (e.key === 'mm_cart') paintCount(); });

  function toast(msg, ms = 2600) {
    $$('.toast').forEach((t) => t.remove());
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms);
  }

  async function loadCatalog() {
    try {
      const r = await fetch('/api/catalog', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      const c = await r.json(); IMGOPT = !!c.imgopt; return c;
    } catch {
      const r = await fetch('/data/catalog.seed.json');   // static hosting fallback
      const c = await r.json();
      c.listings = c.listings.filter((l) => ['available', 'pending', 'sold'].includes(l.status));
      c.checkout = false; return c;
    }
  }
  const sectionName = (id) => (C.sections.find((s) => s.id === id) || {}).name || '';
  const live = () => C.listings.filter((l) => l.status !== 'sold');
  const byNew = (a, b) => (a.created < b.created ? 1 : -1);

  // ---------- chrome: header, tab bar, footer
  const ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z"/></svg>',
    shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/></svg>',
    museum: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 9 12 4l9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20.5h18"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 7h14l-1.2 12.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/></svg>',
    about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4" stroke-linecap="round"/></svg>',
  };
  function chrome() {
    const s = C.settings || {};
    const logo = s.logo_url && s.logo_url !== '/assets/logo-mark.png' ? s.logo_url : '/assets/brand/mineral-murals-logo.png';
    const cur = (p) => (page === p || (p === 'shop' && page === 'product') || (p === 'builds' && page === 'build') ? ' aria-current="page"' : '');
    const builds = s.show_builds || (C.builds || []).length > 0;
    const nav = [['shop', '/shop.html', 'Shop'], ['museum', '/museum.html', 'Museum'], ...(builds ? [['builds', '/builds.html', 'Builds']] : []), ['about', '/about.html', 'About'], ['contact', '/contact.html', 'Contact']];
    const head = $('#mm-header');
    if (head) {
      head.outerHTML = `${s.announcement ? `<div class="announce">${esc(s.announcement)}</div>` : ''}
<header class="site-head"><div class="wrap">
  <a class="brand" href="/" aria-label="Mineral Murals home"><img src="${esc(logo)}" alt="" width="54" height="54"><span><b>Mineral Murals</b><small>Agates &amp; mineral specimens</small></span></a>
  <nav class="nav" aria-label="Main">${nav.map(([k, h, t]) => `<a href="${h}"${cur(k)}>${t}</a>`).join('')}</nav>
  <a class="cart-btn" href="/cart.html" aria-label="Cart">${ICON.cart}<span class="count" hidden>0</span></a>
</div></header>
<nav class="tabbar" aria-label="Main" style="--tabs:5">
  <a href="/"${cur('home')}>${ICON.home}Home</a><a href="/shop.html"${cur('shop')}>${ICON.shop}Shop</a><a href="/museum.html"${cur('museum')}>${ICON.museum}Museum</a>
  <a href="/cart.html"${cur('cart')}>${ICON.cart}Cart<span class="count" hidden>0</span></a><a href="/about.html"${cur('about') || cur('contact')}>${ICON.about}About</a>
</nav>`;
    }
    const foot = $('#mm-footer');
    if (foot) {
      foot.outerHTML = `<footer class="site-foot"><div class="wrap">
  <div><img src="${esc(logo)}" alt="Mineral Murals"><p>Collector agates, mineral specimens &amp; lapidary.<br>Northeast Ohio. ${esc(s.ships_note || '')}</p></div>
  <div><h2>Browse</h2><a href="/shop.html">Shop</a><a href="/museum.html">Museum</a>${builds ? '<a href="/builds.html">Lapidary builds</a>' : ''}<a href="/about.html">About</a><a href="/contact.html">Contact</a><a href="/seller" class="seller-entry">Seller sign in</a></div>
  <div><h2>Find Mineral Murals</h2>${s.ebay_store_url ? `<a href="${esc(s.ebay_store_url)}" rel="noopener" target="_blank">eBay</a>` : ''}${s.etsy_store_url ? `<a href="${esc(s.etsy_store_url)}" rel="noopener" target="_blank">Etsy</a>` : ''}${s.contact_email ? `<a href="mailto:${esc(s.contact_email)}">Email</a>` : ''}</div>
</div></footer>`;
    }
    paintCount();
  }

  // ---------- card
  function card(l) {
    const p = l.photos[0];
    const state = l.status === 'sold' ? '<span class="badge sold">Sold</span>' : l.status === 'pending' ? '<span class="badge hold">On hold</span>' : '';
    return `<a class="card${l.status === 'sold' ? ' is-sold' : ''}" href="/p/${encodeURIComponent(l.id)}">
  <div class="ph">${pic(p, 640, l.title)}${state}</div>
  <div class="t">${esc(l.title)}</div><div class="p">${money(l.price)}</div>${l.locality ? `<div class="loc">${esc(l.locality)}</div>` : ''}</a>`;
  }

  // ---------- home
  function home() {
    const s = C.settings || {}, pool = live();
    document.body.classList.toggle('collection-empty', !pool.length);
    if (s.hero_title && !['One-of-one agates, cut and polished', 'Discover Your Creation'].includes(s.hero_title)) $('#hero-title').textContent = s.hero_title;
    if (s.hero_text && !s.hero_text.startsWith('Kentucky, Chihuahua, Patagonia')) $('#hero-text').textContent = s.hero_text;
    const latest = pool.slice().sort(byNew).slice(0, 8);
    $('#latest').innerHTML = latest.map(card).join('') || `<div class="collection-note"><div><span class="small-rule"></span><h3>New pieces are on the bench.</h3><p>The next available specimens will appear here when their photographs and details are ready.</p></div><a class="text-link" href="/museum.html">In the meantime, explore the museum <span aria-hidden="true">→</span></a></div>`;
    const counts = {};
    for (const l of pool) counts[l.section] = (counts[l.section] || 0) + 1;
    const sections = (C.sections || []).filter((x) => counts[x.id]);
    $('#origin-section').hidden = !sections.length;
    $('#origins').innerHTML = sections.map((x) => {
      const cover = pool.find((l) => l.section === x.id && l.featured) || pool.find((l) => l.section === x.id);
      return `<a class="origin" href="/shop.html?s=${encodeURIComponent(x.id)}">${pic(cover.photos[0], 256, x.name)}<div><b>${esc(x.name)}</b><span>${x.group ? `${esc(x.group)} · ` : ''}${counts[x.id]} ${counts[x.id] === 1 ? 'piece' : 'pieces'}</span></div><span class="origin-arrow" aria-hidden="true">↗</span></a>`;
    }).join('');
    const mt = $('#museum-imgs');
    if (mt) {
      mt.innerHTML = (C.museum || []).filter((m) => m.photos?.[0]).slice(0, 2).map((m) => `<a href="/museum.html#${encodeURIComponent(m.id)}" aria-label="View ${esc(m.title)} in the museum">${pic(m.photos[0], 384, m.title)}</a>`).join('');
      if (s.museum_intro && s.museum_intro !== 'Pieces from my own collection. Not for sale, just worth seeing.') $('#museum-blurb').textContent = s.museum_intro;
    }
  }

  // ---------- shop
  function shop() {
    const q = new URLSearchParams(location.search);
    const st = { s: q.get('s') || '', q: q.get('q') || '', sort: q.get('sort') || 'new', sold: q.get('sold') === '1' };
    const chips = $('#chips');
    const counts = {};
    for (const l of live()) counts[l.section] = (counts[l.section] || 0) + 1;
    const secs = C.sections.filter((x) => counts[x.id] || x.id === st.s);
    chips.innerHTML = `<button class="chip" type="button" data-s="">All</button>${secs.map((x) => `<button class="chip" type="button" data-s="${esc(x.id)}">${esc(x.name)}</button>`).join('')}`;
    const box = $('#q'), sort = $('#sort'), sold = $('#show-sold');
    box.value = st.q; sort.value = st.sort; sold.checked = st.sold;
    const render = () => {
      $$('.chip', chips).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === st.s)));
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      let list = C.listings.filter((l) => (st.sold || l.status !== 'sold') && (!st.s || l.section === st.s) &&
        words.every((w) => `${l.title} ${l.locality} ${l.material} ${l.form} ${sectionName(l.section)}`.toLowerCase().includes(w)));
      list.sort(st.sort === 'low' ? (a, b) => a.price - b.price : st.sort === 'high' ? (a, b) => b.price - a.price : byNew);
      $('#results').innerHTML = list.map(card).join('');
      $('#none').hidden = !!list.length;
      if (!C.listings.length) $('#none').innerHTML = 'New pieces are on the bench. Browse the <a href="/museum.html">museum collection</a> while the next specimens are being prepared.';
      else $('#none').textContent = 'No pieces match your selection. Try another word or clear the filter.';
      $('#count').textContent = `${list.length} ${list.length === 1 ? 'piece' : 'pieces'}`;
      const u = new URLSearchParams(); if (st.s) u.set('s', st.s); if (st.q) u.set('q', st.q); if (st.sort !== 'new') u.set('sort', st.sort); if (st.sold) u.set('sold', '1');
      history.replaceState(null, '', `${location.pathname}${u.toString() ? `?${u}` : ''}`);
      document.title = `${st.s ? `${sectionName(st.s)} · ` : ''}Shop · Mineral Murals`;
    };
    chips.addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; st.s = b.dataset.s; render(); b.scrollIntoView({ inline: 'nearest', block: 'nearest' }); });
    box.addEventListener('input', () => { st.q = box.value.trim(); render(); });
    sort.addEventListener('change', () => { st.sort = sort.value; render(); });
    sold.addEventListener('change', () => { st.sold = sold.checked; render(); });
    render();
    shopTrays();
  }


  // ---------- tray videos: one recording of many rocks; scrub the bar to see (and buy) each piece
  function trayGroups() {
    const groups = {};
    for (const l of C.listings) if (l.video?.batch) (groups[l.video.batch] ||= { clip: l.video.clip, pieces: [] }).pieces.push(l);
    return Object.entries(groups).map(([id, g]) => ({ id, ...g, pieces: g.pieces.sort((a, b) => a.video.start - b.video.start) }));
  }
  function tray(g, focusId = '') {
    const el = document.createElement('section'); el.className = 'tray';
    const first = g.pieces[0].video.start, last = g.pieces[g.pieces.length - 1].video.end, span = Math.max(.1, last - first);
    const focus = g.pieces.find((l) => l.id === focusId) || g.pieces.find((l) => l.status === 'available') || g.pieces[0];
    el.innerHTML = `<div class="tray-player"><video playsinline muted preload="metadata" src="${esc(g.clip)}#t=${focus.video.start}"></video><button class="tray-play" type="button" aria-label="Play">▶</button></div>
<div class="tray-bar" role="slider" tabindex="0" aria-label="Scrub through the tray" aria-valuemin="0" aria-valuemax="${g.pieces.length}">${g.pieces.map((l) => `<span class="tray-seg${l.status === 'sold' ? ' sold' : ''}" style="flex:${(l.video.end - l.video.start).toFixed(2)}" data-id="${esc(l.id)}">${l.photos[0] ? `<img src="${esc(img(l.photos[0].src, 160))}" data-orig="${esc(l.photos[0].src)}" alt="" loading="lazy">` : ''}</span>`).join('')}<i class="tray-head"></i><div class="tray-peek" hidden></div></div>
<div class="tray-now" aria-live="polite"></div>`;
    const video = $('video', el), bar = $('.tray-bar', el), head = $('.tray-head', el), peek = $('.tray-peek', el), now = $('.tray-now', el), play = $('.tray-play', el);
    const at = (t) => g.pieces.find((l) => t >= l.video.start && t < l.video.end) || (t >= last ? g.pieces[g.pieces.length - 1] : null);
    const timeAtX = (x) => { const r = bar.getBoundingClientRect(); return first + clamp((x - r.left) / r.width, 0, .999) * span; };
    let shown = null;
    const showNow = (l) => {
      if (!l || l === shown) return; shown = l;
      $$('.tray-seg', el).forEach((s) => s.classList.toggle('on', s.dataset.id === l.id));
      const can = C.checkout && l.status === 'available';
      now.innerHTML = `${pic(l.photos[0], 256, l.title)}<div><a href="/p/${encodeURIComponent(l.id)}"><b>${esc(l.title)}</b></a><div class="p">${l.status === 'sold' ? 'Sold' : l.status === 'pending' ? 'On hold' : money(l.price)}</div></div>${can ? `<button class="btn primary" type="button" data-add="${esc(l.id)}">${cart.has(l.id) ? 'In your cart' : 'Add to cart'}</button>` : `<a class="btn" href="/p/${encodeURIComponent(l.id)}">View piece</a>`}`;
      const add = $('[data-add]', now); if (add) add.addEventListener('click', () => { if (!cart.has(l.id)) { cart.add(l.id); toast('Added to your cart'); } add.textContent = 'In your cart'; });
    };
    const paintHead = () => { head.style.left = `${clamp((video.currentTime - first) / span, 0, 1) * 100}%`; };
    video.addEventListener('timeupdate', () => { paintHead(); const l = at(video.currentTime); if (l) showNow(l); if (video.currentTime >= last) video.pause(); });
    video.addEventListener('play', () => { play.hidden = true; }); video.addEventListener('pause', () => { play.hidden = false; });
    play.addEventListener('click', () => { if (video.currentTime >= last - .1) video.currentTime = first; video.play().catch(() => {}); });
    video.addEventListener('click', () => (video.paused ? play.click() : video.pause()));
    let dragging = false;
    const preview = (x) => {
      const t = timeAtX(x), l = at(t), r = bar.getBoundingClientRect(); if (!l) return;
      peek.hidden = false; peek.style.left = `${clamp(x - r.left, 60, r.width - 60)}px`;
      peek.innerHTML = `${pic(l.photos[0], 256, '')}<b>${esc(l.title)}</b><span>${l.status === 'sold' ? 'Sold' : money(l.price)}</span>`;
      return { t, l };
    };
    bar.addEventListener('pointermove', (e) => { const hit = preview(e.clientX); if (dragging && hit) { video.currentTime = hit.t; showNow(hit.l); paintHead(); } });
    bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); const hit = preview(e.clientX); if (hit) { video.pause(); video.currentTime = hit.t; showNow(hit.l); paintHead(); } });
    bar.addEventListener('pointerup', () => { dragging = false; if (matchMedia('(hover: none)').matches) peek.hidden = true; });
    bar.addEventListener('pointerleave', () => { if (!dragging) peek.hidden = true; });
    bar.addEventListener('keydown', (e) => {
      const i = g.pieces.indexOf(shown || focus), next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
      if (next < 0 || next >= g.pieces.length) return; e.preventDefault(); const l = g.pieces[next]; video.currentTime = l.video.start + .05; showNow(l); paintHead();
    });
    showNow(focus); video.addEventListener('loadedmetadata', paintHead, { once: true });
    return el;
  }
  function shopTrays() {
    const target = $('#trays'); if (!target) return;
    const groups = trayGroups().filter((g) => g.pieces.some((l) => l.status !== 'sold'));
    target.hidden = !groups.length; if (!groups.length) return;
    target.innerHTML = '<div class="band-title"><h2>Watch the tray</h2><span class="muted">Drag along the bar to see each stone. Tap one to add it to your cart.</span></div>';
    groups.slice(0, 4).forEach((g) => target.append(tray(g)));
  }
  // ---------- full-resolution inspection: pointer loupe + touch/keyboard photo viewer
  const zoomIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6" stroke-linecap="round"/></svg>';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function magnifier(surface, image, fullSource, enabled = () => true) {
    const lens = document.createElement('span');
    lens.className = 'photo-loupe'; lens.setAttribute('aria-hidden', 'true'); lens.hidden = true;
    lens.style.backgroundImage = `url(${JSON.stringify(fullSource)})`;
    surface.appendChild(lens);
    let raf = 0, point = null;
    const hide = () => { lens.hidden = true; surface.classList.remove('loupe-active'); };
    const paint = () => {
      raf = 0;
      if (!point || !enabled() || !image.complete || !image.naturalWidth) { hide(); return; }
      const box = image.getBoundingClientRect(), frame = surface.getBoundingClientRect();
      // Account for the empty mat around a contained portrait/landscape photo.
      const fit = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const width = image.naturalWidth * fit, height = image.naturalHeight * fit;
      const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
      const x = point.x - left, y = point.y - top;
      if (x < 0 || y < 0 || x > width || y > height) { hide(); return; }
      const diameter = Math.min(190, Math.max(130, frame.width * .3)), power = 2.7;
      lens.style.width = lens.style.height = `${diameter}px`;
      lens.style.left = `${point.x - frame.left - diameter / 2 + surface.scrollLeft}px`;
      lens.style.top = `${point.y - frame.top - diameter / 2 + surface.scrollTop}px`;
      lens.style.backgroundSize = `${width * power}px ${height * power}px`;
      lens.style.backgroundPosition = `${diameter / 2 - x * power}px ${diameter / 2 - y * power}px`;
      lens.hidden = false; surface.classList.add('loupe-active');
    };
    const move = (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') { hide(); return; }
      if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      point = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(paint);
    };
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerleave', hide);
    surface.addEventListener('scroll', hide, { passive: true });
    return { hide, destroy() { cancelAnimationFrame(raf); surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerleave', hide); surface.removeEventListener('scroll', hide); lens.remove(); } };
  }
  let activePhotoViewer = null;
  const photoViewerEntries = new Map();
  window.addEventListener('popstate', (e) => {
    const token = e.state && e.state.mmPhotoViewer;
    if (activePhotoViewer && activePhotoViewer.token !== token) activePhotoViewer.close(false);
    if (!activePhotoViewer && token && photoViewerEntries.has(token)) {
      const saved = photoViewerEntries.get(token); lightbox(saved.photos, saved.index, token);
    }
  });
  function lightbox(photos, start = 0, historyToken = '') {
    photos = photos.filter((src) => typeof src === 'string' && src);
    if (!photos.length || activePhotoViewer) return;
    let index = clamp(Number(start) || 0, 0, photos.length - 1), scale = 1, pan = { x: 0, y: 0 };
    let fit = { width: 1, height: 1 }, maxScale = 4, loaded = false, closed = false;
    let gesture = null, lastTap = null;
    const pointers = new Map(), opener = document.activeElement, oldOverflow = document.body.style.overflow;
    const token = historyToken || `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const lb = document.createElement('div');
    lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photo viewer');
    lb.innerHTML = `<div class="lb-bar"><div class="lb-title"><span>Closer look</span><b id="lb-n" aria-live="polite"></b></div><button type="button" id="lb-x" aria-label="Close photo viewer"><span aria-hidden="true">×</span> Close</button></div>
<div class="lb-stage" id="lb-stage" tabindex="0" role="group" aria-label="Photo. Use plus and minus to zoom, arrow keys to move, or Escape to close." aria-describedby="lb-help"><img id="lb-photo" draggable="false" alt=""><span class="lb-loading" role="status">Loading full-resolution photo…</span></div>
<div class="lb-controls"><div class="lb-pages"><button type="button" id="lb-prev" aria-label="Previous photo">←</button><button type="button" id="lb-next" aria-label="Next photo">→</button></div><div class="lb-zoom"><button type="button" id="lb-less" aria-label="Zoom out">−</button><button type="button" id="lb-fit" aria-label="Fit whole photo">Fit</button><button type="button" id="lb-more" aria-label="Zoom in">+</button></div></div>
<div class="lb-foot" id="lb-help"><span class="lb-pointer-help">Move over the photo to magnify · click to zoom</span><span class="lb-touch-help">Pinch or double-tap to zoom · swipe to change photos</span><span class="lb-pan-help">Drag to explore · Fit to see the whole photo</span></div>`;
    document.body.appendChild(lb); document.body.style.overflow = 'hidden';
    // Inert keeps keyboard and assistive technology inside the viewer; restore exact prior state on close.
    const background = [...document.body.children].filter((el) => el !== lb).map((el) => [el, el.inert]);
    background.forEach(([el]) => { el.inert = true; });
    const stage = $('#lb-stage', lb), im = $('#lb-photo', lb), loading = $('.lb-loading', lb);
    const previous = $('#lb-prev', lb), next = $('#lb-next', lb), less = $('#lb-less', lb), more = $('#lb-more', lb), fitButton = $('#lb-fit', lb);
    let loupe = null;
    const constrain = () => {
      const x = Math.max(0, (fit.width * scale - stage.clientWidth) / 2), y = Math.max(0, (fit.height * scale - stage.clientHeight) / 2);
      pan.x = clamp(pan.x, -x, x); pan.y = clamp(pan.y, -y, y);
    };
    const paint = () => {
      constrain();
      im.style.width = `${fit.width}px`; im.style.height = `${fit.height}px`;
      im.style.transform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
      lb.classList.toggle('is-zoomed', scale > 1.01);
      stage.classList.toggle('is-pannable', scale > 1.01);
      less.disabled = !loaded || scale <= 1.01; more.disabled = !loaded || scale >= maxScale - .01;
      fitButton.disabled = !loaded;
      fitButton.textContent = scale > 1.01 ? `${Math.round(scale * 100)}% · Fit` : 'Fit';
      if (scale > 1.01 && loupe) loupe.hide();
    };
    const resize = () => {
      if (!loaded) return;
      const ratio = Math.min((stage.clientWidth - 24) / im.naturalWidth, (stage.clientHeight - 24) / im.naturalHeight, 1);
      fit = { width: Math.max(1, im.naturalWidth * ratio), height: Math.max(1, im.naturalHeight * ratio) };
      maxScale = Math.max(2.5, Math.min(6, 1 / ratio));
      scale = Math.min(scale, maxScale); paint();
    };
    const point = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
    const zoom = (value, anchor = { x: 0, y: 0 }) => {
      if (!loaded) return;
      const target = clamp(value, 1, maxScale), ratio = target / scale;
      pan = { x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio };
      scale = target; paint();
    };
    const toggleZoom = (anchor) => zoom(scale > 1.01 ? 1 : Math.min(2.5, maxScale), anchor);
    const show = (value) => {
      index = clamp(value, 0, photos.length - 1); scale = 1; pan = { x: 0, y: 0 }; loaded = false;
      pointers.clear(); gesture = null; lastTap = null;
      if (loupe) loupe.destroy();
      im.style.opacity = '0'; im.alt = `Full-resolution photo ${index + 1} of ${photos.length}`;
      loading.hidden = false; loading.textContent = 'Loading full-resolution photo…';
      stage.setAttribute('aria-busy', 'true'); $('#lb-n', lb).textContent = `${index + 1} of ${photos.length}`;
      previous.disabled = index === 0; next.disabled = index === photos.length - 1;
      $('.lb-pages', lb).hidden = photos.length === 1;
      photoViewerEntries.set(token, { photos, index });
      im.onload = () => {
        if (closed) return;
        loaded = true; loading.hidden = true; stage.removeAttribute('aria-busy'); im.style.opacity = '1'; resize();
      };
      im.onerror = () => { loading.textContent = 'This photo could not load. Try another photo, or close and try again.'; stage.removeAttribute('aria-busy'); };
      im.src = photos[index]; loupe = magnifier(stage, im, photos[index], () => loaded && scale <= 1.01); paint();
    };
    const close = (goBack = true) => {
      if (closed) return;
      closed = true; if (loupe) loupe.destroy(); observer.disconnect();
      document.removeEventListener('keydown', key); window.removeEventListener('resize', resize);
      background.forEach(([el, wasInert]) => { el.inert = wasInert; });
      lb.remove(); document.body.style.overflow = oldOverflow; activePhotoViewer = null;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      if (goBack && history.state && history.state.mmPhotoViewer === token) history.back();
    };
    const key = (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') {
        const stops = $$('button:not(:disabled), [tabindex="0"]', lb), first = stops[0], last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      } else if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '+' || e.key === '=') zoom(scale * 1.5);
        else if (e.key === '-') zoom(scale / 1.5);
        else if (e.key === '0') zoom(1);
        else if (e.key === 'Home') show(0);
        else if (e.key === 'End') show(photos.length - 1);
        else if (scale > 1.01) { pan.x += e.key === 'ArrowLeft' ? 70 : e.key === 'ArrowRight' ? -70 : 0; pan.y += e.key === 'ArrowUp' ? 70 : e.key === 'ArrowDown' ? -70 : 0; paint(); }
        else if (e.key === 'ArrowLeft') show(index - 1);
        else if (e.key === 'ArrowRight') show(index + 1);
      }
    };
    stage.addEventListener('pointerdown', (e) => {
      if (!loaded || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const p = point(e); pointers.set(e.pointerId, p); stage.setPointerCapture(e.pointerId);
      if (pointers.size === 1) gesture = { first: p, pan: { ...pan }, moved: false, type: e.pointerType };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { pinch: true, distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale, pan: { ...pan }, moved: true };
        if (loupe) loupe.hide();
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      const p = point(e); pointers.set(e.pointerId, p);
      if (gesture.pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        scale = clamp(gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.distance), 1, maxScale);
        const ratio = scale / gesture.scale;
        pan = { x: center.x - (gesture.center.x - gesture.pan.x) * ratio, y: center.y - (gesture.center.y - gesture.pan.y) * ratio }; paint();
      } else if (!gesture.pinch) {
        const dx = p.x - gesture.first.x, dy = p.y - gesture.first.y;
        if (Math.hypot(dx, dy) > 6) gesture.moved = true;
        if (scale > 1.01) { pan = { x: gesture.pan.x + dx, y: gesture.pan.y + dy }; paint(); }
      }
    });
    const endPointer = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = point(e), finished = gesture; pointers.delete(e.pointerId);
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      if (!pointers.size && finished) {
        if (e.type !== 'pointercancel' && !finished.pinch) {
          const dx = p.x - finished.first.x, dy = p.y - finished.first.y;
          if (scale <= 1.01 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) show(index + (dx < 0 ? 1 : -1));
          else if (!finished.moved) {
            if (finished.type === 'mouse' || finished.type === 'pen') toggleZoom(p);
            else if (lastTap && Date.now() - lastTap.at < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 28) { toggleZoom(p); lastTap = null; }
            else lastTap = { ...p, at: Date.now() };
          }
        }
        gesture = null;
      } else if (pointers.size === 1 && finished && finished.pinch) {
        gesture = { first: [...pointers.values()][0], pan: { ...pan }, moved: true, type: e.pointerType };
      }
    };
    stage.addEventListener('pointerup', endPointer); stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(scale * Math.exp(-e.deltaY * .01), point(e)); } }, { passive: false });
    previous.addEventListener('click', () => show(index - 1)); next.addEventListener('click', () => show(index + 1));
    less.addEventListener('click', () => zoom(scale / 1.5)); more.addEventListener('click', () => zoom(scale * 1.5)); fitButton.addEventListener('click', () => zoom(1));
    $('#lb-x', lb).addEventListener('click', () => close());
    const observer = new ResizeObserver(resize); observer.observe(stage); window.addEventListener('resize', resize);
    document.addEventListener('keydown', key); activePhotoViewer = { token, close };
    if (!historyToken) history.pushState({ ...(history.state || {}), mmPhotoViewer: token }, '', location.href);
    show(index); $('#lb-x', lb).focus({ preventScroll: true });
  }
  async function checkout(ids, btn, errBox) {
    location.assign('/checkout.html?'+new URLSearchParams({ids:ids.join(',')}));
  }

  function product() {
    const main = $('main.product'); if (!main) return;
    const id = main.dataset.id, status = main.dataset.status, price = Number(main.dataset.price);
    const l = C.listings.find((x) => x.id === id);
    const strip = $('#g-strip'), thumbs = $$('.g-thumbs button');
    const full = $$('img', strip).map((i) => i.dataset.full || i.dataset.orig || i.src);
    $$('img', strip).forEach((im, i) => { im.dataset.orig = full[i]; });
    strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Specimen photos'); strip.removeAttribute('tabindex');
    [...strip.children].forEach((figure, i) => {
      const image = $('img', figure); if (!image) return;
      figure.tabIndex = 0; figure.setAttribute('role', 'button'); figure.setAttribute('aria-label', `Inspect photo ${i + 1} of ${full.length}, full size`);
      magnifier(figure, image, full[i]);
    });
    const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'g-inspect';
    inspect.innerHTML = `${zoomIcon}<span>Inspect photo</span><span class="g-inspect-pointer">Move over the image to magnify</span><span class="g-inspect-touch">Full screen &amp; zoom</span>`;
    strip.insertAdjacentElement('afterend', inspect);
    inspect.addEventListener('click', () => lightbox(full, Math.round(strip.scrollLeft / strip.clientWidth)));
    strip.addEventListener('click', (e) => { const fig = e.target.closest('figure'); if (fig) lightbox(full, [...strip.children].indexOf(fig)); });
    strip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const fig = e.target.closest('figure'); lightbox(full, fig ? [...strip.children].indexOf(fig) : Math.round(strip.scrollLeft / strip.clientWidth)); } });
    thumbs.forEach((b) => b.addEventListener('click', () => strip.scrollTo({ left: Number(b.dataset.i) * strip.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })));
    strip.addEventListener('scroll', () => { const i = Math.round(strip.scrollLeft / strip.clientWidth); thumbs.forEach((b, j) => b.setAttribute('aria-selected', String(i === j))); }, { passive: true });
    const box = $('#buybox');
    const canPay = (main.dataset.checkout === '1' || C.checkout) && status === 'available';
    if (canPay) {
      const inCart = cart.has(id);
      const others = $('.elsewhere',box)?.outerHTML || '';
      box.innerHTML = `<button class="btn primary block" type="button" id="buy-now">Buy now · ${money(price)}</button>
<div class="row2"><button class="btn" type="button" id="add-cart">${inCart ? 'In your cart' : 'Add to cart'}</button><a class="btn" href="/cart.html">View cart</a></div>
<p class="err" id="buy-err" role="alert"></p><p class="note">${C.payment_mode==='test'?'Test mode · no real charge.':'Secure checkout · card and available wallets.'}</p>${others}`;
      $('#buy-now').addEventListener('click', (e) => checkout([id], e.currentTarget, $('#buy-err')));
      $('#add-cart').addEventListener('click', (e) => {
        if (!cart.has(id)) { cart.add(id); toast('Added to your cart'); }
        e.currentTarget.textContent = 'In your cart';
      });
      $$('.elsewhere a', box).forEach((a) => { a.textContent = a.textContent.replace('Buy on', 'Also on'); });
    }
    if (l?.video?.batch) {
      const g = trayGroups().find((x) => x.id === l.video.batch), old = $('.public-video', main);
      if (g && old) { const note = old.nextElementSibling; const wrap = document.createElement('div'); wrap.innerHTML = `<p class="eyebrow tray-label">This stone on the tray · drag to see the others</p>`; wrap.append(tray(g, id)); old.replaceWith(wrap); if (note?.tagName === 'P') note.remove(); }
    }
    if (l) {
      const rel = live().filter((x) => x.id !== id && x.section === l.section).slice(0, 8);
      const more = rel.length >= 2 ? rel : live().filter((x) => x.id !== id).sort(byNew).slice(0, 8);
      if (more.length) $('#related').innerHTML = `<div class="band-title"><h2>${rel.length >= 2 ? `More ${esc(sectionName(l.section))}` : 'More from the case'}</h2><a href="/shop.html${rel.length >= 2 ? `?s=${encodeURIComponent(l.section)}` : ''}">See all</a></div><div class="scroller">${more.map(card).join('')}</div>`;
    }
  }

  // ---------- cart page
  function cartPage() {
    const wrap = $('#cart');
    const paint = () => {
      const ids = cart.get();
      const items = ids.map((id) => C.listings.find((l) => l.id === id)).filter(Boolean);
      const gone = items.filter((l) => l.status !== 'available');
      if (ids.length !== items.length || gone.length) cart.set(items.filter((l) => l.status === 'available').map((l) => l.id));
      const ok = items.filter((l) => l.status === 'available');
      if (!ok.length) {
        wrap.innerHTML = `${gone.length ? `<p class="notice bad">${gone.map((l) => esc(l.title)).join(', ')} ${gone.length === 1 ? 'has' : 'have'} sold and ${gone.length === 1 ? 'was' : 'were'} removed.</p>` : ''}
<p class="empty">Your cart is empty.</p><p><a class="btn primary" href="/shop.html">Browse the shop</a></p>`;
        return;
      }
      const s = C.settings;
      const sub = ok.reduce((a, l) => a + l.price, 0);
      const ship = s.free_shipping_over > 0 && sub >= s.free_shipping_over ? 0 : Number(s.shipping_flat || 0);
      wrap.innerHTML = `${gone.length ? `<p class="notice bad">${gone.map((l) => esc(l.title)).join(', ')} sold and ${gone.length === 1 ? 'was' : 'were'} removed.</p>` : ''}
<ul class="cart-list">${ok.map((l) => `<li>${pic(l.photos[0], 256, '')}<div><a href="/p/${encodeURIComponent(l.id)}">${esc(l.title)}</a><div class="muted">${money(l.price)}</div></div><button class="rm" type="button" data-rm="${esc(l.id)}">Remove</button></li>`).join('')}</ul>
<div class="totals"><div><span>Subtotal</span><span>${money(sub)}</span></div><div><span>Shipping</span><span>${ship ? money(ship) : 'Free'}</span></div>
${s.free_shipping_over > 0 && ship ? `<div class="muted" style="font-size:.88rem"><span>Free shipping on orders over ${money(s.free_shipping_over)}</span></div>` : ''}
<div class="grand"><span>Total</span><span>${money(sub + ship)}</span></div>
${C.checkout ? `<button class="btn primary block" type="button" id="pay" style="margin-top:10px">Secure checkout</button><p class="err" id="pay-err" role="alert" style="color:#a3261a;font-weight:600"></p><p class="muted" style="font-size:.88rem;margin:0">${C.payment_mode==='test'?'Test mode · no real charge.':'Choose card or an available wallet at checkout. No store account needed.'}</p>`
    : '<p class="notice">Online checkout is being set up. Open a specimen to see its current purchase options, or contact Mineral Murals with its name.</p>'}</div>`;
      $$('[data-rm]', wrap).forEach((b) => b.addEventListener('click', () => { cart.remove(b.dataset.rm); paint(); }));
      const pay = $('#pay'); if (pay) pay.addEventListener('click', async () => { const okk = await checkout(ok.map((l) => l.id), pay, $('#pay-err')); if (okk === false) paint(); });
    };
    paint();
  }

  // ---------- thank-you page
  async function thanks() {
    const params = new URLSearchParams(location.search), order = params.get('order'), token = params.get('token'), box = $('#order');
    if (!order || !token) { box.textContent = 'No payment to check. Your basket is saved.'; return; }
    let tries = 0;
    async function check() {
      try {
        const response = await fetch('/api/checkout?'+new URLSearchParams({order,token}),{cache:'no-store'});
        const result = await response.json(); if (!response.ok) throw Error(result.error);
        if (result.paid) {cart.set(cart.get().filter(id => !result.item_ids.includes(id))); $('main h1').textContent = result.test ? 'Test payment complete' : 'Thank you for your order';}
        else $('main h1').textContent = result.state==='conflict' ? 'Your payment needs a seller review' : 'Checking your payment';
        box.innerHTML = `${result.test?'<p class="notice">Test mode · no real charge.</p>':''}<p class="prose">${result.paid ? (result.test ? 'Test payment verified. Real inventory is unchanged.' : 'Your payment is verified and your specimens are marked sold. We’ll prepare your order for shipping.') : result.state==='conflict' ? 'Payment was received, but availability needs review. Please contact Mineral Murals with this order reference. Do not pay again.' : result.state==='expired' ? 'This checkout expired. No payment has been confirmed.' : 'Please wait while we check with your payment provider. Keep this page open and do not pay again.'}</p><ul>${result.items.map(t=>`<li>${esc(t)}</li>`).join('')}</ul><p>Total: ${money(result.total)}</p><p class="note">Order ${esc(result.id)}</p><button class="btn" type="button" id="check-payment">Check payment status</button>`;
        $('#check-payment').onclick = check;
        if (!result.paid && !['conflict','expired','failed'].includes(result.state) && ++tries<12) setTimeout(check,2500);
      } catch {box.innerHTML='<p class="notice">We could not check payment yet. Please refresh this page. Do not pay again until your payment status is confirmed.</p>';}
    }
    await check();
  }

  // ---------- museum
  function museum() {
    const s = C.settings || {};
    if (s.museum_intro && s.museum_intro !== 'Pieces from my own collection. Not for sale, just worth seeing.') $('#mu-intro').textContent = s.museum_intro;
    const grid = $('#museum'), detail = $('#mu-detail'), list = $('#museum-list'), search = $('#museum-search');
    let shownId = null;
    const items = (C.museum || []).filter((m) => m.photos?.length);
    const fullPhotos = (m) => m.photos.map((p) => p.full || p.full_src || p.src);
    const renderGrid = () => {
      const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const visible = items.filter((m) => words.every((w) => `${m.title} ${m.locality || ''} ${m.material || ''} ${m.story || ''}`.toLowerCase().includes(w)));
      $('#museum-count').textContent = `${visible.length} collection ${visible.length === 1 ? 'entry' : 'entries'}`;
      $('#museum-none').hidden = !!visible.length;
      if (!items.length) $('#museum-none').textContent = 'The collection is being photographed. Check back soon.';
      grid.innerHTML = visible.map((m, i) => `<button class="piece" type="button" data-id="${esc(m.id)}" aria-label="View ${esc(m.title)}">${pic(m.photos[0], 828, m.title)}<div class="cap"><span class="collection-index">Collection ${String(items.indexOf(m) + 1).padStart(2, '0')} <span aria-hidden="true">↗</span></span><b>${esc(m.title)}</b>${m.locality || m.material ? `<span>${esc([m.locality, m.material].filter(Boolean).join(' · '))}</span>` : ''}<span class="not-for-sale">Not for sale</span></div></button>`).join('');
    };
    const show = () => {
      let id = ''; try { id = decodeURIComponent(location.hash.slice(1)); } catch {}
      const m = items.find((x) => x.id === id);
      // Viewer history entries keep this specimen's hash; retain its DOM and focus target on close.
      if (m && shownId === m.id && !detail.hidden) return;
      shownId = m ? m.id : '';
      list.hidden = !!m; $('#mu-hero').hidden = !!m; detail.hidden = !m;
      $('#museum-resources').hidden = !!m;
      if (!m) { document.title = 'The museum · Mineral Murals'; return; }
      document.title = `${m.title} · Museum · Mineral Murals`;
      detail.innerHTML = `<nav class="crumbs"><a href="/museum.html" id="mu-back">← Back to the museum</a><span>Collection · not for sale</span></nav><div class="museum-detail-heading"><p class="eyebrow">Mineral Murals collection · ${String(items.indexOf(m) + 1).padStart(2, '0')}</p><h1>${esc(m.title)}</h1>${[m.locality, m.material, m.size].filter(Boolean).length ? `<p class="mu-meta">${esc([m.locality, m.material, m.size].filter(Boolean).join(' · '))}</p>` : ''}</div>
<div class="ph-row">${m.photos.map((p, i) => `<button type="button" class="piece museum-photo" data-i="${i}" aria-label="Inspect ${esc(m.title)}, photo ${i + 1} full size">${pic(p, 1200, `${m.title}, photo ${i + 1}`)}<span class="museum-inspect">${zoomIcon} Inspect photo</span></button>`).join('')}</div><p class="museum-photo-note">Move over the photograph to magnify. Tap to open the viewer, then pinch or use the zoom controls.</p>
<div class="museum-story"><div><p class="eyebrow">Collection note</p><span class="museum-status">Not for sale</span></div><div class="story">${paras(m.story || 'A specimen from the Mineral Murals collection, shown here for a closer look.')}</div></div><div class="museum-next">${items.length > 1 ? `<a class="text-link" href="#${encodeURIComponent(items[(items.indexOf(m) + 1) % items.length].id)}">Next collection entry <span aria-hidden="true">→</span></a>` : ''}<a href="/shop.html">Browse available pieces ↗</a></div>`;
      $$('.ph-row .piece', detail).forEach((button, i) => {
        const image = $('img', button); if (image) magnifier(button, image, fullPhotos(m)[i]);
        button.addEventListener('click', () => lightbox(fullPhotos(m), Number(button.dataset.i)));
      });
      $('#mu-back').addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', location.pathname); show(); window.scrollTo(0, 0); const opener = [...grid.querySelectorAll('[data-id]')].find((x) => x.dataset.id === m.id); if (opener) opener.focus({ preventScroll: true }); });
      window.scrollTo(0, 0);
    };
    grid.addEventListener('click', (e) => { const button = e.target.closest('.piece'); if (button) location.hash = encodeURIComponent(button.dataset.id); });
    search.addEventListener('input', renderGrid);
    window.addEventListener('hashchange', show);
    window.addEventListener('popstate', show);
    renderGrid(); show();
  }

  function textPages() {
    const s = C.settings;
    if (page === 'about') $('#about').innerHTML = paras(s.about_text && !s.about_text.startsWith('Mineral Murals offers collector-grade') ? s.about_text : 'I cut and polish agates and work with mineral specimens in Northeast Ohio. Mineral Murals is a place to share that work, offer individual pieces, and give the collection a home.\n\nThe shop is for available specimens. The museum holds pieces from the collection, photographed for a closer look. Each listing records the individual piece rather than a representative example.');
    if (page === 'contact') {
      $('#contact').innerHTML = `${s.contact_email ? `<p><a class="btn primary" href="mailto:${esc(s.contact_email)}">Email ${esc(s.contact_email)}</a></p>` : ''}
<p>Questions about a piece, shipping or a hold? Ask away and mention the piece’s name so I can find it fast.</p>
<p>${s.ebay_store_url ? `<a class="btn" href="${esc(s.ebay_store_url)}" rel="noopener" target="_blank">Message on eBay</a> ` : ''}${s.etsy_store_url ? `<a class="btn" href="${esc(s.etsy_store_url)}" rel="noopener" target="_blank">Message on Etsy</a>` : ''}</p>`;
    }
  }

  // ---------- lapidary builds
  const listLines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
  function partsHtml(t) {
    const rows = listLines(t);
    if (!rows.length) return '';
    if (rows.some((r) => r.includes('|'))) {
      return `<div class="tbl"><table><thead><tr><th>Qty</th><th>Part</th><th>Source</th></tr></thead><tbody>${rows.map((r) => { const c = r.split('|').map((x) => x.trim()); return `<tr><td>${esc(c.length > 1 ? c[0] : '')}</td><td>${esc(c.length > 1 ? c[1] : c[0])}</td><td>${esc(c[2] || '')}</td></tr>`; }).join('')}</tbody></table></div>`;
    }
    return `<ul class="ticks">${rows.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  }
  const fileKind = (name) => ((name.split('.').pop() || '').toUpperCase().slice(0, 5));
  const kb = (n) => (!n ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  function buildsPage() {
    $('#builds').innerHTML = paras(C.settings.builds_intro);
    const list = C.builds || [];
    $('#build-list').innerHTML = list.map((b) => `<a class="bcard" href="/b/${encodeURIComponent(b.id)}"><div class="ph">${pic(b.photos[0], 828, b.title)}</div>
<div class="bc"><h2>${esc(b.title)}</h2><p>${esc(b.summary)}</p><p class="bmeta">${[b.difficulty, b.time, b.cost].filter(Boolean).map(esc).join(' · ')}</p></div></a>`).join('')
      || '<p class="empty">The first plans are on the bench. Check back soon.</p>';
  }
  function buildPage() {
    const host = $('#build'); if (!host) return;
    const b = (C.builds || []).find((x) => x.id === host.dataset.id);
    if (!b) return;
    const specs = [['Difficulty', b.difficulty], ['Time', b.time], ['Cost', b.cost]].filter(([, v]) => v);
    if (b.files.length) specs.push(['Plans', `<a href="#plans">${b.files.length} download${b.files.length === 1 ? '' : 's'}</a>`]);
    host.innerHTML = `<nav class="crumbs"><a href="/builds.html">Lapidary builds</a></nav>
<h1>${esc(b.title)}</h1>${b.summary ? `<p class="lede">${esc(b.summary)}</p>` : ''}
${b.photos.length ? `<div class="bphotos">${b.photos.map((p, i) => `<button type="button" class="bph" data-i="${i}" aria-label="Photo ${i + 1}, full size">${pic(p, i ? 640 : 1200, `${b.title}, photo ${i + 1}`)}</button>`).join('')}</div>` : ''}
<div class="bgrid"><div class="bmain">
${specs.length ? `<dl class="placard">${specs.map(([k, v]) => `<div><dt>${k}</dt><dd>${k === 'Plans' ? v : esc(v)}</dd></div>`).join('')}</dl>` : ''}
<div class="prose">${paras(b.intro)}</div>
${b.model ? `<section class="model"><h2>3D model</h2><model-viewer src="${esc(b.model.url)}" alt="3D model of ${esc(b.title)}" camera-controls touch-action="pan-y" auto-rotate shadow-intensity="0.6" exposure="1.05"></model-viewer><p class="muted small-note">Drag to turn it, pinch or scroll to zoom.</p></section>` : ''}
${b.steps.length ? `<section><h2>Step by step</h2><ol class="steps">${b.steps.map((x, i) => `<li><h3>${esc(x.title || `Step ${i + 1}`)}</h3>${paras(x.text)}${x.photos.length ? `<div class="sph">${x.photos.map((p, j) => `<button type="button" class="bph" data-s="${i}" data-i="${j}" aria-label="Step ${i + 1} photo ${j + 1}, full size">${pic(p, 828, '')}</button>`).join('')}</div>` : ''}</li>`).join('')}</ol></section>` : ''}
</div><aside class="bside">
${b.files.length ? `<section class="files" id="plans"><h2>Plans and files</h2>${b.files.map((f) => `<a class="file" href="${esc(f.url)}" download="${esc(f.name)}" target="_blank" rel="noopener"><span class="kind">${esc(fileKind(f.name))}</span><span><b>${esc(f.name)}</b><span class="muted">${kb(f.size)}</span></span></a>`).join('')}</section>` : ''}
${b.parts ? `<section><h2>Parts</h2>${partsHtml(b.parts)}</section>` : ''}
${b.tools ? `<section><h2>Tools</h2><ul class="ticks">${listLines(b.tools).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
</aside></div>`;
    $$('.bphotos .bph', host).forEach((el) => el.addEventListener('click', () => lightbox(b.photos.map((p) => p.src), Number(el.dataset.i))));
    $$('.sph .bph', host).forEach((el) => el.addEventListener('click', () => lightbox(b.steps[Number(el.dataset.s)].photos.map((p) => p.src), Number(el.dataset.i))));
    if (b.model && !customElements.get('model-viewer')) {
      const sc = document.createElement('script'); sc.type = 'module'; sc.src = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js'; document.head.appendChild(sc);
    }
    document.title = `${b.title} · Lapidary builds · Mineral Murals`;
  }

  // ---------- start
  (async () => {
    C = await loadCatalog();
    chrome();
    try {
      ({ home, shop, product, cart: cartPage, thanks, museum, about: textPages, contact: textPages, builds: buildsPage, build: buildPage }[page] || (() => {}))();
    } catch (e) { console.error(e); }
  })();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
