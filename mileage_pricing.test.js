import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initVehicleDb } from './price_db.js';

const input = { brand: 'Skoda', model: 'Octavia', year: 2020,
  fuel: 'benzin', motor: '1.5 TSI', kw: 110 };
const lowMileage = [200000, 210000, 220000].map(price => ({ price, mileage: 100000 }));
const highMileage = [150000, 160000, 170000].map(price => ({ price, mileage: 140000 }));

function fixture(t, rows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-mileage-'));
  const file = path.join(directory, 'fixture.db');
  const db = new Database(file);
  const columns = ['brand', 'model', 'year', 'mileage', 'fuel', 'motor', 'price',
    'transmission', 'drive', 'source_url', 'source_db', 'title', 'kw', 'brand_norm',
    'model_norm', 'fuel_norm', 'transmission_norm', 'drive_norm', 'motor_norm', 'trim_norm', 'is_active'];
  db.exec('CREATE TABLE vehicle_app (' + columns.join(',') + ')');
  const insert = db.prepare('INSERT INTO vehicle_app VALUES (' + columns.map(key => '@' + key).join(',') + ')');
  db.transaction(() => rows.forEach((row, index) => insert.run({
    brand: 'Skoda', model: 'Octavia', year: '2020', mileage: '100000', fuel: 'Benzin',
    motor: '1.5 TSI', price: '210000', transmission: 'manual', drive: 'fwd',
    source_url: 'https://www.sauto.cz/osobni/detail/skoda/octavia/' + (210000000 + index),
    source_db: 'sauto', title: 'Skoda Octavia 1.5 TSI Style', kw: '110',
    brand_norm: 'skoda', model_norm: 'octavia', fuel_norm: 'benzin',
    transmission_norm: 'manual', drive_norm: 'fwd', motor_norm: '1 5 tsi',
    trim_norm: 'style', is_active: 1, ...row,
  })))();
  db.close();
  const api = initVehicleDb(file);
  t.after(() => {
    api.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('carprice-mileage-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return Object.assign(api, { fixturePath: file, fixtureDirectory: directory });
}

test('mileage changes the estimate with the SAME six comparables, not only their ordering', t => {
  const api = fixture(t, [...lowMileage, ...highMileage]);
  const low = api.estimatePrice({ ...input, mileage: 100000 });
  const high = api.estimatePrice({ ...input, mileage: 140000 });
  assert.equal(low.found, true);
  assert.equal(high.found, true);
  assert.equal(low.count, 6);
  assert.equal(high.count, 6);
  assert.equal(low.price_czk, 210000);
  assert.equal(high.price_czk, 170000);
  assert.equal(low.matching.mileage_applied, true);
  assert.equal(low.matching.price_method, 'mileage_weighted_median_v1');
  for (const result of [low, high]) {
    assert.ok(result.low_czk <= result.price_czk);
    assert.ok(result.price_czk <= result.high_czk);
    assert.equal(Object.values(result.source_counts).reduce((a, b) => a + b, 0), result.count);
  }
});

test('missing/zero requested mileage keeps the original unweighted estimate', t => {
  const api = fixture(t, [...lowMileage, ...highMileage]);
  for (const mileage of [undefined, null, '', 0, '0']) {
    const result = api.estimatePrice({ ...input, mileage });
    assert.equal(result.price_czk, 200000);
    assert.equal(result.count, 6);
    assert.equal(result.matching.mileage_applied, false);
    assert.equal(result.matching.price_method, 'median');
  }
});

test('mileage aliases and formatted kilometre inputs are equivalent', t => {
  const api = fixture(t, [...lowMileage, ...highMileage]);
  for (const name of ['mileage', 'mileageKm', 'odometerKm']) {
    for (const value of [100000, '100000', '100 000', '100\u00a0000 km', '100,000', '100.000']) {
      const result = api.estimatePrice({ ...input, [name]: value });
      assert.equal(result.price_czk, 210000);
      assert.equal(result.request.mileage_km, 100000);
    }
  }
});

test('malformed requested mileage cannot silently produce a broad estimate', t => {
  const api = fixture(t, lowMileage);
  for (const mileage of [-100000, '-100000', '100-200000', 'unknown', '100000 miles', NaN, Infinity, true]) {
    const result = api.estimatePrice({ ...input, mileage });
    assert.equal(result.found, false);
    assert.equal(result.price_czk, null);
    assert.equal(result.price_estimate_not_found_reason, 'missing_input');
  }
});

test('unknown, zero, negative and malformed advertisement mileage cannot change a mileage estimate', t => {
  const api = fixture(t, [...lowMileage, ...[null, '', '0', '-100000', 'unknown', '100000 miles', '1e5']
    .flatMap(mileage => Array.from({ length: 20 }, () => ({ mileage, price: 9000000 })))]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.count, 3);
  assert.equal(result.price_czk, 210000);
  assert.equal(api.findComps({ ...input, mileage: 100000 }, 3)[0].mileage, 100000);
});

test('formatted listing mileage is interpreted in kilometres, not as 100 km', t => {
  const api = fixture(t, [
    { mileage: '100.000 km', price: 200000 },
    { mileage: '100,000', price: 210000 },
    { mileage: '100\u00a0000', price: 220000 },
  ]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.price_czk, 210000);
});

test('three similar known-mileage offers suffice even with unequal distances', t => {
  const api = fixture(t, [
    { mileage: 95000, price: 220000 }, { mileage: 102000, price: 210000 },
    { mileage: 110000, price: 200000 },
  ]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.count, 3);
  assert.equal(result.price_czk, 210000);
});

test('unknown mileage does not satisfy minimum comparable support', t => {
  const api = fixture(t, [...lowMileage.slice(0, 2), ...Array(30).fill({ mileage: null })]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, false);
  assert.equal(result.count, 2);
  assert.equal(result.price_czk, null);
});

test('one close offer plus distant offers cannot masquerade as three effective comparables', t => {
  const api = fixture(t, [lowMileage[0], { mileage: 174000 }, { mileage: 175000 }]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.count, 3);
  assert.equal(result.found, false);
  assert.equal(result.price_czk, null);
  assert.ok(result.matching.mileage_effective_comparables < 2.5);
});

test('no extrapolation to a wholly unsupported mileage range', t => {
  const api = fixture(t, Array(30).fill({ mileage: 400000, price: 100000 }));
  const result = api.estimatePrice({ ...input, mileage: 10000 });
  assert.equal(result.found, false);
  assert.equal(result.count, 0);
  assert.equal(result.price_czk, null);
});

test('known mileage is considered before the 5000-candidate cap and the 120-price cap', t => {
  const api = fixture(t, [
    ...Array(5001).fill({ mileage: null, price: 5000000 }),
    ...Array(5001).fill({ mileage: 500000, price: 100000 }), ...lowMileage,
  ]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.count, 3);
  assert.equal(result.price_czk, 210000);
  assert.deepEqual(api.findComps({ ...input, mileage: 100000 }, 3).map(row => row.mileage), [100000, 100000, 100000]);
});

test('unusable mileage in the first year window cannot prevent the existing year fallback', t => {
  const api = fixture(t, [
    ...Array(25).fill({ mileage: null }),
    ...lowMileage.map(row => ({ ...row, year: 2022 })),
  ]);
  const result = api.estimatePrice({ ...input, mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.matching.year_window, 2);
  assert.equal(result.count, 3);
});

test('closer mileage never overrides engine, powertrain, trim, transmission, power or active status', t => {
  const forbidden = [
    { fuel: 'PHEV', motor: '1.5 TSI eHybrid' }, { fuel: 'Diesel', motor: '2.0 TDI' },
    { motor: '1.4 TSI', title: 'Octavia 1.4 TSI Style' }, { trim_norm: 'ambition', title: 'Octavia Ambition' },
    { transmission: 'automatic', transmission_norm: 'automatic' },
    { kw: 180 }, { is_active: 0 }, { source_db: 'caroffice-dealer-prodano' },
  ];
  const api = fixture(t, [...lowMileage.map(row => ({ ...row, mileage: 110000 })),
    ...forbidden.flatMap(row => Array(25).fill({ ...row, mileage: 100000, price: 9000000 }))]);
  const result = api.estimatePrice({ ...input, modelDetail: 'Style', transmission: 'manual', mileage: 100000 });
  assert.equal(result.found, true);
  assert.equal(result.count, 3);
  assert.equal(result.price_czk, 210000);
});

test('increasing mileage follows decreasing observed prices across a supported range', t => {
  const rows = [80000, 120000, 160000, 200000, 240000].flatMap(mileage =>
    [-5000, 0, 5000, 10000].map(offset => ({ mileage: mileage + offset, price: 400000 - mileage })));
  const api = fixture(t, rows);
  const results = [80000, 120000, 160000, 200000, 240000].map(mileage => api.estimatePrice({ ...input, mileage }));
  assert.ok(results.every(result => result.found));
  // Quantiles move in steps; do not manufacture a price change at every km.
  for (let i = 1; i < results.length; i++) assert.ok(results[i].price_czk <= results[i - 1].price_czk);
  assert.ok(new Set(results.map(result => result.price_czk)).size >= 4);
});

test('constant observed prices are not altered by an invented per-km depreciation rate', t => {
  const api = fixture(t, [...lowMileage, ...highMileage].map(row => ({ ...row, price: 200000 })));
  for (const mileage of [100000, 120000, 140000]) {
    assert.equal(api.estimatePrice({ ...input, mileage }).price_czk, 200000);
  }
});

test('insertion order cannot change a weighted median or its price interval', t => {
  const rows = [...lowMileage, ...highMileage];
  const a = fixture(t, rows), b = fixture(t, [...rows].reverse());
  for (const mileage of [100000, 120000, 140000]) {
    const first = a.estimatePrice({ ...input, mileage });
    const second = b.estimatePrice({ ...input, mileage });
    assert.deepEqual([first.price_czk, first.low_czk, first.high_czk],
      [second.price_czk, second.low_czk, second.high_czk]);
  }
});

test('mobile/web and legacy HTTP endpoints use the same mileage-sensitive prices', { timeout: 20000 }, async t => {
  const api = fixture(t, [...lowMileage, ...highMileage]);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    cwd: api.fixtureDirectory,
    env: { ...process.env, PORT: String(port), VEHICLES_DB_PATH: api.fixturePath,
      SQLITE_PATH: path.join(api.fixtureDirectory, 'cache.db'), VEHICLE_INGEST_API_KEY: '' },
    windowsHide: true, stdio: 'ignore',
  });
  try {
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(200) });
        ready = response.ok && (await response.json()).vehicleDbReady;
        if (ready) break;
      } catch { /* The isolated child has not started listening yet. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'isolated backend started with the fixture database');
    for (const route of ['/price/estimate', '/estimate', '/api/estimate']) {
      const values = [];
      for (const mileage of [100000, 140000]) {
        const response = await fetch(base + route, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, mileage }),
          signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.found, true);
        values.push(data.price_czk ?? data.price_estimate);
      }
      assert.deepEqual(values, [210000, 170000], route);
    }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
