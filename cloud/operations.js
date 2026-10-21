import {APIError, owner, json, stmt, item, items, validPhotos, requireReady, now, uid, config} from './store.js';
import {queuePublish, connectionStatus} from './marketplaces.js';
import {generateRecord, generateListings} from './facts.js';

const channels = ['website', 'etsy', 'ebay'];
const mutable = ['draft', 'imported', 'approved', 'published'];
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new APIError('Open this action from your Seller Hub.', 403);
  }
}
function selectedIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 200 || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !id || id.length > 180)) {
    throw new APIError('Select up to 200 distinct specimens.');
  }
  return value;
}
async function readySnapshot(env, id) {
  const record = await item(env, id);
  if (!['approved', 'published'].includes(record.status) || record.quantity !== 1) throw new APIError('Review and approve this available specimen before publishing.');
  requireReady(record);
  if (!String(record.condition || '').trim()) throw new APIError('Inspect and confirm this specimen’s condition before publishing.');
  record.photos = await validPhotos(env, record.photos || []);
  if (!record.photos.length || record.photos.some(photo => photo.preview_only)) throw new APIError('Wait for every selected photograph to finish converting.');
  if (await stmt(env, 'SELECT item_id FROM holds WHERE item_id=?', id).first()) throw new APIError('This specimen is reserved.', 409);
  return record;
}
async function attempt(env, row) {
  const saved = {id: uid('attempt'), created_at: now(), ...row};
  await stmt(env, 'INSERT INTO attempts(id,created,data) VALUES(?,?,?)', saved.id, saved.created_at, JSON.stringify(saved)).run();
  return row;
}

export async function publishAll(env, ids, chosen) {
  selectedIds(ids);
  if (!Array.isArray(chosen) || !chosen.length || chosen.some(channel => !channels.includes(channel))) throw new APIError('Choose website, Etsy and/or eBay.');
  chosen = [...new Set(chosen)];
  const results = [];
  for (const id of ids) {
    let snapshot;
    try { snapshot = await readySnapshot(env, id); }
    catch (error) {
      for (const channel of chosen) results.push(await attempt(env, {item_id: id, channel, status: 'blocked', message: error.message}));
      continue;
    }
    if (chosen.includes('website')) {
      const record = {...snapshot, status: 'published', version: snapshot.version + 1, updated_at: now()};
      const result = await stmt(env, "UPDATE items SET data=?,version=version+1 WHERE id=? AND version=? AND json_extract(data,'$.status') IN ('approved','published') AND NOT EXISTS(SELECT 1 FROM holds WHERE item_id=items.id)", JSON.stringify(record), id, snapshot.version).run();
      results.push(await attempt(env, {item_id: id, channel: 'website', status: result.meta.changes ? 'published' : 'blocked', message: result.meta.changes ? 'Published on your website.' : 'This specimen changed or became unavailable. Reload and review before publishing.'}));
      if (!result.meta.changes) {
        for (const channel of chosen.filter(channel => channel !== 'website')) results.push(await attempt(env, {item_id: id, channel, status: 'blocked', message: 'This specimen changed or became unavailable. Reload and review before publishing.'}));
        continue;
      }
    }
    for (const channel of chosen.filter(channel => channel !== 'website')) {
      try {
        const [job] = await queuePublish(env, [id], [channel]);
        const state = (await connectionStatus(env))[channel];
        const status = job.status === 'done' ? 'published' : !state.ready ? 'needs_setup' : job.status;
        results.push(await attempt(env, {item_id: id, channel, status, job_id: job.id, message: status === 'published' ? 'Confirmed by ' + channel + '.' : status === 'needs_setup' ? 'Request saved. Complete this store’s connection and shop defaults in Connections.' : 'Request saved. Check Channel activity for marketplace confirmation.'}));
      } catch (error) {
        results.push(await attempt(env, {item_id: id, channel, status: 'blocked', message: error instanceof APIError ? error.message : 'This channel needs review. Your saved specimen is retained.'}));
      }
    }
  }
  return {results};
}

