import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { registerListingSaleDurationApi } from './listing_sale_duration_api.js';

test('duration HTTP API works without a pilot, validates inputs and leaves history unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-duration-api-'));
  const file = path.join(directory, 'history.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE vehicle_app (
    source_url TEXT, brand TEXT, model TEXT, brand_norm TEXT, model_norm TEXT,
    year INTEGER, fuel TEXT, mileage INTEGER, motor TEXT, transmission TEXT,
    is_active INTEGER, missing_checks INTEGER, first_seen_at TEXT,
    first_seen_is_observed INTEGER, missing_since TEXT, inactive_at TEXT,
    last_seen_at TEXT, last_checked_at TEXT)`);
  const insert = db.prepare(`INSERT INTO vehicle_app VALUES (
    ?, 'Škoda', 'Octavia', 'skoda', 'octavia', 2020, 'nafta', 150000, '2.0 TDI', 'manual',
    0, 3, '2026-10-01T08:00:00Z', 1, '2026-10-11T08:00:00Z', '2026-10-13T08:00:00Z',
    '2026-10-10T08:00:00Z', '2026-10-13T08:00:00Z')`);
  for (let i = 0; i < 6; i++) insert.run(i < 3
    ? `https://www.sauto.cz/osobni/detail/skoda/octavia/${220000000 + i}`
    : `https://auto.bazos.cz/inzerat/${220000000 + i}/skoda-octavia.php`);
  db.close();
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  const app = express();
  app.use(express.json());
  registerListingSaleDurationApi(app, file);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const post = input => fetch(`http://127.0.0.1:${server.address().port}/market/sale-duration`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  try {
    const response = await post({ brand: 'Škoda', model: 'Octavia', year: 2020 });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.found, true);
    assert.equal(result.average_days, 10);
    assert.equal(result.sample_size, 6);
    assert.equal(result.by_source.sauto.sample_size, 3);
    assert.equal(result.by_source.bazos.sample_size, 3);
    assert.equal(JSON.stringify(result).includes('220000000'), false);
    for (const bad of [[], {}, { brand: 'Škoda', model: 'Octavia', year: -1 },
      { brand: 'Škoda', model: 'Octavia', fuel: {} },
      { brand: 'Škoda', model: 'Octavia', mileage_km: '150000' },
      { brand: 'Škoda', model: 'Octavia', source: 'other' }]) {
      const invalidResponse = await post(bad);
      assert.equal(invalidResponse.status, 400);
      assert.equal((await invalidResponse.json()).reason, 'invalid_sale_duration_query');
    }
    const missing = await (await post({ brand: 'Škoda', model: 'Unknown' })).json();
    assert.equal(missing.found, false);
    assert.equal(hash(), before);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(file, { force: true });
    fs.rmdirSync(directory);
  }
});
