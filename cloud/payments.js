import {APIError,json,now,uid,stmt,config,setConfig,owner,item,requireReady} from './store.js';
import {getSecret,putSecret} from './marketplaces.js';

// Prices and stock always come from D1. The browser never decides what was paid.
const enc=new TextEncoder();
const money=n=>(n/100).toFixed(2);
const terminal=['paid','test_paid','conflict','expired','failed'];
const fields=['mode','shipping_cents','shipping_label','countries','shipping_reviewed','tax_reviewed'];
async function settings(env){return {mode:'test',shipping_cents:null,shipping_label:'Tracked shipping',countries:['US'],shipping_reviewed:false,tax_reviewed:false,...await config(env,'payments',{})};}
async function credentials(env,p){const saved=await getSecret(env,'payments_'+p);return p==='stripe'?{secret_key:env.STRIPE_SECRET_KEY||saved.secret_key,webhook_secret:env.STRIPE_WEBHOOK_SECRET||saved.webhook_secret}:{client_id:env.PAYPAL_CLIENT_ID||saved.client_id,client_secret:env.PAYPAL_CLIENT_SECRET||saved.client_secret};}
function live(s){return s.mode==='live';}
function sameOrigin(req){if(req.headers.get('Origin')&&req.headers.get('Origin')!==new URL(req.url).origin||req.headers.get('Sec-Fetch-Site')==='cross-site')throw new APIError('Open checkout on this website.',403);}
async function body(req){if(Number(req.headers.get('Content-Length')||0)>25000)throw new APIError('Request too large.',413);const text=await req.text();if(text.length>25000)throw new APIError('Request too large.',413);try{return JSON.parse(text);}catch{throw new APIError('Send a JSON request.');}}
async function row(env,id){const r=await stmt(env,'SELECT data FROM payment_sessions WHERE id=?',id).first();if(!r)throw new APIError('Checkout not found.',404);return JSON.parse(r.data);}
async function update(env,s,expected){const r=await stmt(env,'UPDATE payment_sessions SET data=?,state=? WHERE id=? AND state=?',JSON.stringify(s),s.state,s.id,expected).run();if(!r.meta.changes)throw new APIError('This payment is being updated. Please check its status.',409);return s;}
function checkoutURL(s,origin){return origin+'/thanks.html?order='+encodeURIComponent(s.id)+'&token='+s.token;}
function receipt(s){return {id:s.id,provider:s.provider,paid:['paid','test_paid'].includes(s.state),test:!s.live,state:s.state,items:s.lines.map(l=>l.title),item_ids:s.lines.map(l=>l.id),total:s.total_cents,url:s.url||null,provider_order_id:s.remote_id||null,token:s.token};}

