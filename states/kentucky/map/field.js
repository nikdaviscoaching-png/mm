'use strict';
/* =============================================================================
   FIELD TOOLS  (added on top of the research build, Sept 2026)

   Everything here is additive. It does not touch the geology, the targets, the
   reaches, the scoring or any data file. It only uses what app.js already
   exposes: map, TARGETS, markerById, showToast, coordText, copyText, esc,
   locationLayer, lastFix, renderList.

   1. Live GPS      — continuous tracking, accuracy ring, follow mode, and a
                      readout with distance + direction to the nearest target.
   2. Tap rescue    — a tap within ~34 px of any marker opens that marker, so a
                      thumb that lands just off a dot still works.
   3. Field log     — log finds, spots to check, parking, access and landowner
                      contacts at your GPS fix, with a photo and a note. Stored
                      on the phone in IndexedDB (hundreds of photos, not ~30),
                      shown on the map, exportable as GeoJSON or CSV.
   ============================================================================= */
(function () {
  if (typeof map === 'undefined' || typeof L === 'undefined') return;

  const $ = (sel, root = document) => root.querySelector(sel);
  const toast = (m, ms) => (typeof showToast === 'function' ? showToast(m, ms) : console.log(m));
  const html = s => (typeof esc === 'function' ? esc(s) : String(s ?? ''));
  const targets = () => (typeof TARGETS !== 'undefined' && Array.isArray(TARGETS) ? TARGETS : []);

  /* ------------------------------------------------------------------ helpers */
  function bearingWord(from, to) {
    const f1 = from.lat * Math.PI / 180, f2 = to.lat * Math.PI / 180;
    const dl = (to.lng - from.lng) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    const b = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
  }
  function distWords(m) { return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(1)} mi`; }
  function nearestTarget(latlng) {
    let best = null, bd = Infinity;
    targets().forEach(t => {
      const d = map.distance(latlng, [t.lat, t.lon]);
      if (d < bd) { bd = d; best = t; }
    });
    return best ? { t: best, d: bd } : null;
  }

  /* =================================================================== 1. GPS */
  const readout = document.createElement('div');
  readout.id = 'ff-readout';
  readout.hidden = true;
  document.body.appendChild(readout);

  let watchId = null, follow = false, lastListRefresh = 0;
  let fixTime = 0, fixAcc = null;              // when the newest GPS fix arrived, and its accuracy in metres
  const FIX_MAX_AGE = 60000;                   // an older fix is stale: never used as "where I am"

  /* ---- heading arrow: which way the phone is pointing ---------------------
     iPhone gives a true compass heading (webkitCompassHeading) once the user
     allows motion access, which Safari only asks for on a tap — so we ask when
     Locate is pressed. Android gives an absolute orientation (alpha). Both work
     with no signal: the compass is a sensor in the phone, not a network service. */
  let youRing = null, youDot = null, heading = null, compassLive = false, compassStarted = false, headingSrc = '', rafPending = false;
  function screenAngle() {
    return (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
  }
  function setHeading(deg, src) {
    if (!Number.isFinite(deg)) return;
    heading = (deg % 360 + 360) % 360; headingSrc = src;
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; applyHeading(); }); }
  }
  function applyHeading() {
    const el = youDot && youDot.getElement && youDot.getElement();
    const cone = el && el.querySelector('.ff-cone');
    if (!cone) return;
    if (heading === null) { cone.style.opacity = '0'; return; }
    cone.style.opacity = headingSrc === 'travel' ? '.55' : '1';
    cone.style.transform = `rotate(${heading}deg)`;
  }
  // Eastern Kentucky's magnetic declination is about 5° west, so an iPhone's
  // magnetic heading reads ~5° clockwise of true north. The map is true-north up.
  const DECLINATION = -5;
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy < 0) return;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading + DECLINATION;   // iPhone (magnetic)
    else if (e.absolute === true && typeof e.alpha === 'number') h = 360 - e.alpha;              // Android (earth frame)
    if (h === null || !Number.isFinite(h)) return;
    compassLive = true;
    setHeading(h + screenAngle(), 'compass');            // landscape: account for how the phone is held
  }
  async function startCompass() {
    if (compassStarted) return;
    compassStarted = true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();          // iOS: must follow a tap
        if (r !== 'granted') { toast('Compass off — allow Motion & Orientation to see which way you face', 3200); return; }
      }
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
      else window.addEventListener('deviceorientation', onOrient, true);
    } catch (_) { /* no compass on this device; travel direction still works while walking */ }
  }
  const oldBtn = document.getElementById('locate-btn');
  // Replace the one-shot button with a clean copy so its old listener goes away.
  const locBtn = oldBtn && typeof oldBtn.cloneNode === 'function' ? oldBtn.cloneNode(true) : oldBtn;
  if (oldBtn && locBtn && locBtn !== oldBtn && typeof oldBtn.replaceWith === 'function') oldBtn.replaceWith(locBtn);

  let drawFix = function (pos) {
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
    const acc = pos.coords.accuracy || 0;
    try { lastFix = ll; } catch (_) { /* app.js may not declare it */ }
    fixTime = pos._ffTime || Date.now();          // time of arrival on this phone (the fix's own timestamp can disagree with the clock)
    fixAcc = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
    if (typeof locationLayer !== 'undefined') {
      if (!youRing) {
        locationLayer.clearLayers();
        youRing = L.circle(ll, { radius: acc, color: '#2586ff', weight: 1, opacity: .6, fillOpacity: .08, interactive: false }).addTo(locationLayer);
        youDot = L.marker(ll, { interactive: false, keyboard: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: '', iconSize: [64, 64], iconAnchor: [32, 32],
            html: '<div class="ff-you"><div class="ff-cone"></div><div class="ff-you-dot"></div></div>' }) }).addTo(locationLayer);
      } else { youRing.setLatLng(ll).setRadius(acc); youDot.setLatLng(ll); }
      // moving at walking pace or faster: GPS knows your direction of travel even
      // without a compass, so use it until the compass gives something better
      if (!compassLive && Number.isFinite(pos.coords.heading) && (pos.coords.speed || 0) > 0.6) setHeading(pos.coords.heading, 'travel');
      applyHeading();
    }
    const n = nearestTarget(ll);
    readout.hidden = false;
    readout.innerHTML = `<b>${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</b> ±${Math.round(acc)} m` +
      (n ? ` · #${n.t.rank} ${html(n.t.stream || '')} ${distWords(n.d)} ${bearingWord(ll, L.latLng(n.t.lat, n.t.lon))}` : '');
    if (follow) map.setView(ll, Math.max(map.getZoom(), 15), { animate: true });
    if (locBtn) { locBtn.classList.remove('ff-wait'); locBtn.classList.toggle('ff-on', follow); }
    if (typeof sheet !== 'undefined' && sheet.classList.contains('open')) refreshWhere();
    // keep "sort by nearest" honest without redrawing the list on every fix
    const sortSel = document.getElementById('sort-sel');
    if (sortSel && sortSel.value === 'near' && Date.now() - lastListRefresh > 15000 && typeof renderList === 'function') {
      lastListRefresh = Date.now(); renderList();
    }
  }
  function startWatch(recenter) {
    if (!navigator.geolocation) return toast('Location is unavailable on this device');
    follow = recenter !== false;
    if (watchId !== null) return;
    if (locBtn) locBtn.classList.add('ff-wait');
    toast('Finding you… (can take 30 s with no signal)', 2600);
    watchId = navigator.geolocation.watchPosition(p => { hideLocHelp(); drawFix(p); }, err => {
      if (locBtn) locBtn.classList.remove('ff-wait');
      if (err && err.code === 1) {                          // PERMISSION_DENIED
        // Stop the dead watch so the next Locate press asks again instead of
        // silently toggling "follow" on a watch that will never deliver a fix.
        try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
        watchId = null; follow = false;
        if (locBtn) locBtn.classList.remove('ff-on');
        readout.hidden = false;
        readout.textContent = 'Location is off for this map — press ◎ Locate after turning it on';
        pendingDest = null;
        toast('Location is off for this map', 1500);
        showLocHelp();
        return;
      }
      readout.hidden = false;
      readout.textContent = err && err.code === 2
        ? 'GPS unavailable — check that Location is on; still trying…'
        : 'Waiting for GPS… ' + ((err && err.message) || '');
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 2000 });
  }

  /* Location permission denied: say exactly how to turn it back on. */
  let locHelp = null;
  function hideLocHelp() { if (locHelp) { locHelp.remove(); locHelp = null; } }
  function showLocHelp() {
    hideLocHelp();
    locHelp = document.createElement('div');
    locHelp.id = 'ff-lochelp'; locHelp.setAttribute('role', 'alertdialog'); locHelp.setAttribute('aria-label', 'Location is off');
    locHelp.innerHTML = `<b>Location is turned off for this map</b>
      <p><b>iPhone / iPad:</b> Settings → Privacy &amp; Security → Location Services → turn it <b>On</b>, then scroll to <b>Safari Websites</b> → <b>While Using the App</b> (or Ask Next Time). In Safari you can also tap <b>aA</b> → Website Settings → Location → <b>Allow</b>. The Home Screen icon uses the same Safari Websites setting.</p>
      <p><b>Android (Chrome):</b> tap the icon left of the web address → Permissions → Location → <b>Allow</b>, and check that phone Location is on.</p>
      <p>Then press <b>Try again</b>. The map, targets and saved routes still work without GPS.</p>
      <div class="ff-lh-btns"><button type="button" class="go">Try again</button><button type="button" class="x">Close</button></div>`;
    document.body.appendChild(locHelp);
    locHelp.querySelector('.go').onclick = () => { hideLocHelp(); startWatch(true); };
    locHelp.querySelector('.x').onclick = hideLocHelp;
  }

  /* Stop follow mode — used whenever something is opened that the user wants to
     look at (a popup, a target, a search result, a log entry). Otherwise the next
     GPS fix re-centres the map and pushes the popup off screen. */
  function stopFollow(quiet) {
    if (!follow) return;
    follow = false;
    if (locBtn) locBtn.classList.remove('ff-on');
    if (!quiet) toast('Stopped following so you can read this — tap ◎ Locate to follow again', 2200);
  }
  window.ffStopFollow = stopFollow;
  if (typeof openTarget === 'function') {
    const _openTarget = openTarget;
    window.openTarget = openTarget = function (id) { stopFollow(true); return _openTarget(id); };
  }
  if (locBtn) locBtn.addEventListener('click', () => {
    if (!compassLive) startCompass();
    if (watchId === null) return startWatch(true);
    follow = !follow;
    locBtn.classList.toggle('ff-on', follow);
    toast(follow ? 'Following your position' : 'Stopped following', 1200);
    if (follow && typeof lastFix !== 'undefined' && lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15));
  });
  map.on('dragstart', () => { if (follow) { follow = false; if (locBtn) locBtn.classList.remove('ff-on'); } });

  /* ============================================================= 2. TAP RESCUE */
  const TAP_PX = 34;
  map.on('click', e => {
    if (typeof window.ffJustLongPressed === 'function' && window.ffJustLongPressed()) return;
    const p = map.latLngToContainerPoint(e.latlng);
    let best = null, bd = Infinity;
    map.eachLayer(layer => {
      if (!layer.getLatLng || !layer.getPopup || !layer.getPopup()) return;
      if (layer instanceof L.Circle) return;                 // accuracy rings, areas
      const d = p.distanceTo(map.latLngToContainerPoint(layer.getLatLng()));
      if (d < bd) { bd = d; best = layer; }
    });
    if (best && bd <= TAP_PX && !best.isPopupOpen()) {
      setTimeout(() => best.openPopup(), 0);               // after app.js's coordinate popup
    }
  });

  /* ============================================================== 3. FIELD LOG */
  const DB = 'mineral_maps_field_v1', STORE = 'entries';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('no IndexedDB'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
    return dbp;
  }
  const LS_KEY = 'mm_field_log_fallback';
  async function allEntries() {
    const d = await db();
    if (!d) { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (_) { return []; } }
    return new Promise(res => {
      const r = d.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => res([]);
    });
  }
  async function putEntry(e) {
    const d = await db();
    if (!d) {
      const list = await allEntries(); const i = list.findIndex(x => x.id === e.id);
      if (i >= 0) list[i] = e; else list.push(e);
      try { localStorage.setItem(LS_KEY, JSON.stringify(list)); markChanged('log', true); return true; }
      catch (_) { markChanged('log', false); toast('Storage is full — export and delete some photos', 3500); return false; }
    }
    return new Promise(res => {
      let tx;
      try { tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(e); }
      catch (_) { markChanged('log', false); return res(false); }
      tx.oncomplete = () => { markChanged('log', true); res(true); };
      tx.onerror = tx.onabort = () => { markChanged('log', false); toast('Could not save — phone storage may be full', 3200); res(false); };
    });
  }
  async function delEntry(id) {
    const d = await db();
    if (!d) {
      const list = (await allEntries()).filter(x => x.id !== id);
      localStorage.setItem(LS_KEY, JSON.stringify(list)); markChanged('log', true, { now: true }); return;
    }
    return new Promise(res => {
      const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => { markChanged('log', true, { now: true }); res(); }; tx.onerror = res;
    });
  }

  const TYPES = {
    find:     { label: 'Agate find',     color: '#e3342f' },
    check:    { label: 'Spot to check',  color: '#f5d327' },
    parking:  { label: 'Parking',        color: '#2586ff' },
    access:   { label: 'Access / path',  color: '#38c172' },
    owner:    { label: 'Landowner',      color: '#9561e2' },
    blank:    { label: 'Checked — nothing', color: '#9aa0a6' },
    skip:     { label: 'Not for me — skip', color: '#6b7280' },
    place:    { label: 'Saved place', color: '#22d3ee' },
  };

  // --- map layer
  const logLayer = L.layerGroup().addTo(map);
  function entryPopup(e) {
    const t = TYPES[e.type] || TYPES.check;
    const mark = !!e.target_status;
    return `<div class="pp ff-pop ff-log-pop" data-eid="${html(e.id)}">
      <b style="color:${t.color}">${html(t.label)}</b>${e.label ? ' — ' + html(e.label) : ''}<br>
      <span style="opacity:.8">${new Date(e.ts).toLocaleString()} · ${e.acc ? '±' + Math.round(e.acc) + ' m' : 'placed by hand'}</span>
      ${mark ? '<p class="ff-warn">Target mark whose target is no longer at these coordinates.</p>' : ''}
      ${e.photo ? `<img src="${e.photo}" class="ff-photo" alt="">` : ''}
      ${e.note ? `<p>${html(e.note)}</p>` : ''}
      <div class="btns">
        ${mark ? '' : '<button type="button" data-ffe="edit">Edit</button><button type="button" data-ffe="move">Move</button>'}
        <button type="button" data-ffe="copy">Copy coordinates</button>
        <button type="button" data-ffe="route" data-ff-route>Route here</button>
        <button type="button" data-ffe="delete">Delete</button>
      </div></div>`;
  }
  let logCache = []; const logMarkers = {};
  let movingId = null;
  // Redraws run one after another. Two overlapping redraws (startup calls it twice)
  // each cleared the layer and then both added every pin, so pins doubled.
  let drawChain = Promise.resolve();
  function drawLog() { drawChain = drawChain.then(drawLogNow, drawLogNow); return drawChain; }
  async function drawLogNow() {
    movingId = null;
    const all = await allEntries();
    const unattached = await reconcileMarks(all);
    logLayer.clearLayers();
    refreshTargetDots(all);
    logCache = all; for (const k in logMarkers) delete logMarkers[k];
    all.filter(e => !e.target_status || unattached.has(e.id)).forEach(e => {
      const t = TYPES[e.type] || TYPES.check;
      logMarkers[e.id] = L.marker([e.lat, e.lon], {
        pane: 'star',
        icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9],
          html: `<div class="ff-pin" style="background:${t.color}">${e.photo ? '📷' : ''}</div>` }),
      }).bindPopup(() => entryPopup(e), { maxWidth: 300 }).addTo(logLayer);
    });
  }

  // --- UI: button + sheet
  const actions = document.querySelector('.map-actions');
  const logBtn = document.createElement('button');
  logBtn.className = 'action-btn'; logBtn.type = 'button'; logBtn.id = 'ff-log-btn';
  logBtn.textContent = '✎ Log';
  if (actions) actions.appendChild(logBtn);

  const sheet = document.createElement('aside');
  sheet.id = 'ff-sheet'; sheet.className = 'sheet'; sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <div class="sheet-head"><b>Field log</b>
      <button class="icon-btn dark" type="button" id="ff-close" aria-label="Close">×</button></div>
    <div class="ff-body">
      <div class="ff-form">
        <select id="ff-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <input id="ff-label" type="text" placeholder="Short name (e.g. bar below the ford)" maxlength="80">
        <textarea id="ff-note" rows="2" placeholder="Note: what you saw, water level, access…"></textarea>
        <label class="ff-photo-btn"><input id="ff-file" type="file" accept="image/*" capture="environment" hidden>📷 Add photo</label>
        <img id="ff-preview" class="ff-photo" hidden alt="">
        <button type="button" id="ff-rmphoto" class="ff-linkbtn" hidden>Remove photo</button>
        <div class="ff-where" id="ff-where">Waiting for GPS… or long-press the map</div>
        <button class="wide-btn" type="button" id="ff-save">Save here</button>
        <button class="wide-btn" type="button" id="ff-cancel-edit" hidden>Cancel edit</button>
      </div>
      <div class="ff-tools">
        <button type="button" id="ff-exp-geo">Export GeoJSON</button>
        <button type="button" id="ff-exp-csv">Export CSV</button>
        <button type="button" id="ff-backup">Backup all + photos</button>
        <button type="button" id="ff-restore">Restore backup</button>
        <input id="ff-restore-file" type="file" accept="application/json,.json" hidden>
      </div>
      <p class="ff-meter" id="ff-meter"></p>
      <div id="ff-list"></div>
    </div>`;
  document.body.appendChild(sheet);

  let gpsPoll = null, lastPoke = 0;
  function openSheet(on) {
    sheet.classList.toggle('open', on); sheet.setAttribute('aria-hidden', on ? 'false' : 'true');
    clearInterval(gpsPoll); gpsPoll = null;
    if (!on && editing) endEdit();
    if (on) {
      if (!editing && watchId === null) startWatch(false);            // logging at "here" needs a live GPS fix
      refreshWhere(); renderLog(); if (typeof setSheet === 'function') setSheet(false); if (typeof setPanel === 'function') setPanel(false);
      gpsPoll = setInterval(refreshWhere, 2000);                       // notices a fix going stale
    }
  }
  logBtn.addEventListener('click', () => openSheet(!sheet.classList.contains('open')));
  window.ffLogAt = (lat, lng) => { if (editing) endEdit(); pinnedPos = L.latLng(lat, lng); map.closePopup(); openSheet(true); };
  $('#ff-close', sheet).addEventListener('click', () => openSheet(false));

  let pinnedPos = null;              // set by "Log a spot here" on a tapped point
  const freshFix = () => typeof lastFix !== 'undefined' && !!lastFix && Date.now() - fixTime <= FIX_MAX_AGE;
  // Where a new entry would be saved: a pinned spot, or a GPS fix from the last 60 s.
  // There is no silent fallback to the map centre; null means "no position yet".
  function currentPos() {
    if (pinnedPos) return { ll: pinnedPos, gps: false, pinned: true, acc: null };
    if (freshFix()) return { ll: lastFix, gps: true, acc: fixAcc };
    return null;
  }
  // The position is stale, so ask the phone for one fresh reading (a parked phone may
  // stop sending updates). Rate-limited so a weak-signal spot is not hammered.
  function pokeGPS() {
    if (!navigator.geolocation || Date.now() - lastPoke < 8000) return;
    lastPoke = Date.now();
    navigator.geolocation.getCurrentPosition(p => { hideLocHelp(); drawFix(p); }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
  }
  function refreshWhere() {
    const w = $('#ff-where', sheet), saveBtn = $('#ff-save', sheet);
    if (editing) {
      const o = editing.orig;
      w.textContent = `Editing the saved pin at ${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}. Use Move on its popup to change the spot.`;
      saveBtn.disabled = false; return;
    }
    const c = currentPos();
    saveBtn.disabled = !c;
    if (!c) {
      w.textContent = 'Waiting for GPS… or long-press the map';
      if (sheet.classList.contains('open')) pokeGPS();
      return;
    }
    if (c.pinned) { w.innerHTML = `Position: the spot you tapped ${c.ll.lat.toFixed(5)}, ${c.ll.lng.toFixed(5)} · <a href="#" id="ff-unpin">use my GPS instead</a>`;
      const u = $('#ff-unpin', sheet); if (u) u.onclick = ev => { ev.preventDefault(); pinnedPos = null; refreshWhere(); }; return; }
    w.textContent = `Position: your GPS fix ${c.ll.lat.toFixed(5)}, ${c.ll.lng.toFixed(5)}` + (Number.isFinite(c.acc) ? ` ±${Math.round(c.acc)} m` : '');
  }

  // photo: downscale to 1280 px JPEG so a phone photo is ~150 KB, not 4 MB
  let pendingPhoto = null;
  $('#ff-file', sheet).addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {
      try {
        const s = Math.min(1, 1280 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * s)); cv.height = Math.max(1, Math.round(img.height * s));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        pendingPhoto = cv.toDataURL('image/jpeg', 0.75);
        const pv = $('#ff-preview', sheet); pv.src = pendingPhoto; pv.hidden = false;
        if (editing) editing.removePhoto = false;
      } catch (_) { toast('Could not prepare that photo', 2600); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('That photo format could not be opened', 2800); };
    img.src = url;
  });

  // ---- edit an existing saved pin (same id, so nothing else that refers to it breaks)
  let editing = null;                // { orig, removePhoto }
  function resetForm() {
    $('#ff-label', sheet).value = ''; $('#ff-note', sheet).value = '';
    pendingPhoto = null; $('#ff-preview', sheet).hidden = true; $('#ff-file', sheet).value = '';
    $('#ff-rmphoto', sheet).hidden = true;
  }
  function endEdit() {
    editing = null; resetForm();
    $('#ff-save', sheet).textContent = 'Save here'; $('#ff-cancel-edit', sheet).hidden = true;
  }
  function beginEdit(e) {
    map.closePopup(); pinnedPos = null;
    editing = { orig: e, removePhoto: false };
    $('#ff-type', sheet).value = TYPES[e.type] ? e.type : 'check';
    $('#ff-label', sheet).value = e.label || ''; $('#ff-note', sheet).value = e.note || '';
    pendingPhoto = null; $('#ff-file', sheet).value = '';
    const pv = $('#ff-preview', sheet);
    if (e.photo) { pv.src = e.photo; pv.hidden = false; } else pv.hidden = true;
    $('#ff-rmphoto', sheet).hidden = !e.photo;
    $('#ff-save', sheet).textContent = 'Save changes'; $('#ff-cancel-edit', sheet).hidden = false;
    openSheet(true);
  }
  $('#ff-cancel-edit', sheet).addEventListener('click', () => { endEdit(); refreshWhere(); openSheet(false); });
  $('#ff-rmphoto', sheet).addEventListener('click', () => {
    pendingPhoto = null; $('#ff-file', sheet).value = ''; $('#ff-preview', sheet).hidden = true; $('#ff-rmphoto', sheet).hidden = true;
    if (editing) editing.removePhoto = true;
  });

  $('#ff-save', sheet).addEventListener('click', async () => {
    if (editing) {
      const o = editing.orig;
      const ne = { ...o, type: $('#ff-type', sheet).value, label: $('#ff-label', sheet).value.trim(), note: $('#ff-note', sheet).value.trim(),
        photo: pendingPhoto !== null ? pendingPhoto : (editing.removePhoto ? null : o.photo || null), edited: Date.now() };
      if (await putEntry(ne)) { toast('Saved changes'); endEdit(); refreshWhere(); await drawLog(); renderLog(); openSheet(false); }
      return;
    }
    const c = currentPos();
    if (!c) { toast('Waiting for GPS… or long-press the map', 2600); refreshWhere(); return; }
    const e = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(), type: $('#ff-type', sheet).value,
      label: $('#ff-label', sheet).value.trim(), note: $('#ff-note', sheet).value.trim(),
      lat: +c.ll.lat.toFixed(6), lon: +c.ll.lng.toFixed(6), gps: c.gps,
      acc: c.gps && Number.isFinite(c.acc) ? Math.round(c.acc) : null,
      photo: pendingPhoto,
    };
    const n = nearestTarget(c.ll);
    if (n) { e.nearest_target = n.t.rank; e.nearest_target_m = Math.round(n.d); }
    if (await putEntry(e)) {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast('Saved to the field log');
      resetForm();
      pinnedPos = null; refreshWhere();
      drawLog(); renderLog();
      if (typeof window.ffAfterLogSave === 'function') window.ffAfterLogSave(e);
    }
  });

  // ---- saved-pin popup buttons: Edit, Move, Copy coordinates, Route here, Delete
  async function entryAction(id, action) {
    const e = logCache.find(x => x.id === id); if (!e) return;
    const nm = e.label || (TYPES[e.type] || TYPES.check).label;
    if (action === 'copy') return window.copyText(`${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}`);
    if (action === 'route') { map.closePopup(); return window.ffRouteTo(e.lat, e.lon, nm); }
    if (action === 'edit') return beginEdit(e);
    if (action === 'delete') {
      if (!confirm('Delete this saved pin' + (e.photo ? ' and its photo' : '') + '?')) return;
      map.closePopup(); await delEntry(id); await drawLog(); renderLog(); return toast('Deleted', 1200);
    }
    if (action === 'move') {
      const mk = logMarkers[id]; if (!mk) return;
      map.closePopup(); movingId = id; mk.dragging.enable();
      mk.once('dragend', async () => {
        if (movingId !== id) return;
        movingId = null; mk.dragging.disable();
        if (typeof suppressMapClick !== 'undefined') suppressMapClick = true;
        const ll = mk.getLatLng(), ne = { ...e, lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6), gps: false, acc: null, moved: Date.now() };
        const n = nearestTarget(ll); if (n) { ne.nearest_target = n.t.rank; ne.nearest_target_m = Math.round(n.d); }
        if (await putEntry(ne)) { toast('Pin moved and saved', 1800); await drawLog(); renderLog(); const m2 = logMarkers[id]; if (m2) setTimeout(() => m2.openPopup(), 250); }
      });
      toast('Drag the pin to its new spot, then let go to save', 3200);
    }
  }
  window.ffEntry = entryAction;
  map.on('popupopen', ev => {                       // buttons inside saved-pin popups (clicks do not reach document)
    const box = ev.popup.getElement && ev.popup.getElement(); const content = box && box.querySelector('.leaflet-popup-content');
    if (!content || content._ffe) return; content._ffe = true;
    content.addEventListener('click', evt => {
      const b = evt.target.closest && evt.target.closest('[data-ffe]'); if (!b) return;
      const holder = b.closest('[data-eid]'); if (holder) entryAction(holder.dataset.eid, b.dataset.ffe);
    });
  });

  async function renderLog() {
    const list = (await allEntries()).sort((a, b) => b.ts - a.ts);
    const box = $('#ff-list', sheet);
    if (!list.length) { box.innerHTML = '<p class="ff-empty">Nothing logged yet. Log blanks too — knowing which creeks produced nothing is how the next trip gets better.</p>'; }
    else box.innerHTML = list.map(e => {
      const t = TYPES[e.type] || TYPES.check;
      return `<div class="ff-item">
        ${e.photo ? `<img src="${e.photo}" alt="">` : `<span class="ff-dot" style="background:${t.color}"></span>`}
        <div class="ff-txt"><b>${html(e.label || t.label)}</b><br>
          <small>${html(t.label)} · ${new Date(e.ts).toLocaleDateString()}${e.nearest_target ? ` · ${distWords(e.nearest_target_m)} from #${e.nearest_target}` : ''}</small>
          ${e.note ? `<small class="ff-note">${html(e.note)}</small>` : ''}</div>
        <div class="ff-act"><button data-go="${e.id}">Go</button><button data-del="${e.id}">✕</button></div></div>`;
    }).join('');
    box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
      const e = list.find(x => x.id === b.dataset.go); openSheet(false); stopFollow(true);
      map.setView([e.lat, e.lon], Math.max(map.getZoom(), 16));
    });
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this entry and its photo?')) return;
      await delEntry(b.dataset.del); drawLog(); renderLog();
    });
    const bytes = list.reduce((n, e) => n + (e.photo ? e.photo.length : 0) + String(e.label || '').length + String(e.note || '').length + 220, 0);
    let msg = `${list.length} entr${list.length === 1 ? 'y' : 'ies'} · about ${(bytes / 1048576).toFixed(1)} MB.`;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (Number.isFinite(est.usage)) msg += ` App storage: ${(est.usage / 1048576).toFixed(0)} MB used`;
        if (Number.isFinite(est.quota)) msg += ` of ~${(est.quota / 1073741824).toFixed(1)} GB`;
        if (Number.isFinite(est.usage)) msg += '.';
      } catch (_) {}
    }
    $('#ff-meter', sheet).textContent = msg + ' Use “Backup all + photos” occasionally — phone/browser storage can be cleared.';
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  // Home Screen apps on iPhone ignore <a download>, so hand the file to the share
  // sheet first (same path as the backup) and only fall back to a download link.
  async function shareOrDownload(name, text, type, shareType, title) {
    try {
      const file = new File([text], name, { type: shareType || type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return 'shared'; }
    } catch (e) { if (e && e.name === 'AbortError') { toast('Export cancelled', 1400); return 'cancelled'; } }
    download(name, text, type); return 'download';
  }
  $('#ff-exp-geo', sheet).addEventListener('click', async () => {
    const list = await allEntries();
    shareOrDownload(`field-log-${new Date().toISOString().slice(0, 10)}.geojson`, JSON.stringify({
      type: 'FeatureCollection',
      features: list.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: { ...e, photo: e.photo ? '(photo kept in app)' : null } })),
    }, null, 1), 'application/geo+json', 'application/json', 'Mineral Maps field log (GeoJSON)');
  });
  $('#ff-exp-csv', sheet).addEventListener('click', async () => {
    const list = await allEntries();
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['date', 'type', 'label', 'note', 'lat', 'lon', 'gps', 'accuracy_m', 'nearest_target', 'nearest_target_m'].join(',')]
      .concat(list.map(e => [new Date(e.ts).toISOString(), e.type, e.label, e.note, e.lat, e.lon, e.gps, e.acc, e.nearest_target, e.nearest_target_m].map(q).join(',')));
    shareOrDownload(`field-log-${new Date().toISOString().slice(0, 10)}.csv`, rows.join('\n'), 'text/csv', 'text/csv', 'Mineral Maps field log (CSV)');
  });

  // GeoJSON/CSV are convenient analysis exports, but they intentionally omit the
  // photo bytes. This backup is the lossless copy: notes, coordinates and photos.
  $('#ff-backup', sheet).addEventListener('click', () => backupOffPhone());
  const restoreInput = $('#ff-restore-file', sheet);
  $('#ff-restore', sheet).addEventListener('click', () => restoreInput.click());
  restoreInput.addEventListener('change', async ev => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const src = raw && raw.format === 'mineral-maps-field-backup' && Array.isArray(raw.entries) ? raw.entries : null;
      if (!src) throw new Error('not a Mineral Maps field backup');
      if (raw.truck || raw.trail) window.ffTruckRestore && window.ffTruckRestore(raw.truck, raw.trail);
      if (!src.length && (raw.truck || raw.trail)) { toast('Restored truck spot and trail', 2400); return; }
      const clean = src.map((e, i) => {
        const lat = Number(e.lat), lon = Number(e.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        const type = Object.prototype.hasOwnProperty.call(TYPES, e.type) ? e.type : 'check';
        const photo = typeof e.photo === 'string' && e.photo.startsWith('data:image/') ? e.photo : null;
        return { ...e, id: String(e.id || `restored-${Date.now()}-${i}`).slice(0, 120), ts: Number.isFinite(+e.ts) ? +e.ts : Date.now(),
          type, label: String(e.label || '').slice(0, 80), note: String(e.note || '').slice(0, 5000), lat, lon, photo };
      }).filter(Boolean);
      if (!clean.length) throw new Error('backup contains no valid entries');
      if (!confirm(`Restore ${clean.length} entries? Existing entries with the same IDs will be updated; other entries are kept.`)) return;
      let ok = 0;
      for (const e of clean) if (await putEntry(e)) ok++;
      await drawLog(); await renderLog();
      toast(`Restored ${ok}/${clean.length} field-log entries`, 2800);
    } catch (e) { toast('Restore failed: ' + e.message, 3200); }
    finally { restoreInput.value = ''; }
  });


  /* ================================================================ 4. SEARCH */
  // One box for targets (by rank, creek, county or quad), named creeks,
  // counties and quadrangles. Creek/county/quad lists load the first time the
  // box is used, from files the app already caches for offline.
  const bar = document.createElement('div');
  bar.id = 'ff-search';
  bar.innerHTML = `<input id="ff-q" type="search" autocomplete="off" enterkeyhint="search"
      placeholder="Search creeks, targets, counties, quads…" aria-label="Search the map">
    <ul id="ff-res" hidden></ul>`;
  const topbar = document.querySelector('.topbar');
  if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(bar, topbar.nextSibling);
  else document.body.appendChild(bar);
  const qEl = $('#ff-q', bar), resEl = $('#ff-res', bar);
  const idx = []; let idxReady = false, idxLoading = null;
  function add(kind, name, sub, go) { if (name) idx.push({ kind, name: String(name), sub: sub || '', go }); }
  function lineBounds(g) {
    const cs = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat()
      : g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : [];
    if (!cs.length) return null;
    const la = cs.map(c => c[1]), lo = cs.map(c => c[0]);
    return L.latLngBounds([Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]);
  }
  async function waitForTargets() {
    // app.js loads targets asynchronously. A very fast tap into Search used to
    // permanently build an index without them. Wait briefly for that first load.
    for (let i = 0; i < 50 && !targets().length; i++) await new Promise(r => setTimeout(r, 100));
  }
  function buildIndex() {
    if (idxLoading) return idxLoading;
    idxLoading = (async () => {
      await waitForTargets();
      targets().forEach(t => add('target', `#${t.rank} ${t.stream || 'Unnamed'}`,
        `${t.priority || ''} · ${t.county || ''} County · ${t.quad || ''} quad`,
        () => {
          if (typeof openTarget === 'function') openTarget(t.id);
          else { map.setView([t.lat, t.lon], Math.max(map.getZoom(), 15));
            const m = (typeof markerById !== 'undefined') && markerById[t.id];
            if (m) setTimeout(() => m.openPopup(), 300); }
        }));
      const get = n => (typeof getJSON === 'function' ? getJSON(n) : fetch('data/' + n).then(r => r.json())).catch(() => null);
      const [st, co, qu] = await Promise.all([get('streams.geojson'), get('counties.geojson'), get('quads.geojson')]);
      if (st) {
        const byName = {};
        st.features.forEach(f => {
          const n = f.properties.gnis_name; if (!n) return;
          const b = lineBounds(f.geometry); if (!b) return;
          byName[n] = byName[n] ? byName[n].extend(b) : b;
        });
        Object.entries(byName).forEach(([n, b]) => add('creek', n, 'creek', () => map.fitBounds(b, { padding: [40, 40], maxZoom: 15 })));
      }
      if (co) co.features.forEach(f => { const b = lineBounds(f.geometry);
        if (b) add('county', `${f.properties.NAME} County`, 'county', () => map.fitBounds(b, { padding: [20, 20] })); });
      if (qu) qu.features.forEach(f => { const b = lineBounds(f.geometry);
        if (b) add('quad', `${f.properties.quad} quadrangle`, f.properties.gq ? `GQ-${f.properties.gq}` : 'USGS 7.5-minute quad',
          () => map.fitBounds(b, { padding: [20, 20] })); });
      const men = await get('experimental_menifee.geojson');
      if (men) men.features.forEach(f => {
        const p = f.properties, [lon, lat] = f.geometry.coordinates;
        if (+p.top_pct_geology_only > 10) return;           // best bets + good options
        add('menifee', `Menifee (?) #${p.menifee_rank} ${String(p.stream || 'Unnamed').split(',')[0]}`,
          `${menTier(p).name} · ${p.quad} quad · top ${p.top_pct_geology_only}% on geology`,
          async () => {
            // Show the layer WITHOUT the whole-county zoom, then go to this crossing.
            try { await showMenifee(false); } catch (_) { return; }
            map.setView([lat, lon], Math.max(map.getZoom(), 15));
            const mk = menByRank[p.menifee_rank];
            if (mk) setTimeout(() => { if (map.hasLayer(mk)) mk.openPopup(); }, 350);
          });
      });
      idxReady = true;
    })();
    return idxLoading;
  }
  const ORDER = { target: 0, menifee: 1, creek: 2, county: 3, quad: 4 };
  // Coordinates: "37.62, -84.02", "37.62 -84.02", "N37.62 W84.02", 37°37'12"N 84°1'12"W
  function parseCoords(raw) {
    const t = String(raw).trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
    const dms = t.match(/^(\d{1,2})[°\s]+(\d{1,2})['\s]+(\d{1,2}(?:\.\d+)?)"?\s*([NS])[,\s]+(\d{1,3})[°\s]+(\d{1,2})['\s]+(\d{1,2}(?:\.\d+)?)"?\s*([EW])$/i);
    let lat, lng, note = '';
    if (dms) {
      lat = (+dms[1] + dms[2] / 60 + dms[3] / 3600) * (/s/i.test(dms[4]) ? -1 : 1);
      lng = (+dms[5] + dms[6] / 60 + dms[7] / 3600) * (/w/i.test(dms[8]) ? -1 : 1);
    } else {
      const m = t.match(/^([NS])?\s*(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,\s]\s*([EW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?$/i);
      if (!m) return null;
      lat = +m[2]; lng = +m[5];
      if (/s/i.test(m[1] || m[3] || '')) lat = -Math.abs(lat);
      const ew = m[4] || m[6] || '';
      if (/w/i.test(ew)) lng = -Math.abs(lng);
      else if (!ew && lng > 0 && lat > 36 && lat < 40 && lng > 81 && lng < 90) { lng = -lng; note = ' (read as West)'; }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, note };
  }
  // Online place/address search (OpenStreetMap Nominatim), results cached per query
  const placeCache = {}; let placeTimer = null;
  function lookupPlaces(q) {
    if (placeCache[q] || navigator.onLine === false) return;
    placeCache[q] = { pending: true, hits: [] };
    const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', q, limit: '6', countrycodes: 'us',
      viewbox: '-85.6,38.7,-82.4,36.9', bounded: '0' }).toString();
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 9000);
    fetch(u, { signal: ctl.signal, headers: { 'Accept': 'application/json' } }).then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
      .then(list => { placeCache[q] = { hits: (list || []).map(x => ({ lat: +x.lat, lng: +x.lon, name: String(x.name || x.display_name || '').slice(0, 80) || 'Place', sub: String(x.display_name || '') })) }; })
      .catch(() => { placeCache[q] = { failed: true, hits: [] }; })
      .finally(() => { clearTimeout(tm); if (qEl.value.trim() === q) runSearch(); });
  }
  function runSearch() {
    const rawQ = qEl.value.trim(), q = rawQ.toLowerCase();
    if (q.length < 2) { resEl.hidden = true; return; }
    const extra = [], coord = parseCoords(rawQ);
    if (coord) extra.push({ kind: 'coords', name: `Go to ${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`, sub: 'Drops a pin you can fine-tune and save' + coord.note,
      go: () => window.ffDropPin(coord.lat, coord.lng, `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`) });
    logCache.filter(e => (String(e.label || '') + ' ' + String(e.note || '')).toLowerCase().includes(q)).slice(0, 8).forEach(e => {
      const t = TYPES[e.type] || TYPES.check;
      extra.push({ kind: 'saved', name: e.label || t.label, sub: `${t.label} · ${new Date(e.ts).toLocaleDateString()}${e.note ? ' · ' + String(e.note).slice(0, 60) : ''}`,
        go: () => {
          if (e.target_status && resolveTid(e) !== null && typeof openTarget === 'function') return openTarget(resolveTid(e));
          map.setView([e.lat, e.lon], Math.max(map.getZoom(), 16));
          const mk = logMarkers[e.id]; if (mk) setTimeout(() => mk.openPopup(), 350);
        } });
    });
    const places = [];
    if (!coord && q.length >= 3) {
      const pc = placeCache[rawQ];
      if (pc && pc.hits) pc.hits.forEach(h => places.push({ kind: 'place', name: h.name, sub: h.sub, go: () => window.ffDropPin(h.lat, h.lng, h.name) }));
      if (!pc) { clearTimeout(placeTimer); if (navigator.onLine !== false) placeTimer = setTimeout(() => lookupPlaces(rawQ), 650); }
    }
    const score = e => { const n = e.name.toLowerCase();
      return n === q ? 0 : n.startsWith(q) ? 1 : n.replace(/^#\d+\s*/, '').startsWith(q) ? 1 : n.includes(q) ? 2 : e.sub.toLowerCase().includes(q) ? 3 : 9; };
    const local = idx.map(e => [score(e), e]).filter(([s]) => s < 9)
      .sort((a, b) => a[0] - b[0] || ORDER[a[1].kind] - ORDER[b[1].kind] || a[1].name.localeCompare(b[1].name))
      .slice(0, 30).map(([, e]) => e);
    const hits = [...extra.filter(e => e.kind === 'coords'), ...extra.filter(e => e.kind === 'saved'), ...local, ...places];
    let tail = '';
    if (!coord && q.length >= 3) {
      const pc = placeCache[rawQ];
      tail = navigator.onLine === false ? '<li class="ff-none">Address / place search needs internet. Coordinates and saved points work offline.</li>'
        : (!pc || pc.pending) ? '<li class="ff-none">Searching addresses and places…</li>'
        : pc.failed ? '<li class="ff-none">Address / place search unavailable (no signal?). Coordinates and saved points still work offline.</li>'
        : !pc.hits.length ? '<li class="ff-none">No addresses or places found.</li>' : '';
    }
    resEl.innerHTML = (hits.length ? hits.map((e, i) =>
      `<li data-i="${i}" role="button" tabindex="0"><span class="ff-kind">${e.kind}</span><b>${html(e.name)}</b><small>${html(e.sub)}</small></li>`).join('')
      : (tail ? '' : `<li class="ff-none">${idxReady ? 'No match' : 'Loading names…'}</li>`)) + tail;
    resEl.hidden = false;
    const choose = li => { const e = hits[+li.dataset.i]; if (!e) return; resEl.hidden = true; qEl.blur(); stopFollow(true); e.go(); };
    resEl.querySelectorAll('li[data-i]').forEach(li => {
      li.onclick = () => choose(li);
      li.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(li); } };
    });
  }
  qEl.addEventListener('focus', () => { buildIndex().then(runSearch); });
  qEl.addEventListener('input', () => { if (!idxReady) buildIndex().then(runSearch); runSearch(); });
  qEl.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { resEl.hidden = true; qEl.blur(); }
    if (ev.key === 'Enter' && !resEl.hidden) { const first = resEl.querySelector('li[data-i]'); if (first) { ev.preventDefault(); first.click(); } }
  });
  document.addEventListener('click', ev => { if (!ev.target.closest('#ff-search')) resEl.hidden = true; });

  /* ======================================================== 5. DOWNLOAD SAFETY */
  // iPhones pause web pages when the screen sleeps, which stalls a long tile
  // download halfway. Hold a screen wake lock while the download button is busy.
  const dlBtn = document.getElementById('dl-btn');
  if (dlBtn && 'wakeLock' in navigator && typeof MutationObserver === 'function') {
    let lock = null;
    const sync = async () => {
      try {
        if (dlBtn.disabled && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
        else if (!dlBtn.disabled && lock) { await lock.release(); lock = null; }
      } catch (_) { /* not allowed right now; download still runs */ }
    };
    new MutationObserver(sync).observe(dlBtn, { attributes: true, attributeFilter: ['disabled'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  }

  /* ======================================================= 6. MENIFEE (?) LAYER */
  // Experimental. Menifee has 1,253 valid crossings (Estill has 1,256) but one
  // ranked target, because 20% of the documented score is distance from the KGS
  // agate outline and Menifee lies mostly outside it. This layer re-scores its
  // crossings with that regional term removed and the other weights rescaled,
  // using the stored inputs — no geology is re-derived. Off by default.
  const slot = document.getElementById('research-layer-slot');
  let menLayer = null, menLoading = null;
  // Plain-language tiers from the stored geology-only percentile (no data changed).
  // Percentile = where the crossing falls among ALL 5,421 valid crossings in the study.
  const MEN_TIERS = [
    { max: 5,   key: 'best', name: 'Best bet to test', color: '#f0abfc', ring: '#fff',
      what: 'Top 5% of all 5,421 valid crossings on geology alone. Try these first.' },
    { max: 10,  key: 'good', name: 'Good option', color: '#a855f7', ring: '#fff',
      what: 'Top 5–10% on geology alone. Worth a stop if you are nearby or the best bets are barren.' },
    { max: 25,  key: 'maybe', name: 'Possible', color: '#7c5ca8', ring: '#e9d5ff',
      what: 'Top 10–25% on geology alone. Only if you are already on that creek.' },
    { max: 101, key: 'weak', name: 'Weaker — low priority', color: '#57506a', ring: '#9d93b3',
      what: 'Below the top 25% on geology alone. Shown for completeness; skip unless passing by.' }
  ];
  const menTier = p => MEN_TIERS.find(t => (+p.top_pct_geology_only) <= t.max) || MEN_TIERS[3];
  const menByRank = {};
  if (slot) {
    const h = document.createElement('h2'); h.className = 'sub'; h.textContent = 'Experimental';
    const lab = document.createElement('label'); lab.id = 'ff-men-label';
    lab.innerHTML = `<input type="checkbox" id="ff-men"><span class="sw dot" style="background:#a855f7"></span>` +
      `Menifee County (?) — geology only<small class="ff-sub">New territory, scored without the “near documented agate” term. Not field-checked. Tiers compare each crossing with all 5,421 valid crossings:</small>` +
      `<small class="ff-sub ff-men-key"><span><i class="ff-mk best">1</i><b>Best bet to test</b> · top 5% · 35 spots, numbered</span>` +
      `<span><i class="ff-mk good">36</i><b>Good option</b> · top 5–10% · 66 spots, numbered</span>` +
      `<span><i class="ff-mk maybe"></i><b>Possible</b> · top 10–25% · 189 small dots</span>` +
      `<span><i class="ff-mk weak"></i><b>Weaker</b> · below top 25% · 963 faint dots</span></small>`;
    slot.appendChild(h); slot.appendChild(lab);
  }
  async function buildMenifee() {
    const gj = await (typeof getJSON === 'function' ? getJSON('experimental_menifee.geojson')
      : fetch('data/experimental_menifee.geojson').then(r => r.json()));
    const grp = L.layerGroup();
    [...gj.features].sort((a, b) => b.properties.menifee_rank - a.properties.menifee_rank).forEach(f => {
      const p = f.properties, [lon, lat] = f.geometry.coordinates;
      const tier = menTier(p);
      const sz = tier.key === 'best' ? 24 : 19;
      const mk = (tier.key === 'best' || tier.key === 'good')
        ? L.marker([lat, lon], { pane: 'tgt', icon: L.divIcon({ className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
            html: `<div class="ff-men-top ff-men-${tier.key}">${p.menifee_rank}</div>` }) })
        : L.circleMarker([lat, lon], { pane: 'pts', radius: tier.key === 'maybe' ? 4 : 2.6, color: tier.ring, weight: tier.key === 'maybe' ? 1 : .6,
            fillColor: tier.color, fillOpacity: tier.key === 'maybe' ? .9 : .55, opacity: tier.key === 'maybe' ? 1 : .6 });
      let ws = null; try { ws = JSON.parse(p.walk_start); } catch (_) {}
      mk.bindPopup(() => `<div class="pp ff-pop">
        <b style="color:#c084fc">Menifee (?) · #${p.menifee_rank} of ${gj.features.length} in Menifee</b><br>
        <div class="ff-men-tier ff-men-tier-${tier.key}"><b>${tier.name.toUpperCase()}</b> · top ${p.top_pct_geology_only}% on geology alone<br><span>${tier.what}</span></div>
        ${html(p.stream)}<br><span style="opacity:.8">${html(p.quad)} quad · GQ-${html(p.gq)} · ${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
        <table class="ff-tab">
          <tr><td>Geology-only score</td><td><b>${p.score_geology_only}</b> (top ${p.top_pct_geology_only}% of all 5,421)</td></tr>
          <tr><td>Original score</td><td>${p.score_original}</td></tr>
          ${p.geo_conf ? `<tr><td>Geological confidence</td><td>${html(p.geo_conf)}</td></tr>` : ''}
          ${ws && ws.length === 2 ? `<tr><td>Start walking</td><td>${(+ws[0]).toFixed(5)}, ${(+ws[1]).toFixed(5)}</td></tr>` : ''}
          <tr><td>Inputs</td><td>S ${p.S} · D ${p.D} · E ${p.E} · I ${p.I} · T ${p.T} · G ${p.G}</td></tr>
          <tr><td>Regional term (dropped)</td><td>${p.R} — ${p.dist_outline_km} km from the KGS agate outline</td></tr>
        </table>
        <p class="ff-warn">Experimental, not one of the ranked 120. Same verified contact and same method, minus the regional-evidence term. This is a combined-unit quadrangle, so the true Nada top sits a few feet to ~10 m below the mapped line. Not field-checked.</p>
        <div class="btns"><button onclick="copyText('${lat.toFixed(5)}, ${lon.toFixed(5)}')">Copy coords</button></div></div>`,
        { maxWidth: 330 });
      mk.on('click', () => { if (typeof suppressMapClick !== 'undefined') suppressMapClick = true; });
      menByRank[p.menifee_rank] = mk;
      mk.addTo(grp);
    });
    return grp;
  }
  const menBox = document.getElementById('ff-men');
  // Turn the layer on. fit=true (the checkbox) shows the whole county; a search
  // result passes fit=false and then goes to its own crossing.
  async function showMenifee(fit) {
    if (!menLayer) {
      if (!menLoading) menLoading = (async () => { toast('Loading Menifee layer…'); menLayer = await buildMenifee(); })()
        .finally(() => { menLoading = null; });
      try { await menLoading; }
      catch (e) { if (menBox) menBox.checked = false; toast('Menifee layer is not saved for offline yet — connect once and try again', 3200); throw e; }
    }
    if (menBox) menBox.checked = true;
    if (!map.hasLayer(menLayer)) menLayer.addTo(map);
    if (fit) map.fitBounds([[37.78, -83.80], [38.02, -83.48]], { padding: [20, 20] });
  }
  if (menBox) menBox.addEventListener('change', async () => {
    if (menBox.checked) { try { await showMenifee(true); } catch (_) {} }
    else if (menLayer) map.removeLayer(menLayer);
  });

  /* ===================================================== 7. ONE THING AT A TIME */
  // Only one of the ☰ panel, the Targets sheet and the Field log may be open, and
  // the search box and GPS readout step aside while any of them is open.
  const panelEl = document.getElementById('panel'), listSheet = document.getElementById('sheet');
  ['menu-btn', 'list-btn'].forEach(id => { const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => openSheet(false)); });
  const covered = () => {
    const on = [panelEl, listSheet, sheet].some(el => el && el.classList.contains('open'));
    if (document.body.classList.contains('ff-covered') !== on) document.body.classList.toggle('ff-covered', on);
  };
  if (typeof MutationObserver === 'function')
    [panelEl, listSheet, sheet].forEach(el => el && new MutationObserver(covered).observe(el, { attributes: true, attributeFilter: ['class'] }));

  /* ============================================ 8. MENIFEE TOPO FOR OFFLINE USE */
  // The research download covers the ranked reaches. When it finishes, also save
  // close-up topo (zoom 13–16) around the top 25 Menifee (?) crossings so the
  // experimental layer is usable in airplane mode too.
  if (dlBtn && typeof MutationObserver === 'function' && typeof tilesFor === 'function' && typeof tileURL === 'function' && typeof TILE_CACHE !== 'undefined') {
    let wasBusy = false;
    new MutationObserver(async () => {
      if (dlBtn.disabled) { wasBusy = true; return; }
      if (!wasBusy) return; wasBusy = false;
      try {
        const gj = await (typeof getJSON === 'function' ? getJSON('experimental_menifee.geojson') : fetch('data/experimental_menifee.geojson').then(r => r.json()));
        const set = new Set();
        gj.features.filter(f => +f.properties.top_pct_geology_only <= 5).forEach(f => {   // every best bet
          const [lon, lat] = f.geometry.coordinates, pad = 0.006;
          for (let z = 13; z <= 16; z++) tilesFor([lat - pad, lon - pad, lat + pad, lon + pad], z).forEach(t => set.add(t));
        });
        const tc = await caches.open(TILE_CACHE); let got = 0;
        for (const t of set) {
          const u = tileURL(t);
          if (await tc.match(u)) { got++; continue; }
          try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) { await tc.put(u, r); got++; } } catch (_) {}
        }
        toast(`Menifee (?) best-bet close-up topo saved: ${got}/${set.size} tiles`, 2600);
      } catch (_) { /* optional extra; the main download is unaffected */ }
    }).observe(dlBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  /* =================================================== 9. WATCHABLE LAYER PANEL */
  const panelBox = document.getElementById('panel');
  if (panelBox) {
    const grip = document.createElement('div');
    grip.className = 'ff-grip'; grip.setAttribute('role', 'button'); grip.setAttribute('tabindex', '0');
    grip.setAttribute('aria-label', 'Expand or shrink the panel');
    grip.innerHTML = '<i></i><span>tap to expand</span>';
    if (typeof panelBox.insertBefore === 'function') panelBox.insertBefore(grip, panelBox.firstChild || null); else panelBox.appendChild(grip);
    const label = grip.querySelector('span') || { textContent: '' };
    const togglePanelHeight = () => {
      const tall = panelBox.classList.toggle('ff-tall');
      document.body.classList.toggle('ff-panel-tall', tall);
      label.textContent = tall ? 'tap to shrink and see the map' : 'tap to expand';
      grip.setAttribute('aria-expanded', tall ? 'true' : 'false');
    };
    grip.setAttribute('aria-expanded', 'false');
    grip.addEventListener('click', togglePanelHeight);
    grip.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); togglePanelHeight(); } });
    // IMPORTANT: this observer watches the panel's class attribute, so it must
    // never write that attribute unless something really changes. classList.remove()
    // of a class that is not there still rewrites the attribute, which re-fired this
    // observer forever and froze the page when the settings panel was closed.
    let wasOpen = panelBox.classList.contains('open');
    const syncPanel = () => {
      const open = panelBox.classList.contains('open');
      if (open === wasOpen) return;
      wasOpen = open;
      document.body.classList.toggle('ff-panel-open', open);
      if (!open) {
        if (panelBox.classList.contains('ff-tall')) panelBox.classList.remove('ff-tall');
        document.body.classList.remove('ff-panel-tall'); label.textContent = 'tap to expand';
        grip.setAttribute('aria-expanded', 'false');
      }
      setTimeout(() => map.invalidateSize(), 250);
    };
    if (typeof MutationObserver === 'function') new MutationObserver(syncPanel).observe(panelBox, { attributes: true, attributeFilter: ['class'] });
    // with the map visible above, a layer switched on should be seen: nudge a
    // freshly enabled layer into view only if nothing of it is on screen
    panelBox.addEventListener('change', ev => {
      const inp = ev.target; if (!inp || inp.type !== 'checkbox' || !inp.checked) return;
      toast(`${(inp.closest('label') || {}).textContent ? inp.closest('label').textContent.trim().split('\n')[0].slice(0, 42) : 'Layer'} on`, 1100);
    });
  }

  /* ============================================ 10. INSTALL + OFFLINE GUIDANCE */
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  // Sit the hint ABOVE both bottom stacks (right: Targets/Locate/Area/Log; left:
  // zoom + scale) so it never covers a button, and below the top bar/search.
  function placeBanner(b) {
    const h = window.innerHeight || document.documentElement.clientHeight;
    const tops = ['.map-actions', '.leaflet-bottom.leaflet-left']
      .map(q => document.querySelector(q)).filter(Boolean)
      .map(el => el.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.top);
    const clearTop = Math.min(h, ...tops);
    b.style.bottom = Math.max(16, Math.round(h - clearTop + 10)) + 'px';
    const tb = document.querySelector('.topbar');
    const topLimit = tb ? tb.getBoundingClientRect().bottom + 60 : 130;
    b.style.maxHeight = Math.max(90, Math.round(clearTop - 10 - topLimit)) + 'px';
  }
  function banner(key, title, body, action) {
    try { if (localStorage.getItem(key)) return; } catch (_) {}
    const b = document.createElement('div'); b.id = 'ff-banner'; b.setAttribute('role', 'dialog');
    b.innerHTML = `<button class="x" aria-label="Dismiss">×</button><b>${title}</b>${body}` + (action ? `<br><button class="go">${action.label}</button>` : '');
    document.body.appendChild(b);
    placeBanner(b);
    const onResize = () => placeBanner(b);
    window.addEventListener('resize', onResize);
    const close = () => { b.remove(); window.removeEventListener('resize', onResize); try { localStorage.setItem(key, '1'); } catch (_) {} };
    b.querySelector('.x').onclick = close;
    if (action) b.querySelector('.go').onclick = () => { close(); action.run(); };
  }
  setTimeout(() => {
    if (isIOS && !standalone) {
      banner('ff_hint_install', 'Use it like an app', 'Tap the Share button, then <b style="display:inline">Add to Home Screen</b>. Open it from that icon, then download the map for offline use from there — the icon keeps its own saved maps.');
      return;
    }
    let done = false; try { const m = JSON.parse(localStorage.getItem('kyOffline') || 'null'); done = !!(m && m.verified); } catch (_) {}
    if (!done) banner('ff_hint_download', 'Save the map for no-signal use', 'Downloads topo and all map data to this device, then checks every piece. Do it on Wi-Fi.',
      { label: 'Open download', run: () => { if (typeof setPanel === 'function') setPanel(true);
        const b = document.getElementById('dl-btn'); if (b) setTimeout(() => b.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250); } });
  }, 1800);

  // small "Offline" pill so it is obvious why satellite or hillshade are blank
  const net = document.createElement('div'); net.id = 'ff-net'; net.textContent = 'OFFLINE · saved maps'; 
  const setNet = off => { net.hidden = !off; document.body.classList.toggle('ff-offline', off); };
  setNet(navigator.onLine === false);
  document.body.appendChild(net);
  window.addEventListener('online', () => { setNet(false); toast('Back online', 1200); });
  window.addEventListener('offline', () => { setNet(true); toast('Offline — using saved maps', 1800); });

  /* ============================================== 11. LAND: FOREST SERVICE OWNED */
  // Public vs private, as far as free data allows. The Daniel Boone "boundary"
  // layers are the proclaimed boundary, which the Forest Service says includes
  // private land — shading that as public would put people on private property.
  // This uses the Forest Service's own ownership layer instead (FS-owned parcels
  // only), fetched for this map area once while online, then saved for offline.
  const FS_URL = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_BasicOwnership_01/MapServer/0/query';
  const FS_KEY = new URL('data/land_fs_ownership.geojson', (window.location && window.location.href) || document.baseURI).href;   // cache key only
  const FS_BOX = [-84.65, 37.20, -83.15, 38.10];                                   // study area w,s,e,n
  let fsGeo = null, fsLayer = null;

  async function fsLoad(allowNetwork) {
    if (fsGeo) return fsGeo;
    try { const c = await caches.open(typeof DATA_CACHE !== 'undefined' ? DATA_CACHE : 'mineral-maps-ky-agate-v3');
          const hit = await c.match(FS_KEY); if (hit) { fsGeo = await hit.json(); return fsGeo; } } catch (_) {}
    if (!allowNetwork || navigator.onLine === false) throw new Error('not saved yet');
    const feats = []; let offset = 0;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({
        where: "ownerclassification='USDA FOREST SERVICE'", geometry: FS_BOX.join(','),
        geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: 'ownerclassification,forestname', returnGeometry: 'true', outSR: '4326',
        geometryPrecision: '5', maxAllowableOffset: '0.0001', resultOffset: String(offset),
        resultRecordCount: '2000', f: 'geojson' });
      const r = await fetch(FS_URL + '?' + q.toString(), { mode: 'cors' });
      if (!r.ok) throw new Error('Forest Service server said ' + r.status);
      const gj = await r.json(); const got = (gj.features || []);
      feats.push(...got);
      if (got.length < 2000 && !(gj.properties && gj.properties.exceededTransferLimit) && !gj.exceededTransferLimit) break;
      offset += got.length;
    }
    fsGeo = { type: 'FeatureCollection', properties: { source: 'USDA Forest Service Basic Ownership (EDW)', fetched: new Date().toISOString(),
      note: 'Forest Service owned parcels only. Not a legal survey. State land, WMAs and parks are not included.' }, features: feats };
    try { const c = await caches.open(typeof DATA_CACHE !== 'undefined' ? DATA_CACHE : 'mineral-maps-ky-agate-v3');
          await c.put(FS_KEY, new Response(JSON.stringify(fsGeo), { headers: { 'Content-Type': 'application/geo+json' } })); } catch (_) {}
    return fsGeo;
  }
  function pointInFS(lat, lon) {
    if (!fsGeo) return null;
    for (const f of fsGeo.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        let inside = false;
        poly.forEach((ring, k) => {
          let c = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
          }
          inside = k === 0 ? c : (inside && !c);
        });
        if (inside) return true;
      }
    }
    return false;
  }

  if (slot) {
    const h = document.createElement('h2'); h.className = 'sub'; h.textContent = 'Land';
    const a = document.createElement('label');
    a.innerHTML = `<input type="checkbox" id="ff-fs"><span class="sw" style="background:rgba(56,193,114,.35);border:2px solid #38c172"></span>` +
      `Forest Service-owned land<small class="ff-sub">Shows parcels the Forest Service owns. Anything not green is unverified here, so confirm ownership and access before entering. Loads once online, then works offline.</small>`;
    const b = document.createElement('label');
    b.innerHTML = `<input type="checkbox" id="ff-fs-only"><span class="sw dot" style="background:#38c172"></span>` +
      `Show only targets on Forest Service-owned land<small class="ff-sub">Map filter only. Ownership does not guarantee collecting permission; verify current rules and access.</small>`;
    slot.appendChild(h); slot.appendChild(a); slot.appendChild(b);
  }
  async function ensureFS() {
    try { await fsLoad(true); return true; }
    catch (e) { toast(navigator.onLine === false ? 'Land layer is not saved yet — connect once to load it'
      : 'Could not load Forest Service land: ' + e.message, 3400); return false; }
  }
  const fsBox = document.getElementById('ff-fs'), fsOnly = document.getElementById('ff-fs-only');
  if (fsBox) fsBox.addEventListener('change', async () => {
    if (!fsBox.checked) { if (fsLayer) map.removeLayer(fsLayer); return; }
    toast('Loading Forest Service land…', 1600);
    if (!(await ensureFS())) { fsBox.checked = false; return; }
    if (!fsLayer) fsLayer = L.geoJSON(fsGeo, { pane: 'units', interactive: false,
      style: { color: '#38c172', weight: 1.2, opacity: .9, fillColor: '#38c172', fillOpacity: .18 } });
    fsLayer.addTo(map);
    toast(`${fsGeo.features.length} Forest Service parcels shown`, 1800);
  });
  const hidden = [];
  if (fsOnly) fsOnly.addEventListener('change', async () => {
    if (fsOnly.checked) {
      if (!(await ensureFS())) { fsOnly.checked = false; return; }
      let kept = 0;
      targets().forEach(t => {
        const m = (typeof markerById !== 'undefined') && markerById[t.id]; if (!m) return;
        if (pointInFS(t.lat, t.lon)) { kept++; return; }
        map.eachLayer(g => { if (g instanceof L.LayerGroup && g.hasLayer && g.hasLayer(m)) { g.removeLayer(m); hidden.push([g, m]); } });
      });
      toast(`${kept} of ${targets().length} ranked targets are on Forest Service land`, 2800);
    } else {
      hidden.splice(0).forEach(([g, m]) => g.addLayer(m));
    }
  });
  // fetch and save the land layer automatically at the end of the offline download
  if (dlBtn && typeof MutationObserver === 'function') {
    let busy = false;
    new MutationObserver(() => {
      if (dlBtn.disabled) { busy = true; return; }
      if (busy) { busy = false; fsLoad(true).then(g => toast(`Forest Service land saved for offline (${g.features.length} parcels)`, 2400)).catch(() => {}); }
    }).observe(dlBtn, { attributes: true, attributeFilter: ['disabled'] });
  }


  /* ============================================= 12. TRUE OFFLINE ROAD NETWORK */
  // The map itself was already offline. This saves a real road graph too, so a
  // NEW destination can be routed after signal is gone instead of relying only
  // on a route that was planned earlier while online.
  const roadBtn = document.getElementById('ff-road-dl');
  const roadStatus = document.getElementById('ff-road-status');
  async function refreshRoadStatus() {
    if (!roadStatus || !window.FFRoads) return;
    try {
      const st = await window.FFRoads.status();
      if (!st.ready) {
        roadStatus.className = 'status-box';
        roadStatus.innerHTML = '<b>Offline road routing not downloaded yet.</b><br>Download once on Wi-Fi, then Route here can calculate new routes with no signal inside the mapped agate area.';
        return;
      }
      const when = st.savedAt ? new Date(st.savedAt).toLocaleString() : 'saved';
      roadStatus.className = st.connectedPct >= 85 ? 'status-box ok' : 'status-box warn';
      roadStatus.innerHTML = `<b>${st.connectedPct >= 85 ? 'OFFLINE ROADS READY' : 'OFFLINE ROADS SAVED: NETWORK FRAGMENTED'}</b><br>${st.featureCount.toLocaleString()} road features · ${st.connectedPct}% largest connected network · saved ${when}.` +
        (st.connectedPct >= 85 ? '' : '<br>Some destinations may not connect. Re-download on a good connection before relying on it.');
    } catch (e) {
      roadStatus.className = 'status-box warn'; roadStatus.textContent = 'Offline road storage could not be read: ' + e.message;
    }
  }
  let roadDl = null;
  function downloadRoads() {
    if (!roadBtn || !window.FFRoads) return Promise.resolve(false);
    if (roadDl) return roadDl;
    if (navigator.onLine === false) { toast('Connect once to download the road network', 2800); return Promise.resolve(false); }
    roadDl = runRoadDownload().finally(() => { roadDl = null; });
    return roadDl;
  }
  if (roadBtn && window.FFRoads) roadBtn.addEventListener('click', () => { if (!roadBtn.disabled) downloadRoads(); });
  async function runRoadDownload() {
    roadBtn.disabled = true;
    const old = roadBtn.textContent;
    try {
      const g = await window.FFRoads.download(info => {
        if (!roadStatus) return;
        roadStatus.className = 'status-box';
        if (info.stage === 'download') roadStatus.textContent = `Downloading road centerlines… ${info.done.toLocaleString()} features`;
        else if (info.stage === 'build') roadStatus.textContent = `Building offline road graph… ${info.done ? info.done.toLocaleString() + ' / ' + info.total.toLocaleString() : ''}`;
        else roadStatus.textContent = 'Saving offline road graph…';
      });
      toast(`Offline roads saved: ${g.edges.length.toLocaleString()} segments`, 2600);
      await refreshRoadStatus();
      hlLayer = null; if (hlBox && hlBox.checked) showHighlighter(true);
      return true;
    } catch (e) {
      if (roadStatus) { roadStatus.className = 'status-box warn'; roadStatus.textContent = 'Road download failed: ' + e.message; }
      toast('Could not save offline roads: ' + e.message, 3600);
      return false;
    } finally { roadBtn.disabled = false; roadBtn.textContent = old; }
  }
  refreshRoadStatus();

  /* ================================= 13. OFFLINE ROAD HIGHLIGHTER (basic map) */
  // The simplest no-signal map: every road in the study area drawn as a yellow
  // highlighter from the saved Kentucky 911 roads, under the creeks and your blue
  // GPS dot. It is vector data on the phone, so it works at any zoom, even where
  // no topo tiles were saved between creeks.
  const HL_KEY = 'ff_hl_on', HL_MINZOOM = 11;
  map.createPane('hl').style.zIndex = 405;          // above geology fills, below creeks/targets
  map.getPane('hl').style.pointerEvents = 'none';
  let hlLayer = null, hlBuilding = null, hlHintShown = false;
  if (roadBtn) {
    const lab = document.createElement('label'); lab.id = 'ff-hl-label';
    lab.innerHTML = `<input type="checkbox" id="ff-hl"><span class="sw" style="border-top:7px solid rgba(255,230,0,.7)"></span>` +
      `Road highlighter (works with no signal)<small class="ff-sub">Every road in this map area in yellow, under the creeks and your blue GPS dot. Uses the road download above (fetched automatically the first time). Shows from zoom ${HL_MINZOOM} in. Roads may be private or gated.</small>`;
    roadBtn.insertAdjacentElement('afterend', lab);
  }
  const hlBox = document.getElementById('ff-hl');
  async function buildHighlighter() {
    const g = window.FFRoads && window.FFRoads.graph ? await window.FFRoads.graph() : null;
    if (!g || !g.edges || !g.edges.length) return null;
    // group segments into ~5 km cells, one canvas polyline per cell
    const cells = new Map(), C = 0.05;
    for (const e of g.edges) {
      const c = e.c; if (!c || c.length < 2) continue;
      const m = c[c.length >> 1], k = Math.floor(m[0] / C) + ',' + Math.floor(m[1] / C);
      let a = cells.get(k); if (!a) cells.set(k, a = []);
      a.push(c.map(q => [q[1], q[0]]));
    }
    const renderer = L.canvas({ pane: 'hl', padding: 0.25 });
    const grp = L.layerGroup();
    cells.forEach(lines => L.polyline(lines, { renderer, pane: 'hl', color: '#ffe600', weight: 8, opacity: .5,
      lineCap: 'round', lineJoin: 'round', interactive: false, smoothFactor: 1.2 }).addTo(grp));
    return grp;
  }
  function syncHighlighterZoom() {
    if (!hlLayer || !hlBox || !hlBox.checked) return;
    const show = map.getZoom() >= HL_MINZOOM;
    if (show && !map.hasLayer(hlLayer)) hlLayer.addTo(map);
    if (!show && map.hasLayer(hlLayer)) map.removeLayer(hlLayer);
    if (!show && !hlHintShown) { hlHintShown = true; toast('Zoom in to see the road highlighter', 1800); }
  }
  async function showHighlighter(on) {
    try { localStorage.setItem(HL_KEY, on ? '1' : '0'); } catch (_) {}
    if (!on) { if (hlLayer && map.hasLayer(hlLayer)) map.removeLayer(hlLayer); return; }
    if (!hlLayer) {
      if (!hlBuilding) hlBuilding = buildHighlighter().finally(() => { hlBuilding = null; });
      hlLayer = await hlBuilding;
      if (!hlLayer) {
        if (navigator.onLine === false) { if (hlBox) hlBox.checked = false; toast('Roads are not saved yet — connect once and turn this on', 3200); return; }
        toast('Downloading roads for this map area (one time)…', 2600);
        if (!(await downloadRoads())) { if (hlBox) hlBox.checked = false; }
        return;                                      // runRoadDownload() redraws when done
      }
    }
    if (hlBox && !hlBox.checked) return;
    hlHintShown = false; syncHighlighterZoom();
  }
  if (hlBox) {
    hlBox.addEventListener('change', () => showHighlighter(hlBox.checked));
    map.on('zoomend', syncHighlighterZoom);
    let want = null; try { want = localStorage.getItem(HL_KEY); } catch (_) {}
    // on by default whenever roads are saved, unless the user switched it off
    if (window.FFRoads) window.FFRoads.status().then(st => {
      if (st.ready && want !== '0') { hlBox.checked = true; showHighlighter(true); }
    }).catch(() => {});
    window.addEventListener('offline', () => {
      if (hlBox.checked || !window.FFRoads) return;
      window.FFRoads.status().then(st => { if (st.ready) { hlBox.checked = true; showHighlighter(true); } }).catch(() => {});
    });
  }
  // the main "Download ... for offline" button also saves the roads if missing
  if (dlBtn && window.FFRoads && typeof MutationObserver === 'function') {
    let wasBusy = false;
    new MutationObserver(() => {
      if (dlBtn.disabled) { wasBusy = true; return; }
      if (!wasBusy) return; wasBusy = false;
      window.FFRoads.status().then(st => { if (!st.ready && navigator.onLine !== false) {
        if (hlBox) hlBox.checked = true;
        downloadRoads();
      } }).catch(() => {});
    }).observe(dlBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  /* ============================== 12. EVERY POPUP: LAND STATUS + OWNER LOOKUP */
  // Leaflet rebuilds a popup's content from its template every time the popup is
  // (re)opened or popup.update() is called, which wiped the buttons injected here.
  // So: never call popup.update() after injecting; re-inject whenever Leaflet
  // fires 'contentupdate'; and re-measure with Leaflet's layout/pan steps only.
  function relayoutPopup(popup) {
    if (!popup || !popup.isOpen || !popup.isOpen()) return;
    try { popup._updateLayout(); popup._updatePosition(); if (popup._adjustPan) popup._adjustPan(); } catch (_) {}
  }
  function injectActions(popup, relayout) {
    const el = popup.getElement && popup.getElement(); if (!el) return;
    const content = el.querySelector('.leaflet-popup-content'); if (!content || content.querySelector('.ff-land')) return;
    if (!content.firstElementChild && !content.textContent.trim()) return;
    const ll = popup.getLatLng && popup.getLatLng(); if (!ll) return;
    const inFS = pointInFS(ll.lat, ll.lng);
    const status = inFS === null
      ? '<span class="ff-land-tag unk">Ownership not checked in-app</span>'
      : inFS
        ? '<span class="ff-land-tag pub">Forest Service-owned parcel — verify collecting rules</span>'
        : '<span class="ff-land-tag priv">Not Forest Service-owned — verify ownership/access</span>';
    const div = document.createElement('div'); div.className = 'ff-land';
    div.innerHTML = `${status}<div class="btns">
      ${content.querySelector('[data-ff-route]') ? '' : '<button type="button" data-route>🧭 Route here</button>'}
      <button type="button" data-log>✎ Log a spot here</button>
      <button type="button" data-own>Who owns this?</button>
      <button type="button" data-dir>Directions</button></div>`;
    div.querySelector('[data-log]').onclick = () => window.ffLogAt(ll.lat, ll.lng);
    const routeBtn = div.querySelector('[data-route]');
    if (routeBtn) routeBtn.onclick = () => {
      const t = content.querySelector('h3, b, strong'); map.closePopup();
      window.ffRouteTo(ll.lat, ll.lng, t ? t.textContent.trim().slice(0, 48) : 'Selected spot');
    };
    div.querySelector('[data-own]').onclick = () => window.open(`https://app.regrid.com/us#b=search&q=${ll.lat.toFixed(5)}%2C${ll.lng.toFixed(5)}`, '_blank');
    div.querySelector('[data-dir]').onclick = () => window.open(`https://maps.apple.com/?daddr=${ll.lat},${ll.lng}`, '_blank');
    const tid = targetIdForPopup(popup);
    if (tid !== null) {
      // a one-line reminder at the very top, so a target you already tried is obvious
      const top = document.createElement('div'); top.className = 'ff-tn-top'; top.hidden = true;
      const h = content.querySelector('.pp > h3 + div') || content.querySelector('.pp > h3');
      if (h) h.insertAdjacentElement('afterend', top);
      content.appendChild(targetNotesBlock(tid, popup, top));
    }
    content.appendChild(div);
    // field-log photos change the height once decoded
    content.querySelectorAll('img').forEach(img => { if (!img.complete) img.addEventListener('load', () => relayoutPopup(popup), { once: true }); });
    if (relayout) relayoutPopup(popup);
  }
  function anyPopupOpen() { let open = false; map.eachLayer(l => { if (l instanceof L.Popup) open = true; }); return open; }
  map.on('popupopen', e => {
    const pop = e.popup;
    stopFollow(false);                                                    // keep the popup on screen
    document.body.classList.add('ff-popup');                              // search/GPS/route bars step aside
    if (!pop._ffHooked) {
      pop._ffHooked = true;
      // fires inside Leaflet's own update(), before it measures, so no relayout here
      pop.on('contentupdate', () => injectActions(pop, false));
    }
    injectActions(pop, true);
  });
  map.on('popupclose', () => {
    setTimeout(() => { if (!anyPopupOpen()) document.body.classList.remove('ff-popup'); }, 0);
  });

  /* ===================================================== 14. ROUTE HERE (blue line) */
  // A plain blue line to follow, not turn-by-turn. With signal, the public OSRM
  // router is used and that route is saved. With no signal, the locally saved
  // Kentucky 911 road graph calculates a new route entirely on the phone. If the
  // road graph has not been downloaded yet, the last-resort fallback is an honest
  // straight line with distance + direction rather than pretending a road exists.
  const ROUTE_KEY = 'ff_route_v1';
  const routeLayer = L.layerGroup().addTo(map);
  const rbar = document.createElement('div'); rbar.id = 'ff-route'; rbar.hidden = true;
  document.body.appendChild(rbar);
  let route = null, lastReroute = 0, pendingDest = null, offCount = 0, rerouting = false;

  function saveRoute() { try { route ? localStorage.setItem(ROUTE_KEY, JSON.stringify(route)) : localStorage.removeItem(ROUTE_KEY); } catch (_) {} }
  function fmtDist(m) { return m < 1609 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(1)} mi`; }
  function fmtTime(s) { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }

  function drawRoute() {
    routeLayer.clearLayers();
    if (!route) { rbar.hidden = true; return; }
    const dest = L.latLng(route.dest.lat, route.dest.lng);
    if (route.coords && route.coords.length > 1) {
      const ll = route.coords.map(c => [c[1], c[0]]);
      L.polyline(ll, { color: '#0b3d91', weight: 10, opacity: .55, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      L.polyline(ll, { color: '#3b8cff', weight: 6, opacity: .95, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      const start = L.latLng(ll[0]), end = L.latLng(ll[ll.length - 1]);
      const origin = route.origin ? L.latLng(route.origin.lat, route.origin.lng) : null;
      if (origin && map.distance(origin, start) > 25)                        // first leg to the road network
        L.polyline([origin, start], { color: '#3b8cff', weight: 3, opacity: .9, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(routeLayer);
      if (map.distance(end, dest) > 25)                                     // last leg on foot, off the road network
        L.polyline([end, dest], { color: '#3b8cff', weight: 3, opacity: .9, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(routeLayer);
    } else if (route.straight) {
      L.polyline([route.origin, route.dest], { color: '#3b8cff', weight: 3, opacity: .85, dashArray: '8 8', interactive: false }).addTo(routeLayer);
    }
    L.circleMarker(dest, { radius: 7, color: '#fff', weight: 2.5, fillColor: '#3b8cff', fillOpacity: 1, interactive: false }).addTo(routeLayer);
    updateBar();
  }
  function updateBar() {
    if (!route) return;
    const dest = L.latLng(route.dest.lat, route.dest.lng);
    const here = (typeof lastFix !== 'undefined' && lastFix) ? lastFix : null;
    let line;
    if (route.coords) {
      const end = L.latLng(route.coords[route.coords.length - 1][1], route.coords[route.coords.length - 1][0]);
      const foot = map.distance(end, dest);
      const start = L.latLng(route.coords[0][1], route.coords[0][0]);
      const first = route.origin ? map.distance(L.latLng(route.origin.lat, route.origin.lng), start) : 0;
      line = `<b>${html(route.label)}</b> · ${fmtDist(route.distance)} by road, about ${fmtTime(route.duration)}` +
             (first > 25 ? ` · ${fmtDist(first)} to road` : '') +
             (foot > 25 ? ` · then ${fmtDist(foot)} on foot` : '') +
             (route.local ? ' · <span class="ff-saved">offline roads</span>' : route.offline ? ' · <span class="ff-saved">saved route</span>' : '');
    } else {
      const from = here || L.latLng(route.origin.lat, route.origin.lng);
      line = `<b>${html(route.label)}</b> · no signal: ${fmtDist(map.distance(from, dest))} ${bearingWord(from, dest)} in a straight line. Plan routes while you have signal.`;
    }
    if (here) {
      const left = map.distance(here, dest);
      if (left < 60) line = `<b>You're there</b> · ${html(route.label)}`;
    }
    rbar.innerHTML = `<div class="ff-rtxt">${line}</div><button type="button" id="ff-rclear" aria-label="Clear route">✕</button>`;
    rbar.hidden = false;
    $('#ff-rclear', rbar).onclick = () => { route = null; saveRoute(); drawRoute(); toast('Route cleared', 1000); };
  }

  async function cacheTilesAlong(coords) {
    if (typeof tilesFor !== 'function' || typeof tileURL !== 'function' || typeof TILE_CACHE === 'undefined') return;
    const set = new Set(); let last = null;
    coords.forEach(c => {
      const ll = L.latLng(c[1], c[0]);
      if (last && map.distance(last, ll) < 350) return; last = ll;
      const pad = 0.004;
      for (let z = 13; z <= 15; z++) tilesFor([ll.lat - pad, ll.lng - pad, ll.lat + pad, ll.lng + pad], z).forEach(t => set.add(t));
    });
    const list = [...set].slice(0, 2500);
    const tc = await caches.open(TILE_CACHE);
    let i = 0;
    const worker = async () => { while (i < list.length) { const u = tileURL(list[i++]);
      if (await tc.match(u)) continue;
      try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await tc.put(u, r); } catch (_) {} } };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async function routeTo(lat, lng, label, opts) {
    const quiet = !!(opts && opts.quiet);             // automatic re-plan while walking/driving
    const say = (m, ms) => { if (!quiet) toast(m, ms); };
    const dest = { lat, lng };
    const here = (typeof lastFix !== 'undefined' && lastFix) ? lastFix : null;
    if (!here) {
      pendingDest = { lat, lng, label };
      toast('Finding your location first…', 2200);
      startWatch(false);
      return;
    }
    const base = { dest, origin: { lat: here.lat, lng: here.lng }, label: label || 'Destination', created: Date.now() };
    // Online: use the full OSRM driving router first. It gives the best route and
    // the resulting blue line is saved for later no-signal use.
    if (navigator.onLine !== false) {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${here.lng.toFixed(6)},${here.lat.toFixed(6)};${lng.toFixed(6)},${lat.toFixed(6)}?overview=full&geometries=geojson`;
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch(url, { signal: ctl.signal }); clearTimeout(tm);
        const j = await r.json();
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(j.message || 'no route found');
        const rt = j.routes[0];
        if (!rt.geometry || !rt.geometry.coordinates || rt.geometry.coordinates.length < 2) throw new Error('empty route');
        route = { ...base, coords: rt.geometry.coordinates, distance: rt.distance, duration: rt.duration, offline: false, local: false };
        saveRoute(); drawRoute();
        if (!quiet) map.fitBounds(L.latLngBounds(route.coords.map(c => [c[1], c[0]])).extend(here).extend([lat, lng]), { padding: [60, 60] });
        say('Route saved — it stays on the map without signal', 2600);
        cacheTilesAlong(route.coords).then(() => say('Topo along the route saved for offline', 1800)).catch(() => {});
        return true;
      } catch (e) { say('Online router unavailable — trying saved offline roads', 2200); }
    }

    // No signal (or online router failed): calculate from the road graph saved in
    // IndexedDB. This is real offline pathfinding, not a cached single route.
    if (window.FFRoads) {
      try {
        const rr = await window.FFRoads.route(here.lat, here.lng, lat, lng);
        if (rr && rr.coords && rr.coords.length > 1) {
          route = { ...base, coords: rr.coords, distance: rr.distance, duration: rr.duration, offline: true, local: true,
            footStart: rr.footStart, footEnd: rr.footEnd };
          saveRoute(); drawRoute();
          if (!quiet) map.fitBounds(L.latLngBounds(route.coords.map(c => [c[1], c[0]])).extend(here).extend([lat, lng]), { padding: [60, 60] });
          say('Offline road route — no signal needed', 2400);
          cacheTilesAlong(route.coords).catch(() => {});
          return true;
        }
      } catch (_) { /* fall through to straight-line fallback */ }
    }

    // A quiet re-plan that finds nothing better keeps the last good road line.
    if (quiet && route && route.coords) return false;
    route = { ...base, straight: true };
    saveRoute(); drawRoute();
    map.fitBounds(L.latLngBounds([here, [lat, lng]]), { padding: [60, 60] });
    toast('No offline road network for this route — showing a straight line', 2600);
  }
  window.ffRouteTo = routeTo;

  // Distance (m) from a point to the WHOLE trip: the walking leg from where the
  // route was planned to the road, every road segment, and the walking leg from
  // the road's end to the destination. Counting only the road part meant anyone
  // standing off-road at either end was always "off the line" and the app
  // re-planned forever.
  function distToTripM(here, r) {
    const pts = [];
    if (r.origin) pts.push([r.origin.lat, r.origin.lng]);
    r.coords.forEach(c => pts.push([c[1], c[0]]));
    pts.push([r.dest.lat, r.dest.lng]);
    const R = 6371000 * Math.PI / 180, k = Math.cos(here.lat * Math.PI / 180);
    const xy = pts.map(([la, lo]) => [(lo - here.lng) * k * R, (la - here.lat) * R]);
    let best = Infinity;
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i], dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      best = Math.min(best, Math.hypot(px, py));
    }
    return best;
  }
  // follow along: keep the bar current, re-plan quietly if you really leave the trip
  function onFixForRoute(pos) {
    if (pendingDest && typeof lastFix !== 'undefined' && lastFix) { const d = pendingDest; pendingDest = null; routeTo(d.lat, d.lng, d.label); return; }
    if (!route) return;
    updateBar();
    if (!route.coords || rerouting || (navigator.onLine === false && !route.local)) return;
    const here = lastFix; if (!here) return;
    if (map.distance(here, L.latLng(route.dest.lat, route.dest.lng)) < 60) { offCount = 0; return; }
    const acc = pos && pos.coords && Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 0;
    const limit = Math.max(150, acc * 2);                  // a poor fix is not "off route"
    if (distToTripM(here, route) <= limit) { offCount = 0; return; }
    if (++offCount < 2 || Date.now() - lastReroute < 30000) return;   // two off-route fixes in a row, max one re-plan / 30 s
    offCount = 0; lastReroute = Date.now(); rerouting = true;
    routeTo(route.dest.lat, route.dest.lng, route.label, { quiet: true }).catch(() => {}).finally(() => { rerouting = false; });
  }
  // hook into the GPS updates
  const _drawFix = drawFix;
  drawFix = function (pos) { _drawFix(pos); onFixForRoute(pos); onFixForTruck(pos); };

  /* =================================================== 15. MARK TARGETS CHECKED */
  // From a target's popup: "Tried — nothing", "Found agate" or "Not for me", with
  // a note. Each mark is a normal field-log entry (so it is in exports and the
  // photo backup) tagged with the target. The newest mark changes the target dot.
  const TSTAT = {
    blank: { short: 'Tried — nothing', badge: '✓', cls: 'tried' },
    find:  { short: 'Found agate', badge: '★', cls: 'found' },
    skip:  { short: 'Not for me', badge: '✕', cls: 'skip' }
  };
  window.ffTargetStatus = {};                       // id -> newest mark (read by the Targets list)
  // A mark is tied to a PLACE, not just an id number. If the target list is ever
  // re-numbered, a mark follows the target within 30 m of where it was made, or
  // becomes an ordinary pin; it is never attached to a different place.
  const MARK_M = 30;
  function resolveTid(e) {
    const tl = targets(); if (!tl.length) return e.target_id;      // target list not loaded yet: leave as is
    const la = Number.isFinite(+e.target_lat) ? +e.target_lat : +e.lat, lo = Number.isFinite(+e.target_lon) ? +e.target_lon : +e.lon;
    const t = tl.find(x => x.id === e.target_id);
    if (t && map.distance([la, lo], [t.lat, t.lon]) <= MARK_M) return t.id;
    let best = null, bd = Infinity;
    tl.forEach(x => { const d = map.distance([la, lo], [x.lat, x.lon]); if (d < bd) { bd = d; best = x; } });
    return best && bd <= MARK_M ? best.id : null;
  }
  // Writes the re-attachment (and the stored coordinates on older marks) once, and
  // returns the ids of marks that no longer match any target.
  async function reconcileMarks(all) {
    const lost = new Set();
    if (!targets().length) return lost;
    for (const e of all) {
      if (!e.target_status) continue;
      const tid = resolveTid(e);
      if (tid === null) { lost.add(e.id); continue; }
      const t = targets().find(x => x.id === tid);
      if (tid !== e.target_id || !Number.isFinite(+e.target_lat)) {
        e.target_id = tid; if (t) { e.target_rank = t.rank; if (!Number.isFinite(+e.target_lat)) { e.target_lat = t.lat; e.target_lon = t.lon; } }
        await putEntry(e);
      }
    }
    return lost;
  }
  function targetIdForPopup(popup) {
    const src = popup && popup._source;
    if (!src || typeof markerById === 'undefined') return null;
    for (const id in markerById) if (markerById[id] === src) return +id;
    return null;
  }
  function refreshTargetDots(all) {
    const newest = {};
    (all || []).forEach(e => {
      if (!e.target_status || e.target_id === undefined || !TSTAT[e.type]) return;
      const tid = resolveTid(e); if (tid === null) return;          // its target is gone: shown as a plain pin instead
      if (!newest[tid] || e.ts > newest[tid].ts) newest[tid] = e;
    });
    window.ffTargetStatus = newest;
    if (typeof markerById === 'undefined') return;
    Object.keys(markerById).forEach(id => {
      const m = markerById[id]; if (!m) return;
      if (!m._ffIcon) m._ffIcon = m.options.icon;
      const st = newest[id], base = m._ffIcon;
      if (!st) { if (m.options.icon !== base) m.setIcon(base); return; }
      const t = TSTAT[st.type], o = base.options;
      m.setIcon(L.divIcon({ className: '', iconSize: o.iconSize, iconAnchor: o.iconAnchor,
        html: `<div class="ff-tstat ff-tstat-${t.cls}">${o.html}<span class="ff-tbadge">${t.badge}</span></div>` }));
    });
    const sel = document.getElementById('sort-sel'), listSheet = document.getElementById('sheet');
    if (sel && listSheet && listSheet.classList.contains('open') && typeof renderList === 'function') renderList();
  }
  function targetNotesBlock(tid, popup, topEl) {
    const t = targets().find(x => x.id === tid);
    const box = document.createElement('div'); box.className = 'ff-tnotes';
    box.innerHTML = `<b>Your notes on this target</b><div class="ff-tn-hist">Loading…</div>
      <textarea rows="2" maxlength="2000" placeholder="Why you liked it or didn't, water level, access…"></textarea>
      <div class="ff-tn-btns">
        <button type="button" data-s="blank">✓ Tried — nothing</button>
        <button type="button" data-s="find">★ Found agate</button>
        <button type="button" data-s="skip">✕ Not for me</button>
      </div>`;
    const hist = box.querySelector('.ff-tn-hist'), ta = box.querySelector('textarea');
    const paint = async () => {
      const mine = (await allEntries()).filter(e => e.target_status && resolveTid(e) === tid).sort((a, b) => b.ts - a.ts);
      hist.innerHTML = mine.length ? mine.map(e => `<div class="ff-tn-row ff-tn-${TSTAT[e.type] ? TSTAT[e.type].cls : 'tried'}">
          <span>${TSTAT[e.type] ? TSTAT[e.type].badge + ' ' + TSTAT[e.type].short : html(e.type)}</span> · ${new Date(e.ts).toLocaleDateString()}
          ${e.note ? `<div class="ff-tn-note">${html(e.note)}</div>` : ''}
          <button type="button" class="ff-tn-del" data-del="${html(e.id)}" aria-label="Delete this mark">✕</button></div>`).join('')
        : '<span class="ff-tn-none">Not checked yet.</span>';
      if (topEl) {
        const e = mine[0], st = e && TSTAT[e.type];
        topEl.hidden = !st;
        if (st) {
          topEl.className = `ff-tn-top ff-tn-${st.cls}`;
          topEl.innerHTML = `<b>${st.badge} ${st.short}</b> · ${new Date(e.ts).toLocaleDateString()}${e.note ? ` — ${html(e.note.length > 90 ? e.note.slice(0, 90) + '…' : e.note)}` : ''}` +
            (mine.length > 1 ? ` <span style="opacity:.7">(${mine.length} marks)</span>` : '');
        }
      }
      hist.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this mark and its note?')) return;
        await delEntry(b.dataset.del); await drawLog(); await paint();
      });
      relayoutPopup(popup);
    };
    box.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
      const type = b.dataset.s, n = ta.value.trim();
      const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), type,
        label: t ? `#${t.rank} ${String(t.stream || '').slice(0, 60)}` : `Target ${tid}`, note: n,
        lat: t ? t.lat : popup.getLatLng().lat, lon: t ? t.lon : popup.getLatLng().lng, gps: false, acc: null, photo: null,
        target_status: true, target_id: tid, target_rank: t ? t.rank : null, nearest_target: t ? t.rank : null, nearest_target_m: 0,
        target_lat: t ? t.lat : null, target_lon: t ? t.lon : null };
      if (await putEntry(e)) {
        ta.value = ''; toast(`#${t ? t.rank : ''} marked: ${TSTAT[type].short}`, 1800);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        await drawLog(); await paint();
      }
    });
    paint();
    return box;
  }
  // dots appear once the targets have loaded
  (async () => { await waitForTargets(); await drawLog(); })();

  /* ======================================================= 16. BACK TO THE TRUCK */
  // One tap saves where you parked. The GPS readout then always starts with the
  // distance and direction back to it, and a faint trail shows where you walked.
  // Everything is on the phone; no signal needed.
  const TRUCK_KEY = 'ff_truck_v1', TRAIL_KEY = 'ff_trail_v1';
  let truck = null, trail = [], pendingTruck = false, trailDirty = 0;
  try { truck = JSON.parse(localStorage.getItem(TRUCK_KEY) || 'null'); } catch (_) {}
  try { trail = JSON.parse(localStorage.getItem(TRAIL_KEY) || '[]'); if (!Array.isArray(trail)) trail = []; } catch (_) { trail = []; }
  const truckLayer = L.layerGroup().addTo(map);
  let truckMarker = null, trailLine = null;
  const truckBtn = document.createElement('button');
  truckBtn.className = 'action-btn'; truckBtn.type = 'button'; truckBtn.id = 'ff-truck-btn';
  truckBtn.textContent = '🚙 Truck';
  if (locBtn && locBtn.parentNode) locBtn.insertAdjacentElement('afterend', truckBtn);
  else if (actions) actions.appendChild(truckBtn);

  function saveTruck() { try { truck ? localStorage.setItem(TRUCK_KEY, JSON.stringify(truck)) : localStorage.removeItem(TRUCK_KEY); markChanged('truck', true); } catch (_) { markChanged('truck', false); } }
  function saveTrail(dirty) { try { trail.length ? localStorage.setItem(TRAIL_KEY, JSON.stringify(trail)) : localStorage.removeItem(TRAIL_KEY); markChanged('trail', true, { dirty: dirty !== false }); } catch (_) { markChanged('trail', false); } }
  window.ffTruckRestore = (t, tr) => {                 // used by Restore backup / safety copy
    if (!truck && t && Number.isFinite(+t.lat) && Number.isFinite(+t.lng)) { truck = { lat: +t.lat, lng: +t.lng, ts: +t.ts || Date.now() }; saveTruck(); }
    if (trail.length < 2 && Array.isArray(tr) && tr.length) { trail = tr.filter(q => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1])).slice(-6000); saveTrail(); }
    drawTruck();
  };
  function truckPopup() {
    const here = (typeof lastFix !== 'undefined' && lastFix) ? lastFix : null;
    const far = here ? `${distWords(map.distance(here, [truck.lat, truck.lng]))} ${bearingWord(here, L.latLng(truck.lat, truck.lng))} of you` : 'Press ◎ Locate to see how far';
    return `<div class="pp ff-pop ff-truck-pop"><b>🚙 Your truck</b><br>
      <span style="opacity:.85">${far}</span><br>
      <span style="opacity:.7">Parked ${new Date(truck.ts).toLocaleString()} · ${truck.lat.toFixed(5)}, ${truck.lng.toFixed(5)}</span>
      <div class="btns"><button type="button" onclick="ffTruck('here')">Park here instead</button>
      <button type="button" onclick="ffTruck('clear')">Clear truck + trail</button></div></div>`;
  }
  function drawTruck() {
    truckLayer.clearLayers(); truckMarker = null; trailLine = null;
    if (trail.length > 1) trailLine = L.polyline(trail.map(p => [p[0], p[1]]), { color: '#e0f2ff', weight: 3, opacity: .85,
      dashArray: '1 7', lineCap: 'round', interactive: false }).addTo(truckLayer);
    if (!truck) { truckBtn.classList.remove('ff-on'); return; }
    truckMarker = L.marker([truck.lat, truck.lng], { pane: 'star', zIndexOffset: 500, title: 'Your truck',
      icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="ff-truck">🚙</div>' }) })
      .bindPopup(truckPopup, { maxWidth: 280 }).addTo(truckLayer);
    truckMarker.on('click', () => { if (typeof suppressMapClick !== 'undefined') suppressMapClick = true; });
    truckBtn.classList.add('ff-on');
  }
  function parkAt(ll) {
    truck = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), ts: Date.now() };
    trail = [[truck.lat, truck.lng]]; saveTruck(); saveTrail(); drawTruck();
    toast('Truck saved here — the GPS bar now points back to it', 2600);
    if (typeof lastFix !== 'undefined' && lastFix) drawFix({ coords: { latitude: lastFix.lat, longitude: lastFix.lng, accuracy: lastAcc || 0 }, _ffTime: fixTime });
  }
  let lastAcc = null;
  window.ffTruck = action => {
    if (action === 'clear') {
      if (!confirm('Clear the saved truck spot and your walked trail?')) return;
      truck = null; trail = []; saveTruck(); saveTrail(); map.closePopup(); drawTruck();
      readout.innerHTML = readout.innerHTML.replace(/^<span class="ff-rt-truck">.*?<\/span>/, '');
      return toast('Truck cleared', 1200);
    }
    if (action === 'here') {
      map.closePopup();
      if (typeof lastFix !== 'undefined' && lastFix) return parkAt(lastFix);
      pendingTruck = true; toast('Finding your location to save the truck…', 2400); startWatch(false);
    }
  };
  truckBtn.addEventListener('click', () => {
    if (!truck) {
      if (typeof lastFix !== 'undefined' && lastFix) return parkAt(lastFix);
      pendingTruck = true; toast('Finding your location to save the truck…', 2400); startWatch(false);
      return;
    }
    stopFollow(true);
    const here = (typeof lastFix !== 'undefined' && lastFix) ? lastFix : null;
    if (here && map.distance(here, [truck.lat, truck.lng]) > 40) map.fitBounds(L.latLngBounds([here, [truck.lat, truck.lng]]), { padding: [70, 70], maxZoom: 17 });
    else map.setView([truck.lat, truck.lng], Math.max(map.getZoom(), 16));
    setTimeout(() => { if (truckMarker) truckMarker.openPopup(); }, 350);
  });
  function onFixForTruck(pos) {
    const here = typeof lastFix !== 'undefined' ? lastFix : null; if (!here) return;
    lastAcc = pos && pos.coords ? pos.coords.accuracy : null;
    if (pendingTruck) { pendingTruck = false; parkAt(here); return; }
    if (!truck) return;
    const tl = L.latLng(truck.lat, truck.lng), d = map.distance(here, tl);
    const part = d < 30 ? '🚙 at the truck' : `🚙 ${distWords(d)} ${bearingWord(here, tl)}`;
    readout.innerHTML = `<span class="ff-rt-truck">${part}</span> · ` + readout.innerHTML;
    // breadcrumb: only decent fixes, one point per ~15 m, capped
    const last = trail[trail.length - 1];
    if ((lastAcc === null || lastAcc <= 50) && (!last || map.distance(here, [last[0], last[1]]) >= 15)) {
      trail.push([+here.lat.toFixed(6), +here.lng.toFixed(6)]);
      if (trail.length > 6000) trail.splice(1, trail.length - 6000);
      if (trailLine) trailLine.addLatLng(here); else drawTruck();
      saveTrail();
    }
    if (truckMarker && truckMarker.isPopupOpen()) {
      const c = truckMarker.getPopup().getElement() && truckMarker.getPopup().getElement().querySelector('.ff-truck-pop span');
      if (c) c.textContent = `${distWords(d)} ${bearingWord(here, tl)} of you`;
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveTrail(false); });
  window.addEventListener('pagehide', () => saveTrail(false));
  drawTruck();

  /* ================================================ 17. SEARCH PIN (fine-tune + save) */
  // A temporary, draggable pin for a searched address/place/coordinates. Switch to
  // aerial to fine-tune, then "Save + label" stores it in the field log (offline).
  let tempPin = null, tempLabel = '', aerialBefore = null;
  const pinIcon = L.divIcon({ className: '', iconSize: [30, 40], iconAnchor: [15, 38], popupAnchor: [0, -34], html: '<div class="ff-spin"><i></i></div>' });
  function pinPopup() {
    const ll = tempPin.getLatLng(), aerial = currentBase === basemaps.imagery;
    return `<div class="pp ff-pop ff-pin-pop"><b>📍 ${html(tempLabel)}</b><br>
      <span style="opacity:.85">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</span><br>
      <small style="opacity:.75">Drag the pin to fine-tune${aerial ? '' : ' — aerial view helps'}. Not saved until you tap Save.</small>
      <div class="btns"><button type="button" onclick="ffPin('aerial')">${aerial ? 'Back to topo' : 'Aerial view'}</button>
      <button type="button" onclick="ffPin('save')">Save + label</button>
      <button type="button" onclick="ffPin('copy')">Copy coordinates</button>
      <button type="button" data-ff-route onclick="ffPin('route')">Route here</button>
      <button type="button" onclick="ffPin('clear')">Remove pin</button></div></div>`;
  }
  window.ffDropPin = (lat, lng, label) => {
    stopFollow(true);
    tempLabel = String(label || 'Searched spot').slice(0, 80);
    if (!tempPin) {
      tempPin = L.marker([lat, lng], { draggable: true, autoPan: true, zIndexOffset: 1500, icon: pinIcon, title: 'Drag to fine-tune' })
        .bindPopup(pinPopup, { maxWidth: 290 }).addTo(map);
      tempPin.on('click', () => { if (typeof suppressMapClick !== 'undefined') suppressMapClick = true; });
      tempPin.on('dragstart', () => tempPin.closePopup());
      tempPin.on('dragend', () => { if (typeof suppressMapClick !== 'undefined') suppressMapClick = true; tempPin.openPopup(); });
    } else tempPin.setLatLng([lat, lng]);
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
    setTimeout(() => tempPin && tempPin.openPopup(), 350);
  };
  function setBase(name) {
    const r = document.querySelector(`input[name="basemap"][value="${name}"]`); if (r) r.checked = true;
    if (typeof setBasemap === 'function') setBasemap(name);
  }
  window.ffPin = action => {
    if (!tempPin) return;
    if (action === 'aerial') {
      if (currentBase === basemaps.imagery) { setBase(aerialBefore || 'topo'); aerialBefore = null; }
      else {
        if (navigator.onLine === false) return toast('Aerial imagery needs internet', 2000);
        aerialBefore = currentBase === basemaps.streets ? 'streets' : 'topo'; setBase('imagery');
        if (map.getZoom() < 17) map.setView(tempPin.getLatLng(), 17);
      }
      tempPin.closePopup(); setTimeout(() => tempPin && tempPin.openPopup(), 250);
      return;
    }
    if (action === 'copy') { const ll = tempPin.getLatLng(); return window.copyText(`${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`); }
    if (action === 'route') { const ll = tempPin.getLatLng(); tempPin.closePopup(); return window.ffRouteTo(ll.lat, ll.lng, tempLabel); }
    if (action === 'save') {
      const ll = tempPin.getLatLng();
      window.ffLogAt(ll.lat, ll.lng);
      const ty = document.getElementById('ff-type'), lb = document.getElementById('ff-label');
      if (ty) ty.value = 'place';
      if (lb && !lb.value) lb.value = tempLabel;
      return;
    }
    if (action === 'clear') { map.removeLayer(tempPin); tempPin = null; if (aerialBefore) { setBase(aerialBefore); aerialBefore = null; } }
  };
  window.ffAfterLogSave = e => {
    if (!tempPin) return;
    const ll = tempPin.getLatLng();
    if (Math.abs(ll.lat - e.lat) < 1e-5 && Math.abs(ll.lng - e.lon) < 1e-5) {
      map.removeLayer(tempPin); tempPin = null;
      toast('Point saved — it stays on the map offline', 2200);
    }
  };

  /* ====================================== 18. FIELD DATA SAFETY + STATUS */
  // Every save above is already written to the phone at once (IndexedDB for the
  // log, notes, marks and saved points; localStorage for truck + trail). This adds:
  //  - a second on-phone safety copy (separate database), refreshed after changes,
  //    used to put things back automatically if the main copy comes up empty;
  //  - persistent-storage request, so the browser is less likely to clear data;
  //  - an off-phone backup file (share sheet → Files / iCloud / email) with a
  //    reminder when you are online and have changes that are not backed up;
  //  - a small status chip: field data saved? offline map ready?
  const META_KEY = 'ff_data_meta_v1';
  let meta = {}; try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (_) { meta = {}; }
  let saveOk = true, mirrorTimer = null, persisted = null;
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) {} }
  // What triggers the on-phone safety copy (it holds every photo, so rewriting it is costly):
  //   log entries  -> 1.2 s after the change
  //   deletes      -> immediately, so a deleted entry can never be "restored" from a stale copy
  //   truck, trail -> at most once every 5 minutes, plus when the app is hidden or closed
  const MIRROR_EVERY_MS = 5 * 60 * 1000;
  let mirrorDirty = false;
  function markChanged(kind, ok, opts) {
    saveOk = ok !== false;
    if (!saveOk) { updateDataStatus(); return; }
    if (kind === 'trail') {                                   // a breadcrumb every ~15 m: no status redraw, no mirror rewrite now
      if (opts && opts.dirty === false) return;
      mirrorDirty = true; scheduleMirror(MIRROR_EVERY_MS); return;
    }
    meta.lastSave = Date.now();
    meta.pending = (meta.pending || 0) + 1;
    saveMeta();
    mirrorDirty = true;
    if (opts && opts.now) { clearTimeout(mirrorTimer); mirrorTimer = null; writeMirror(); }
    else if (kind === 'truck') scheduleMirror(MIRROR_EVERY_MS);
    else { clearTimeout(mirrorTimer); mirrorTimer = setTimeout(writeMirror, 1200); }
    updateDataStatus();
  }
  // run the mirror write no sooner than `gap` ms after the previous one
  function scheduleMirror(gap) {
    if (mirrorTimer) return;                                  // one is already waiting (log changes use a shorter one)
    const wait = Math.max(1200, (meta.lastMirror || 0) + gap - Date.now());
    mirrorTimer = setTimeout(writeMirror, wait);
  }
  function flushMirror() { if (mirrorDirty) { clearTimeout(mirrorTimer); mirrorTimer = null; writeMirror(); } }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushMirror(); });
  window.addEventListener('pagehide', flushMirror);
  const MIRROR_DB = 'mineral_maps_field_mirror_v1';
  function mirrorDB() {
    return new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('no IndexedDB'));
      const r = indexedDB.open(MIRROR_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('snap');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function snapshot() {
    let t = null, tr = []; try { t = JSON.parse(localStorage.getItem('ff_truck_v1') || 'null'); tr = JSON.parse(localStorage.getItem('ff_trail_v1') || '[]'); } catch (_) {}
    return { format: 'mineral-maps-field-backup', version: 2, exported_at: new Date().toISOString(), entries: await allEntries(), truck: t, trail: tr };
  }
  async function writeMirror() {
    mirrorTimer = null; mirrorDirty = false;
    try {
      const snap = await snapshot(), d = await mirrorDB();
      await new Promise((res, rej) => { const tx = d.transaction('snap', 'readwrite'); tx.objectStore('snap').put(snap, 'latest');
        tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
      meta.lastMirror = Date.now(); meta.mirrorCount = snap.entries.length; saveMeta();
    } catch (_) { meta.lastMirror = null; saveMeta(); }
    updateDataStatus();
  }
  async function readMirror() {
    try { const d = await mirrorDB();
      return await new Promise(res => { const q = d.transaction('snap').objectStore('snap').get('latest'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
    } catch (_) { return null; }
  }
  // startup check: if the main log is empty but the safety copy is not, put it back
  (async () => {
    const [cur, snap] = await Promise.all([allEntries(), readMirror()]);
    if (snap && Array.isArray(snap.entries) && snap.entries.length && !cur.length) {
      let n = 0; for (const e of snap.entries) if (await putEntry(e)) n++;
      await drawLog();
      toast(`Field log put back from the on-phone safety copy (${n} entries)`, 3200);
    }
    if (snap && (snap.truck || (snap.trail && snap.trail.length)) && window.ffTruckRestore) window.ffTruckRestore(snap.truck, snap.trail);
    if (!snap && (cur.length || localStorage.getItem('ff_truck_v1'))) writeMirror();        // first run of this version
    if (navigator.storage && navigator.storage.persist) {
      try { persisted = await navigator.storage.persisted(); if (!persisted && (cur.length || localStorage.getItem('ff_truck_v1'))) persisted = await navigator.storage.persist(); } catch (_) {}
    }
    updateDataStatus();
  })();

  async function backupOffPhone() {
    const snap = await snapshot();
    const name = `mineral-maps-field-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    const text = JSON.stringify(snap);
    let done = false;
    try {
      const file = new File([text], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Mineral Maps field backup' });   // Save to Files / iCloud Drive / email
        done = true;
      }
    } catch (e) { if (e && e.name === 'AbortError') { toast('Backup cancelled', 1400); return; } }
    if (!done) { download(name, text, 'application/json'); done = true; }
    meta.lastBackup = Date.now(); meta.pending = 0; saveMeta(); updateDataStatus();
    toast(`Backed up ${snap.entries.length} entr${snap.entries.length === 1 ? 'y' : 'ies'}${snap.truck ? ', truck' : ''} and photos`, 2400);
  }

  // status chip in the top bar + details in Map settings
  const chip = document.createElement('button');
  chip.type = 'button'; chip.id = 'ff-status'; chip.setAttribute('aria-label', 'Field data and offline map status');
  const menuBtnEl = document.getElementById('menu-btn');
  if (menuBtnEl && menuBtnEl.parentNode) menuBtnEl.parentNode.insertBefore(chip, menuBtnEl);
  const dataSec = document.createElement('section');
  dataSec.className = 'panel-section'; dataSec.id = 'ff-data-sec';
  dataSec.innerHTML = `<h2>Field data</h2><div id="ff-data-status" class="status-box">Checking…</div>
    <button id="ff-data-backup" class="wide-btn" type="button">Back up field data off this phone</button>
    <p class="muted small">Notes, target marks, saved points, photos, truck spot and trail save on this phone the moment you make them and work with no signal. A second safety copy is kept on the phone too. This app has no account or cloud server, so the off-phone copy is a backup file: on iPhone choose “Save to Files” (iCloud Drive) or email it. Restore it from ✎ Log → Restore backup.</p>`;
  const offSec = document.getElementById('dl-btn') && document.getElementById('dl-btn').closest('.panel-section');
  if (offSec) offSec.insertAdjacentElement('afterend', dataSec);
  document.getElementById('ff-data-backup').addEventListener('click', () => backupOffPhone());
  chip.addEventListener('click', () => {
    if (typeof setSheet === 'function') setSheet(false);
    if (typeof setPanel === 'function') setPanel(true);
    setTimeout(() => dataSec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 260);
  });
  const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
  let nagged = false;
  async function updateDataStatus() {
    let om = null; try { om = JSON.parse(localStorage.getItem('kyOffline') || 'null'); } catch (_) {}
    const mapReady = !!(om && om.verified && om.app !== undefined);
    let roads = false; try { roads = window.FFRoads ? (await window.FFRoads.status()).ready : false; } catch (_) {}
    const pending = meta.pending || 0, online = navigator.onLine !== false;
    chip.className = '';
    chip.innerHTML = `<span class="${saveOk ? 'ok' : 'bad'}">${saveOk ? '✓ Data saved' : '! Not saved'}</span>` +
      `<span class="${mapReady ? 'ok' : 'warn'}">${mapReady ? (roads ? '✓ Map ready' : '✓ Map · no roads') : '○ Map not saved'}</span>` +
      (online && pending && saveOk ? '<i class="ff-status-dot" title="Changes not backed up off the phone"></i>' : '');
    const box = document.getElementById('ff-data-status'); if (!box) return;
    const list = logCache || [];
    const marks = list.filter(e => e.target_status).length, places = list.filter(e => e.type === 'place').length;
    const photos = list.filter(e => e.photo).length;
    let tk = null, trn = 0; try { tk = JSON.parse(localStorage.getItem('ff_truck_v1') || 'null'); trn = (JSON.parse(localStorage.getItem('ff_trail_v1') || '[]') || []).length; } catch (_) {}
    box.className = 'status-box ' + (!saveOk ? 'warn' : pending && meta.lastBackup ? '' : 'ok');
    box.innerHTML = (saveOk ? '<b>FIELD DATA SAVED ON THIS PHONE</b>' : '<b>LAST SAVE FAILED</b> — phone storage may be full. Back up, then delete some photos.') +
      `<br>${list.length - marks} log entr${list.length - marks === 1 ? 'y' : 'ies'} (${places} saved place${places === 1 ? '' : 's'}, ${photos} photo${photos === 1 ? '' : 's'}) · ${marks} target mark${marks === 1 ? '' : 's'} · truck ${tk ? 'saved' : 'not set'}${trn > 1 ? ` · trail ${trn} pts` : ''}` +
      `<br>Last saved: ${ago(meta.lastSave)} · safety copy: ${meta.lastMirror ? ago(meta.lastMirror) : 'not yet'}` +
      `<br>Storage protection: ${persisted === true ? 'on' : persisted === false ? 'not granted by the browser (on iPhone, use the Home Screen app)' : 'checking'}` +
      `<br>Off-phone backup: ${meta.lastBackup ? ago(meta.lastBackup) : 'never'}${pending ? ` · ${pending} change${pending === 1 ? '' : 's'} since` : ' · up to date'}` +
      `<br>Offline map: ${mapReady ? 'ready' : 'not fully saved — use Download above'}${roads ? ' · roads saved' : ' · roads not saved'}`;
    // online with un-backed-up changes: one gentle reminder per session
    if (online && saveOk && pending >= 3 && !nagged && (!meta.lastBackup || Date.now() - meta.lastBackup > 6 * 3600 * 1000)) {
      nagged = true; setTimeout(() => toast('You have signal — tap “Data saved” at the top to back up field data off the phone', 4200), 1500);
    }
  }
  window.addEventListener('online', updateDataStatus);
  window.addEventListener('offline', updateDataStatus);
  window.addEventListener('storage', updateDataStatus);
  if (typeof MutationObserver === 'function') {
    const st = document.getElementById('offline-status'), rs = document.getElementById('ff-road-status');
    [st, rs].forEach(el => el && new MutationObserver(() => { clearTimeout(updateDataStatus.t); updateDataStatus.t = setTimeout(updateDataStatus, 400); })
      .observe(el, { childList: true, characterData: true, subtree: true }));
  }
  setInterval(updateDataStatus, 60000);
  updateDataStatus();

  // restore a saved route when the app opens
  try { const saved = JSON.parse(localStorage.getItem(ROUTE_KEY) || 'null'); if (saved) { route = { ...saved, offline: !!saved.coords }; drawRoute(); } } catch (_) {}

  drawLog();
})();
