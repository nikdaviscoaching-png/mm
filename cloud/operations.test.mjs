import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveItem, item, items, stmt, setConfig} from './store.js';
import {publishAll, recordSale, recordShipment, splitSegment, mergeSegments, channelActivity, handleOperations} from './operations.js';
import {connectionStatus, applySale, putMarket, getMarket} from './marketplaces.js';

const folder = mkdtempSync(join(tmpdir(), 'mm-operation-tests-')), db = join(folder, 'test.sqlite3');
const py = `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
q=json.load(sys.stdin);out=[]
try:
 for s in q:
  if 'script' in s:c.executescript(s['script']);out.append({});continue
  r=c.execute(s['sql'],s['args']);rows=[dict(x) for x in r.fetchall()];out.append({'results':rows,'meta':{'changes':c.execute('SELECT changes()').fetchone()[0]}})
 c.commit();print(json.dumps(out))
except: c.rollback();raise
`;
function execute(queries) {
  const result = spawnSync('python3', ['-c', py, db], {input: JSON.stringify(queries), encoding: 'utf8'});
  if (result.status) throw Error(result.stderr);
  return JSON.parse(result.stdout);
}
class Query {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Query(this.sql, args); }
  async run() { return execute([this])[0]; }
  async all() { return this.run(); }
  async first() { return (await this.run()).results[0] || null; }
}
const env = {DB: {prepare: sql => new Query(sql), batch: async queries => execute(queries)}, MM_SECRET_KEY: 'test-private-host-encryption-key-more-than32'};
for (const filename of ['0000_initial.sql', '0001_marketplace_tables.sql']) execute([{script: readFileSync(new URL('../drizzle/' + filename, import.meta.url), 'utf8')}]);
await setConfig(env, 'owner', 'trusted-owner');
const baseRecord = (id, more = {}) => ({id, status: 'approved', quantity: 1, material: 'agate', condition: 'Small chip on the back',
  price_cents: 4500, reviewed: true, stock_verified: true, photos: [{src: '/photos/test.webp'}],
  title: 'Agate', description: 'Agate. Small chip on the back.', ...more});
const video = (start, end, original = '/media/original/batch.mov') => ({original, start, end, duration: 20, clip: '/media/clip/previous.mp4'});