export async function paymentStatus(env,privateView=false){
 const s=await settings(env),missing=[];if(s.shipping_reviewed!==true||!Number.isSafeInteger(s.shipping_cents)||s.shipping_cents<0)missing.push('Confirm your shipping rate');if(s.tax_reviewed!==true)missing.push('Review sales tax settings');if(live(s)&&env.MM_PAYMENTS_LIVE!=='true')missing.push('Enable live payments on the host after testing');
 let stripe={},paypal={};try{stripe=await credentials(env,'stripe');paypal=await credentials(env,'paypal');}catch{missing.push('Configure private payment storage');}
 const keyOK=typeof stripe.secret_key==='string'&&stripe.secret_key.startsWith(live(s)?'sk_live_':'sk_test_');
 const common=!missing.length;
 const out={provider:'stripe',mode:s.mode,enabled:common&&keyOK&&!!stripe.webhook_secret,stripe:common&&keyOK&&!!stripe.webhook_secret,paypal:common&&!!paypal.client_id&&!!paypal.client_secret,paypal_client_id:common&&paypal.client_id&&paypal.client_secret?paypal.client_id:null,shipping_cents:s.shipping_cents,shipping_label:s.shipping_label,countries:s.countries,wallet_notice:'Available wallets appear automatically for your device and account. No store account required.'};
 if(privateView)Object.assign(out,{settings:s,missing,stripe_configured:keyOK,webhook_configured:!!stripe.webhook_secret,paypal_configured:!!paypal.client_id&&!!paypal.client_secret,live_host_enabled:env.MM_PAYMENTS_LIVE==='true',setup_url:'https://dashboard.stripe.com/apikeys',paypal_setup_url:'https://developer.paypal.com/dashboard/applications',note:'Stripe handles cards and eligible wallets. Separate PayPal credentials enable PayPal and eligible US Venmo. Test payments never mark real specimens sold.'});
 return out;
}
async function stripeRequest(env,s,path,method='GET',params=null,key=null){
 const c=await credentials(env,'stripe');const response=await fetch('https://api.stripe.com/v1/'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+c.secret_key,'Stripe-Version':'2025-02-24.acacia',...(params?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},...(params?{body:params}:{})});
 const data=await response.json();if(!response.ok)throw new APIError('Stripe could not open this payment. Your basket is saved. Please try again or contact the seller.',502);return data;
}
async function paypalRequest(env,s,path,method='GET',data=null,key=null){
 const c=await credentials(env,'paypal'),base='https://api-m'+(s.live?'':'.sandbox')+'.paypal.com';
 const auth=await fetch(base+'/v1/oauth2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Basic '+btoa(c.client_id+':'+c.client_secret),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});const token=await auth.json();if(!auth.ok||!token.access_token)throw new APIError('PayPal is temporarily unavailable. Choose card or a wallet instead.',502);
 const response=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json',Prefer:'return=representation',...(key?{'PayPal-Request-Id':key}:{})},...(data?{body:JSON.stringify(data)}:{})});const result=await response.json();if(!response.ok)throw new APIError('PayPal could not complete this request. Check payment status before trying again.',502);return result;
}
async function openRemote(env,s,origin){
 if(s.provider==='stripe'){
  const p=new URLSearchParams({mode:'payment',success_url:checkoutURL(s,origin),cancel_url:origin+'/checkout.html?'+new URLSearchParams({ids:s.lines.map(l=>l.id).join(','),order:s.id,token:s.token,canceled:'1'}),client_reference_id:s.id,'metadata[mm_order]':s.id,'metadata[mm_live]':String(s.live),billing_address_collection:'auto',expires_at:String(s.expires),'custom_text[submit][message]':'You receive the exact specimen photographed. Thank you for supporting Mineral Murals.'});
  // Omit payment_method_types: Stripe selects eligible enabled methods, including wallets.
  s.lines.forEach((l,i)=>{p.set(`line_items[${i}][price_data][currency]`,'usd');p.set(`line_items[${i}][price_data][unit_amount]`,String(l.price_cents));p.set(`line_items[${i}][price_data][product_data][name]`,l.title);p.set(`line_items[${i}][quantity]`,'1');});
  s.countries.forEach((country,i)=>p.set(`shipping_address_collection[allowed_countries][${i}]`,country));
  p.set('shipping_options[0][shipping_rate_data][type]','fixed_amount');p.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]',String(s.shipping_cents));p.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]','usd');p.set('shipping_options[0][shipping_rate_data][display_name]',s.shipping_label);
  const remote=await stripeRequest(env,s,'checkout/sessions','POST',p,s.id);
  if(!remote.id||!remote.url||new URL(remote.url).origin!=='https://checkout.stripe.com'||Boolean(remote.livemode)!==s.live)throw new APIError('Stripe checkout needs review. Please contact the seller.',502);
  return {...s,state:'open',remote_id:remote.id,url:remote.url};
 }
 const remote=await paypalRequest(env,s,'/v2/checkout/orders','POST',{intent:'CAPTURE',purchase_units:[{reference_id:s.id,custom_id:s.id,description:'Mineral Murals · one-of-one specimens',amount:{currency_code:'USD',value:money(s.total_cents),breakdown:{item_total:{currency_code:'USD',value:money(s.total_cents-s.shipping_cents)},shipping:{currency_code:'USD',value:money(s.shipping_cents)}}},items:s.lines.map(l=>({name:l.title.slice(0,127),sku:l.id.slice(0,127),quantity:'1',category:'PHYSICAL_GOODS',unit_amount:{currency_code:'USD',value:money(l.price_cents)}}))}],application_context:{brand_name:'Mineral Murals',shipping_preference:'GET_FROM_FILE',user_action:'PAY_NOW',return_url:checkoutURL(s,origin),cancel_url:origin+'/checkout.html?ids='+encodeURIComponent(s.lines.map(l=>l.id).join(','))}},s.id);
 if(!remote.id)throw new APIError('PayPal checkout needs review.',502);return {...s,state:'open',remote_id:remote.id};
}
async function reserve(env,s,snapshots){
 const guard=uid('checkout'),conditions=snapshots.map(()=>"(id=? AND version=? AND json_extract(data,'$.status')='published')").join(' OR '),args=snapshots.flatMap(r=>[r.id,r.version]),ids=s.lines.map(l=>l.id),marks=ids.map(()=>'?').join(',');
 const statements=[stmt(env,`INSERT INTO action_keys(key,result,created) SELECT ?,?,? WHERE (SELECT count(*) FROM items WHERE ${conditions})=? AND NOT EXISTS(SELECT 1 FROM holds WHERE item_id IN (${marks}))`,guard,s.id,Date.now(),...args,ids.length,...ids),stmt(env,'INSERT INTO payment_sessions(id,provider,state,created,data) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)',s.id,s.provider,s.state,Date.now(),JSON.stringify(s),guard)];
 if(s.live)for(const id of ids)statements.push(stmt(env,'INSERT INTO holds(item_id,order_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)',id,s.id,guard));
 const results=await env.DB.batch(statements);if(!results[0].meta.changes)throw new APIError('A specimen just became unavailable. Review your basket.',409);
}
export async function startCheckout(env,data,origin){
 const provider=data.provider||'stripe';if(!['stripe','paypal'].includes(provider))throw new APIError('Choose a supported payment method.');
 const status=await paymentStatus(env);if(!status[provider])throw new APIError('Online payments are not ready yet. Your basket is saved.',503);
 if(!Array.isArray(data.ids)||!data.ids.length||data.ids.length>15||new Set(data.ids).size!==data.ids.length||data.ids.some(id=>typeof id!=='string'||id.length>180))throw new APIError('Choose up to 15 distinct specimens.');
 if(typeof data.attempt!=='string'||!/^[-a-zA-Z0-9]{16,80}$/.test(data.attempt))throw new APIError('Reload checkout before paying.');
 const id='pay-'+data.attempt,existing=await stmt(env,'SELECT data FROM payment_sessions WHERE id=?',id).first();
 if(existing){const s=JSON.parse(existing.data);if(s.provider!==provider||JSON.stringify(s.lines.map(l=>l.id))!==JSON.stringify(data.ids))throw new APIError('Start a new checkout for the changed basket.',409);if(s.state==='creating')return receipt(await update(env,await openRemote(env,s,origin),'creating'));if(terminal.includes(s.state))throw new APIError('This checkout has ended. Start a new checkout.',409);return receipt(s);}
 // Safely release previous abandoned checkouts only after provider reconciliation.
 const holds=(await stmt(env,`SELECT DISTINCT p.data FROM holds h JOIN payment_sessions p ON p.id=h.order_id WHERE h.item_id IN (${data.ids.map(()=>'?').join(',')})`,...data.ids).all()).results;
 for(const held of holds)await reconcileOne(env,JSON.parse(held.data));
 const snapshots=[];for(const id of data.ids){const r=await item(env,id);if(r.status!=='published'||r.quantity!==1)throw new APIError('A specimen is no longer available. Review your basket.',409);requireReady(r);snapshots.push(r);}
 const prefs=await settings(env),s={id,provider,state:'creating',live:live(prefs),token:uid('receipt')+uid('proof'),created_at:now(),expires:Math.floor(Date.now()/1000)+1860,lines:snapshots.map(r=>({id:r.id,title:r.title||r.material,price_cents:r.price_cents})),shipping_cents:prefs.shipping_cents,shipping_label:prefs.shipping_label,countries:prefs.countries};s.total_cents=s.lines.reduce((a,l)=>a+l.price_cents,0)+s.shipping_cents;
 await reserve(env,s,snapshots);
 // Unknown network outcomes keep the hold. Retry uses the same provider idempotency key.
 return receipt(await update(env,await openRemote(env,s,origin),'creating'));
}
async function expire(env,s){if(terminal.includes(s.state))return s;const ended={...s,state:'expired'};await env.DB.batch([stmt(env,"UPDATE payment_sessions SET state='expired',data=? WHERE id=? AND state=?",JSON.stringify(ended),s.id,s.state),stmt(env,"DELETE FROM holds WHERE order_id=? AND EXISTS(SELECT 1 FROM payment_sessions WHERE id=? AND state='expired')",s.id,s.id)]);return row(env,s.id);}
export async function settlePayment(env,s,verified){
 if(['paid','test_paid','conflict'].includes(s.state))return s;
 if(verified.paid!==true)return s;
 if(verified.total_cents!==s.total_cents||verified.currency!=='USD'||verified.reference!==s.id||verified.live!==s.live)throw new APIError('Payment totals or identity need seller review.',409);
 const order={id:s.id,item_ids:s.lines.map(l=>l.id),status:s.live?'website_paid':'test_paid',sale_platform:s.provider,payment_mode:s.live?'live':'test',total_cents:s.total_cents,shipping_cents:s.shipping_cents,created_at:now(),reference:s.remote_id,customer:verified.customer||{},shipping_address:verified.shipping||{}};
 const records=await Promise.all(s.lines.map(l=>item(env,l.id))),conflicts=[];
 if(s.live)for(const r of records){const held=await stmt(env,'SELECT order_id FROM holds WHERE item_id=?',r.id).first();if(r.status==='sold'&&r.sale_reference!==s.id||held?.order_id!==s.id)conflicts.push(r.id);}
 if(conflicts.length){order.status='paid_needs_review';order.conflicts=conflicts;}
 const next={...s,state:conflicts.length?'conflict':s.live?'paid':'test_paid',paid_at:now()},guard=uid('paid');
 const conditions=records.map(()=>'(id=? AND version=?)').join(' OR ');
 const statements=[stmt(env,`INSERT INTO action_keys(key,result,created) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM payment_sessions WHERE id=? AND state=?) AND (SELECT count(*) FROM items WHERE ${conditions})=?`,guard,s.id,Date.now(),s.id,s.state,...records.flatMap(r=>[r.id,r.version]),records.length),stmt(env,'INSERT OR IGNORE INTO orders(id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)',s.id,JSON.stringify(order),guard)];
 if(s.live){const links=(await stmt(env,"SELECT value FROM mm_market WHERE kind='link'").all()).results.map(r=>JSON.parse(r.value));
  for(const r of records){if(conflicts.includes(r.id))continue;const sold={...r,status:'sold',quantity:0,sale_platform:s.provider,sale_reference:s.id,sold_at:now(),updated_at:now(),version:r.version+1};statements.push(stmt(env,'UPDATE items SET data=?,version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM action_keys WHERE key=?)',JSON.stringify(sold),r.id,guard));
   for(const link of links.filter(l=>l.item_id===r.id)){const job={id:link.provider+':'+r.id+':delist',provider:link.provider,item_id:r.id,action:'delist',status:'queued',attempts:0,stage:'start',next_attempt:0,created_at:now(),updated_at:now(),message:'Verified website payment via '+s.provider};statements.push(stmt(env,"INSERT INTO mm_market(kind,id,value) SELECT 'job',?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",job.id,JSON.stringify(job),guard));}
  }
 }
 statements.push(stmt(env,'UPDATE payment_sessions SET state=?,data=? WHERE id=? AND EXISTS(SELECT 1 FROM action_keys WHERE key=?)',next.state,JSON.stringify(next),s.id,guard),stmt(env,'DELETE FROM holds WHERE order_id=? AND EXISTS(SELECT 1 FROM action_keys WHERE key=?)',s.id,guard));
 const results=await env.DB.batch(statements);if(!results[0].meta.changes){const latest=await row(env,s.id);if(terminal.includes(latest.state))return latest;throw new APIError('Inventory changed while confirming payment. Please check again.',409);}return next;
}
async function reconcileOne(env,s){
 if(terminal.includes(s.state)||!s.remote_id)return s;
 if(s.provider==='stripe'){const remote=await stripeRequest(env,s,'checkout/sessions/'+encodeURIComponent(s.remote_id));if(remote.id!==s.remote_id)throw new APIError('Payment identity mismatch.',409);
  if(remote.payment_status==='paid')return settlePayment(env,s,{paid:true,total_cents:remote.amount_total,currency:String(remote.currency).toUpperCase(),reference:remote.client_reference_id,live:Boolean(remote.livemode),customer:remote.customer_details,shipping:remote.shipping_details});
  if(remote.status==='expired')return expire(env,s);
 }else{const remote=await paypalRequest(env,s,'/v2/checkout/orders/'+encodeURIComponent(s.remote_id));const units=remote.purchase_units||[],captures=units.flatMap(u=>u.payments?.captures||[]);
  if(remote.status==='COMPLETED'&&captures.length===1&&captures[0].status==='COMPLETED')return settlePayment(env,s,{paid:true,total_cents:Math.round(Number(captures[0].amount.value)*100),currency:captures[0].amount.currency_code,reference:units.length===1?units[0].custom_id:null,live:s.live,customer:{email:remote.payer?.email_address,name:remote.payer?.name},shipping:units[0].shipping});
  if(s.state==='open'&&s.expires<Math.floor(Date.now()/1000))return expire(env,s);
 }return s;
}
export async function reconcileCheckouts(env){const rows=(await stmt(env,"SELECT data FROM payment_sessions WHERE state IN ('open','capturing') ORDER BY created LIMIT 10").all()).results;const result=[];for(const r of rows){const s=JSON.parse(r.data);try{result.push({id:s.id,state:(await reconcileOne(env,s)).state});}catch{result.push({id:s.id,state:'needs_check'});}}return result;}
async function capturePayPal(env,s){
 if(s.provider!=='paypal'||!s.remote_id)throw new APIError('PayPal checkout not found.');if(terminal.includes(s.state))return s;
 s=await reconcileOne(env,s);if(terminal.includes(s.state))return s;
 const approved=await paypalRequest(env,s,'/v2/checkout/orders/'+encodeURIComponent(s.remote_id));
 if(approved.status!=='COMPLETED'&&!s.countries.includes(approved.purchase_units?.[0]?.shipping?.address?.country_code))throw new APIError('Please choose a delivery address in an available shipping country.',400);
 if(s.state==='open'){if(s.expires<Math.floor(Date.now()/1000))throw new APIError('Checkout expired. Please start again.',409);s=await update(env,{...s,state:'capturing'},'open');}
 // Repeating a capture after a lost response is safe with a stable PayPal-Request-Id.
 await paypalRequest(env,s,'/v2/checkout/orders/'+encodeURIComponent(s.remote_id)+'/capture','POST',{},s.id+'-capture');return reconcileOne(env,s);
}
export async function verifyStripeSignature(raw,header,secret,seconds=Math.floor(Date.now()/1000)){
 const entries=String(header||'').split(',').map(x=>x.split('=')),timestamp=entries.find(([k])=>k==='t')?.[1],signatures=entries.filter(([k])=>k==='v1').map(([,v])=>v);
 if(!secret||!/^\d+$/.test(timestamp||'')||Math.abs(seconds-Number(timestamp))>300)throw new APIError('Invalid payment signature.',400);
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);let valid=false;for(const signature of signatures){if(!/^[a-f0-9]{64}$/i.test(signature||''))continue;const bytes=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16));if(await crypto.subtle.verify('HMAC',key,bytes,enc.encode(timestamp+'.'+raw)))valid=true;}if(!valid)throw new APIError('Invalid payment signature.',400);
}
export async function handlePayments(req,env){const u=new URL(req.url),p=u.pathname;
 if(p==='/api/payments/config'&&req.method==='GET')return json(await paymentStatus(env));
 if(p==='/api/payments/stripe/webhook'){
  if(req.method!=='POST')throw new APIError('Use POST.',405);const raw=await req.text();if(raw.length>1000000)throw new APIError('Event too large.',413);const c=await credentials(env,'stripe');await verifyStripeSignature(raw,req.headers.get('Stripe-Signature'),c.webhook_secret);const event=JSON.parse(raw),remote=event.data?.object;
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type))return json({received:true});
  const id=remote?.metadata?.mm_order;if(!id)return json({received:true});let s;try{s=await row(env,id);}catch(e){if(e.status===404)return json({received:true});throw e;}
  if(s.provider!=='stripe'||s.remote_id!==remote.id||s.live!==Boolean(event.livemode))throw new APIError('Payment identity mismatch.',400);
  await reconcileOne(env,s);return json({received:true});
 }
 if(p==='/api/checkout'){
  if(req.method==='POST'){sameOrigin(req);const result=await startCheckout(env,await body(req),u.origin);return json({...result,url:result.provider==='stripe'?result.url:null});}
  if(req.method==='GET'){const s=await row(env,u.searchParams.get('order'));if(!u.searchParams.get('token')||u.searchParams.get('token')!==s.token)throw new APIError('Receipt access required.',404);return json(receipt(await reconcileOne(env,s)));}
  throw new APIError('Method not allowed.',405);
 }
 if(p==='/api/payments/paypal/capture'||p==='/api/payments/cancel'){
  if(req.method!=='POST')throw new APIError('Use POST.',405);sameOrigin(req);const b=await body(req),s=await row(env,b.order);if(b.token!==s.token)throw new APIError('Checkout access required.',404);
  if(p.endsWith('/capture'))return json(receipt(await capturePayPal(env,s)));
  let next=await reconcileOne(env,s);if(next.state==='open'){if(next.provider==='stripe')await stripeRequest(env,next,'checkout/sessions/'+encodeURIComponent(next.remote_id)+'/expire','POST',new URLSearchParams(),next.id+'-cancel');next=next.provider==='stripe'?await reconcileOne(env,next):await expire(env,next);}return json(receipt(next));
 }
 if(p==='/api/seller/payments'){
  await owner(req,env);if(req.method==='GET')return json(await paymentStatus(env,true));if(req.method!=='POST')throw new APIError('Use POST.',405);sameOrigin(req);const b=await body(req),old=await settings(env),s={...old};for(const k of fields)if(k in b)s[k]=b[k];
  if(!['test','live'].includes(s.mode)||s.shipping_cents!==null&&(!Number.isSafeInteger(s.shipping_cents)||s.shipping_cents<0||s.shipping_cents>1000000)||!Array.isArray(s.countries)||!s.countries.length||s.countries.some(c=>!(/^[A-Z]{2}$/).test(c))||s.countries.length>30||typeof s.shipping_label!=='string'||s.shipping_label.length>80)throw new APIError('Check payment and shipping settings.');
  if(s.mode!==old.mode){const active=await stmt(env,"SELECT id FROM payment_sessions WHERE state IN ('creating','open','capturing') LIMIT 1").first();if(active)throw new APIError('Finish or reconcile open checkouts before changing payment mode.',409);}
  for(const provider of ['stripe','paypal'])if(b[provider]){const allowed=provider==='stripe'?['secret_key','webhook_secret']:['client_id','client_secret'];if(Object.entries(b[provider]).some(([k,v])=>!allowed.includes(k)||typeof v!=='string'||v.length>4096))throw new APIError('Unexpected payment credential.');const previous=await getSecret(env,'payments_'+provider),merged={...previous};for(const [k,v]of Object.entries(b[provider]))if(v.trim())merged[k]=v.trim();if(Object.keys(merged).length)await putSecret(env,'payments_'+provider,merged);}
  await setConfig(env,'payments',s);return json(await paymentStatus(env,true));
 }
 if(p==='/api/seller/payments/reconcile'){await owner(req,env);sameOrigin(req);if(req.method!=='POST')throw new APIError('Use POST.',405);return json({results:await reconcileCheckouts(env)});}
 return null;
}
