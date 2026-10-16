// boot.js — two safety nets that must work even when app.js cannot.
// 1) If the app module has not started within 8 s (blocked script, broken cache), offer a reload.
// 2) Self-heal after an upgrade: if the page is newer than the scripts it got (e.g. the HTML of a new release with the scripts an older installed
//    version cached), clear the old service worker and caches once and reload.
(function () {
  setTimeout(function () { if (!window.__stackerReady) { var b = document.getElementById('boot-fail'); if (b) b.hidden = false; } }, 8000);
  var meta = document.querySelector('meta[name="stacker-version"]'), want = meta && meta.content;
  function heal() {
    if (!want || window.__stackerVersion === want) return;
    try { if (sessionStorage.getItem('stacker.heal')) return; sessionStorage.setItem('stacker.heal', '1'); } catch (e) { return; }
    var regs = navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }) : Promise.resolve();
    regs.then(function () { return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : null; }).then(function () { location.reload(); });
  }
  window.addEventListener('load', function () { setTimeout(heal, 500); });
})();
