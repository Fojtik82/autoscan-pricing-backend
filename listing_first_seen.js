// First observation is not a publication date. Only a transition from absence
// in a previous complete index can bound the start of an observation period.
const FIELDS = [
  ['first_seen_at', 'TEXT'],
  ['first_seen_after_at', 'TEXT'],
  ['first_seen_is_observed', 'INTEGER NOT NULL DEFAULT 0'],
  ['first_seen_evidence', 'TEXT'],
];

export function ensureFirstSeenSchema(db, table = 'vehicle_app') {
  const quoted = JSON.stringify(table);
  const columns = new Set(db.prepare(`PRAGMA table_info(${quoted})`).all().map(r => r.name));
  const migration = !columns.has('first_seen_at');
  for (const [name, definition] of FIELDS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ${quoted} ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS listing_first_seen (
    listing_key TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    first_seen_after_at TEXT,
    first_seen_is_observed INTEGER NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS listing_first_seen_runs (
    source TEXT PRIMARY KEY, checked_at TEXT NOT NULL
  ) WITHOUT ROWID`);
  if (migration && columns.has('last_seen_at')) {
    // A check of an absent ad is never evidence of a live observation.
    db.exec(`UPDATE ${quoted} SET first_seen_at = last_seen_at,
      first_seen_evidence = 'legacy_last_seen', first_seen_is_observed = 0
      WHERE last_seen_at IS NOT NULL`);
  }
}

export function recordFirstSeenIndex(db, { source, liveKeys, rows, keyForUrl, now, table = 'vehicle_app' }) {
  const previous = db.prepare('SELECT checked_at FROM listing_first_seen_runs WHERE source = ?').get(source)?.checked_at;
  if (previous && now < previous) throw new Error('First-seen index timestamp rollback');
  const seed = db.prepare(`INSERT OR IGNORE INTO listing_first_seen
    (listing_key, first_seen_at, first_seen_after_at, first_seen_is_observed, evidence)
    VALUES (?, ?, ?, ?, ?)`);
  const get = db.prepare('SELECT * FROM listing_first_seen WHERE listing_key = ?');
  const update = db.prepare(`UPDATE ${JSON.stringify(table)} SET first_seen_at = ?,
    first_seen_after_at = ?, first_seen_is_observed = ?, first_seen_evidence = ? WHERE rowid = ?`);
  let introduced = 0;
  db.transaction(() => {
    // Preserve the earliest existing observation, also across duplicate URLs.
    for (const row of [...rows].sort((a, b) => String(a.first_seen_at || a.last_seen_at || '\uffff')
      .localeCompare(String(b.first_seen_at || b.last_seen_at || '\uffff')))) {
      const key = keyForUrl(row.source_url);
      const seen = row.first_seen_at || row.last_seen_at;
      if (key && seen && seen <= now && (row.first_seen_at || !previous || seen <= previous)) seed.run(key, seen, row.first_seen_after_at || null,
        row.first_seen_is_observed || 0, row.first_seen_evidence || 'legacy_last_seen');
    }
    // Store the complete index, including IDs not yet imported into vehicle_app.
    // Otherwise a late import of an old ad could be mistaken for a new arrival.
    for (const key of liveKeys) {
      introduced += seed.run(key, now, previous && previous < now ? previous : null,
        previous && previous < now ? 1 : 0, 'complete_live_index').changes;
    }
    for (const row of rows) {
      const key = keyForUrl(row.source_url);
      const first = key ? get.get(key) : null;
      if (first) update.run(first.first_seen_at, first.first_seen_after_at,
        first.first_seen_is_observed, first.evidence, row.rowid);
    }
    db.prepare(`INSERT INTO listing_first_seen_runs (source, checked_at) VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET checked_at = excluded.checked_at`).run(source, now);
  })();
  return { introduced, previous_complete_check_at: previous || null };
}
