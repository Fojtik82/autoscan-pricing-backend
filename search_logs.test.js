import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initSearchLogsDb, normalizeSearchLog } from "./search_logs.js";

test("normalizeSearchLog keeps vehicle search fields in safe shapes", () => {
  const row = normalizeSearchLog(
    {
      vin: " tmbaG7ne9e0117046 ",
      brand: "BMW",
      model: "320d",
      modelDetail: "320D XDRIVE",
      year: "2017",
      mileageKm: "154000",
      fuel: "Nafta",
      drive: "4x4",
      transmission: "Automat",
      kw: "140",
      estimatedPriceCzk: "355000",
      found: true,
      priceSource: "local_db",
    },
    { userAgent: "test-agent" },
  );

  assert.equal(row.vin, "TMBAG7NE9E0117046");
  assert.equal(row.brand, "BMW");
  assert.equal(row.model, "320d");
  assert.equal(row.year, 2017);
  assert.equal(row.mileage_km, 154000);
  assert.equal(row.kw, 140);
  assert.equal(row.estimated_price_czk, 355000);
  assert.equal(row.found, 1);
  assert.equal(row.user_agent, "test-agent");

  const notFound = normalizeSearchLog({
    brand: "BMW",
    model: "3",
    resultCount: 0,
    found: false,
    estimatedPriceCzk: 0,
  });

  assert.equal(notFound.result_count, 0);
  assert.equal(notFound.found, 0);
  assert.equal(notFound.estimated_price_czk, 0);
});

test("search log db inserts, lists, and summarizes searches", () => {
  const dir = mkdtempSync(join(tmpdir(), "carprice-search-log-"));
  const dbPath = join(dir, "logs.db");

  try {
    const logs = initSearchLogsDb(dbPath);
    const inserted = logs.insert({
      vin: "TMBAG7NE9E0117046",
      brand: "Skoda",
      model: "Octavia",
      year: 2017,
      mileageKm: 120000,
      fuel: "Nafta",
      drive: "Predni",
      transmission: "Manual",
      kw: 85,
      estimatedPriceCzk: 210000,
      resultCount: 12,
      found: true,
      priceSource: "backend",
      platform: "android",
      appVersion: "1.0.0",
      buildNumber: "33",
    });

    assert.equal(typeof inserted.id, "number");

    const rows = logs.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vin, "TMBAG7NE9E0117046");
    assert.equal(rows[0].brand, "Skoda");
    assert.equal(rows[0].model, "Octavia");
    assert.equal(rows[0].estimated_price_czk, 210000);

    const summary = logs.summary({ days: 1 });
    assert.equal(summary.total, 1);
    assert.equal(summary.found_total, 1);
    assert.equal(summary.top_models[0].brand, "Skoda");
    assert.equal(summary.top_models[0].model, "Octavia");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
