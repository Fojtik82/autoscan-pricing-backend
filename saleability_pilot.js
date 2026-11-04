import { createHash } from 'node:crypto';
import { DAY_MS, features, HORIZON_DAYS, liveCohort, outcomeAt, predict, priceReferences,
  readSnapshot, scorePredictions } from './saleability_model.js';

const COHORT_CAP = 5000;
export function ensurePilotSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS saleability_pilots (
    model_version TEXT PRIMARY KEY, started_at TEXT NOT NULL, issue_until TEXT NOT NULL,
    first_due_at TEXT NOT NULL, model_json TEXT NOT NULL, cohort_cap INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS saleability_forecasts (
    model_version TEXT NOT NULL, listing_key TEXT NOT NULL, source TEXT NOT NULL,
    issued_at TEXT NOT NULL, observed_at TEXT NOT NULL, due_at TEXT NOT NULL,
    probability REAL NOT NULL, baseline REAL NOT NULL, match_level TEXT NOT NULL,
    sample_size INTEGER NOT NULL, features_json TEXT NOT NULL,
    outcome INTEGER, outcome_state TEXT NOT NULL DEFAULT 'pending',
    evaluated_at TEXT, outcome_observed_at TEXT,
    PRIMARY KEY(model_version, listing_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_saleability_due ON saleability_forecasts(model_version, outcome_state, due_at);`);
}

function fresh(checked, now) {
  const age = Date.parse(now) - Date.parse(checked);
  return Number.isFinite(age) && age >= -300000 && age <= 2 * DAY_MS;
}

export function updateSaleabilityPilot(db, model, { now = new Date(), snapshot, completeSources = ['sauto', 'bazos'],
  pricedSources = ['sauto', 'bazos'] } = {}) {
  const nowIso = now.toISOString();
  if (!model) return { enabled: false, reason: 'pilot_model_not_installed' };
  ensurePilotSchema(db);
  snapshot ||= readSnapshot(db);
  const previous = db.prepare('SELECT * FROM saleability_pilots ORDER BY started_at DESC LIMIT 1').get();
  if (previous && previous.model_version !== model.version) return { enabled: true, skipped: true, reason: 'pilot_model_frozen', model_version: previous.model_version };
  if (!previous && !['sauto', 'bazos'].every(source => completeSources.includes(source) && fresh(snapshot.checked[source], nowIso))) {
    return { enabled: false, reason: 'fresh_complete_indexes_required_for_start' };
  }
  const trainingEnd = Math.max(...Object.values(model.provenance.train_end || {}).map(Date.parse));
  if (!Number.isFinite(trainingEnd) || trainingEnd >= now.getTime()) throw new Error('Pilot prediction must follow training outcomes');
  if (previous && nowIso < previous.started_at) throw new Error('Pilot clock rollback');
  const firstDue = new Date(now.getTime() + HORIZON_DAYS * DAY_MS).toISOString();
  const pilot = previous || { model_version: model.version, started_at: nowIso,
    issue_until: new Date(now.getTime() + DAY_MS).toISOString(), first_due_at: firstDue, cohort_cap: COHORT_CAP };
  let issued = 0, resolved = 0, censored = 0;
  db.transaction(() => {
    if (!previous) db.prepare('INSERT INTO saleability_pilots VALUES (?,?,?,?,?,?)')
      .run(model.version, pilot.started_at, pilot.issue_until, firstDue, JSON.stringify(model), COHORT_CAP);
    const pending = db.prepare("SELECT * FROM saleability_forecasts WHERE model_version=? AND outcome_state='pending'").all(model.version);
    const resolve = db.prepare(`UPDATE saleability_forecasts SET outcome=?, outcome_state=?, evaluated_at=?, outcome_observed_at=?
      WHERE model_version=? AND listing_key=? AND outcome_state='pending'`);
    for (const forecast of pending) {
      if (!completeSources.includes(forecast.source) || !fresh(snapshot.checked[forecast.source], nowIso)) continue;
      const result = outcomeAt(snapshot.records.get(forecast.listing_key), snapshot.checked[forecast.source], forecast.due_at);
      if (result.state === 'not_due') continue;
      resolve.run(result.value, result.state, nowIso, snapshot.checked[forecast.source], model.version, forecast.listing_key);
      if (result.value === null) censored++; else resolved++;
    }
    if (nowIso >= pilot.issue_until) return;
    const existing = db.prepare('SELECT listing_key,source FROM saleability_forecasts WHERE model_version=?').all(model.version);
    const seen = new Set(existing.map(r => r.listing_key));
    const cohort = liveCohort(snapshot);
    const references = priceReferences(cohort);
    const insert = db.prepare(`INSERT OR IGNORE INTO saleability_forecasts
      (model_version,listing_key,source,issued_at,observed_at,due_at,probability,baseline,match_level,sample_size,features_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const source of ['sauto', 'bazos']) {
      if (!completeSources.includes(source) || !pricedSources.includes(source) || !fresh(snapshot.checked[source], nowIso)) continue;
      let remaining = Math.floor(pilot.cohort_cap / 2) - existing.filter(r => r.source === source).length;
      if (remaining <= 0) continue;
      // Sample independently of the future label and keep the same cohort on retries.
      const candidates = cohort.filter(r => r.source === source && !seen.has(r.key)).map(r => ({ r,
        rank: createHash('sha256').update(`${model.version}:${r.key}`).digest('hex') })).sort((a, b) => a.rank.localeCompare(b.rank));
      for (const { r } of candidates) {
        if (remaining <= 0) break;
        const prediction = predict(model, r, references);
        if (!prediction.available) continue;
        const { key, active, missing, checked, seen: lastSeen, ...inputFeatures } = r;
        const changes = insert.run(model.version, r.key, source, nowIso, snapshot.checked[source], firstDue,
          prediction.probability_inactive_30d, model.sources[source].inactive / model.sources[source].n,
          prediction.match_level, prediction.sample_size, JSON.stringify({ ...inputFeatures,
            peer_median_czk: prediction.peer_median_czk, price_ratio: prediction.price_ratio })).changes;
        issued += changes; remaining -= changes;
      }
    }
  })();
  return { enabled: true, model_version: model.version, issued, resolved, censored,
    started_at: pilot.started_at, first_due_at: pilot.first_due_at, cohort_cap: pilot.cohort_cap };
}

