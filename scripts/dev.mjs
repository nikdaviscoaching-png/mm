import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,createReadStream,createWriteStream,readdirSync,statSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fetchApp} from '../cloud/router.js';
const root=resolve(process.env.MM_DEV_DATA||'../../work/hosted-preview');mkdirSync(root,{recursive:true});
const py=`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
q=json.load(sys.stdin);out=[]
try:
 for s in q:
  if 'script' in s:c.executescript(s['script']);out.append({});continue
  r=c.execute(s['sql'],s['args']);rows=[dict(x) for x in r.fetchall()];out.append({'results':rows,'meta':{'changes':c.execute('SELECT changes()').fetchone()[0]}})
 c.commit();print(json.dumps(out))
except:c.rollback();raise
`;
function execute(q){const r=spawnSync(process.env.MM_PYTHON||'python3',['-c',py,join(root,'inventory.sqlite3')],{input:JSON.stringify(q),encoding:'utf8'});if(r.status)throw Error(r.stderr);return JSON.parse(r.stdout);}
class Query{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Query(this.sql,args);}async run(){return execute([this])[0];}async all(){return this.run();}async first(){return (await this.run()).results[0]||null;}}
for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())execute([{script:readFileSync('drizzle/'+f,'utf8')}]);
const objectPath=key=>{const p=resolve(root,'objects',key);if(!p.startsWith(resolve(root,'objects')+'/'))throw Error('Invalid object key');return p;};
const bucket={async put(key,body,options={}){const p=objectPath(key);mkdirSync(dirname(p),{recursive:true});if(body?.getReader)await pipeline(Readable.fromWeb(body),createWriteStream(p));else writeFileSync(p,body instanceof ArrayBuffer?Buffer.from(body):body);writeFileSync(p+'.metadata.json',JSON.stringify(options.httpMetadata||{}));return {key,size:statSync(p).size};},async get(key,opts={}){const p=objectPath(key);if(!existsSync(p))return null;const size=statSync(p).size,meta=existsSync(p+'.metadata.json')?JSON.parse(readFileSync(p+'.metadata.json')):{};let start=0,end=size-1,range=null;const header=opts.range?.get?.('range');if(header){const match=header.match(/bytes=(\d+)-(\d*)/);if(match){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;range={offset:start,length:end-start+1};}}return {size,httpEtag:'"'+size+'-'+statSync(p).mtimeMs+'"',httpMetadata:meta,range,body:Readable.toWeb(createReadStream(p,{start,end})),arrayBuffer:async()=>readFileSync(p),writeHttpMetadata(h){h.set('Content-Type',meta.contentType||'application/octet-stream');}};},async createMultipartUpload(key,options){const id=crypto.randomUUID();const p=join(root,'multipart',id);mkdirSync(p,{recursive:true});writeFileSync(p+'/meta',JSON.stringify({key,options}));return {uploadId:id};},resumeMultipartUpload(key,id){const p=join(root,'multipart',id);return {async uploadPart(n,body){const target=p+'/'+n;await pipeline(Readable.fromWeb(body),createWriteStream(target));return {partNumber:n,etag:'part-'+n};},async complete(parts){const meta=JSON.parse(readFileSync(p+'/meta'));async function* chunks(){for(const part of parts)yield readFileSync(p+'/'+part.partNumber);}return bucket.put(key,Readable.toWeb(Readable.from(chunks())),meta.options);}};}};
const env={STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET:process.env.STRIPE_WEBHOOK_SECRET,DB:{prepare:sql=>new Query(sql),batch:async q=>execute(q)},BUCKET:bucket,MM_OWNER_CLAIM:'true',MM_WORKER_TOKEN:'local-preview-worker-only-token-0123456789',MM_MAINTENANCE_TOKEN:'local-preview-maintenance-only-token',MM_SECRET_KEY:'local-preview-encryption-only-not-production'};
const legacy=resolve('../Mineral-Murals/photos'),brand=resolve('source-public/assets/brand'),full=resolve('../../work/brand-full-resolution-assets');
const origin='http://127.0.0.1:8791';
// Seed preview only from the preserved archive; real hosted data is separate.
if(!execute([{sql:"SELECT key FROM config WHERE key='seed_imported'",args:[]}])[0].results.length){const pySeed=`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
print(json.dumps({'items':[json.loads(r['data']) for r in c.execute('select data from items')],'storefront':json.loads(c.execute("select value from config where key='storefront'").fetchone()[0])}))`;
 const r=spawnSync('python3',['-c',pySeed,resolve('../Mineral-Murals/.seller-data/inventory.sqlite3')],{encoding:'utf8'});if(!r.status){await fetchApp(new Request(origin+'/api/maintenance/seed',{method:'POST',headers:{Authorization:'Bearer '+env.MM_MAINTENANCE_TOKEN,'Content-Type':'application/json'},body:r.stdout}),env,{});}}
http.createServer(async(req,res)=>{try{const u=new URL(req.url,origin),p=decodeURIComponent(u.pathname);let disk;if(p.startsWith('/assets/brand/'))disk=resolve(brand,p.slice(14));else if(p.startsWith('/brand/'))disk=resolve(full,p.slice(7));else if(p.startsWith('/photos/'))disk=resolve(legacy,p.slice(8));if(disk&&existsSync(disk)){res.setHeader('Content-Type',p.endsWith('.webp')?'image/webp':p.endsWith('.png')?'image/png':'image/jpeg');createReadStream(disk).pipe(res);return;}const h=new Headers(req.headers);if(!h.has('Authorization')&&!h.has('X-Test-Anonymous'))h.set('oai-authenticated-user-id','local-preview-owner');const request=new Request(u,{method:req.method,headers:h,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const response=await fetchApp(request,env,{waitUntil:p=>p.catch(()=>{})});res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();}catch(e){console.error(e.message);res.writeHead(500);res.end('Preview request failed');}}).listen(8791,'127.0.0.1',()=>console.log(origin));
