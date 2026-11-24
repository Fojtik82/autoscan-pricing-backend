import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureListingSaleDurationIndexes } from './listing_sale_duration_schema.js';

test('duration lookup searches both raw and normalized models without a full table scan', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE vehicle_app(brand TEXT,model TEXT,brand_norm TEXT,model_norm TEXT)');
    ensureListingSaleDurationIndexes(db);
    ensureListingSaleDurationIndexes(db);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM vehicle_app WHERE
      (brand COLLATE NOCASE IN (?) AND model COLLATE NOCASE IN (?)) OR
      (brand_norm COLLATE NOCASE IN (?) AND model_norm COLLATE NOCASE IN (?))`)
      .all('Škoda', 'Octavia', 'skoda', 'octavia');
    assert.equal(plan.some(row => /SCAN vehicle_app/.test(row.detail)), false);
    assert.equal(plan.filter(row => /SEARCH vehicle_app USING INDEX/.test(row.detail)).length, 2);
  } finally { db.close(); }
});
