import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  buildSautoListingUrl,
  ensureSautoLifecycleSchema,
  fetchSautoBucketWithRecovery,
  hasSafeSautoCoverage,
  hasSautoLifecycleSchema,
  parseSautoListingId,
  reconcileSautoLifecycle,
  sautoDailySourceDb,
} from "./sauto_lifecycle.js";

test("Sauto coverage accepts tiny duplicate drift but rejects incomplete scans", () => {
  assert.equal(hasSafeSautoCoverage(6676, 6677), true);
  assert.equal(hasSafeSautoCoverage(6666, 6677), false);
  assert.equal(hasSafeSautoCoverage(99_900, 100_000), true);
  assert.equal(hasSafeSautoCoverage(99_899, 100_000), false);
});

function bucketScan(bucket, firstId, count, prices = []) {
  const ids = new Set(Array.from({ length: count }, (_, index) => firstId + index));
  return { ...bucket, ids, prices: new Map(prices), liveTotal: bucket.plannedTotal };
}

test("a complete Sauto bucket does not require recovery scans", async () => {
  const bucket = { categoryId: 838, priceFrom: 100, priceTo: 199, plannedTotal: 30 };
  const scanned = bucketScan(bucket, 1, 30);
  const result = await fetchSautoBucketWithRecovery(bucket, {
    scan: async () => scanned,
    searchTotal: async () => assert.fail("complete range must not be split"),
  });
  assert.equal(result, scanned);
});

