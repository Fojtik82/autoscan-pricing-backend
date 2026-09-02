import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  buildSautoListingUrl,
  ensureSautoLifecycleSchema,
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
