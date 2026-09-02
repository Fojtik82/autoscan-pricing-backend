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
