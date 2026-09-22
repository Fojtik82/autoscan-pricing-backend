import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { ensureVehicleDatabase } from './vehicle_db_archive.js';
import { bazosDetailPriceObservation, bazosPagePriceObservations,
  existingPriceTargets, fillMissingPriceObservations, applyExistingPriceRefresh } from './daily_price_refresh.js';

test('streaming restore preserves bytes and never replaces an existing database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-stream-test-'));
  const file = path.join(directory, 'vehicles.db');
  try {
    const payload = Buffer.alloc(3 * 1024 * 1024, 73);
    fs.writeFileSync(file + '.gz', gzipSync(payload));
    assert.equal((await ensureVehicleDatabase(file)).prepared, true);
    assert.deepEqual(fs.readFileSync(file), payload);
    fs.writeFileSync(file + '.gz', 'broken archive');
    assert.equal((await ensureVehicleDatabase(file)).prepared, false);
    assert.deepEqual(fs.readFileSync(file), payload);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('truncated archive cannot publish a partial database and cleans its temporary file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-stream-test-'));
  const file = path.join(directory, 'vehicles.db');
  try {
    const archive = gzipSync(Buffer.alloc(1024 * 1024, 65));
    fs.writeFileSync(file + '.gz', archive.subarray(0, archive.length - 8));
    await assert.rejects(ensureVehicleDatabase(file));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(directory), ['vehicles.db.gz']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const url = 'https://auto.bazos.cz/inzerat/223864405/jeep-grand-cherokee-wk2-30d-177kw.php';
const key = 'auto.bazos.cz:223864405';
const detail = (price) => `<link rel="canonical" href="${url}"><h1 class="nadpisdetail">Jeep</h1><table><tr><td>Cena:</td><td><span>${price}</span></td></tr></table>`;

test('Nerozhoduje is an explicit nonnumeric price in both index and detail', () => {
  assert.equal(bazosDetailPriceObservation(detail('Nerozhoduje'), {url, key}).state, 'unpriced');
  const page = `<div class="inzeraty inzeratyflex"><a href="${url}">Jeep</a><div class="inzeratycena">Nerozhoduje</div></div>`;
  assert.equal(bazosPagePriceObservations(page, {host:'auto.bazos.cz'}).get(key).state, 'unpriced');
  assert.equal(bazosDetailPriceObservation(detail('unexpected text'), {url, key}).state, 'unknown');
  assert.equal(bazosDetailPriceObservation(detail('Nerozhoduje'), {url, key:'auto.bazos.cz:999999999'}).state, 'unknown');
});

test('Nerozhoduje completes refresh, clears asking price and preserves numeric history', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE vehicle_app(source_url TEXT, price TEXT)');
    db.prepare('INSERT INTO vehicle_app VALUES (?,?)').run(url, '300000');
    const targets = existingPriceTargets(db, 'bazos', new Set([key]));
    assert.equal(targets.length, 1);
    const prices = new Map();
    const details = await fillMissingPriceObservations(targets, prices,
      (target) => bazosDetailPriceObservation(detail('Nerozhoduje'), target));
    assert.equal(details.failed, 0);
    const result = applyExistingPriceRefresh(db, 'bazos', targets, prices, {details});
    assert.equal(result.complete, true);
    assert.equal(result.unpriced, 1);
    assert.equal(db.prepare('SELECT price FROM vehicle_app').get().price, null);
    assert.equal(db.prepare('SELECT last_numeric_price FROM listing_price_observations').get().last_numeric_price, 300000);
  } finally { db.close(); }
});
