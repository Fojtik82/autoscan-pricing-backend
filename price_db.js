import path from "node:path";
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
  return year >= 1980 && year <= 2035 ? year : null;
}

function normalizeFuel(value) {
  const normalized = fold(value);
  if (!normalized) return "";
  if (["nafta", "diesel", "tdi", "d"].some((needle) => normalized.includes(needle))) {
    return "diesel";
  }
  if (["benzin", "benzine", "petrol", "tsi", "tfsi"].some((needle) => normalized.includes(needle))) {
    return "benzin";
  }
  if (normalized.includes("hybrid")) return "hybrid";
  if (normalized.includes("elektro") || normalized.includes("electric")) return "elektro";
  if (normalized.includes("lpg")) return "lpg";
  if (normalized.includes("cng")) return "cng";
  return normalized;
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
  const mileage = parseNumber(row.mileage);
  const kw = parseNumber(row.kw);

  return {
    source: row.source_db || "vehicles_ai",
    url: row.source_url || "",
    brand: row.brand || "",
    model: row.model || "",
    year,
    mileage: mileage ? Math.round(mileage) : null,
    fuel: row.fuel || "",
    motor: row.motor || "",
    transmission: row.transmission || "",
    drive: row.drive || "",
    kw: kw ? Math.round(kw) : null,
    price_czk: price,
    title: row.title || "",
    source_db: row.source_db || "",
  };
}

function scoreVehicle(vehicle, request) {
  let score = 0;

  if (request.year && vehicle.year) {
    score += Math.abs(vehicle.year - request.year) * 12;
  }
  if (request.mileageKm && vehicle.mileage) {
    score += Math.abs(vehicle.mileage - request.mileageKm) / 12000;
  }
  if (request.kw && vehicle.kw) {
    score += Math.abs(vehicle.kw - request.kw) * 0.7;
  }
  if (request.fuelNorm && normalizeFuel(vehicle.fuel) !== request.fuelNorm) {
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

function normalizeRequest(input = {}) {
  const brand = input.brand || input.make || "";
  const model = input.model || "";
  const modelDetail = input.modelDetail || input.equipment || input.trim || "";
  const mileageKm = parseNumber(input.mileageKm || input.mileage || input.odometerKm);

  return {
    brand,
    model,
    modelDetail,
    brandNorm: fold(brand),
    modelNorm: fold(model),
    modelCompact: compact(model),
    detailNorm: fold(modelDetail),
    detailCompact: compact(modelDetail),
    year: parseYear(input.year),
    mileageKm: mileageKm ? Math.round(mileageKm) : null,
    fuelNorm: normalizeFuel(input.fuel),
    transmissionNorm: fold(input.transmission),
    driveNorm: fold(input.drive),
    kw: parseNumber(input.kw || input.powerKw || input.power),
  };
}

function buildWhere(request, attempt) {
  const where = ["price IS NOT NULL", "TRIM(price) <> ''"];
  const params = {};

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

  if (request.detailNorm && attempt.useDetail) {
    where.push(`(
      trim_norm LIKE @detailLike
      OR motor_norm LIKE @detailLike
      OR lower(title) LIKE @detailLike
      OR lower(title) LIKE @detailCompactLike
    )`);
    params.detailLike = `%${request.detailNorm.replace(/\s+/g, "%")}%`;
    params.detailCompactLike = `%${request.detailCompact}%`;
  }

  if (request.year && attempt.yearWindow !== null) {
    where.push("CAST(year AS INTEGER) BETWEEN @yearFrom AND @yearTo");
    params.yearFrom = request.year - attempt.yearWindow;
    params.yearTo = request.year + attempt.yearWindow;
  }

  if (request.fuelNorm && attempt.useFuel) {
    where.push("(fuel_norm LIKE @fuelLike OR lower(fuel) LIKE @fuelLike)");
    params.fuelLike = `%${request.fuelNorm}%`;
  }

  if (request.transmissionNorm && attempt.useTransmission) {
    where.push("(transmission_norm LIKE @transmissionLike OR lower(transmission) LIKE @transmissionLike)");
    params.transmissionLike = `%${request.transmissionNorm}%`;
  }

  if (request.driveNorm && attempt.useDrive) {
    where.push("(drive_norm LIKE @driveLike OR lower(drive) LIKE @driveLike)");
    params.driveLike = `%${request.driveNorm}%`;
  }

  if (request.kw && attempt.useKw) {
    where.push("CAST(kw AS INTEGER) BETWEEN @kwFrom AND @kwTo");
    params.kwFrom = Math.max(1, Math.round(request.kw - 18));
    params.kwTo = Math.round(request.kw + 18);
  }

  return { where: where.join(" AND "), params };
}

export function initVehicleDb(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  const table = detectTable(db);

  if (!table) {
    throw new Error(`V databazi ${resolvedPath} nebyla nalezena tabulka s vozidly.`);
  }

  function fetchCandidates(input, limit = 5000) {
    const request = normalizeRequest(input);
    const attempts = [
      { yearWindow: 1, useFuel: true, useKw: true, useTransmission: true, useDrive: true, useDetail: true },
      { yearWindow: 2, useFuel: true, useKw: true, useTransmission: false, useDrive: false, useDetail: true },
      { yearWindow: 4, useFuel: true, useKw: false, useTransmission: false, useDrive: false, useDetail: false },
      { yearWindow: 6, useFuel: false, useKw: false, useTransmission: false, useDrive: false, useDetail: false },
      { yearWindow: null, useFuel: false, useKw: false, useTransmission: false, useDrive: false, useDetail: false },
    ];

    let bestRows = [];
    let usedAttempt = attempts[attempts.length - 1];

    for (const attempt of attempts) {
      const { where, params } = buildWhere(request, attempt);
      const rows = db
        .prepare(
          `
          SELECT
            brand, model, year, mileage, fuel, motor, price, transmission, drive,
            source_url, source_db, title, kw
          FROM ${JSON.stringify(table)}
          WHERE ${where}
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
    const { request, vehicles, usedAttempt } = fetchCandidates(input);
    const selected = vehicles.slice(0, Math.min(120, Math.max(vehicles.length, 0)));
    const prices = selected.map((vehicle) => vehicle.price_czk).filter(Boolean);

    if (prices.length < 3) {
      return {
        found: false,
        count: prices.length,
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
      count: prices.length,
      price_czk: roundPrice(percentile(prices, 0.5)),
      low_czk: roundPrice(percentile(prices, 0.15)),
      high_czk: roundPrice(percentile(prices, 0.85)),
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
    const { vehicles } = fetchCandidates(input, Math.max(1000, Number(limit) * 80));
    return vehicles.slice(0, Math.min(Number(limit) || 12, 30)).map((vehicle) => ({
      source: vehicle.source,
      url: vehicle.url,
      brand: vehicle.brand,
      model: vehicle.model,
      year: vehicle.year,
      mileage: vehicle.mileage,
      fuel: vehicle.fuel,
      motor: vehicle.motor,
      transmission: vehicle.transmission,
      drive: vehicle.drive,
      price_czk: vehicle.price_czk,
      scraped_at: vehicle.source_db,
    }));
  }

  function health() {
    const count = db.prepare(`select count(*) as count from ${JSON.stringify(table)}`).get();
    return {
      ok: true,
      path: resolvedPath,
      table,
      count: count.count,
    };
  }

  return { estimatePrice, findComps, health };
}
