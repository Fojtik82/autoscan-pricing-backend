import path from "node:path";
import { normalizePowertrain, matchesEdition, matchesEngine } from "./vehicle_variant.js";
import { countMarketSources, marketSourceId } from "./source_identity.js";
import { ANNOTATED_SPECS_POLICY, assessSpec, unknownSpecs, summarizePartialSpecs } from "./comparison_policy.js";
import { parseMileage, mileageBandwidth, mileageWeight, weightedPercentile,
  effectiveComparables, MIN_EFFECTIVE_COMPARABLES, MILEAGE_PRICE_METHOD,
  MILEAGE_EXTRAPOLATION_METHOD, extrapolationBandwidth, extrapolationWeight,
  robustMileageSlope } from "./mileage_pricing.js";
import Database from "better-sqlite3";

const TABLE_CANDIDATES = [
  "vehicle_app",
  "vehicles_app",
  "vehicles_clean",
  "vehicles_ai",
  "vehicle",
  "vehicles",
];

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value) {
  return fold(value).replace(/\s+/g, "");
}

function parseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value).replace(/\s+/g, "");
  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (!match) {
    return null;
  }

  const numeric = Number(match[0].replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseMoney(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 10000 && value <= 20000000 ? Math.round(value) : null;
  }

  const digits = String(value).match(/\d+/g)?.join("") || "";
  if (!digits) {
    return null;
  }

  const numeric = Number(digits);
  if (!Number.isFinite(numeric) || numeric < 10000 || numeric > 20000000) {
    return null;
  }
  return Math.round(numeric);
}

function parseYear(value) {
  const numeric = parseNumber(value);
  if (!numeric) {
    return null;
  }
  const year = Math.round(numeric);
  return year >= 1886 && year <= new Date().getUTCFullYear() + 1 ? year : null;
}

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[index];
}

function roundPrice(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(value / 1000) * 1000;
}

function detectTable(db) {
  const existing = new Set(
    db.prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => row.name),
  );
  return TABLE_CANDIDATES.find((table) => existing.has(table));
}

function rowToVehicle(row) {
  const price = parseMoney(row.price);
  const year = parseYear(row.year);
  const mileage = parseMileage(row.mileage);
  const kw = parseNumber(row.kw);

  return {
    source: row.source_db || "vehicles_ai",
    url: row.source_url || "",
    brand: row.brand || "",
    model: row.model || "",
    year,
    mileage: mileage ? Math.round(mileage) : null,
    fuel: row.fuel || "",
    powertrain: normalizePowertrain(row),
    trim: row.trim || row.trim_norm || "",
    motor: row.motor || "",
    transmission: row.transmission || "",
    drive: row.drive || "",
    kw: kw ? Math.round(kw) : null,
    price_czk: price,
    title: row.title || "",
    source_db: row.source_db || "",
    _transmission_norm: row.transmission_norm || "",
    _drive_norm: row.drive_norm || "",
  };
}

function scoreVehicle(vehicle, request) {
  let score = 0;

  if (request.year && vehicle.year) {
    score += Math.abs(vehicle.year - request.year) * 12;
  }
  if (request.mileageKm) {
    score += vehicle.mileage > 0
      ? Math.abs(vehicle.mileage - request.mileageKm) / mileageBandwidth(request.mileageKm) * 12
      : 1000000;
  }
  if (request.kw && vehicle.kw) {
    score += Math.abs(vehicle.kw - request.kw) * 0.7;
  }
  if (request.fuelNorm && vehicle.powertrain !== request.fuelNorm) {
    score += 35;
  }
  if (request.transmissionNorm && fold(vehicle.transmission) !== request.transmissionNorm) {
    score += 20;
  }
  if (request.driveNorm && fold(vehicle.drive) !== request.driveNorm) {
    score += 16;
  }

  const text = compact(
    `${vehicle.brand} ${vehicle.model} ${vehicle.motor} ${vehicle.title}`,
  );
  if (request.modelCompact && !text.includes(request.modelCompact)) {
    score += 25;
  }

  return score;
}

