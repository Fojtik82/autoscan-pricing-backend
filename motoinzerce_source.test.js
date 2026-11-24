import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { listingIdentity, parseMotoIndex, parseMotoDetail, robotsAllows, collectMotoInzerce, updateMotoInzerce, selectMotoDetails } from './motoinzerce_source.js';

const first = '<p id="vypis-info">Zobrazuji inzeráty: 1 - 1 z 1</p>' +
  '<a href="/motorky/suzuki/123-rm-z-250.html">Suzuki<br />RM-Z 250</a>' +
  '<a href="https://www.tipmoto.com/motorky/a/12-b.html">Tip<br />Moto</a>';
const detail = '<strong><span>Výpis inzerátu id 123</span></strong><h1 id="vypis-detail">Suzuki RM-Z 250</h1><p id="detail-cena">55.000,- Kč</p>' +
  '<strong>Objem:</strong>250 ccm<br /><strong>Vyrobeno:</strong>2012<br /><strong>Najeto:</strong> 10 200 km<br />' +
  '<strong>Výkon:</strong>18 kW</p><strong>Zařazení:</strong> <h2><a href="/podle-typu/terenni-cross/">cross</a></h2>' +
  '<p>telefon 123456789</p>';
test('accept only local motorcycle listing URLs and exclude promoted links', () => {
  assert.equal(listingIdentity('https://www.tipmoto.com/motorky/a/123-x.html'), null);
  assert.equal(listingIdentity('/dily/suzuki/123-x.html'), null);
  assert.equal(parseMotoIndex(first).entries.length, 1);
  assert.throws(() => parseMotoIndex(first.replace('z 1', 'z 2').replace('1 - 1', '1 - 2')), /Incomplete/);
});
test('extracts sale data without contact and excludes quad bikes', () => {
  const item = parseMotoIndex(first).entries[0];
  const result = parseMotoDetail(detail, item);
  assert.equal(result.row.price, 55000); assert.equal(result.row.year, '2012');
  assert.equal(result.row.mileage, 10200); assert.equal(result.row.engine_ccm, 250);
  assert.equal(JSON.stringify(result).includes('123456789'), false);
  assert.equal(parseMotoDetail(detail.replace('terenni-cross', 'ctyrkolka'), item).status, 'excluded');
  assert.equal(parseMotoDetail(detail.replace('55.000,- Kč', 'dohodou'), item).status, 'unsupported');
  assert.throws(() => parseMotoDetail(detail.replace('id 123', 'id 124'), item), /mismatched/);
});
test('inserts and updates prices without deactivating absent listings on partial index', async () => {
  const db = new Database(':memory:');
  const item = parseMotoDetail(detail, parseMotoIndex(first).entries[0]);
  const cols = Object.keys(item.row).map(column => column + ' TEXT');
  db.exec('CREATE TABLE vehicle_app (' + cols.join(',') + ', is_active INTEGER, last_seen_at TEXT, last_checked_at TEXT, missing_checks INTEGER, missing_since TEXT, inactive_at TEXT)');
  const collect = async () => ({ indexComplete: false, detailsComplete: false, indexed: 1, results: [item] });
  const added = await updateMotoInzerce(db, { collect }); assert.equal(added.inserted, 1);
  db.prepare('UPDATE vehicle_app SET price=?,is_active=0').run('60000');
  const changed = await updateMotoInzerce(db, { collect }); assert.equal(changed.updated, 1);
  assert.equal(Number(db.prepare('SELECT price FROM vehicle_app').get().price), 55000);
  assert.equal(db.prepare('SELECT is_active FROM vehicle_app').get().is_active, 1);
  const empty = await updateMotoInzerce(db, { collect: async () => ({ indexComplete: false, detailsComplete: false, indexed: 0, results: [] }) });
  assert.equal(empty.deactivated, 0); assert.equal(db.prepare('SELECT is_active FROM vehicle_app').get().is_active, 1);
  await updateMotoInzerce(db, { collect: async () => ({ indexComplete: false, detailsComplete: false, indexed: 1, results: [{ id:'999', status:'unsupported' }] }) });
  let knownIds;
  await updateMotoInzerce(db, { collect: async ({known}) => { knownIds = known; return { indexComplete: false, detailsComplete: false, indexed: 0, results: [] }; } });
  assert.equal(knownIds.has('999'), true);
  db.close();
});
test('obeys robots exclusion and specific agent precedence', () => {
  const robots = 'User-agent: *\nDisallow: /motorky/\nUser-agent: CarPriceBot\nAllow: /motorky/\nDisallow: /motorky/private';
  assert.equal(robotsAllows(robots, '/motorky/'), true);
  assert.equal(robotsAllows(robots, '/motorky/private'), false);
});
test('bounded detail budget reserves capacity for the oldest existing prices', () => {
  const all = Array.from({ length: 300 }, (_, id) => ({ id: String(id) }));
  const known = new Map(all.slice(0, 200).map(item => [item.id, item.id.padStart(3, '0')]));
  const selected = selectMotoDetails(all, known, 100);
  assert.equal(selected.length, 100);
  assert.equal(selected.filter(item => known.has(item.id)).length, 50);
  assert.ok(selected.some(item => item.id === '0'));
  assert.ok(!selected.some(item => item.id === '199'));
});
test('partial import can never deactivate listings', async () => {
  const response = body => ({ status: 200, text: async () => body });
  const fetchImpl = async url => response(url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /schranka' : url.includes('.html') ? detail : first);
  const result = await collectMotoInzerce({ fetchImpl, paceMs: 1000 });
  assert.equal(result.indexComplete, true); assert.equal(result.deactivationSafe, false);
  assert.equal(result.results.length, 1);
});

test('a changing index total does not discard verified sales', async () => {
  const pageOne = '<p id="vypis-info">Zobrazuji inzeráty: 1 - 10 z 12</p>' +
    Array.from({ length: 10 }, (_, index) => `<a href="/motorky/suzuki/${123 + index}-rm-z-250.html">Suzuki<br />RM-Z 250</a>`).join('');
  const pageTwo = '<p id="vypis-info">Zobrazuji inzeráty: 11 - 11 z 11</p>' +
    '<a href="/motorky/suzuki/133-rm-z-250.html">Suzuki<br />RM-Z 250</a>';
  const response = body => ({ status: 200, text: async () => body });
  const fetchImpl = async url => response(url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' :
    url.includes('.html') ? detail : url.includes('?od=10') ? pageTwo : pageOne);
  const result = await collectMotoInzerce({ fetchImpl, maxDetails: 1, paceMs: 1000 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'parsed');
  assert.equal(result.deactivationSafe, false);
});
