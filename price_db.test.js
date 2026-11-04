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
