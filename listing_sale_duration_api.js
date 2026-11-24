import Database from 'better-sqlite3';
import { listingSaleDuration } from './listing_sale_duration.js';

function validInput(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') return false;
  for (const field of ['brand', 'model']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 100) return false;
  }
  for (const field of ['fuel', 'motor', 'transmission', 'drive']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 200)) return false;
  }
  for (const field of ['year', 'mileage_km', 'engine_l', 'engine_ccm', 'kw']) {
    if (input[field] !== undefined && (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] < 0)) return false;
  }
  if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2100)) return false;
  return input.source === undefined || ['sauto', 'bazos'].includes(input.source);
}

export function registerListingSaleDurationApi(app, databasePath) {
  // This descriptive statistic uses completed listing durations directly. It is
  // independent of the experimental 30-day inactivity prediction pilot.
  app.post('/market/sale-duration', (req, res) => {
    if (!validInput(req.body)) return res.status(400).json({ found: false, reason: 'invalid_sale_duration_query' });
    let db;
    try {
      db = new Database(databasePath, { readonly: true, fileMustExist: true });
      // Map historical pages instead of repeatedly copying random rows from
      // the large archive. These pragmas affect only this read-only handle.
      db.pragma('mmap_size = 1073741824');
      db.pragma('cache_size = -65536');
      return res.json(listingSaleDuration(db, req.body));
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ found: false, reason: 'invalid_sale_duration_query' });
      console.error('Listing duration query failed:', error.message);
      return res.status(503).json({ found: false, reason: 'sale_duration_unavailable' });
    } finally {
      db?.close();
    }
  });
}
