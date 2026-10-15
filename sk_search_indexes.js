import Database from 'better-sqlite3';

// Both sides of the brand predicate need an index for SQLite's OR optimization.
export function createSkSearchIndexes(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS sk_vehicle_search
      ON vehicle_app(brand_norm,model_norm,year);
    CREATE INDEX IF NOT EXISTS sk_vehicle_brand_lower
      ON vehicle_app(lower(brand));`);
}

export function prepareSkSearchIndexes(filename) {
  const db = new Database(filename, { fileMustExist: true });
  try {
    createSkSearchIndexes(db);
  } finally {
    db.close();
  }
}
