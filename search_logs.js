import Database from "better-sqlite3";

function cleanText(value, maxLength = 120) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

function cleanVin(value) {
  return cleanText(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cleanInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanBool(value) {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

export function normalizeSearchLog(input = {}, meta = {}) {
  const row = {
    created_at: Date.now(),
    vin: cleanVin(input.vin),
    brand: cleanText(input.brand),
    model: cleanText(input.model),
    model_detail: cleanText(firstPresent(input.modelDetail, input.model_detail)),
    year: cleanInt(input.year),
    year_from: cleanInt(firstPresent(input.yearFrom, input.year_from)),
    year_to: cleanInt(firstPresent(input.yearTo, input.year_to)),
    mileage_km: cleanInt(firstPresent(input.mileageKm, input.mileage_km, input.mileage)),
    fuel: cleanText(input.fuel),
    drive: cleanText(input.drive),
    transmission: cleanText(firstPresent(input.transmission, input.gearbox)),
    kw: cleanInt(firstPresent(input.kw, input.powerKw, input.power_kw)),
    estimated_price_czk: cleanNumber(
      firstPresent(input.estimatedPriceCzk, input.estimated_price_czk, input.priceCzk, input.price_czk),
    ),
    low_czk: cleanNumber(firstPresent(input.lowCzk, input.low_czk)),
    high_czk: cleanNumber(firstPresent(input.highCzk, input.high_czk)),
    result_count: cleanInt(firstPresent(input.resultCount, input.result_count, input.count)),
    found: cleanBool(input.found),
    price_source: cleanText(firstPresent(input.priceSource, input.price_source, input.source), 60),
    decode_source: cleanText(firstPresent(input.decodeSource, input.decode_source), 60),
    platform: cleanText(input.platform, 40),
    app_version: cleanText(firstPresent(input.appVersion, input.app_version), 40),
    build_number: cleanText(firstPresent(input.buildNumber, input.build_number), 40),
    user_agent: cleanText(meta.userAgent, 200),
  };

  row.payload_json = JSON.stringify({
    vin: row.vin || null,
    brand: row.brand || null,
    model: row.model || null,
    model_detail: row.model_detail || null,
    year: row.year,
    year_from: row.year_from,
    year_to: row.year_to,
    mileage_km: row.mileage_km,
    fuel: row.fuel || null,
    drive: row.drive || null,
    transmission: row.transmission || null,
    kw: row.kw,
    estimated_price_czk: row.estimated_price_czk,
    low_czk: row.low_czk,
    high_czk: row.high_czk,
    result_count: row.result_count,
    found: row.found,
    price_source: row.price_source || null,
    decode_source: row.decode_source || null,
    platform: row.platform || null,
    app_version: row.app_version || null,
    build_number: row.build_number || null,
  });

  return row;
}

export function initSearchLogsDb(sqlitePath) {
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      vin TEXT,
      brand TEXT,
      model TEXT,
      model_detail TEXT,
      year INTEGER,
      year_from INTEGER,
      year_to INTEGER,
      mileage_km INTEGER,
      fuel TEXT,
      drive TEXT,
      transmission TEXT,
      kw INTEGER,
      estimated_price_czk REAL,
      low_czk REAL,
      high_czk REAL,
      result_count INTEGER,
      found INTEGER,
      price_source TEXT,
      decode_source TEXT,
      platform TEXT,
      app_version TEXT,
      build_number TEXT,
      user_agent TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_search_logs_brand_model ON search_logs(brand, model);
    CREATE INDEX IF NOT EXISTS idx_search_logs_vin ON search_logs(vin);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO search_logs (
      created_at, vin, brand, model, model_detail, year, year_from, year_to,
      mileage_km, fuel, drive, transmission, kw, estimated_price_czk, low_czk,
      high_czk, result_count, found, price_source, decode_source, platform,
      app_version, build_number, user_agent, payload_json
    ) VALUES (
      @created_at, @vin, @brand, @model, @model_detail, @year, @year_from, @year_to,
      @mileage_km, @fuel, @drive, @transmission, @kw, @estimated_price_czk, @low_czk,
      @high_czk, @result_count, @found, @price_source, @decode_source, @platform,
      @app_version, @build_number, @user_agent, @payload_json
    )
  `);

  const listStmt = db.prepare(`
    SELECT
      id, created_at, vin, brand, model, model_detail, year, year_from, year_to,
      mileage_km, fuel, drive, transmission, kw, estimated_price_czk, low_czk,
      high_czk, result_count, found, price_source, decode_source, platform,
      app_version, build_number
    FROM search_logs
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `);

  const summaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN found = 1 THEN 1 ELSE 0 END) AS found_total,
      SUM(CASE WHEN found = 0 THEN 1 ELSE 0 END) AS not_found_total,
      MIN(created_at) AS first_created_at,
      MAX(created_at) AS last_created_at
    FROM search_logs
    WHERE created_at >= @from
  `);

  const topModelsStmt = db.prepare(`
    SELECT brand, model, COUNT(*) AS count
    FROM search_logs
    WHERE created_at >= @from
      AND brand != ''
      AND model != ''
    GROUP BY brand, model
    ORDER BY count DESC, brand ASC, model ASC
    LIMIT @limit
  `);

  return {
    insert(input, meta) {
      const row = normalizeSearchLog(input, meta);
      const result = insertStmt.run(row);
      return { id: result.lastInsertRowid, created_at: row.created_at };
    },
    list({ limit = 100, offset = 0 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const safeOffset = Math.max(Number(offset) || 0, 0);
      return listStmt.all({ limit: safeLimit, offset: safeOffset });
    },
    summary({ days = 30, limit = 10 } = {}) {
      const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);
      const from = Date.now() - safeDays * 24 * 60 * 60 * 1000;
      return {
        days: safeDays,
        ...summaryStmt.get({ from }),
        top_models: topModelsStmt.all({ from, limit: Math.min(Math.max(Number(limit) || 10, 1), 50) }),
      };
    },
  };
}
