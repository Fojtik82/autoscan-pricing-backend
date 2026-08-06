import Database from "better-sqlite3";

export function initDb(sqlitePath) {
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vin_cache (
      vin TEXT PRIMARY KEY,
      valid INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vin_cache_updated ON vin_cache(updated_at);
  `);

  const stmtGet = db.prepare(`SELECT * FROM vin_cache WHERE vin = ?`);
  const stmtUpsert = db.prepare(`
    INSERT INTO vin_cache (vin, valid, payload_json, source, confidence, created_at, updated_at)
    VALUES (@vin, @valid, @payload_json, @source, @confidence, @now, @now)
    ON CONFLICT(vin) DO UPDATE SET
      valid=excluded.valid,
      payload_json=excluded.payload_json,
      source=excluded.source,
      confidence=excluded.confidence,
      updated_at=excluded.updated_at
  `);

  return {
    get: (vin) => stmtGet.get(vin),
    upsert: (row) => stmtUpsert.run(row),
  };
}
