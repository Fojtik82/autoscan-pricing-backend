import test from 'node:test';
import assert from 'node:assert/strict';
import { collectIsolatedMarketSource } from './market_source_isolation.js';

const run = overrides => collectIsolatedMarketSource({ source: 'sauto', enabled: true,
  scrape: async () => [{ brand: 'Skoda' }], indexEnabled: true,
  index: async () => ({ ids: new Set([1]) }), validateIndex: value => value?.ids instanceof Set,
  ...overrides });

test('collection failure cannot expose rows or an index and another source can proceed', async () => {
  let indexCalled = false;
  const failed = await run({ scrape: async () => { throw new Error('HTTP 503'); },
    index: async () => { indexCalled = true; return { ids: new Set([1]) }; } });
  const healthy = await run({ source: 'bazos', scrape: async () => ({ rows: [{ brand: 'Honda' }], indexErrors: [] }) });
  assert.equal(failed.failure.phase, 'daily_collection');
  assert.equal(failed.scraped, null); assert.equal(failed.liveIndex, null);
  assert.equal(indexCalled, false);
  assert.equal(healthy.failure, null); assert.equal(healthy.scraped.rows.length, 1);
});

test('partial daily index is an error and cannot expose partial rows', async () => {
  const result = await run({ scrape: async () => ({ rows: [{ brand: 'Honda' }], indexErrors: ['category unavailable'] }) });
  assert.equal(result.failure.phase, 'daily_collection');
  assert.match(result.failure.message, /category unavailable/);
  assert.equal(result.scraped, null); assert.equal(result.liveIndex, null);
});

test('an invalid daily collection result is not treated as an empty successful source', async () => {
  const result = await run({ scrape: async () => undefined, validateScrape: Array.isArray });
  assert.equal(result.failure.phase, 'daily_collection');
  assert.equal(result.scraped, null); assert.equal(result.liveIndex, null);
});

test('local database corruption is fatal instead of being masked as source outage', async () => {
  const error = Object.assign(new Error('database corrupt'), { code: 'SQLITE_CORRUPT' });
  await assert.rejects(run({ scrape: async () => { throw error; } }), /database corrupt/);
  await assert.rejects(run({ index: async () => { throw error; } }), /database corrupt/);
});

test('incomplete or failed live index discards staged rows and never allows reconciliation', async () => {
  for (const index of [async () => { throw new Error('timeout'); }, async () => ({ ids: [] })]) {
    const result = await run({ index });
    assert.equal(result.failure.phase, 'live_index');
    assert.equal(result.scraped, null); assert.equal(result.liveIndex, null);
  }
});

test('disabled source is untouched and disabling reconciliation preserves prior behavior', async () => {
  const disabled = await run({ enabled: false, scrape: async () => { throw new Error('unexpected'); } });
  assert.equal(disabled.enabled, false); assert.equal(disabled.failure, null);
  const noIndex = await run({ indexEnabled: false });
  assert.equal(noIndex.scraped.length, 1); assert.equal(noIndex.liveIndex, null);
});
