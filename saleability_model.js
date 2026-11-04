import { createHash } from 'node:crypto';
import { foldVariant, normalizePowertrain } from './vehicle_variant.js';
import { parseSautoListingId } from './sauto_lifecycle.js';
import { parseBazosListing } from './bazos_lifecycle.js';

export const HORIZON_DAYS = 30;
export const DAY_MS = 86400000;
export const MODEL_METHOD = 'existing-ad-inactivity-30d-v1';
const MIN_SUPPORT = 50;
const PRIOR_STRENGTH = 20;
const LEVELS = ['variant_price', 'variant', 'model_year_price', 'model_year', 'model'];

export function listingIdentity(url) {
  const sauto = parseSautoListingId(url);
  if (sauto && /sauto\.cz\/osobni\/detail\//i.test(url)) return { key: `sauto:${sauto}`, source: 'sauto' };
  const bazos = parseBazosListing(url);
  if (bazos?.domain === 'auto.bazos.cz') return { key: `bazos:${bazos.key}`, source: 'bazos' };
  return null;
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

export function features(row = {}) {
  const year = number(row.year);
  const mileage = number(row.mileage_km ?? row.mileage);
  const price = number(row.asking_price_czk ?? row.price);
  const ccm = number(row.engine_ccm);
  const liters = number(row.engine_l) ?? (ccm ? ccm / 1000 : null);
  const transmission = foldVariant(row.transmission_norm || row.transmission);
  const drive = foldVariant(row.drive_norm || row.drive);
  return {
    brand: foldVariant(row.brand_norm || row.brand), model: foldVariant(row.model_norm || row.model),
    year_band: year >= 1950 && year <= 2100 ? Math.floor(year / 5) * 5 : null,
    mileage_band: mileage !== null && mileage >= 0 && mileage <= 2000000 ? Math.floor(mileage / 100000) : null,
    fuel: normalizePowertrain(row),
    transmission: /automat|dsg|dct|cvt/.test(transmission) ? 'automatic'
      : /manual/.test(transmission) ? 'manual' : '',
    drive: /4x4|4wd|awd|quattro/.test(drive) ? 'awd'
      : /predni|front|fwd/.test(drive) ? 'fwd' : /zadni|rear|rwd/.test(drive) ? 'rwd' : '',
    engine_l: liters >= 0.5 && liters <= 10 ? Math.round(liters * 10) / 10 : null,
    price: price >= 1000 && price <= 20000000 ? price : null,
  };
}

export function readSnapshot(db, filter = {}) {
  const columns = new Set(db.prepare('PRAGMA table_info(vehicle_app)').all().map(r => r.name));
  const required = ['source_url', 'is_active', 'missing_checks', 'last_seen_at', 'last_checked_at'];
  if (!required.every(name => columns.has(name))) throw new Error('Snapshot lacks verified lifecycle fields');
  const wanted = [...required, 'brand', 'model', 'brand_norm', 'model_norm', 'year', 'mileage',
    'fuel', 'motor', 'title', 'transmission', 'transmission_norm', 'drive', 'drive_norm', 'engine_ccm', 'engine_l', 'price'];
  const selected = wanted.filter(name => columns.has(name));
  const records = new Map();
  const checked = {};
  let duplicates = 0;
  const where = filter.brand && filter.model ? ' WHERE brand_norm=? AND model_norm=?' : '';
  const params = where ? [filter.brand, filter.model] : [];
  for (const row of db.prepare(`SELECT ${selected.join(',')} FROM vehicle_app${where}`).iterate(...params)) {
    const identity = listingIdentity(row.source_url);
    if (!identity) continue;
    const record = { ...identity, ...features(row), active: Number(row.is_active) === 1,
      missing: Number(row.missing_checks || 0), seen: row.last_seen_at, checked: row.last_checked_at };
    if (Number.isFinite(Date.parse(record.checked)) && record.checked > (checked[identity.source] || '')) checked[identity.source] = record.checked;
    const existing = records.get(identity.key);
    if (existing) {
      duplicates++;
      if (String(existing.seen || '') > String(record.seen || '')) continue;
      if (existing.brand !== record.brand || existing.model !== record.model || existing.year_band !== record.year_band) record.feature_conflict = true;
      record.feature_conflict ||= existing.feature_conflict;
    }
    records.set(identity.key, record);
  }
  return { records, checked, duplicates };
}

export function liveCohort(snapshot) {
  return [...snapshot.records.values()].filter(r => r.active && r.missing === 0 && r.seen === snapshot.checked[r.source]
    && r.checked === snapshot.checked[r.source] && r.brand && r.model && !r.feature_conflict);
}

export function outcomeAt(record, checkedAt, dueAt, { toleranceMs = 2 * DAY_MS } = {}) {
  const delta = Date.parse(checkedAt) - Date.parse(dueAt);
  if (!Number.isFinite(delta) || delta < 0) return { state: 'not_due', value: null };
  if (delta > toleranceMs) return { state: 'censored_late_check', value: null };
  if (!record || record.checked !== checkedAt) return { state: 'censored_missing_evidence', value: null };
  if (!record.active && record.missing >= 3) return { state: 'resolved', value: 1 };
  if (record.active && record.missing === 0 && record.seen === checkedAt) return { state: 'resolved', value: 0 };
  return { state: 'censored_pending_absence', value: null };
}

const key = values => JSON.stringify(values);
const modelKey = r => key([r.source, r.brand, r.model]);
const peerKey = r => key([r.source, r.brand, r.model, r.year_band, r.fuel, r.mileage_band]);

export function priceReferences(cohort) {
  const grouped = new Map();
  for (const r of cohort) if (r.price) {
    const k = peerKey(r);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r.price);
  }
  const medians = {};
  for (const [k, prices] of grouped) {
    if (prices.length < 20) continue;
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    medians[k] = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  }
  return medians;
}

function cellKeys(r, references) {
  const median = references[peerKey(r)];
  const ratio = median && r.price ? r.price / median : null;
  const priceBand = ratio === null ? '' : ratio < 0.9 ? 'below' : ratio > 1.1 ? 'above' : 'around';
  const base = [r.source, r.brand, r.model];
  const year = [...base, r.year_band, r.fuel];
  const variant = [...year, r.transmission, r.engine_l, r.mileage_band, r.drive];
  return {
    model: modelKey(r), model_year: r.year_band !== null && r.fuel ? key(['year', ...year]) : null,
    model_year_price: r.year_band !== null && r.fuel && priceBand ? key(['year_price', ...year, priceBand]) : null,
    variant: r.year_band !== null && r.fuel && r.transmission && r.engine_l !== null && r.mileage_band !== null
      ? key(['variant', ...variant]) : null,
    variant_price: r.year_band !== null && r.fuel && r.transmission && r.engine_l !== null && r.mileage_band !== null && priceBand
      ? key(['variant_price', ...variant, priceBand]) : null,
    price_ratio: ratio, peer_median_czk: median || null,
  };
}

export function buildExamples(start, end, { issuedAt } = {}) {
  const cohort = liveCohort(start);
  for (const source of Object.keys(start.checked)) {
    const elapsed = Date.parse(end.checked[source]) - Date.parse(issuedAt || start.checked[source]);
    if (!Number.isFinite(elapsed) || elapsed < HORIZON_DAYS * DAY_MS || elapsed > (HORIZON_DAYS + 2) * DAY_MS) {
      throw new Error(`Invalid ${source} outcome horizon: expected 30 to 32 days`);
    }
  }
  const censoring = {};
  const examples = [];
  for (const r of cohort) {
    const dueAt = new Date(Date.parse(issuedAt || start.checked[r.source]) + HORIZON_DAYS * DAY_MS).toISOString();
    const outcome = outcomeAt(end.records.get(r.key), end.checked[r.source], dueAt);
    if (outcome.value === null) { censoring[outcome.state] = (censoring[outcome.state] || 0) + 1; continue; }
    examples.push({ ...r, outcome: outcome.value });
  }
  return { examples, references: priceReferences(cohort), cohort_size: cohort.length, censoring };
}

export function trainModel(dataset, provenance) {
  const cells = {}, sources = {};
  for (const r of dataset.examples) {
    const source = sources[r.source] ||= { n: 0, inactive: 0 };
    source.n++; source.inactive += r.outcome;
    const keys = cellKeys(r, dataset.references);
    for (const level of LEVELS) if (keys[level]) {
      const cell = cells[keys[level]] ||= { n: 0, inactive: 0 };
      cell.n++; cell.inactive += r.outcome;
    }
  }
  if (!Object.values(sources).some(source => source.n >= MIN_SUPPORT)) throw new Error('Training requires a supported source');
  const payload = { method: MODEL_METHOD, horizon_days: HORIZON_DAYS, min_support: MIN_SUPPORT,
    prior_strength: PRIOR_STRENGTH, target: 'confirmed_inactive_at_horizon', population: 'already_advertised',
    provenance, sources, cells };
  return { ...payload, version: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20) };
}