function normalizeModelInput(brand, model) {
  const brandNorm = fold(brand);
  const modelNorm = fold(model);
  if (["mercedes benz", "mercedes"].includes(brandNorm)) {
    const match = modelNorm.match(/^(gle|glc|gls|cla|cls|gla|glb)\b/);
    if (match) return match[1].toUpperCase();
  }
  if (brandNorm === "ford") {
    const match = modelNorm.match(/^f\s*(\d{3})\b/);
    if (match) return `F-${match[1]}`;
  }
  if (brandNorm === "saab") {
    const match = modelNorm.match(/^9\s*([357])\b/);
    if (match) return `9-${match[1]}`;
  }
  return model;
}

function normalizeRequest(input = {}) {
  const brand = input.brand || input.make || "";
  const model = normalizeModelInput(brand, input.model || "");
  const modelDetail = input.modelDetail || input.equipment || input.trim || "";
  const rawMileage = input.mileageKm ?? input.mileage ?? input.odometerKm;
  const mileageKm = parseMileage(rawMileage);

  return {
    brand,
    model,
    modelDetail,
    motor: input.motor || input.engine || "",
    brandNorm: fold(brand),
    modelNorm: fold(model),
    modelCompact: compact(model),
    detailNorm: fold(modelDetail),
    detailCompact: compact(modelDetail),
    year: parseYear(input.year),
    mileageKm: mileageKm ? Math.round(mileageKm) : null,
    invalidMileage: rawMileage != null && String(rawMileage).trim() !== '' && mileageKm === null,
    fuelNorm: normalizePowertrain({ ...input, motor: input.motor || input.engine, title: modelDetail }),
    fuelSpecified: Boolean(input.fuel || input.powertrain),
    transmissionNorm: fold(input.transmission),
    driveNorm: fold(input.drive),
    kw: parseNumber(input.kw || input.powerKw || input.power),
    comparisonPolicy: input.comparison_policy === ANNOTATED_SPECS_POLICY ? ANNOTATED_SPECS_POLICY : '',
  };
}

function buildWhere(request, attempt, supportsActiveFlag = false, supportsFreshness = false) {
  const where = [
    "price IS NOT NULL",
    "TRIM(price) <> ''",
    `(source_db IS NULL OR lower(source_db) NOT IN (
      'caroffice-dealer-inzerat',
      'caroffice-dealer-prodano',
      'caroffice-anonymized-purchase'
    ))`,
  ];
  const params = {};
  const niche = "(lower(coalesce(source_db,'')) LIKE '%sportovnivozy%'"
    + " OR lower(coalesce(source_db,'')) LIKE '%rajveteranu%'"
    + " OR lower(coalesce(source_url,'')) LIKE '%sportovnivozy.cz/%'"
    + " OR lower(coalesce(source_url,'')) LIKE '%rajveteranu.cz/%')";
  where.push(supportsFreshness
    ? "(NOT " + niche + " OR (is_active=1 AND missing_checks=0"
      + " AND last_seen_at=last_checked_at"
      + " AND julianday(last_checked_at) BETWEEN julianday('now','-48 hours') AND julianday('now','+5 minutes')))"
    : "NOT " + niche);

  if (supportsActiveFlag) {
    where.push("COALESCE(CAST(is_active AS INTEGER), 1) <> 0");
  }

  if (request.brandNorm) {
    where.push("(brand_norm = @brandNorm OR lower(brand) = @brandNorm)");
    params.brandNorm = request.brandNorm;
  }

  if (request.modelNorm) {
    where.push(`(
      model_norm LIKE @modelLike
      OR replace(model_norm, ' ', '') LIKE @modelCompactLike
      OR motor_norm LIKE @modelLike
      OR trim_norm LIKE @modelLike
      OR lower(title) LIKE @modelLike
      OR lower(title) LIKE @modelCompactLike
    )`);
    params.modelLike = `%${request.modelNorm.replace(/\s+/g, "%")}%`;
    params.modelCompactLike = `%${request.modelCompact}%`;
  }

  if (request.detailNorm) {
    where.push("carprice_edition(@detail, COALESCE(trim_norm,'') || ' ' || COALESCE(motor,'') || ' ' || COALESCE(model,'') || ' ' || COALESCE(title,'')) = 1");
    params.detail = request.modelDetail;
  }

  if (request.year && attempt.yearWindow !== null) {
    where.push("CAST(year AS INTEGER) BETWEEN @yearFrom AND @yearTo");
    params.yearFrom = request.year - attempt.yearWindow;
    params.yearTo = request.year + attempt.yearWindow;
  }

  if (request.fuelSpecified && (!request.fuelNorm || request.fuelNorm === 'hybrid')) {
    where.push("0"); // A generic hybrid label cannot identify PHEV, HEV or MHEV.
  } else if (request.fuelNorm) {
    where.push("carprice_powertrain(COALESCE(NULLIF(fuel,''),fuel_norm),motor,model,title) = @powertrain");
    params.powertrain = request.fuelNorm;
  }
  if (request.motor) {
    where.push("carprice_engine(@motor, COALESCE(motor,'') || ' ' || COALESCE(title,'')) = 1");
    params.motor = request.motor;
  }

  if (request.transmissionNorm) {
    if (request.comparisonPolicy) {
      where.push("carprice_partial_spec('transmission', @transmission, transmission, transmission_norm, title) = 1");
      params.transmission = request.transmissionNorm;
    } else {
      where.push("(transmission_norm LIKE @transmissionLike OR lower(transmission) LIKE @transmissionLike)");
      params.transmissionLike = `%${request.transmissionNorm}%`;
    }
  }

  if (request.driveNorm) {
    if (request.comparisonPolicy) {
      where.push("carprice_partial_spec('drive', @drive, drive, drive_norm, title) = 1");
      params.drive = request.driveNorm;
    } else {
      where.push("(drive_norm LIKE @driveLike OR lower(drive) LIKE @driveLike)");
      params.driveLike = `%${request.driveNorm}%`;
    }
  }

  if (request.kw) {
    where.push("CAST(kw AS INTEGER) BETWEEN @kwFrom AND @kwTo");
    params.kwFrom = Math.max(1, Math.round(request.kw - 18));
    params.kwTo = Math.round(request.kw + 18);
  }

  return { where: where.join(" AND "), params };
}

