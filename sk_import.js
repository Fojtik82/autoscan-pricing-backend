import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { makeReader } from './niche_sources.js';
import { SK_SOURCES, parseSkListing, sitemapLocations, parseSkDetail, skDetailGone } from './sk_sources.js';
import { compressVehicleDatabase, ensureVehicleDatabase } from './vehicle_db_archive.js';

const FIELDS = ['brand','model','year','mileage','fuel','motor','price','transmission','drive','vin','kw','body',
  'source_url','source_db','source_id','market','currency','title','brand_norm','model_norm','fuel_norm',
  'transmission_norm','drive_norm','motor_norm','trim_norm','last_seen_at','last_checked_at','missing_since','inactive_at'];

export function createSkDatabase(filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  const existing = db.prepare("PRAGMA table_info(vehicle_app)").all();
  if (existing.length && (!existing.some(c => c.name === 'market') ||
      !existing.some(c => c.name === 'currency') ||
      db.prepare("SELECT 1 FROM vehicle_app WHERE market IS NOT 'SK' OR currency IS NOT 'EUR' LIMIT 1").get())) {
    db.close(); throw new Error('Refusing to import SK listings into a different market database');
  }
  db.pragma('journal_mode = DELETE');
  db.exec(`CREATE TABLE IF NOT EXISTS vehicle_app (
    ${FIELDS.map(f => `${f} TEXT`).join(',')}, is_active INTEGER NOT NULL DEFAULT 1,
    missing_checks INTEGER NOT NULL DEFAULT 0, UNIQUE(source_db,source_id));
    CREATE INDEX IF NOT EXISTS sk_vehicle_search ON vehicle_app(brand_norm,model_norm,year);
    CREATE TABLE IF NOT EXISTS sk_source_runs (source TEXT PRIMARY KEY, checked_at TEXT,
      index_count INTEGER, index_complete INTEGER, parsed_count INTEGER, detail_errors INTEGER);`);
  return db;
}

export function saveSkRows(db, rows) {
  const fields = [...FIELDS, 'is_active', 'missing_checks'];
  const put = db.prepare(`INSERT INTO vehicle_app (${fields.join(',')})
    VALUES (${fields.map(f => '@'+f).join(',')}) ON CONFLICT(source_db,source_id) DO UPDATE SET
    ${fields.filter(f => !['source_db','source_id'].includes(f)).map(f => `${f}=excluded.${f}`).join(',')}`);
  db.transaction(() => {
    for (const row of rows) {
      const identity = parseSkListing(row.source_url);
      if (!identity || identity.source !== row.source_db || identity.id !== row.source_id ||
          row.market !== 'SK' || row.currency !== 'EUR' || !Number.isFinite(Number(row.price)) || Number(row.price) < 100)
        throw new Error('Invalid SK record');
      put.run(Object.fromEntries(fields.map(f => [f, row[f] ?? null])));
    }
  })();
}

export function reconcileSkMissing(db, source, liveIds, { complete, now, threshold = 3 } = {}) {
  if (!complete || liveIds.size === 0) return 0;
  const previous = db.prepare('SELECT index_count FROM sk_source_runs WHERE source=? AND index_complete=1').get(source);
  if (previous && liveIds.size < previous.index_count * 0.9) return 0;
  let marked = 0;
  const missing = db.prepare(`UPDATE vehicle_app SET missing_checks=missing_checks+1,
    missing_since=COALESCE(missing_since,?), is_active=CASE WHEN missing_checks+1>=? THEN 0 ELSE is_active END,
    inactive_at=CASE WHEN missing_checks+1>=? THEN ? ELSE inactive_at END WHERE rowid=?`);
  db.transaction(() => {
    for (const row of db.prepare('SELECT rowid,source_id FROM vehicle_app WHERE source_db=?').all(source)) {
      if (!liveIds.has(row.source_id)) { missing.run(now, threshold, threshold, now, row.rowid); marked++; }
    }
  })();
  return marked;
}

const relevantSitemap = (source, url) => source.id === 'bazos_sk' ||
  /sitemap-listings-(?:osobne-vozidla|suv-terenne-vozidla|uzitkove-vozidla-do-3-5t|motocykle|veterany)/.test(new URL(url).pathname);