// One guard row gates every statement in a D1 transaction. A stale source
// version cannot create only half a split, an orphan job, or an orphan order.
function transactionGuard(env, originals, action) {
  const key = uid(action);
  const conditions = originals.map(() => "(id=? AND version=? AND json_extract(data,'$.status') NOT IN ('sold','reserved','archived'))").join(' OR ');
  const args = originals.flatMap(record => [record.id, record.version]);
  const placeholders = originals.map(() => '?').join(',');
  const statement = stmt(env, `INSERT INTO action_keys(key,result,created) SELECT ?,?,? WHERE (SELECT count(*) FROM items WHERE ${conditions})=? AND NOT EXISTS(SELECT 1 FROM holds WHERE item_id IN (${placeholders}))`, key, JSON.stringify({action, ids: originals.map(record => record.id)}), Date.now(), ...args, originals.length, ...originals.map(record => record.id));
  return {key, statement};
}
async function guardedBatch(env, guard, statements) {
  const results = await env.DB.batch([guard.statement, ...statements]);
  if (!results[0].meta.changes) throw new APIError('A specimen changed or became unavailable. Reload before trying again.', 409);
  return results;
}
function updateWithGuard(env, guard, record) {
  return stmt(env, 'UPDATE items SET data=?,version=? WHERE id=? AND EXISTS(SELECT 1 FROM action_keys WHERE key=?)', JSON.stringify(record), record.version, record.id, guard.key);
}
function insertWithGuard(env, guard, record) {
  return stmt(env, 'INSERT INTO items(id,data,version) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)', record.id, JSON.stringify(record), record.version, guard.key);
}
function segmentJob(record) {
  return {id: uid('segment'), kind: 'segment', item_id: record.id, media: record.video.original,
    baseline: record, options: {start: record.video.start, end: record.video.end}, status: 'waiting_worker',
    progress: 0, created_at: now(), message: 'Saved online. Waiting for your Mac to refresh this segment’s clip, photographs and narration.'};
}
function jobWithGuard(env, guard, job) {
  return stmt(env, 'INSERT INTO jobs(id,data,status,created) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)', job.id, JSON.stringify(job), job.status, Date.now(), guard.key);
}
function pending(record) {
  return {...record, media_pending: true, status: 'draft', reviewed: false, stock_verified: false,
    version: record.version + 1, updated_at: now(), video: {...record.video, clip: null}};
}
function editableSegment(record) {
  const video = record.video;
  if (!['draft', 'approved'].includes(record.status) || record.media_pending) throw new APIError('Wait for processing, then select unpublished drafts.');
  if (!video || !video.original?.startsWith('/media/') || !Number.isFinite(video.start) || !Number.isFinite(video.end) || video.start < 0 || video.end <= video.start) throw new APIError('Select a valid saved recording segment.');
}
export async function splitSegment(env, id, at) {
  const original = await item(env, id);
  editableSegment(original);
  at = Number(at);
  if (!Number.isFinite(at) || at <= original.video.start || at >= original.video.end) throw new APIError('Put the playhead inside this specimen’s segment.');
  const first = pending({...original, video: {...original.video, end: at}});
  const settings = await config(env, 'ai', {});
  const second = {...generateRecord('', original.photos || [], settings), id: uid('specimen'), version: 1,
    video: {...original.video, start: at, clip: null}, media_pending: true,
    warnings: ['Split segment: wait for refreshed narration and photographs, then review every fact.']};
  const guard = transactionGuard(env, [original], 'split'), jobs = [segmentJob(first), segmentJob(second)];
  await guardedBatch(env, guard, [updateWithGuard(env, guard, first), insertWithGuard(env, guard, second), ...jobs.map(job => jobWithGuard(env, guard, job))]);
  return {ids: [first.id, second.id], jobs};
}
export async function mergeSegments(env, ids) {
  selectedIds(ids);
  if (ids.length !== 2) throw new APIError('Choose exactly two segments to merge.');
  const originals = await Promise.all(ids.map(id => item(env, id)));
  originals.forEach(editableSegment);
  originals.sort((a, b) => a.video.start - b.video.start);
  const [a, b] = originals;
  if (a.video.original !== b.video.original) throw new APIError('Choose segments from the same recording.');
  const start = a.video.start, end = Math.max(a.video.end, b.video.end);
  if ((await items(env)).some(record => !ids.includes(record.id) && record.status !== 'archived' && record.video?.original === a.video.original && record.video.start < end && record.video.end > start)) throw new APIError('Choose adjacent segments. Another specimen is inside this interval.');
  const record = pending({...a, video: {...a.video, start, end}, transcript: [a.transcript, b.transcript].filter(Boolean).join('\n'),
    photos: [...new Map([...(a.photos || []), ...(b.photos || [])].map(photo => [photo.src, photo])).values()].slice(0, 30),
    condition: [...new Set([a.condition, b.condition].filter(Boolean))].join('; '),
    price_cents: a.price_cents === b.price_cents ? a.price_cents : null,
    warnings: [...(a.warnings || []), ...(b.warnings || []), 'Merged segments: review material, price, narration, photographs and disclosures.']});
  record.listings = generateListings(record, await config(env, 'ai', {}));
  record.description = record.listings.website.description;
  const archived = {...b, status: 'archived', reviewed: false, version: b.version + 1, updated_at: now(), merged_into: a.id};
  const guard = transactionGuard(env, originals, 'merge'), job = segmentJob(record);
  await guardedBatch(env, guard, [updateWithGuard(env, guard, record), updateWithGuard(env, guard, archived), jobWithGuard(env, guard, job)]);
  return {id: record.id, jobs: [job]};
}

