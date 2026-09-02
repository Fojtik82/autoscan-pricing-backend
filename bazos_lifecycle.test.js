import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  hasSafeBazosCoverage,
  parseBazosListing,
  reconcileBazosLifecycle,
} from "./bazos_lifecycle.js";
import { ensureSautoLifecycleSchema } from "./sauto_lifecycle.js";

test("Bazos URL parser keeps domains separate", () => {
  assert.deepEqual(
    parseBazosListing("https://auto.bazos.cz/inzerat/223315917/renault-megane.php"),
    { domain: "auto.bazos.cz", id: 223315917, key: "auto.bazos.cz:223315917" },
  );
  assert.deepEqual(
    parseBazosListing("https://motorky.bazos.cz/inzerat/223289221/bmw-r1250gs.php"),
    { domain: "motorky.bazos.cz", id: 223289221, key: "motorky.bazos.cz:223289221" },
  );
  assert.equal(parseBazosListing("https://auto.bazos.cz/dodavka/"), null);
});

test("Bazos sitemap coverage allows live drift but rejects incomplete data", () => {
  assert.equal(hasSafeBazosCoverage(409_900, 410_000), true);
  assert.equal(hasSafeBazosCoverage(405_000, 410_000), false);
});

test("Bazos rows deactivate after three daily checks and reactivate", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE vehicle_app (source_url TEXT, title TEXT)");
  ensureSautoLifecycleSchema(db);
  const insert = db.prepare("INSERT INTO vehicle_app (source_url, title) VALUES (?, ?)");
  insert.run("https://auto.bazos.cz/inzerat/223315917/renault-megane.php", "live");
  insert.run("https://motorky.bazos.cz/inzerat/223289221/bmw-r1250gs.php", "missing");
  insert.run("https://www.sauto.cz/osobni/detail/skoda/octavia/210000001", "other");

  const live = new Set(["auto.bazos.cz:223315917"]);
  const first = reconcileBazosLifecycle(db, live, { now: new Date("2026-09-01T08:00:00Z") });
  assert.equal(first.newly_missing, 1);
  assert.equal(first.pending_missing, 1);

  const retry = reconcileBazosLifecycle(db, live, { now: new Date("2026-09-01T12:00:00Z") });
  assert.equal(retry.already_checked_today, 1);
  reconcileBazosLifecycle(db, live, { now: new Date("2026-09-02T08:00:00Z") });
  const third = reconcileBazosLifecycle(db, live, { now: new Date("2026-09-03T08:00:00Z") });
  assert.equal(third.deactivated, 1);

  const reactivated = reconcileBazosLifecycle(
    db,
    new Set(["auto.bazos.cz:223315917", "motorky.bazos.cz:223289221"]),
    { now: new Date("2026-09-04T08:00:00Z") },
  );
  assert.equal(reactivated.reactivated, 1);
  const row = db.prepare("SELECT * FROM vehicle_app WHERE title = 'missing'").get();
  assert.equal(row.is_active, 1);
  assert.equal(row.missing_checks, 0);
  assert.equal(row.inactive_at, null);
  assert.equal(
    db.prepare("SELECT missing_checks FROM vehicle_app WHERE title = 'other'").get().missing_checks,
    0,
  );
  db.close();
});
