import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { initVehicleDb } from "./price_db.js";

test("price estimates and comps exclude inactive rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "carprice-active-filter-"));
  const dbPath = path.join(directory, "vehicles.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE vehicle_app (
      brand TEXT, model TEXT, year TEXT, mileage TEXT, fuel TEXT, motor TEXT,
      price TEXT, transmission TEXT, drive TEXT, source_url TEXT, source_db TEXT,
      title TEXT, kw TEXT, brand_norm TEXT, model_norm TEXT, fuel_norm TEXT,
      transmission_norm TEXT, drive_norm TEXT, motor_norm TEXT, trim_norm TEXT,
      is_active INTEGER
    )
  `);
  const insert = db.prepare(`
    INSERT INTO vehicle_app VALUES (
      'Skoda', 'Octavia', '2020', '100000', 'Benzin', '1.5 TSI', ?,
      'manual', 'Predni', ?, 'sauto_1den', 'Skoda Octavia', '110',
      'skoda', 'octavia', 'benzin', 'manual', 'fwd', '1 5 tsi', '', ?
    )
  `);
  insert.run("100000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000001", 1);
  insert.run("200000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000002", 1);
  insert.run("300000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000003", 1);
  insert.run("5000000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000004", 0);
  insert.run("6000000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000005", 0);
  insert.run("7000000", "https://www.sauto.cz/osobni/detail/skoda/octavia/210000006", 0);
  db.close();

  const vehicleDb = initVehicleDb(dbPath);
  const input = { brand: "Skoda", model: "Octavia", year: 2020, fuel: "benzin" };
  const estimate = vehicleDb.estimatePrice(input);
  assert.equal(estimate.found, true);
  assert.equal(estimate.count, 3);
  assert.equal(estimate.price_czk, 200000);
  assert.deepEqual(
    vehicleDb.findComps(input, 10).map((vehicle) => vehicle.price_czk).sort((a, b) => a - b),
    [100000, 200000, 300000],
  );
  assert.deepEqual(vehicleDb.health(), {
    ok: true,
    path: path.resolve(dbPath),
    table: "vehicle_app",
    count: 6,
    active_count: 3,
    inactive_count: 3,
    active_filter: true,
  });
  vehicleDb.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('exact-year estimates never widen the year or borrow adjacent-year prices', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-exact-year-'));
  const file = path.join(directory, 'vehicles.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE vehicle_app (
    brand, model, year, mileage, fuel, motor, price, transmission, drive,
    source_url, source_db, title, kw, brand_norm, model_norm, fuel_norm,
    transmission_norm, drive_norm, motor_norm, trim_norm, is_active)`);
  const insert = db.prepare(`INSERT INTO vehicle_app VALUES (
    'Skoda','Octavia',?,'100000','Benzin','1.5 TSI',?,'manual','Predni',?,
    'sauto','Skoda Octavia','110','skoda','octavia','benzin','manual','fwd','1 5 tsi','',1)`);
  let id = 210000000;
  for (const year of [2016, 2017, 2018, 2019, 2020]) {
    for (const price of year === 2018 ? [270000, 280000, 290000] : [900000, 950000, 990000, 1000000, 1100000, 1200000]) {
      insert.run(String(year), String(price), `https://www.sauto.cz/osobni/detail/skoda/octavia/${++id}`);
    }
  }
  db.close();
  const api = initVehicleDb(file);
  t.after(() => { api.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const input = { brand: 'Skoda', model: 'Octavia', year: 2018, fuel: 'Benzin', exact_year: true };
  const result = api.estimatePrice(input);
  assert.equal(result.found, true);
  assert.equal(result.price_czk, 280000);
  assert.equal(result.count, 3);
  assert.equal(result.matching.year_window, 0);
  assert.equal(result.used_filters.yearWindow, 0);
  assert.ok(api.findComps(input, 5000).every(row => row.year === 2018));
  const absent = api.estimatePrice({ ...input, year: 2021 });
  assert.equal(absent.found, false);
  assert.equal(absent.count, 0);
  assert.equal(absent.matching.year_window, 0);
});

test('Renault Megane Scenic and Scenic share comparables, separate from Grand Scenic', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-scenic-alias-'));
  const file = path.join(directory, 'vehicles.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE vehicle_app (
    brand, model, year, mileage, fuel, motor, price, transmission, drive,
    source_url, source_db, title, kw, brand_norm, model_norm, fuel_norm,
    transmission_norm, drive_norm, motor_norm, trim_norm, is_active)`);
  const insert = db.prepare(`INSERT INTO vehicle_app VALUES (
    'Renault',?,'2009','210000','Nafta','1.5 dCi',?,'manual','Predni',?,
    'sauto',?,'78','renault',?,'diesel','manual','fwd','1 5 dci','',1)`);
  const listings = [
    ['Scenic', 'scenic', 'Renault Scénic 1.5 dCi', 60000],
    ['Megane Scenic', 'megane scenic', 'Renault Mégane Scénic 1.5 dCi', 65000],
    ['Megane', 'megane', 'Renault Mégane Scénic 1.5 dCi', 70000],
    ['GrandScenic', 'grandscenic', 'Renault GrandScénic 1.5 dCi', 90000],
    ['Grand Scenic', 'grand scenic', 'Renault Grand Scénic 1.5 dCi', 95000],
    ['Scenic', 'scenic', 'Renault Grand Scénic 1.5 dCi', 100000],
    ['Megane', 'megane', 'Renault Mégane 1.5 dCi', 20000],
  ];
  listings.forEach(([model, modelNorm, title, price], index) => {
    insert.run(model, String(price), `https://www.sauto.cz/detail/${index}`, title, modelNorm);
  });
  db.close();

  const api = initVehicleDb(file);
  t.after(() => { api.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = { brand: 'Renault', year: 2009, fuel: 'nafta', exact_year: true };
  for (const [model, prices] of [
    ['Mégane Scénic', [60000, 65000, 70000]],
    ['Scenic', [60000, 65000, 70000]],
    ['Grand Scénic', [90000, 95000, 100000]],
  ]) {
    const input = { ...base, model };
    const estimate = api.estimatePrice(input);
    assert.equal(estimate.found, true, model);
    assert.equal(estimate.count, prices.length, model);
    assert.equal(estimate.price_czk, prices[1], model);
    assert.deepEqual(api.findComps(input).map(row => row.price_czk).sort((a, b) => a - b), prices);
  }
});
