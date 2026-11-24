export function ensureListingSaleDurationIndexes(db, table = 'vehicle_app') {
  const columns = new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(row => row.name));
  for (const fields of [['brand_norm', 'model_norm'], ['brand', 'model']]) {
    if (fields.every(field => columns.has(field))) {
      const withYear = columns.has('year');
      db.exec(`CREATE INDEX IF NOT EXISTS ${JSON.stringify(`idx_${table}_duration_${fields[0]}${withYear ? '_year' : ''}`)}
        ON ${JSON.stringify(table)} (${fields.map(field => `${field} COLLATE NOCASE`).join(', ')}${withYear ? ', year' : ''})`);
    }
  }
}