export function pilotStatus(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='saleability_pilots'").get()) {
    return { enabled: false, state: 'not_started', production_ready: false };
  }
  const pilot = db.prepare('SELECT model_version,started_at,issue_until,first_due_at,cohort_cap FROM saleability_pilots ORDER BY started_at DESC LIMIT 1').get();
  if (!pilot) return { enabled: false, state: 'not_started', production_ready: false };
  const rows = db.prepare('SELECT source,probability,baseline,outcome,outcome_state FROM saleability_forecasts WHERE model_version=?').all(pilot.model_version);
  const evaluated = rows.filter(r => r.outcome_state === 'resolved').map(r => ({ ...r, actual: r.outcome }));
  const unresolved = rows.filter(r => r.outcome_state === 'pending').length;
  return { enabled: true, ...pilot, state: unresolved ? 'collecting_outcomes' : rows.length ? 'evaluated' : 'awaiting_eligible_cohort',
    target: 'confirmed_inactive_at_horizon', population: 'already_advertised', production_ready: false,
    forecast_count: rows.length, issued_by_source: Object.fromEntries(['sauto','bazos'].map(source => [source, rows.filter(r => r.source === source).length])),
    pending: unresolved, censored: rows.length - unresolved - evaluated.length,
    overall: scorePredictions(evaluated), by_source: Object.fromEntries(['sauto','bazos'].map(source => [source,
      scorePredictions(evaluated.filter(r => r.source === source))])) };
}