export async function recordSale(env, data) {
  if (!['website', 'etsy', 'ebay', 'cash', 'other'].includes(data.platform)) throw new APIError('Choose where this specimen sold.');
  if (!Number.isInteger(data.total_cents) || data.total_cents <= 0 || data.total_cents > 100000000) throw new APIError('Enter the actual positive sale amount.');
  const original = await item(env, data.id), orderId = 'manual-' + original.id;
  const existing = await stmt(env, 'SELECT data FROM orders WHERE id=?', orderId).first();
  if (existing && original.sale_reference === orderId) return {...JSON.parse(existing.data), already_recorded: true};
  if (!mutable.includes(original.status)) throw new APIError('This specimen is already sold, reserved or archived.', 409);
  const order = {id: orderId, status: 'seller_recorded_sale', sale_platform: data.platform,
    payment_mode: 'recorded_by_seller', reference: String(data.reference || '').slice(0, 500),
    total_cents: data.total_cents, item_ids: [original.id], created_at: now()};
  const record = {...original, status: 'sold', quantity: 0, sold_at: now(), sale_platform: data.platform,
    sale_reference: orderId, updated_at: now(), version: original.version + 1};
  const links = (await stmt(env, "SELECT value FROM mm_market WHERE kind='link'").all()).results.map(row => JSON.parse(row.value)).filter(link => link.item_id === original.id);
  const guard = transactionGuard(env, [original], 'sale');
  const statements = [updateWithGuard(env, guard, record), stmt(env, 'INSERT INTO orders(id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?)', orderId, JSON.stringify(order), guard.key)];
  for (const link of links) {
    const job = {id: link.provider + ':' + original.id + ':delist', provider: link.provider, item_id: original.id,
      action: 'delist', status: 'queued', stage: 'start', attempts: 0, next_attempt: 0, created_at: now(), updated_at: now(),
      message: 'Seller recorded a sale on ' + data.platform + '. Removal requires marketplace confirmation.'};
    statements.push(stmt(env, "INSERT INTO mm_market(kind,id,value) SELECT 'job',?,? WHERE EXISTS(SELECT 1 FROM action_keys WHERE key=?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", job.id, JSON.stringify(job), guard.key));
  }
  await guardedBatch(env, guard, statements);
  return {...order, message: 'Marked sold in your shared inventory. Check linked store removals in Channel activity.'};
}
export async function recordShipment(env, data) {
  const row = await stmt(env, 'SELECT data FROM orders WHERE id=?', data.id).first();
  if (!row) throw new APIError('Order not found.', 404);
  const order = JSON.parse(row.data);
  if (!['marketplace_paid', 'seller_recorded_sale', 'website_paid', 'paid', 'shipped'].includes(order.status)) throw new APIError('Record a paid sale before adding shipment information.');
  const carrier = String(data.carrier || '').trim().slice(0, 100), tracking = String(data.tracking || '').trim().slice(0, 200);
  if (!carrier || !tracking) throw new APIError('Add a carrier and tracking number.');
  const saved = {...order, status: 'shipped', shipping: {carrier, tracking, recorded_at: now(), sync_status: 'local_record_only'}, updated_at: now()};
  const result = await stmt(env, 'UPDATE orders SET data=? WHERE id=? AND data=?', JSON.stringify(saved), data.id, row.data).run();
  if (!result.meta.changes) throw new APIError('This order changed. Reload before saving its shipment.', 409);
  return saved;
}
export async function channelActivity(env) {
  const saved = (await stmt(env, 'SELECT data FROM attempts ORDER BY rowid DESC LIMIT 100').all()).results.map(row => JSON.parse(row.data));
  const marketplace = (await stmt(env, "SELECT value FROM mm_market WHERE kind IN ('job','conflict') ORDER BY rowid DESC LIMIT 100").all()).results.map(row => {
    const value = JSON.parse(row.value);
    return {...value, channel: value.provider, status: value.status || 'needs_review', message: value.message || value.reason};
  });
  return [...marketplace, ...saved].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).slice(0, 150);
}
export async function handleOperations(request, env) {
  const path = new URL(request.url).pathname;
  const known = ['publish-all', 'publish', 'sale', 'shipment', 'split', 'merge', 'attempts'];
  if (!path.startsWith('/api/seller/') || !known.includes(path.slice(12))) return null;
  try {
    await owner(request, env);
    const op = path.slice(12);
    if (request.method === 'GET' && op === 'attempts') return json(await channelActivity(env));
    if (request.method !== 'POST') throw new APIError('Use POST for this action.', 405);
    sameOrigin(request);
    if (Number(request.headers.get('Content-Length') || 0) > 1000000) throw new APIError('Request is too large.', 413);
    let body;
    try { body = await request.json(); } catch { throw new APIError('Send a JSON request.'); }
    if (op === 'publish-all' || op === 'publish') return json(await publishAll(env, op === 'publish' ? [body.id] : body.ids, op === 'publish' ? [body.channel || 'website'] : body.channels));
    if (op === 'sale') return json(await recordSale(env, body));
    if (op === 'shipment') return json(await recordShipment(env, body));
    if (op === 'split') return json(await splitSegment(env, body.id, body.at));
    if (op === 'merge') return json(await mergeSegments(env, body.ids));
    throw new APIError('Unsupported action.', 405);
  } catch (error) {
    return json({error: error instanceof APIError ? error.message : 'This action could not finish. Your saved work is retained.'}, error instanceof APIError ? error.status : 500);
  }
}
