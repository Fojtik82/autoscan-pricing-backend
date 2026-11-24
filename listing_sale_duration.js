import { parseSautoListingId } from './sauto_lifecycle.js';
import { parseBazosListing } from './bazos_lifecycle.js';
import { foldVariant, normalizePowertrain } from './vehicle_variant.js';

const DAY_MS = 86400000;
const SOURCES = ['sauto', 'bazos'];
const PUBLICATION_FIELDS = ['published_at', 'publication_date', 'date_published'];
const FIELDS = ['source_url', 'source_db', 'market', 'currency', 'brand', 'brand_norm', 'model', 'model_norm',
  'year', 'mileage', 'fuel', 'fuel_norm', 'motor', 'title', 'transmission', 'transmission_norm', 'drive', 'drive_norm',
  'engine_ccm', 'engine_l', 'kw', 'is_active', 'missing_checks', 'first_seen_at', 'first_seen_is_observed',
  'last_seen_at', 'last_checked_at', 'missing_since', 'inactive_at', ...PUBLICATION_FIELDS];

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function brandName(value) {
  const brand = foldVariant(value);
  if (brand === 'vw') return 'volkswagen';
  if (['mercedes', 'mercedes benz'].includes(brand)) return 'mercedes benz';
  return brand;
}

function modelName(brand, value, title = '') {
  const model = foldVariant(value);
  if (brand === 'renault') {
    const compact = model.replace(/\s/g, '');
    if (['grandscenic', 'meganegrandscenic', 'grandmeganescenic'].includes(compact)) return 'grandscenic';
    if (['scenic', 'meganescenic', 'megane', ''].includes(compact)) {
      const heading = foldVariant(title);
      if (/\b(?:grand ?(?:megane ?)?scenic|scenic grand)\b/.test(heading)) return 'grandscenic';
      if (['scenic', 'meganescenic'].includes(compact) || /\b(?:megane ?)?scenic\b/.test(heading)) return 'scenic';
    }
  }
  if (brand === 'bmw') {
    const series = model.match(/^(?:rada\s+|series\s+)?([1-8])(?:\s+(?:series|rada))?$/);
    if (series) return `rada ${series[1]}`;
  }
  return model.replace(/\s/g, '');
}

function matchesModel(brand, wanted, row) {
  const actual = modelName(brand, row.model_norm || row.model, row.title);
  if (brand === 'bmw' && /^rada [1-8]$/.test(wanted)) {
    // A series query includes ordinary 318i/320d names used by Bazos, while a
    // concrete 320d query stays concrete. M and GT have separate populations.
    const variant = foldVariant(row.model_norm || row.model).match(/^([1-8])\d{2}\s*(?:[dei]|[di]x|[di] xdrive|[dei] xdrive|xi|xd)?$/);
    return actual === wanted || Boolean(variant && wanted === `rada ${variant[1]}`);
  }
  return actual === wanted;
}

function modelAliases(brand, wanted, original) {
  const folded = foldVariant(original);
  const aliases = [original.trim(), folded, folded.replace(/\s/g, ''), folded.replace(/\s/g, '-')];
  if (brand === 'renault' && ['scenic', 'grandscenic'].includes(wanted)) {
    // Old imports can file Scenic under Megane; the title disambiguates the
    // family after this bounded lookup, without reading every Renault row.
    aliases.push('scenic', 'scénic', 'megane scenic', 'mégane scénic', 'megane', 'mégane',
      'grand scenic', 'grand scénic', 'megane grand scenic', 'grand megane scenic');
  }
  if (brand === 'bmw' && /^rada [1-8]$/.test(wanted)) {
    const series = wanted.at(-1);
    aliases.push(series, `rada ${series}`, `řada ${series}`, `${series} series`, `series ${series}`);
  }
  return [...new Set(aliases)];
}

