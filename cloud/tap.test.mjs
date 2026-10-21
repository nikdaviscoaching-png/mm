// Tap & list batches: real SQLite through Python, no cloud writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleCore} from './core.js';
import {stmt,publicCatalog,item} from './store.js';
const db=join(mkdtempSync(join(tmpdir(),'mm-tap-tests-')),'test.sqlite3');
const py=`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
q=json.load(sys.stdin);out=[]
try:
 for s in q:
  if 'script' in s:c.executescript(s['script']);out.append({});continue
  r=c.execute(s['sql'],s['args']);rows=[dict(x) for x in r.fetchall()];out.append({'results':rows,'meta':{'changes':c.execute('SELECT changes()').fetchone()[0]}})
 c.commit();print(json.dumps(out))
except: c.rollback();raise
`;
function execute(q){const r=spawnSync('python3',['-c',py,db],{input:JSON.stringify(q),encoding:'utf8'});if(r.status)throw Error(r.stderr);return JSON.parse(r.stdout);}
class Query{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Query(this.sql,args);}async run(){return execute([this])[0];}async all(){return this.run();}async first(){return (await this.run()).results[0]||null;}}
const env={MM_OWNER_CLAIM:'true',DB:{prepare:sql=>new Query(sql),batch:async q=>execute(q)},BUCKET:{put:async()=>{},get:async()=>null}};
for(const f of ['0000_initial.sql','0001_marketplace_tables.sql','0002_payments.sql'])execute([{script:readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8')}]);
const call=(path,body)=>handleCore(new Request('https://hub.example'+path,{method:'POST',headers:{'oai-authenticated-user-id':'owner','Content-Type':'application/json','Origin':'https://hub.example'},body:JSON.stringify(body)}),env,{});
const media=(key,data)=>stmt(env,'INSERT INTO media(key,data,created) VALUES(?,?,?)',key,JSON.stringify(data),Date.now()).run();
await media('tray/v.mp4',{role:'clip',content_type:'video/mp4',name:'v.mp4'});
await media('tray/r1.jpg',{role:'display',content_type:'image/jpeg',original:'/media/tray/v.mp4',w:400,h:400});
await media('tray/orig.mov',{role:'original',content_type:'video/quicktime',name:'orig.mov'});
const photo={src:'/media/tray/r1.jpg',original:'/media/tray/v.mp4'};

test('tap batch creates one draft per marked rock with its own video slice',async()=>{
 const r=await call('/api/seller/tap-batch',{media:'/media/tray/v.mp4',segments:[{start:0,end:6.2,photos:[photo],price_cents:4500,material:'Kentucky agate',note:'Small chip on the back.'},{start:6.2,end:11,photos:[photo],price_cents:null,material:'',note:''}]});
 assert.equal(r.status,200);const out=await r.json();assert.equal(out.item_ids.length,2);
 const a=await item(env,out.item_ids[0]),b=await item(env,out.item_ids[1]);
 assert.equal(a.status,'draft');assert.equal(a.price_cents,4500);assert.equal(a.material,'Kentucky agate');assert.match(a.condition,/chip/i);
 assert.deepEqual([a.video.start,a.video.end,a.video.clip,a.video.job_id],[0,6.2,'/media/tray/v.mp4',out.batch]);
 assert.equal(b.video.start,6.2);assert.equal(b.price_cents,null);assert.ok(b.warnings.some(w=>/price/i.test(w)));
 assert.ok(a.listings.etsy.why.length>2&&a.listings.ebay.why.some(w=>/80 characters/.test(w)));
});
test('tap batch refuses private originals, bad ranges and bad prices',async()=>{
 assert.equal((await call('/api/seller/tap-batch',{media:'/media/tray/orig.mov',segments:[{start:0,end:3,photos:[photo]}]})).status,400);
 assert.equal((await call('/api/seller/tap-batch',{media:'/media/tray/v.mp4',segments:[{start:5,end:5,photos:[photo]}]})).status,400);
 assert.equal((await call('/api/seller/tap-batch',{media:'/media/tray/v.mp4',segments:[{start:0,end:4,photos:[photo],price_cents:-3}]})).status,400);
});
test('published tap pieces expose their batch to the storefront scrubber',async()=>{
 const out=await(await call('/api/seller/tap-batch',{media:'/media/tray/v.mp4',segments:[{start:1,end:4,photos:[photo],price_cents:1000,material:'Geode'}]})).json();
 await stmt(env,"UPDATE items SET data=json_set(data,'$.status','published') WHERE id=?",out.item_ids[0]).run();
 const listing=(await publicCatalog(env)).listings.find(l=>l.id===out.item_ids[0]);
 assert.deepEqual(listing.video,{clip:'/media/tray/v.mp4',start:1,end:4,batch:out.batch,index:1});
});
