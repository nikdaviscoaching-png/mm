// Owner-private migration only. Read both bearer tokens from hidden stdin, never arguments/files.
import {createInterface} from 'node:readline';
import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('Ready for private migration JSON on stdin (input is hidden).');
const rl=createInterface({input:process.stdin,terminal:false});
const input=await new Promise(resolve=>rl.once('line',resolve));rl.close();process.stdin.pause();
const {origin,dispatchToken,maintenanceToken,finalizeOnly=false}=JSON.parse(input);
if(!origin?.startsWith('https://')||!dispatchToken||!maintenanceToken)throw Error('Private host credentials are required.');
const headers={'OAI-Sites-Authorization':'Bearer '+dispatchToken,Authorization:'Bearer '+maintenanceToken};
async function request(endpoint,options={}){const response=await fetch(origin+endpoint,{redirect:'error',signal:AbortSignal.timeout(60000),...options,headers:{...headers,...options.headers}});if(!response.ok)throw Error('Migration endpoint returned '+response.status);return response.json();}
if(finalizeOnly){console.log(JSON.stringify(await request('/api/maintenance/finalize',{method:'POST'})));process.exit(0);}
const status=await request('/api/maintenance/status');console.log(JSON.stringify({before:status}));
const groups=[{dir:'source-public/assets/brand',prefix:'/assets/brand/'},{dir:'../../work/brand-full-resolution-assets',prefix:'/brand/'},{dir:'../Mineral-Murals/photos',prefix:'/photos/'}];
let count=0,bytes=0;
for(const group of groups){const queue=[];async function scan(dir,prefix=''){for(const f of await readdir(dir,{withFileTypes:true})){const rel=prefix+f.name;if(f.isDirectory())await scan(path.join(dir,f.name),rel+'/');else if(/\.(png|webp|jpe?g)$/i.test(f.name))queue.push(rel);}}await scan(group.dir);let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<queue.length){const name=queue[cursor++],data=await readFile(path.join(group.dir,name));await request('/api/maintenance/asset?'+new URLSearchParams({path:group.prefix+name}),{method:'PUT',headers:{'Content-Type':name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'image/jpeg'},body:data});count++;bytes+=data.length;if(count%50===0)console.log(JSON.stringify({uploaded:count,bytes}));}}));}
const py=`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
settings={r['key']:json.loads(r['value']) for r in c.execute("select key,value from config where key in ('storefront','ai')")}
print(json.dumps({'items':[json.loads(r['data']) for r in c.execute('select data from items')],'storefront':settings.get('storefront',{}),'ai':settings.get('ai',{})}))`;
const source=spawnSync('python3',['-c',py,path.resolve('../Mineral-Murals/.seller-data/inventory.sqlite3')],{encoding:'utf8',maxBuffer:10000000});if(source.status)throw Error('Could not read preserved inventory.');
const seed=await request('/api/maintenance/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:source.stdout});console.log(JSON.stringify({uploaded:count,bytes,seed,after:await request('/api/maintenance/status')}));