export function initVehicleDb(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  db.function('carprice_powertrain', { deterministic: true }, (fuel, motor, model, title) =>
    normalizePowertrain({ fuel, motor, model, title }));
  db.function('carprice_edition', { deterministic: true }, (requested, text) => Number(matchesEdition(requested, text)));
  db.function('carprice_engine', { deterministic: true }, (requested, text) => Number(matchesEngine(requested, text)));
  db.function('carprice_partial_spec', { deterministic: true }, (kind, requested, raw, normalized, title) =>
    Number(assessSpec(kind, requested, raw, normalized, title).include));
  db.function('carprice_mileage', { deterministic: true }, parseMileage);
  const table = detectTable(db);

  if (!table) {
    throw new Error(`V databazi ${resolvedPath} nebyla nalezena tabulka s vozidly.`);
  }
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name),
  );
  const supportsActiveFlag = columns.has("is_active");
  const supportsFreshness = ["is_active", "last_seen_at", "last_checked_at", "missing_checks"]
    .every((column) => columns.has(column));

  function fetchCandidates(input, limit = 5000, forEstimate = false, mileageDistanceMultiplier = 3) {
    const request = normalizeRequest(input);
    const attempts = [
      { yearWindow: 1, useFuel: true, useKw: true, useTransmission: true, useDrive: true, useDetail: true },
      { yearWindow: 2, useFuel: true, useKw: true, useTransmission: true, useDrive: true, useDetail: true },
    ];

    let bestRows = [];
    let usedAttempt = attempts[attempts.length - 1];

    if (request.invalidMileage) return { request, vehicles: [], usedAttempt, table };

    for (const attempt of attempts) {
      const { where, params } = buildWhere(request, attempt, supportsActiveFlag, supportsFreshness);
      // Filter before LIMIT and before deciding whether to widen the year
      // window. Unknown mileage cannot crowd out usable price evidence.
      let mileageWhere = '';
      let mileageOrder = '';
      if (request.mileageKm) {
        params.targetMileage = request.mileageKm;
        mileageOrder = `ORDER BY CASE WHEN carprice_mileage(mileage) > 0 THEN 0 ELSE 1 END,
          ABS(carprice_mileage(mileage) - @targetMileage), source_url`;
        if (forEstimate) {
          params.maxMileageDistance = mileageBandwidth(request.mileageKm) * mileageDistanceMultiplier;
          mileageWhere = `AND carprice_mileage(mileage) > 0
            AND ABS(carprice_mileage(mileage) - @targetMileage) <= @maxMileageDistance`;
        }
      }
      const rows = db
        .prepare(
          `
          SELECT
            brand, model, year, mileage, fuel, motor, price, transmission, drive,
            source_url, source_db, title, trim_norm AS trim, kw, transmission_norm, drive_norm
          FROM ${JSON.stringify(table)}
          WHERE ${where}
          ${mileageWhere}
          ${mileageOrder}
          LIMIT @limit
          `,
        )
        .all({ ...params, limit });

      const mapped = rows
        .map(rowToVehicle)
        .filter((row) => row.price_czk && row.year);

      if (mapped.length > bestRows.length) {
        bestRows = mapped;
        usedAttempt = attempt;
      }

      if (mapped.length >= 20) {
        bestRows = mapped;
        usedAttempt = attempt;
        break;
      }
    }

    bestRows.sort((a, b) => scoreVehicle(a, request) - scoreVehicle(b, request));
    return { request, vehicles: bestRows, usedAttempt, table };
  }

  function estimatePrice(input) {
    let { request, vehicles, usedAttempt } = fetchCandidates(input, 5000, true);
    const selected = vehicles.slice(0, Math.min(120, Math.max(vehicles.length, 0)));
    const prices = selected.map((vehicle) => vehicle.price_czk).filter(Boolean);
    const weighted = request.mileageKm ? selected.map(vehicle => ({
      value: vehicle.price_czk, weight: mileageWeight(vehicle.mileage, request.mileageKm),
    })) : null;
    const effectiveCount = weighted ? effectiveComparables(weighted) : prices.length;
    const insufficientMileageSupport = weighted && effectiveCount < MIN_EFFECTIVE_COMPARABLES;
    const priceAt = quantile => weighted
      ? weightedPercentile(weighted, quantile) : percentile(prices, quantile);
    const sourceCounts = countMarketSources(selected);
    const partialSpecs = request.comparisonPolicy ? summarizePartialSpecs(selected, request) : null;
    const powertrains = new Set(selected.map(vehicle => vehicle.powertrain).filter(Boolean));
    const unconfirmed = request.fuelNorm === 'hybrid' ||
      request.fuelSpecified && !request.fuelNorm ||
      !request.fuelNorm && selected.length > 0 && (powertrains.size !== 1 || selected.some(vehicle => !vehicle.powertrain || vehicle.powertrain === 'hybrid'));

    // High-mileage cars are rare. When the normal local neighbourhood has too
    // little evidence, extend it while preserving every variant constraint,
    // then normalize observed prices to the requested mileage from the
    // observed median mileage slope. This is deliberately low confidence.
    if (!request.invalidMileage && request.mileageKm && (prices.length < 3 || insufficientMileageSupport) && !unconfirmed) {
      const extended = fetchCandidates(input, 5000, true, 6);
      const candidates = extended.vehicles.slice(0, 120)
        .filter(vehicle => vehicle.price_czk && vehicle.mileage > 0);
      const mileageValues = candidates.map(vehicle => vehicle.mileage);
      const minimumMileage = Math.min(...mileageValues);
      const maximumMileage = Math.max(...mileageValues);
      const outsideRange = Math.max(minimumMileage - request.mileageKm, request.mileageKm - maximumMileage, 0);
      const slope = robustMileageSlope(candidates.map(vehicle => ({ mileage: vehicle.mileage, price: vehicle.price_czk })));
      const adjusted = slope === null ? [] : candidates.map(vehicle => ({
        value: vehicle.price_czk + slope * (request.mileageKm - vehicle.mileage),
        weight: extrapolationWeight(vehicle.mileage, request.mileageKm),
      })).filter(item => item.value > 0 && item.weight > 0);
      const extrapolatedEffectiveCount = effectiveComparables(adjusted);
      if (candidates.length >= 4 && maximumMileage - minimumMileage >= 100000 &&
          outsideRange <= 180000 && extrapolatedEffectiveCount >= MIN_EFFECTIVE_COMPARABLES) {
        vehicles = extended.vehicles;
        usedAttempt = extended.usedAttempt;
        const sourceCounts = countMarketSources(candidates);
        return {
          found: true,
          matching: {
            schema_version: 1, powertrain: request.fuelNorm || null,
            powertrain_applied: Boolean(request.fuelNorm), engine: request.motor || null,
            engine_applied: Boolean(request.motor), trim: request.modelDetail || null,
            trim_applied: Boolean(request.detailNorm), power_applied: Boolean(request.kw),
            transmission_applied: Boolean(request.transmissionNorm), drive_applied: Boolean(request.driveNorm),
            year_window: usedAttempt.yearWindow, minimum_comparables: 3,
            mileage_applied: true, mileage_km: request.mileageKm,
            mileage_extrapolated: true, mileage_extrapolation_slope_czk_per_km: slope,
            mileage_bandwidth_km: extrapolationBandwidth(request.mileageKm),
            mileage_max_distance_km: mileageBandwidth(request.mileageKm) * 6,
            mileage_effective_comparables: Math.round(extrapolatedEffectiveCount * 100) / 100,
            mileage_minimum_effective_comparables: MIN_EFFECTIVE_COMPARABLES,
            price_method: MILEAGE_EXTRAPOLATION_METHOD, confidence: 'low',
          },
          count: candidates.length, source_counts: sourceCounts,
          price_czk: roundPrice(weightedPercentile(adjusted, 0.5)),
          low_czk: roundPrice(weightedPercentile(adjusted, 0.15)),
          high_czk: roundPrice(weightedPercentile(adjusted, 0.85)),
          source: "backend_db", table, used_filters: usedAttempt,
          request: { brand: request.brand, model: request.model, year: request.year,
            mileage_km: request.mileageKm, fuel: request.fuelNorm },
        };
      }
    }
    const matching = {
      schema_version: 1, powertrain: request.fuelNorm || null,
      powertrain_applied: Boolean(request.fuelNorm) && !unconfirmed,
      engine: request.motor || null, engine_applied: Boolean(request.motor),
      trim: request.modelDetail || null, trim_applied: Boolean(request.detailNorm),
      power_applied: Boolean(request.kw), transmission_applied: Boolean(request.transmissionNorm),
      drive_applied: Boolean(request.driveNorm), year_window: usedAttempt.yearWindow,
      minimum_comparables: 3,
      mileage_applied: Boolean(request.mileageKm),
      mileage_km: request.mileageKm,
      price_method: weighted ? MILEAGE_PRICE_METHOD : 'median',
      ...(weighted ? {
        mileage_bandwidth_km: mileageBandwidth(request.mileageKm),
        mileage_max_distance_km: mileageBandwidth(request.mileageKm) * 3,
        mileage_effective_comparables: Math.round(effectiveCount * 100) / 100,
        mileage_minimum_effective_comparables: MIN_EFFECTIVE_COMPARABLES,
      } : {}),
      ...(partialSpecs ? { comparison_policy: request.comparisonPolicy,
        transmission_fully_confirmed: partialSpecs.transmission_unknown === 0,
        drive_fully_confirmed: partialSpecs.drive_unknown === 0 } : {}),
    };

    if (request.invalidMileage || prices.length < 3 || insufficientMileageSupport || unconfirmed) {
      return {
        found: false,
        matching,
        price_estimate_not_found_reason: request.invalidMileage ? 'missing_input'
          : unconfirmed ? 'powertrain_unconfirmed' : 'insufficient_comparable_vehicles',
        ...(request.invalidMileage ? { invalid_fields: ['mileage'] } : {}),
        count: prices.length,
        source_counts: sourceCounts,
        ...(partialSpecs ? { comparison_policy: request.comparisonPolicy, partial_specs: partialSpecs } : {}),
        price_czk: null,
        low_czk: null,
        high_czk: null,
        source: "backend_db",
        table,
        used_filters: usedAttempt,
      };
    }

    return {
      found: true,
      matching,
      count: prices.length,
      source_counts: sourceCounts,
      ...(partialSpecs ? { comparison_policy: request.comparisonPolicy, partial_specs: partialSpecs } : {}),
      price_czk: roundPrice(priceAt(0.5)),
      low_czk: roundPrice(priceAt(0.15)),
      high_czk: roundPrice(priceAt(0.85)),
      source: "backend_db",
      table,
      used_filters: usedAttempt,
      request: {
        brand: request.brand,
        model: request.model,
        year: request.year,
        mileage_km: request.mileageKm,
        fuel: request.fuelNorm,
      },
    };
  }

  function findComps(input, limit = 12) {
    const comparisonRequest = normalizeRequest(input);
    const requested = Number(limit);
    const cap = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 5000)) : 12;
    let vehicles;
    if (input.mode === "trend") {
      const request = normalizeRequest(input);
      if (!request.brandNorm || !request.modelNorm || !request.year) return [];
      const { where, params } = buildWhere(request, {
        yearWindow: 8, useFuel: true, useKw: false,
        useTransmission: false, useDrive: false, useDetail: false,
      }, supportsActiveFlag, supportsFreshness);
      // Sample every model year independently: the closest year must not
      // consume the entire chart budget.
      vehicles = db.prepare(`SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY CAST(year AS INTEGER) ORDER BY source_url
        ) AS year_rank FROM ${JSON.stringify(table)} WHERE ${where}
      ) WHERE year_rank <= 290 ORDER BY year_rank, CAST(year AS INTEGER)`)
        .all(params).map(rowToVehicle).filter(row => row.price_czk && row.year);
    } else {
      ({ vehicles } = fetchCandidates(input));
    }
    const seen = new Set();
    vehicles = vehicles.filter(vehicle => {
      try {
        const url = new URL(vehicle.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
        url.search = ""; url.hash = "";
        const key = url.toString();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch { return false; }
    });
    // Preserve ranking within each source, while exposing each available
    // source even in the short preview requested by older app versions.
    const groups = new Map();
    for (const vehicle of vehicles) {
      const key = marketSourceId(vehicle.url, vehicle.source_db);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(vehicle);
    }
    const selected = [];
    for (let index = 0; selected.length < cap; index++) {
      let added = false;
      for (const group of groups.values()) {
        if (index < group.length && selected.length < cap) {
          selected.push(group[index]); added = true;
        }
      }
      if (!added) break;
    }
    return selected.map((vehicle) => ({
      source: vehicle.source,
      url: vehicle.url,
      brand: vehicle.brand,
      model: vehicle.model,
      year: vehicle.year,
      mileage: vehicle.mileage,
      fuel: vehicle.fuel,
      powertrain: vehicle.powertrain,
      title: vehicle.title,
      trim: vehicle.trim,
      motor: vehicle.motor,
      transmission: vehicle.transmission,
      drive: vehicle.drive,
      kw: vehicle.kw,
      price_czk: vehicle.price_czk,
      scraped_at: vehicle.source_db,
      ...(comparisonRequest.comparisonPolicy ? { comparison_unknown: unknownSpecs(vehicle, comparisonRequest) } : {}),
    }));
  }

  function health() {
    const count = supportsActiveFlag
      ? db.prepare(
        `SELECT COUNT(*) AS count,
                SUM(CASE WHEN COALESCE(CAST(is_active AS INTEGER), 1) <> 0 THEN 1 ELSE 0 END)
                  AS active_count,
                SUM(CASE WHEN COALESCE(CAST(is_active AS INTEGER), 1) = 0 THEN 1 ELSE 0 END)
                  AS inactive_count
           FROM ${JSON.stringify(table)}`,
      ).get()
      : db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)}`).get();
    return {
      ok: true,
      path: resolvedPath,
      table,
      count: count.count,
      active_count: supportsActiveFlag ? count.active_count : count.count,
      inactive_count: supportsActiveFlag ? count.inactive_count : 0,
      active_filter: supportsActiveFlag,
    };
  }

  return {
    estimatePrice,
    findComps,
    health,
    close() {
      db.close();
    },
  };
}
