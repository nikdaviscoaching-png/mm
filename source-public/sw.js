/* Static app shell only. Inventory, authentication, private derivatives and media
   always use the network. Logging out must never reveal cached owner content. */
const V='mm-final-shell-v3';
const STATIC=['/','/index.html','/shop.html','/about.html','/contact.html','/cart.html','/museum.html','/assets/site.css','/assets/site.js','/assets/logo-mark.png','/assets/icon-192.png','/assets/offline.html','/manifest.webmanifest','/seller/app.js','/seller/style.css','/seller/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>Promise.all(STATIC.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 const req=e.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==location.origin)return;
 const privateImage=url.pathname==='/_vercel/image'&&(url.searchParams.get('url')||'').startsWith('/media/');
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/')||url.pathname.startsWith('/admin')||privateImage||url.pathname==='/sw.js')return;
 if(url.pathname==='/seller'||url.pathname==='/seller/'){
  e.respondWith(fetch(req).catch(async()=>await caches.match('/assets/offline.html')||Response.error()));return;
 }
 const cacheable=STATIC.includes(url.pathname)||url.pathname.startsWith('/photos/');
 if(!cacheable){if(req.mode==='navigate')e.respondWith(fetch(req).catch(async()=>await caches.match('/assets/offline.html')||Response.error()));return}
 e.respondWith(fetch(req).then(r=>{if(r.ok){const copy=r.clone();caches.open(V).then(c=>c.put(req,copy))}return r}).catch(async()=>await caches.match(req)||await caches.match('/assets/offline.html')||Response.error()));
});