export function wilson(inactive, n) {
  if (!n) return null;
  const z = 1.959963984540054, p = inactive / n, divisor = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / divisor;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / divisor;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function predict(model, r, references = {}) {
  const source = model.sources[r.source];
  if (!source || !r.brand || !r.model) return { available: false, reason: 'missing_or_unsupported_query' };
  const parent = model.cells[modelKey(r)];
  if (!parent || parent.n < model.min_support) return { available: false, reason: 'insufficient_model_support' };
  const sourceRate = source.inactive / source.n;
  const parentRate = (parent.inactive + model.prior_strength * sourceRate) / (parent.n + model.prior_strength);
  const keys = cellKeys(r, references);
  const level = LEVELS.find(name => keys[name] && model.cells[keys[name]]?.n >= model.min_support);
  const cell = model.cells[keys[level]];
  const probability = level === 'model' ? parentRate
    : (cell.inactive + model.prior_strength * parentRate) / (cell.n + model.prior_strength);
  return { available: true, model_version: model.version, source: r.source,
    probability_inactive_30d: probability, match_level: level, sample_size: cell.n,
    observed_rate: cell.inactive / cell.n, observed_rate_interval_95: wilson(cell.inactive, cell.n),
    peer_median_czk: keys.peer_median_czk, price_ratio: keys.price_ratio,
    target: model.target, population: model.population, experimental: true,
    note: 'Předpověď stavu již inzerovaného vozu za 30 dní; zmizení inzerátu nepotvrzuje prodej.' };
}

export function scorePredictions(rows) {
  if (!rows.length) return { n: 0, brier: null, baseline_brier: null, calibration_error: null, bins: [] };
  let loss = 0, baselineLoss = 0;
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, n: 0, predicted: 0, actual: 0 }));
  for (const r of rows) {
    loss += (r.probability - r.actual) ** 2;
    baselineLoss += (r.baseline - r.actual) ** 2;
    const bin = bins[Math.min(9, Math.floor(r.probability * 10))];
    bin.n++; bin.predicted += r.probability; bin.actual += r.actual;
  }
  let error = 0;
  for (const bin of bins) if (bin.n) {
    bin.predicted /= bin.n; bin.actual /= bin.n;
    error += bin.n / rows.length * Math.abs(bin.predicted - bin.actual);
  }
  return { n: rows.length, brier: loss / rows.length, baseline_brier: baselineLoss / rows.length,
    brier_improvement: (baselineLoss - loss) / rows.length, calibration_error: error,
    mean_prediction: rows.reduce((sum, r) => sum + r.probability, 0) / rows.length,
    actual_rate: rows.reduce((sum, r) => sum + r.actual, 0) / rows.length,
    bins: bins.filter(bin => bin.n) };
}

export function evaluateModel(model, dataset, { trainingKeys = new Set() } = {}) {
  const rows = [], unavailable = {};
  for (const r of dataset.examples) {
    const prediction = predict(model, r, dataset.references);
    if (!prediction.available) { unavailable[prediction.reason] = (unavailable[prediction.reason] || 0) + 1; continue; }
    const source = model.sources[r.source];
    rows.push({ source: r.source, key: r.key, probability: prediction.probability_inactive_30d,
      actual: r.outcome, baseline: source.inactive / source.n });
  }
  return { total_cohort: dataset.cohort_size, resolved_labels: dataset.examples.length,
    censoring: dataset.censoring, unavailable, overall: scorePredictions(rows),
    by_source: Object.fromEntries(['sauto', 'bazos'].map(source => [source, scorePredictions(rows.filter(r => r.source === source))])),
    unseen_listing_ids: scorePredictions(rows.filter(r => !trainingKeys.has(r.key))),
    cross_source_vehicle_deduplication: false, production_approved: false };
}