test('new marketplace migration creates functional missing-account status without a grant', async () => {
  const status = await connectionStatus(env);
  assert.equal(status.etsy.connected, false);
  assert.equal(status.ebay.connected, false);
  assert.equal(status.etsy.status, 'needs_setup');
});
test('publishing website succeeds while each disconnected external channel reports setup', async () => {
  await saveItem(env, baseRecord('publish-three'));
  const {results} = await publishAll(env, ['publish-three'], ['website', 'etsy', 'ebay']);
  assert.deepEqual(results.map(row => [row.channel, row.status]), [['website', 'published'], ['etsy', 'needs_setup'], ['ebay', 'needs_setup']]);
  assert.equal((await item(env, 'publish-three')).status, 'published');
  assert.equal((await getMarket(env, 'job', 'etsy:publish-three:publish')).status, 'queued');
});
test('unreviewed or still-converting records never publish anywhere', async () => {
  await saveItem(env, baseRecord('blocked-pending', {media_pending: true}));
  const {results} = await publishAll(env, ['blocked-pending'], ['website', 'ebay']);
  assert.ok(results.every(row => row.status === 'blocked'));
  assert.equal((await item(env, 'blocked-pending')).status, 'approved');
  assert.equal(await getMarket(env, 'job', 'ebay:blocked-pending:publish'), null);
});
test('a publication race reports every requested channel and cannot overwrite newer sold stock', async () => {
  await saveItem(env, baseRecord('publish-race'));
  let injected = false;
  const raced = {...env, DB: {...env.DB, prepare(sql) {
    const query = new Query(sql);
    if (sql.startsWith('UPDATE items SET data=?,version=version+1 WHERE')) {
      const originalBind = query.bind;
      query.bind = function (...args) {
        const bound = originalBind.call(this, ...args), run = bound.run.bind(bound);
        bound.run = async () => {
          if (!injected) {
            injected = true;
            await stmt(env, "UPDATE items SET data=json_set(data,'$.status','sold'),version=version+1 WHERE id=?", 'publish-race').run();
          }
          return run();
        };
        return bound;
      };
    }
    return query;
  }}};
  const {results} = await publishAll(raced, ['publish-race'], ['website', 'etsy', 'ebay']);
  assert.equal(results.length, 3);
  assert.ok(results.every(row => row.status === 'blocked'));
  assert.equal((await item(env, 'publish-race')).status, 'sold');
});
test('manual sale commits sold stock, provider-labelled order and linked removals together; retry is idempotent', async () => {
  await saveItem(env, baseRecord('sale-manual'));
  for (const provider of ['etsy', 'ebay']) await putMarket(env, 'link', provider + ':sale-manual', {provider, item_id: 'sale-manual', listing_id: provider + '-listing', state: 'active'});
  const order = await recordSale(env, {id: 'sale-manual', platform: 'ebay', total_cents: 4400, reference: 'my-order'});
  assert.equal(order.sale_platform, 'ebay');
  assert.equal((await item(env, 'sale-manual')).quantity, 0);
  assert.equal((await getMarket(env, 'job', 'etsy:sale-manual:delist')).status, 'queued');
  assert.equal((await getMarket(env, 'job', 'ebay:sale-manual:delist')).status, 'queued');
  assert.equal((await recordSale(env, {id: 'sale-manual', platform: 'ebay', total_cents: 4400})).already_recorded, true);
});
test('sale transaction is all or nothing when stock changes immediately before commit', async () => {
  await saveItem(env, baseRecord('sale-race'));
  const raced = {...env, DB: {...env.DB, batch: async queries => {
    await stmt(env, "UPDATE items SET data=json_set(data,'$.status','reserved'),version=version+1 WHERE id=?", 'sale-race').run();
    return execute(queries);
  }}};
  await assert.rejects(recordSale(raced, {id: 'sale-race', platform: 'cash', total_cents: 4500}), /changed/);
  assert.equal((await item(env, 'sale-race')).status, 'reserved');
  assert.equal(await stmt(env, 'SELECT data FROM orders WHERE id=?', 'manual-sale-race').first(), null);
});
test('verified paid marketplace order persists provider and stock state once, unpaid does nothing', async () => {
  await saveItem(env, baseRecord('verified-sale'));
  await putMarket(env, 'link', 'etsy:verified-sale', {provider: 'etsy', item_id: 'verified-sale', listing_id: '123456', state: 'active'});
  const event = {id: 'receipt-1', paid: false, lines: [{listing_id: '123456'}], total_cents: 4500};
  assert.equal((await applySale(env, 'etsy', event)).applied, false);
  event.paid = true;
  assert.equal((await applySale(env, 'etsy', event)).applied, true);
  assert.equal((await applySale(env, 'etsy', event)).applied, false);
  const record = await item(env, 'verified-sale');
  assert.equal(record.status, 'sold');
  assert.equal(record.sale_platform, 'etsy');
  const order = JSON.parse((await stmt(env, "SELECT data FROM orders WHERE json_extract(data,'$.reference')='receipt-1'").first()).data);
  assert.equal(order.status, 'marketplace_paid');
  assert.equal(order.sale_platform, 'etsy');
});
test('shipments preserve marketplace source and clearly record local-only tracking', async () => {
  const row = await stmt(env, "SELECT data FROM orders WHERE json_extract(data,'$.reference')='receipt-1'").first();
  const order = JSON.parse(row.data);
  const saved = await recordShipment(env, {id: order.id, carrier: 'USPS', tracking: '123'});
  assert.equal(saved.sale_platform, 'etsy');
  assert.equal(saved.shipping.sync_status, 'local_record_only');
  assert.equal(saved.status, 'shipped');
});
test('split atomically creates two unapproved pending intervals and two durable jobs', async () => {
  await saveItem(env, baseRecord('split-source', {status: 'draft', video: video(1, 8)}));
  const response = await splitSegment(env, 'split-source', 4);
  assert.equal(response.ids.length, 2);
  assert.equal(response.jobs.length, 2);
  const [first, second] = await Promise.all(response.ids.map(id => item(env, id)));
  assert.equal(first.video.end, 4);
  assert.equal(second.video.start, 4);
  for (const record of [first, second]) {
    assert.equal(record.media_pending, true);
    assert.equal(record.reviewed, false);
    assert.equal(record.video.clip, null);
  }
  assert.equal((await stmt(env, "SELECT id FROM jobs WHERE json_extract(data,'$.item_id') IN (?,?)", ...response.ids).all()).results.length, 2);
});
test('invalid split and nonadjacent merge leave all source records intact', async () => {
  await assert.rejects(splitSegment(env, 'split-source', NaN), /Wait for processing/);
  for (const [id, start, end] of [['merge-a', 1, 4], ['merge-between', 5, 6], ['merge-b', 7, 9]]) await saveItem(env, baseRecord(id, {status: 'draft', video: video(start, end, '/media/original/merge.mov')}));
  await assert.rejects(mergeSegments(env, ['merge-a', 'merge-b']), /adjacent/);
  assert.equal((await item(env, 'merge-a')).status, 'draft');
  assert.equal((await item(env, 'merge-b')).status, 'draft');
});
test('adjacent merge archives only the duplicate and queues one unapproved complete interval', async () => {
  const response = await mergeSegments(env, ['merge-a', 'merge-between']);
  const merged = await item(env, response.id);
  assert.equal(merged.media_pending, true);
  assert.equal(merged.reviewed, false);
  assert.equal(merged.video.start, 1);
  assert.equal(merged.video.end, 6);
  assert.equal((await item(env, 'merge-between')).status, 'archived');
  assert.equal(response.jobs.length, 1);
});
test('split source race cannot leave an orphan second specimen or processing job', async () => {
  await saveItem(env, baseRecord('split-race', {status: 'draft', video: video(10, 15, '/media/original/race.mov')}));
  const before = (await items(env)).length;
  const raced = {...env, DB: {...env.DB, batch: async queries => {
    await stmt(env, 'UPDATE items SET version=version+1 WHERE id=?', 'split-race').run();
    return execute(queries);
  }}};
  await assert.rejects(splitSegment(raced, 'split-race', 12), /changed/);
  assert.equal((await items(env)).length, before);
  assert.equal((await stmt(env, "SELECT id FROM jobs WHERE json_extract(data,'$.item_id')='split-race'").all()).results.length, 0);
});
test('Hub activity contains actual pending marketplace stock removal and its source channel', async () => {
  const activity = await channelActivity(env);
  assert.ok(activity.some(row => row.item_id === 'sale-manual' && row.action === 'delist' && row.channel === 'etsy' && row.status === 'queued'));
});
test('operations independently reject unauthenticated and cross-site mutations', async () => {
  const request = (who, origin) => new Request('https://hub.example/api/seller/sale', {method: 'POST', headers: {'Content-Type': 'text/plain', ...(who ? {'oai-authenticated-user-id': who} : {}), Origin: origin}, body: '{}'});
  assert.equal((await handleOperations(request(null, 'https://hub.example'), env)).status, 401);
  assert.equal((await handleOperations(request('trusted-owner', 'https://attacker.example'), env)).status, 403);
});
process.on('exit', () => rmSync(folder, {recursive: true, force: true}));