test("an incomplete 7113/7126 Sauto bucket recovers through validated subranges", async () => {
  const bucket = { categoryId: 838, priceFrom: 100000, priceTo: 199999, plannedTotal: 7126 };
  const counted = [];
  const scanned = [];
  const logs = [];
  const result = await fetchSautoBucketWithRecovery(bucket, {
    searchTotal: async (categoryId, from, to) => {
      counted.push([categoryId, from, to]);
      return from === 100000 ? 3500 : 3626;
    },
    scan: async (range) => {
      scanned.push([range.priceFrom, range.priceTo]);
      if (range === bucket) return bucketScan(range, 9000, 7113, [["sauto:9000", 180000]]);
      if (range.priceFrom === 100000) return bucketScan(range, 1, 3500, [["sauto:1", 120000]]);
      return bucketScan(range, 3501, 3626, [["sauto:3501", 170000]]);
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(counted, [[838, 100000, 149999], [838, 150000, 199999]]);
  assert.deepEqual(scanned, [[100000, 199999], [100000, 149999], [150000, 199999]]);
  assert.equal(result.ids.size, 7126);
  assert.equal(result.ids.has(9000), false, "partial parent results cannot make a split pass");
  assert.deepEqual([...result.prices], [["sauto:1", 120000], ["sauto:3501", 170000]]);
  assert.match(logs[0], /splitting.*7113\/7126/);
  assert.match(logs[1], /recovered.*7126\/7126/);
});

test("a split still rejects duplicated IDs across individually complete subranges", async () => {
  const bucket = { categoryId: 838, priceFrom: 100, priceTo: 199, plannedTotal: 80 };
  await assert.rejects(fetchSautoBucketWithRecovery(bucket, {
    searchTotal: async () => 40,
    scan: async (range) => range === bucket
      ? bucketScan(range, 1, 66)
      : bucketScan(range, range.priceFrom === 100 ? 1 : 27, 40),
    log: () => {},
  }), /Incomplete Sauto active-index bucket after splitting.*66\/80/);
});

test("a persistently incomplete Sauto range stops at the split depth limit", async () => {
  const ranges = [];
  await assert.rejects(fetchSautoBucketWithRecovery(
    { categoryId: 838, priceFrom: 0, priceTo: 15, plannedTotal: 100 },
    {
      searchTotal: async () => 100,
      scan: async (range) => {
        ranges.push([range.priceFrom, range.priceTo]);
        return bucketScan(range, 1, 0);
      },
      log: () => {},
    },
  ), /Incomplete Sauto active-index bucket.*price 0-1: 0\/100/);
  assert.deepEqual(ranges, [[0, 15], [0, 7], [0, 3], [0, 1]]);
});

test("daily Sauto URLs and source names follow the vehicle category", () => {
  const baseItem = {
    id: 210000010,
    manufacturer_cb: { seo_name: "ford" },
    model_cb: { seo_name: "transit" },
  };
  const utility = { ...baseItem, category: { id: 839, seo_name: "uzitkova" } };
  assert.equal(
    buildSautoListingUrl(utility),
    "https://www.sauto.cz/uzitkova/detail/ford/transit/210000010",
  );
  assert.equal(sautoDailySourceDb(utility), "sauto_uzitkova_1den_cloud");

  const motorcycle = {
    ...baseItem,
    id: 210000011,
    category: { id: 841, seo_name: "motorky" },
    manufacturer_cb: { seo_name: "honda" },
    model_cb: { seo_name: "cb-500" },
  };
  assert.equal(
    buildSautoListingUrl(motorcycle),
    "https://www.sauto.cz/motorky/detail/honda/cb-500/210000011",
  );
  assert.equal(sautoDailySourceDb(motorcycle), "sauto_motorky_1den_cloud");
});

test("parseSautoListingId accepts canonical listing URLs only", () => {
  assert.equal(
    parseSautoListingId("https://www.sauto.cz/osobni/detail/skoda/octavia/210000001"),
    210000001,
  );
  assert.equal(
    parseSautoListingId("https://sauto.cz/uzitkova/detail/ford/transit/210000002?foo=1"),
    210000002,
  );
  assert.equal(parseSautoListingId("https://example.test/210000001"), null);
  assert.equal(parseSautoListingId("https://i.imedia.cz/v2/click?utm_source=sauto.cz"), null);
});

test("Sauto rows become inactive after three missing checks and can reactivate", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE vehicle_app (source_url TEXT, title TEXT)");
  ensureSautoLifecycleSchema(db);
  assert.equal(hasSautoLifecycleSchema(db), true);

  const insert = db.prepare("INSERT INTO vehicle_app (source_url, title) VALUES (?, ?)");
  insert.run("https://www.sauto.cz/osobni/detail/skoda/octavia/210000001", "live");
  insert.run("https://www.sauto.cz/osobni/detail/skoda/fabia/210000002", "missing");
  insert.run("https://example.test/car/3", "other source");
  insert.run("https://i.imedia.cz/v2/click?utm_source=sauto.cz", "invalid Sauto URL");

  const liveIds = new Set([210000001]);
  const first = reconcileSautoLifecycle(db, liveIds, {
    now: new Date("2026-09-01T08:00:00Z"),
  });
  assert.equal(first.newly_missing, 1);
  assert.equal(first.pending_missing, 1);
  assert.equal(first.invalid_urls, 1);

  const retry = reconcileSautoLifecycle(db, liveIds, {
    now: new Date("2026-09-01T12:00:00Z"),
  });
  assert.equal(retry.already_checked_today, 1);
  assert.equal(
    db.prepare("SELECT missing_checks FROM vehicle_app WHERE title = 'missing'").get().missing_checks,
    1,
  );

  reconcileSautoLifecycle(db, liveIds, { now: new Date("2026-09-02T08:00:00Z") });
  const third = reconcileSautoLifecycle(db, liveIds, {
    now: new Date("2026-09-03T08:00:00Z"),
  });
  assert.equal(third.deactivated, 1);

  let missing = db.prepare("SELECT * FROM vehicle_app WHERE title = 'missing'").get();
  assert.equal(missing.is_active, 0);
  assert.equal(missing.missing_checks, 3);
  assert.equal(missing.missing_since, "2026-09-01T08:00:00.000Z");
  assert.equal(missing.inactive_at, "2026-09-03T08:00:00.000Z");

  const reactivated = reconcileSautoLifecycle(db, new Set([210000001, 210000002]), {
    now: new Date("2026-09-04T08:00:00Z"),
  });
  assert.equal(reactivated.reactivated, 1);
  missing = db.prepare("SELECT * FROM vehicle_app WHERE title = 'missing'").get();
  assert.equal(missing.is_active, 1);
  assert.equal(missing.missing_checks, 0);
  assert.equal(missing.missing_since, null);
  assert.equal(missing.inactive_at, null);

  const other = db.prepare("SELECT * FROM vehicle_app WHERE title = 'other source'").get();
  assert.equal(other.is_active, 1);
  assert.equal(other.missing_checks, 0);
  db.close();
});