export async function discoverSkListings(source, read, { maxSitemaps = 500 } = {}) {
  const queue = [`https://${source.host}${source.sitemap}`];
  const visited = new Set(), listings = new Map();
  while (queue.length) {
    if (visited.size >= maxSitemaps) return { listings, complete: false };
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const result = await read(url);
    if (result.status !== 200) throw new Error('Sitemap HTTP ' + result.status);
    const locations = sitemapLocations(result.html);
    for (const loc of locations) {
      const u = new URL(loc);
      if (u.hostname !== source.host || u.protocol !== 'https:') continue;
      if (/<sitemapindex\b/i.test(result.html)) {
        if (relevantSitemap(source, loc)) queue.push(loc);
      } else {
        const item = parseSkListing(loc);
        if (item?.source === source.id) listings.set(item.id, item);
      }
    }
  }
  return { listings, complete: listings.size > 0 };
}

export async function updateSkSources(db, { maxDetails = 5000, maxSitemaps = 500,
  sources = SK_SOURCES, taxonomyRows = [], readerFactory = makeReader, dryRun = false } = {}) {
  const summaries = [];
  for (const source of sources) {
    const now = new Date().toISOString();
    const summary = { source: source.id, market: 'SK', currency: 'EUR', ok: false, index_complete: false,
      index_count: 0, details_checked: 0, parsed: 0, rejected: 0, errors: 0, missing: 0, limited: false };
    try {
      const read = await readerFactory({ ...source, maxResponseBytes: 32 * 1024 * 1024,
        requestDelayMs: process.env.SK_REQUEST_DELAY_MS ?? 600 });
      const index = await discoverSkListings(source, read, { maxSitemaps });
      summary.index_count = index.listings.size;
      summary.index_complete = index.complete;
      // Round-robin by oldest verified detail. A bounded run must not forever
      // refresh the same first page while the rest of the catalogue starves.
      const existing = new Map(db.prepare('SELECT source_id,last_checked_at FROM vehicle_app WHERE source_db=?')
        .all(source.id).map(r => [r.source_id, r.last_checked_at]));
      const candidates = [...index.listings.values()].sort((a,b) =>
        (existing.get(a.id) ?? '').localeCompare(existing.get(b.id) ?? '') || a.id.localeCompare(b.id));
      summary.limited = candidates.length > maxDetails;
      for (const item of candidates.slice(0, maxDetails)) {
        try {
          const detail = await read(item.url);
          summary.details_checked++;
          if ([404,410].includes(detail.status) || skDetailGone(detail.html)) {
            if (!dryRun) db.prepare('UPDATE vehicle_app SET is_active=0,inactive_at=?,last_checked_at=? WHERE source_db=? AND source_id=?')
              .run(now, now, source.id, item.id);
            continue;
          }
          const row = parseSkDetail(detail.html, item.url, taxonomyRows, now);
          if (!row) { summary.rejected++; continue; }
          if (!dryRun) saveSkRows(db, [row]);
          summary.parsed++;
        } catch (error) { summary.errors++; summary.last_error = error.message; }
      }
      if (!dryRun) {
        summary.missing = reconcileSkMissing(db, source.id, new Set(index.listings.keys()), { complete: index.complete, now });
        // Keep the last good coverage baseline on an incomplete or suspicious run.
        const previous = db.prepare('SELECT index_count FROM sk_source_runs WHERE source=?').get(source.id);
        const safe = index.complete && (!previous || index.listings.size >= previous.index_count * 0.9);
        if (safe) db.prepare(`INSERT OR REPLACE INTO sk_source_runs VALUES (?,?,?,?,?,?)`)
          .run(source.id, now, index.listings.size, 1, summary.parsed, summary.errors);
      }
      summary.ok = index.complete && summary.errors === 0 &&
        (summary.details_checked === 0 || summary.parsed > 0);
    } catch (error) { summary.error = error.message; }
    summaries.push(summary);
    console.log('SK_IMPORT ' + JSON.stringify(summary));
  }
  return summaries;
}

async function main() {
  if (process.env.CARPRICE_MARKET && process.env.CARPRICE_MARKET !== 'SK')
    throw new Error('The SK importer requires CARPRICE_MARKET=SK');
  const filename = path.resolve(process.env.SK_VEHICLES_DB_PATH ?? './data/vehicles_sk.db');
  if (fs.existsSync(filename + '.gz')) await ensureVehicleDatabase(filename);
  const db = createSkDatabase(filename);
  const dryRun = process.argv.includes('--dry-run');
  const taxonomyRows = db.prepare('SELECT DISTINCT brand,model FROM vehicle_app').all();
  const summaries = await updateSkSources(db, { dryRun, taxonomyRows,
    maxDetails: Number(process.env.SK_MAX_DETAILS_PER_SOURCE ?? 5000),
    maxSitemaps: Number(process.env.SK_MAX_SITEMAPS ?? 500) });
  db.close();
  if (!dryRun) await compressVehicleDatabase(filename);
  if (summaries.some(s => !s.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
