import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ensureSautoLifecycleSchema, reconcileSautoLifecycle } from './sauto_lifecycle.js';
import { reconcileBazosLifecycle } from './bazos_lifecycle.js';

const sauto = id => `https://www.sauto.cz/osobni/detail/skoda/octavia/${id}`;
const bazos = id => `https://auto.bazos.cz/inzerat/${id}/auto.php`;
const day = n => new Date(`2026-10-${String(n).padStart(2, '0')}T08:00:00Z`);

test('legacy migration uses live evidence, never a missing check or inferred publication date', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE vehicle_app(source_url TEXT, last_seen_at TEXT, last_checked_at TEXT)');
    db.prepare('INSERT INTO vehicle_app VALUES (?,?,?)').run(sauto(1), day(1).toISOString(), day(5).toISOString());
    db.prepare('INSERT INTO vehicle_app VALUES (?,?,?)').run(sauto(2), null, day(5).toISOString());
    ensureSautoLifecycleSchema(db);
    const rows = db.prepare('SELECT * FROM vehicle_app ORDER BY rowid').all();
    assert.equal(rows[0].first_seen_at, day(1).toISOString());
    assert.equal(rows[0].first_seen_is_observed, 0);
    assert.equal(rows[0].first_seen_evidence, 'legacy_last_seen');
    assert.equal(rows[1].first_seen_at, null);
    ensureSautoLifecycleSchema(db);
    assert.equal(db.prepare('SELECT first_seen_at FROM vehicle_app WHERE rowid=2').get().first_seen_at, null);
  } finally { db.close(); }
});

for (const source of ['sauto', 'bazos']) {
  test(`${source}: full index retains first sighting before import, bounds new arrivals, survives disappearance`, () => {
    const db = new Database(':memory:');
    const url = source === 'sauto' ? sauto : bazos;
    const live = ids => new Set(ids.map(id => source === 'sauto' ? id : `auto.bazos.cz:${id}`));
    const reconcile = (ids, n, extra = {}) => (source === 'sauto' ? reconcileSautoLifecycle : reconcileBazosLifecycle)(db, live(ids), { now: day(n), ...extra });
    try {
      db.exec('CREATE TABLE vehicle_app(source_url TEXT)');
      ensureSautoLifecycleSchema(db);
      reconcile([1], 1); // Baseline: ad 1 already exists, but is not imported.
      reconcile([1, 2], 2); // Ad 2 appears after a complete prior index.
      db.prepare('INSERT INTO vehicle_app(source_url,last_seen_at) VALUES (?,?)').run(url(1), day(3).toISOString());
      db.prepare('INSERT INTO vehicle_app(source_url,last_seen_at) VALUES (?,?)').run(url(2), day(3).toISOString());
      db.prepare('INSERT INTO vehicle_app(source_url,last_seen_at) VALUES (?,?)').run(url(2) + '?duplicate=1', day(3).toISOString());
      reconcile([1, 2], 3);
      const rows = db.prepare('SELECT * FROM vehicle_app ORDER BY rowid').all();
      assert.equal(rows[0].first_seen_at, day(1).toISOString());
      assert.equal(rows[0].first_seen_is_observed, 0);
      assert.equal(rows[1].first_seen_at, day(2).toISOString());
      assert.equal(rows[1].first_seen_after_at, day(1).toISOString());
      assert.equal(rows[1].first_seen_is_observed, 1);
      assert.equal(rows[2].first_seen_at, rows[1].first_seen_at);
      for (const n of [4, 5, 6]) reconcile([], n);
      assert.equal(db.prepare('SELECT is_active FROM vehicle_app LIMIT 1').get().is_active, 0);
      reconcile([1, 2], 7);
      assert.equal(db.prepare('SELECT first_seen_at FROM vehicle_app LIMIT 1').get().first_seen_at, day(1).toISOString());
      const before = db.prepare('SELECT * FROM listing_first_seen_runs').all();
      reconcile([3], 8, { dryRun: true });
      assert.deepEqual(db.prepare('SELECT * FROM listing_first_seen_runs').all(), before);
      assert.throws(() => reconcile([1], 1), /timestamp rollback/);
    } finally { db.close(); }
  });
}