function identity(url) {
  const sauto = parseSautoListingId(url);
  if (sauto && /sauto\.cz\/osobni\/detail\//i.test(url)) return { source: 'sauto', key: `sauto:${sauto}` };
  const bazos = parseBazosListing(url);
  if (bazos?.domain === 'auto.bazos.cz') return { source: 'bazos', key: `bazos:${bazos.key}` };
  return null;
}

function vehicleTitle(title) {
  const text = foldVariant(title);
  return !/^(?:koupim|hledam|vymenim)\b/.test(text)
    && !/\b(?:nahradni dily|dily|karburator|blatnik|riditka|sedlo|pneumatiky|pneu|helma|prilba|bunda|kalhoty|rafek)\b/.test(text)
    && !/^(?:motor|prevodovka|vyfuk)\b/.test(text);
}

function date(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.UTC(1990, 0, 1) && timestamp <= now ? timestamp : null;
}

function transmission(value) {
  const text = foldVariant(value);
  if (/automat|dsg|dct|cvt|s tronic|tiptronic/.test(text)) return 'automatic';
  return /manual/.test(text) ? 'manual' : '';
}

function drive(value) {
  const text = foldVariant(value);
  if (/4x4|4 x 4|4wd|awd|quattro|xdrive|4motion/.test(text)) return 'awd';
  if (/predni|front|fwd/.test(text)) return 'fwd';
  return /zadni|rear|rwd/.test(text) ? 'rwd' : '';
}

function specs(row) {
  const ccm = numeric(row.engine_ccm);
  const motorSize = String(row.motor || '').match(/\b([0-8][.,][0-9])\b/);
  return { year: numeric(row.year), mileage_km: numeric(row.mileage_km ?? row.mileage),
    engine_l: numeric(row.engine_l) ?? (ccm ? ccm / 1000 : motorSize ? numeric(motorSize[1]) : null), kw: numeric(row.kw),
    fuel: normalizePowertrain({ ...row, fuel: row.fuel || row.fuel_norm }),
    transmission: transmission(row.transmission_norm || row.transmission), drive: drive(row.drive_norm || row.drive) };
}

function quantile(values, p) {
  const position = (values.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return values[low] + (values[high] - values[low]) * (position - low);
}

const round = n => Math.round(n * 10) / 10;
const iso = value => value === null ? null : new Date(value).toISOString();

function summary(rows, minSupport) {
  const sold = rows.filter(row => row.sold);
  const measured = sold.filter(row => row.duration !== null);
  const values = measured.map(row => row.duration).sort((a, b) => a - b);
  const supported = measured.length >= minSupport;
  const dates = field => measured.map(row => row[field]).sort((a, b) => a - b);
  const starts = dates('start'), ends = dates('end');
  return { sample_size: measured.length, sold_count: sold.length, active_count: rows.filter(row => row.active).length,
    excluded_missing_dates: sold.length - measured.length,
    average_days: supported ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    median_days: supported ? round(quantile(values, 0.5)) : null,
    p25_days: supported ? round(quantile(values, 0.25)) : null,
    p75_days: supported ? round(quantile(values, 0.75)) : null,
    date_basis: { published: measured.filter(row => row.basis === 'published').length,
      first_observed: measured.filter(row => row.basis === 'first_observed').length,
      legacy_first_observed: measured.filter(row => row.basis === 'legacy_first_observed').length,
      missing_since: measured.filter(row => row.endBasis === 'missing_since').length,
      inactive_at: measured.filter(row => row.endBasis === 'inactive_at').length },
    period: { first_seen_from: iso(starts[0] ?? null), first_seen_to: iso(starts.at(-1) ?? null),
      sold_from: iso(ends[0] ?? null), sold_to: iso(ends.at(-1) ?? null) } };
}

function cohorts(query) {
  const variant = { year_window: query.year ? 2 : null, fuel: query.fuel || null,
    engine_l: query.engine_l, engine_tolerance_l: query.engine_l ? 0.15 : null,
    transmission: query.transmission || null, drive: query.drive || null,
    mileage_km: query.mileage_km, mileage_tolerance_km: query.mileage_km !== null ? 75000 : null,
    kw: query.kw, kw_tolerance: query.kw ? 15 : null };
  const seen = new Set();
  return [variant, { year_window: query.year ? 2 : null, fuel: query.fuel || null },
    { year_window: query.year ? 4 : null }, {}].map(raw => {
    const filters = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
    const variantLevel = ['engine_l', 'transmission', 'drive', 'mileage_km', 'kw'].some(field => filters[field] !== undefined);
    const level = variantLevel ? 'variant' : filters.year_window && filters.fuel ? 'year_fuel'
      : filters.year_window ? 'year' : filters.fuel ? 'fuel' : 'model';
    return { level, filters };
  }).filter(cohort => {
    const key = JSON.stringify(cohort.filters);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function matches(row, query, filters) {
  if (filters.year_window !== undefined && filters.year_window !== null
      && (row.year === null || Math.abs(row.year - query.year) > filters.year_window)) return false;
  for (const field of ['fuel', 'transmission', 'drive']) if (filters[field] && row[field] !== filters[field]) return false;
  for (const [field, tolerance] of [['engine_l', 'engine_tolerance_l'], ['mileage_km', 'mileage_tolerance_km'], ['kw', 'kw_tolerance']]) {
    if (filters[field] !== undefined && filters[field] !== null
        && (row[field] === null || Math.abs(row[field] - filters[field]) > filters[tolerance])) return false;
  }
  return true;
}

/** Descriptive completed-listing durations, using the product rule withdrawn URL = sold. */
export function listingSaleDuration(db, input = {}, { now = new Date(), minSupport = 5, onStage } = {}) {
  // Normal queries need only the nearby model years. Broader historical cohorts
  // are read only when the narrower cohort lacks enough completed lifetimes.
  const windows = input.year ? [2, 4, null] : [null];
  let result;
  for (const yearWindow of windows) {
    result = calculateDuration(db, input, { now, minSupport, onStage, yearWindow });
    if (result.found) break;
  }
  return result;
}

function calculateDuration(db, input, { now, minSupport, onStage, yearWindow }) {
  const started = performance.now();
  if (typeof input.brand !== 'string' || typeof input.model !== 'string' || !input.brand.trim() || !input.model.trim()
      || input.brand.length > 100 || input.model.length > 100) throw new TypeError('brand_model_required');
  if (!Number.isFinite(now.getTime())) throw new TypeError('invalid_now');
  if (!Number.isInteger(minSupport) || minSupport < 1) throw new TypeError('invalid_min_support');
  if (input.source !== undefined && !SOURCES.includes(input.source)) throw new TypeError('invalid_source');
  for (const name of ['year', 'mileage_km', 'engine_l', 'engine_ccm', 'kw']) {
    if (input[name] !== undefined && input[name] !== null && (typeof input[name] !== 'number' || !Number.isFinite(input[name]) || input[name] < 0)) {
      throw new TypeError(`invalid_${name}`);
    }
  }
  const brand = brandName(input.brand), model = modelName(brand, input.model), query = specs(input);
  const columns = new Set(db.prepare('PRAGMA table_info(vehicle_app)').all().map(row => row.name));
  if (!['source_url', 'is_active', 'brand', 'model'].every(field => columns.has(field))) throw new Error('listing_history_unavailable');
  const selected = FIELDS.filter(field => columns.has(field));
  // Narrow in SQLite before parsing histories; never materialize the entire market per request.
  const aliases = [...new Set([brand, input.brand.trim(), ...(brand === 'skoda' ? ['Škoda', 'škoda'] : []),
    ...(brand === 'volkswagen' ? ['vw'] : []), ...(brand === 'mercedes benz' ? ['mercedes', 'mercedes-benz'] : [])])];
  const models = modelAliases(brand, model, input.model);
  const modelCondition = column => {
    const exact = `${column} COLLATE NOCASE IN (${models.map(() => '?').join(',')})`;
    return brand === 'bmw' && /^rada [1-8]$/.test(model) ? `(${exact} OR ${column} LIKE '${model.at(-1)}__%')` : exact;
  };
  const placeholders = aliases.map(() => '?').join(',');
  // Both source imports store four-digit model years as TEXT. String bounds
  // retain the column's indexed affinity instead of CASTing every table row.
  const yearCondition = yearWindow !== null && columns.has('year') ? ' AND year BETWEEN ? AND ?' : '';
  const yearParams = yearCondition ? [String(input.year - yearWindow), String(input.year + yearWindow)] : [];
  const branches = [`(brand COLLATE NOCASE IN (${placeholders}) AND ${modelCondition('model')}${yearCondition})`];
  const params = [...aliases, ...models, ...yearParams];
  if (columns.has('brand_norm') && columns.has('model_norm')) {
    branches.push(`(brand_norm COLLATE NOCASE IN (${placeholders}) AND ${modelCondition('model_norm')}${yearCondition})`);
    params.push(...aliases, ...models, ...yearParams);
  }
  const sql = `SELECT ${selected.join(',')} FROM vehicle_app WHERE ${branches.join(' OR ')}`;
  const hasHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='listing_first_seen'").get());
  const groups = new Map();
  for (const row of db.prepare(sql).iterate(...params)) {
    const id = identity(row.source_url);
    if (!id || (input.source && id.source !== input.source) || (row.market && row.market !== 'CZ') || (row.currency && row.currency !== 'CZK')
        || !matchesModel(brand, model, row) || (id.source === 'bazos' && !vehicleTitle(row.title))) continue;
    const group = groups.get(id.key) || { ...id, rows: [] };
    group.rows.push(row); groups.set(id.key, group);
  }
  onStage?.({ stage: 'selected', year_window: yearWindow, count: groups.size, elapsed_ms: Math.round(performance.now() - started) });
  const ordered = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const histories = new Map();
  if (hasHistory) {
    // A single native SQLite iteration per batch avoids tens of thousands of
    // individual statements against the much larger complete live-index table.
    for (let offset = 0; offset < ordered.length; offset += 500) {
      const keys = ordered.slice(offset, offset + 500).map(group => group.key);
      for (const entry of db.prepare(`SELECT listing_key,first_seen_at,first_seen_is_observed
        FROM listing_first_seen WHERE listing_key IN (${keys.map(() => '?').join(',')})`).all(...keys)) histories.set(entry.listing_key, entry);
    }
  }
  onStage?.({ stage: 'history_lookup', count: histories.size, elapsed_ms: Math.round(performance.now() - started) });
  const rows = [];
  for (const group of ordered) {
    const sorted = group.rows.sort((a, b) => (date(b.last_checked_at, now.getTime()) ?? -Infinity) - (date(a.last_checked_at, now.getTime()) ?? -Infinity));
    const latest = date(sorted[0].last_checked_at, now.getTime());
    const current = sorted.filter(row => date(row.last_checked_at, now.getTime()) === latest);
    const activeRow = current.find(row => Number(row.is_active) !== 0);
    const row = activeRow || sorted[0];
    const active = Boolean(activeRow);
    const sold = !active && Number(row.is_active) === 0;
    let start = null, basis = null, end = null, endBasis = null, duration = null;
    const first = histories.get(group.key);
    const observations = [...group.rows, ...(first ? [first] : [])].map(item => ({ timestamp: date(item.first_seen_at, now.getTime()), observed: Number(item.first_seen_is_observed) === 1 }))
      .filter(item => item.timestamp !== null).sort((a, b) => a.timestamp - b.timestamp);
    const liveEvidence = [...observations.map(item => item.timestamp), ...group.rows.map(item => date(item.last_seen_at, now.getTime())).filter(value => value !== null)];
    const firstLiveEvidence = liveEvidence.length ? Math.min(...liveEvidence) : null;
    const publications = group.rows.flatMap(item => PUBLICATION_FIELDS.map(field => date(item[field], now.getTime())))
      .filter(value => value !== null && (firstLiveEvidence === null || value <= firstLiveEvidence));
    if (publications.length) { start = Math.min(...publications); basis = 'published'; }
    else {
      if (observations.length) { start = observations[0].timestamp; basis = observations[0].observed ? 'first_observed' : 'legacy_first_observed'; }
    }
    if (sold) {
      const missing = date(row.missing_since, now.getTime());
      const inactive = date(row.inactive_at, now.getTime());
      if (missing !== null) { end = missing; endBasis = 'missing_since'; }
      else if (inactive !== null) { end = inactive; endBasis = 'inactive_at'; }
      const seen = date(row.last_seen_at, now.getTime());
      if (start !== null && end !== null && end >= start && (seen === null || end >= seen)) duration = (end - start) / DAY_MS;
    }
    rows.push({ source: group.source, ...specs(row), active, sold, start, end, basis, endBasis, duration });
  }
  onStage?.({ stage: 'histories', count: rows.length, elapsed_ms: Math.round(performance.now() - started) });
  const candidates = cohorts(query).filter(cohort => yearWindow === null || !columns.has('year')
    || (cohort.filters.year_window !== undefined && cohort.filters.year_window <= yearWindow))
    .map(cohort => ({ ...cohort, rows: rows.filter(row => matches(row, query, cohort.filters)) }));
  const chosen = candidates.find(cohort => cohort.rows.filter(row => row.sold && row.duration !== null).length >= minSupport) || candidates.at(-1);
  const combined = summary(chosen.rows, minSupport);
  return { found: combined.sample_size >= minSupport, status: combined.sample_size >= minSupport ? 'available' : 'insufficient_data',
    method: 'withdrawn-listings-duration-v1', assumption: 'withdrawn_listing_is_sold', min_support: minSupport,
    match_level: chosen.level, filters: { brand, model: input.model.trim(), year: chosen.filters.year_window ? query.year : null,
      ...(input.source ? { source: input.source } : {}), ...chosen.filters },
    ...combined, by_source: Object.fromEntries(SOURCES.map(source => [source, summary(chosen.rows.filter(row => row.source === source), 1)])),
    note: 'Stažené inzeráty počítáme jako prodané. Doba prodeje je od zveřejnění, případně prvního zachycení, do prvního zjištěného zmizení z nabídky.',
    generated_at: now.toISOString() };
}
