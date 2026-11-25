import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyCollection, collectNicheDetails, fetchNicheWithRetry, NicheTransientError, parseNicheDetail, validateNicheDetailCoverage } from './niche_sources.js';

const listing = { source: 'rajveteranu', url: 'https://www.rajveteranu.cz/72463-aero-662-1934' };
const fields = [
  ['Značka', 'Aero'], ['Model', '662'], ['Rok výroby', '1934'],
  ['Datum vložení', '1.1.2026'],
].map(([key, value]) => `<tr><td>${key}:</td><td>&nbsp;</td><td>${value}</td></tr>`).join('');

test('a detail archived between index and fetch is a gone listing', () => {
  const page = `<a href="archiv">archivní inzeráty</a><table>${fields}
    <tr><td class='vm tr ital '>Datum&nbsp;archivace:</td>
    <td>&nbsp;&nbsp;&nbsp;</td><td>24.11.2026</td></tr></table>`;
  assert.deepEqual(parseNicheDetail(page, listing), { status: 'gone' });
});

test('normal archive navigation does not hide an active listing', () => {
  const page = `<a href="archiv">archivní inzeráty</a><table>${fields}</table>`;
  assert.equal(parseNicheDetail(page, listing).status, 'parsed');
});

test('a single unrecognized detail stays unverified, not a false deletion', () => {
  assert.deepEqual(parseNicheDetail('<h1>Inzerát</h1>', listing), { status: 'unsupported' });
});

test('isolated unsupported detail is safe, but broken source coverage is rejected', () => {
  const parsed = Array.from({ length: 100 }, () => ({ status: 'parsed' }));
  assert.doesNotThrow(() => validateNicheDetailCoverage(listing, [...parsed, { status: 'unsupported' }]));
  assert.throws(() => validateNicheDetailCoverage(listing, [
    ...parsed, ...Array.from({ length: 4 }, () => ({ status: 'unsupported' })),
  ]), /unusable detail coverage/);
  assert.throws(() => validateNicheDetailCoverage(listing, [{ status: 'gone' }]), /unusable detail coverage/);
});

test('retries transient 502/503 and keeps per-host pacing on every attempt', async () => {
  const statuses = [502, 503, 200]; const waits = []; let paced = 0; let cancelled = 0;
  const response = await fetchNicheWithRetry('https://www.sportovnivozy.cz/1-example', { id: 'sportovnivozy' }, {
    fetchImpl: async () => ({ status: statuses.shift(), body: { cancel: async () => { cancelled++; } } }),
    pace: async () => { paced++; }, wait: async ms => waits.push(ms),
  });
  assert.equal(response.status, 200);
  assert.equal(paced, 3);
  assert.equal(cancelled, 2);
  assert.deepEqual(waits, [1000, 2000]);
});

test('exhausted server errors are transient and rate limits are not retried', async () => {
  let calls = 0; let paced = 0;
  await assert.rejects(fetchNicheWithRetry('https://www.sportovnivozy.cz/1-example', { id: 'sportovnivozy' }, {
    fetchImpl: async () => { calls++; return { status: 504, body: { cancel: async () => {} } }; },
    pace: async () => { paced++; }, wait: async () => {},
  }), NicheTransientError);
  assert.equal(calls, 3); assert.equal(paced, 3);
  calls = 0;
  const limited = await fetchNicheWithRetry('https://www.sportovnivozy.cz/1-example', { id: 'sportovnivozy' }, {
    fetchImpl: async () => { calls++; return { status: 429 }; }, pace: async () => {}, wait: async () => {},
  });
  assert.equal(limited.status, 429); assert.equal(calls, 1);
});

test('one unavailable detail remains unverified and never deactivates an existing ad', async () => {
  const first = { key: 'rajveteranu:72463', url: listing.url };
  const other = { key: 'rajveteranu:123', url: 'https://www.rajveteranu.cz/123-aero-662' };
  const results = await collectNicheDetails({ id: 'rajveteranu' }, [first, other], async url => {
    if (url === first.url) throw new NicheTransientError('HTTP 502');
    return { status: 200, url, html: `<table>${fields}</table>` };
  });
  assert.deepEqual(results.find(result => result.key === first.key),
    { status: 'unsupported', key: first.key, transient_error: true });
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE vehicle_app (brand,model,year,mileage,fuel,motor,price,transmission,drive,kw,body,source_url,source_db,title,brand_norm,model_norm,fuel_norm,motor_norm,trim_norm,transmission_norm,drive_norm,engine_ccm,engine_l,is_active,last_seen_at,last_checked_at,missing_checks,missing_since,inactive_at)`);
    db.prepare('INSERT INTO vehicle_app (source_url,is_active,last_seen_at,last_checked_at,missing_checks) VALUES (?,1,?,?,0)').run(first.url, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
    const summary = applyCollection(db, { source: { id: 'rajveteranu' }, results, indexed: 2 }, { dryRun: false, missingChecks: 3 });
    const existing = db.prepare('SELECT is_active,missing_checks,last_seen_at,last_checked_at FROM vehicle_app WHERE source_url=?').get(first.url);
    assert.equal(existing.is_active, 1); assert.equal(existing.missing_checks, 0);
    assert.notEqual(existing.last_seen_at, existing.last_checked_at);
    assert.equal(summary.transient_errors, 1); assert.equal(summary.details_complete, false);
  } finally { db.close(); }
});

test('widespread detail outages and access denials reject the whole source', async () => {
  const candidates = Array.from({ length: 1000 }, (_, index) => ({ key: 'sportovnivozy:' + (index + 1), url: `https://www.sportovnivozy.cz/${index + 1}-example` }));
  let calls = 0;
  await assert.rejects(collectNicheDetails({ id: 'sportovnivozy' }, candidates, async () => {
    calls++; throw new NicheTransientError('HTTP 502');
  }), /widespread transient/);
  assert.ok(calls <= 6);
  await assert.rejects(collectNicheDetails({ id: 'sportovnivozy' }, candidates, async () => {
    throw new Error('sportovnivozy: HTTP 403');
  }), /HTTP 403/);
});
