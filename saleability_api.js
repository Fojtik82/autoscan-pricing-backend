import Database from 'better-sqlite3';
import { DAY_MS, features, liveCohort, predict, priceReferences, readSnapshot } from './saleability_model.js';
import { pilotStatus } from './saleability_pilot.js';

export function registerSaleabilityApi(app, databasePath) {
  let cachedModel;
  const open = () => new Database(databasePath, { readonly: true, fileMustExist: true });
  app.get('/market/saleability/status', (_req, res) => {
    let db;
    try { db = open(); return res.json(pilotStatus(db)); }
    catch { return res.status(503).json({ enabled: false, production_ready: false, reason: 'pilot_database_unavailable' }); }
    finally { db?.close(); }
  });
  app.post('/market/saleability', (req, res) => {
    const input = req.body || {};
    if (typeof input.brand !== 'string' || typeof input.model !== 'string' || !input.brand.trim() || !input.model.trim()
        || input.brand.length > 100 || input.model.length > 100 || input.source && !['sauto', 'bazos'].includes(input.source)) {
      return res.status(400).json({ found: false, reason: 'brand_model_and_valid_source_required' });
    }
    for (const name of ['year', 'mileage_km', 'asking_price_czk', 'engine_ccm', 'engine_l']) {
      if (input[name] !== undefined && (typeof input[name] !== 'number' || !Number.isFinite(input[name]) || input[name] < 0)) {
        return res.status(400).json({ found: false, reason: 'invalid_numeric_field', field: name });
      }
    }
    let db;
    try {
      db = open();
      const status = pilotStatus(db);
      if (!status.enabled) return res.status(503).json({ found: false, reason: 'pilot_not_started', production_ready: false });
      if (cachedModel?.version !== status.model_version) {
        cachedModel = JSON.parse(db.prepare('SELECT model_json FROM saleability_pilots WHERE model_version=?').get(status.model_version).model_json);
      }
      const query = features(input);
      const snapshot = readSnapshot(db, { brand: query.brand, model: query.model });
      const cohort = liveCohort(snapshot);
      const references = priceReferences(cohort);
      const now = Date.now();
      const sources = (input.source ? [input.source] : ['sauto', 'bazos']).map(source => {
        const observedAt = snapshot.checked[source];
        const age = now - Date.parse(observedAt);
        if (!Number.isFinite(age) || age < -300000 || age > 2 * DAY_MS) return { source, available: false, reason: 'source_stale_or_unavailable' };
        if (!cohort.some(r => r.source === source)) return { source, available: false, reason: 'no_current_comparables' };
        return { source, observed_at: observedAt, ...predict(cachedModel, { ...query, source }, references) };
      });
      return res.json({ found: sources.some(source => source.available), mode: 'experimental_market_reference',
        production_ready: false, model_version: cachedModel.version, horizon_days: cachedModel.horizon_days,
        target: cachedModel.target, population: cachedModel.population,
        temporally_tested_sources: cachedModel.validation?.temporally_tested_sources || [], sources,
        note: 'Údaje se vztahují k již aktivním inzerátům. Přesnost se ověřuje v pilotu; nejde o potvrzený prodej ani pravděpodobnost pro nový inzerát.' });
    } catch { return res.status(503).json({ found: false, reason: 'pilot_unavailable', production_ready: false }); }
    finally { db?.close(); }
  });
}
