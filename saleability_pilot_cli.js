import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { updateSaleabilityPilot, pilotStatus } from './saleability_pilot.js';
import { readSnapshot } from './saleability_model.js';

const args = process.argv.slice(2);
function value(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${flag}`);
  return args[index + 1];
}
const db = new Database(value('--database'), { fileMustExist: true });
try {
  const model = JSON.parse(fs.readFileSync(value('--model'), 'utf8'));
  const snapshot = readSnapshot(db);
  const runs = db.prepare('SELECT source,checked_at FROM listing_first_seen_runs').all();
  const completeSources = runs.filter(run => run.checked_at === snapshot.checked[run.source]).map(run => run.source);
  const inventoryBefore = db.prepare('SELECT COUNT(*) n FROM vehicle_app').get().n;
  const update = updateSaleabilityPilot(db, model, { snapshot, completeSources });
  const inventoryAfter = db.prepare('SELECT COUNT(*) n FROM vehicle_app').get().n;
  if (inventoryBefore !== inventoryAfter) throw new Error('Pilot changed inventory row count');
  const status = pilotStatus(db);
  if (!status.enabled || status.forecast_count === 0) throw new Error(`Pilot did not start: ${JSON.stringify(update)}`);
  const report = { update, status, inventory_rows_unchanged: inventoryAfter };
  const destination = value('--report');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Pilot SQLite integrity check failed');
  console.log(JSON.stringify(report, null, 2));
} finally { db.close(); }
