// Runs actual schema/SQLite statements through Python; no marketplace or cloud writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleCore} from './core.js';
import {saveItem,claim,assertLease,validPhotos,config,stmt} from './store.js';
const folder=mkdtempSync(join(tmpdir(),'mm-cloud-tests-')), db=join(folder,'test.sqlite3');
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
const env={MM_OWNER_CLAIM:'true',DB:{prepare:sql=>new Query(sql),batch:async q=>execute(q)},MM_WORKER_TOKEN:'private-test-token-01234567890123456789',BUCKET:{put:async()=>{},get:async()=>null}};
execute([{script:readFileSync(new URL('../drizzle/0000_initial.sql',import.meta.url),'utf8')}]);
const request=(path,body,who='owner',headers={})=>new Request('https://hub.example'+path,{method:body===undefined?'GET':'POST',headers:{...(who?{'oai-authenticated-user-id':who}:{}),...(body?{'Content-Type':'application/json','Origin':'https://hub.example'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const call=(path,b,who,headers)=>handleCore(request(path,b,who,headers),env,{});
const workerHeaders={'Authorization':'Bearer '+env.MM_WORKER_TOKEN};
test('anonymous seller access is rejected',async()=>{assert.equal((await call('/api/seller/items',undefined,null)).status,401);});
test('hosted owner claims session; a different account cannot edit',async()=>{assert.equal((await call('/api/seller/session')).status,200);assert.equal(await config(env,'owner'),'owner');assert.equal((await call('/api/seller/items',undefined,'intruder')).status,403);});
test('cross-origin mutations rejected',async()=>{const r=await call('/api/seller/settings',{},'owner',{'Origin':'https://attacker.example'});assert.equal(r.status,403);});
test('typed draft creation is deterministic by saved capture',async()=>{const b={capture_id:'test-capture',transcript:'Material: agate. Price: 45 dollars. Condition: small chip.',photos:[]};const a=await(await call('/api/seller/generate',b)).json(),c=await(await call('/api/seller/generate',b)).json();assert.equal(a.id,c.id);assert.equal(a.price_cents,4500);assert.equal(a.status,'draft');});
test('optimistic version rejects stale concurrent editor',async()=>{const r=await saveItem(env,{id:'cas',status:'draft',photos:[],material:'agate'});const newer=await saveItem(env,{...r,title:'First'},r.version);await assert.rejects(saveItem(env,{...r,title:'Old'},r.version),/changed/);assert.equal(newer.version,2);});
test('sold records cannot be edited',async()=>{await saveItem(env,{id:'sold',status:'sold',photos:[]});await assert.rejects(saveItem(env,{id:'sold',status:'draft'},1),/sold/);});
test('private original cannot masquerade as public display',async()=>{await stmt(env,'INSERT INTO media VALUES(?,?,?)','private/a.arw',JSON.stringify({role:'original'}),Date.now()).run();await assert.rejects(validPhotos(env,[{src:'/media/private/a.arw'}]),/display/);const p=await validPhotos(env,[{src:'/assets/conversion-needed.svg',original:'/media/private/a.arw'}]);assert.equal(p[0].preview_only,true);});
test('approve refuses pending conversion even when client marks reviewed',async()=>{await saveItem(env,{id:'pending',status:'draft',reviewed:true,stock_verified:true,material:'agate',price_cents:1000,photos:[{src:'/assets/conversion-needed.svg',preview_only:true}]});const response=await call('/api/seller/approve-batch',{ids:['pending']});assert.equal(response.status,400);});
test('uploaded recordings queue online without Mac present',async()=>{await stmt(env,'INSERT INTO media VALUES(?,?,?)','private/movie.mov',JSON.stringify({role:'original'}),Date.now()).run();const response=await call('/api/seller/jobs',{kind:'video',media:'/media/private/movie.mov'});const j=await response.json();assert.equal(response.status,202);assert.equal(j.status,'waiting_worker');});
test('worker bearer required and lease token rotates after expiry',async()=>{assert.equal((await call('/api/worker/claim',{worker_id:'mac'},null)).status,401);const response=await call('/api/worker/claim',{worker_id:'mac'},null,workerHeaders),{job}=await response.json();assert.ok(job.lease_token);await assert.rejects(assertLease(env,job.id,'mac','incorrect'),/lease changed/);await stmt(env,'UPDATE jobs SET lease_until=? WHERE id=?',Date.now()-1,job.id).run();const next=await claim(env,'mac');assert.notEqual(next.lease_token,job.lease_token);await assert.rejects(assertLease(env,job.id,'mac',job.lease_token),/lease changed/);});
test('only published records reach public catalog',async()=>{const r=await call('/api/catalog',undefined,null);const catalog=await r.json();assert.ok(!catalog.listings.some(r=>r.id==='cas'));assert.ok(catalog.listings.some(r=>r.id==='sold'));assert.equal(catalog.checkout,false);});
test('SQL schema includes durable jobs/media and unique item identities',async()=>{const names=(await stmt(env,"SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(r=>r.name);for(const name of ['items','jobs','media','captures','uploads','holds'])assert.ok(names.includes(name));});
process.on('exit',()=>rmSync(folder,{recursive:true,force:true}));
