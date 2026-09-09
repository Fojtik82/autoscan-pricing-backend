import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { parseSautoListingId } from "./sauto_lifecycle.js";
import { parseBazosListing } from "./bazos_lifecycle.js";
import "dotenv/config";
import express from "express";
import { initDb } from "./db.js";
import { decodeVinPipeline } from "./decoder_pipeline.js";
import { initVehicleDb } from "./price_db.js";
import { initSearchLogsDb } from "./search_logs.js";
import { initVehicleIngestDb, isAuthorizedIngestRequest } from "./vehicle_ingest.js";
import { normalizeVin, validateVin } from "./vin.js";
import { ensureVehicleDatabaseSync } from "./vehicle_db_archive.js";

const PORT = Number(process.env.PORT || 3000);
const SQLITE_PATH = process.env.SQLITE_PATH || "./vin_cache.db";
const NHTSA_TIMEOUT_MS = Number(process.env.NHTSA_TIMEOUT_MS || 8000);
const VEHICLES_DB_PATH =
  process.env.VEHICLES_DB_PATH || process.env.VEHICLE_DB_PATH || "./data/vehicles_ai.db";
const VEHICLE_INGEST_API_KEY = String(process.env.VEHICLE_INGEST_API_KEY || "");
const SEARCH_LOGS_ADMIN_KEY = String(process.env.SEARCH_LOGS_ADMIN_KEY || "");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});
app.use((req, res, next) => {
  req.setTimeout(90_000);
  res.setTimeout(90_000);
  next();
});

const cache = initDb(SQLITE_PATH);
const searchLogs = initSearchLogsDb(SQLITE_PATH);
let vehicleDb = null;
let vehicleIngestDb = null;

try {
  ensureVehicleDatabaseSync(VEHICLES_DB_PATH);
  vehicleDb = initVehicleDb(VEHICLES_DB_PATH);
  if (VEHICLE_INGEST_API_KEY) vehicleIngestDb = initVehicleIngestDb(VEHICLES_DB_PATH);
  console.log("Vehicle price DB loaded", vehicleDb.health());
} catch (error) {
  console.error("Vehicle price DB was not loaded:", error.message);
}


// Export only public listing fields, never VIN cache or search-log data.
// This snapshot covers known ads confirmed in the latest complete source index;
// it is not a claim that every market listing or every asking price was refetched.
function createMobileVehicleSnapshot(sourcePath) {
  const source = new Database(path.resolve(sourcePath), {
    readonly: true, fileMustExist: true,
  });
  const fields = [
    "brand", "model", "year", "mileage", "fuel", "motor", "price",
    "transmission", "drive", "kw", "body", "source_url", "source_db",
    "title", "brand_norm", "model_norm", "fuel_norm", "transmission_norm",
    "drive_norm", "motor_norm", "engine_ccm", "engine_l", "trim_norm",
    "last_seen_at", "last_checked_at",
  ];
  const now = new Date();
  const maxAgeMs = 48 * 60 * 60 * 1000;
  const latest = { sauto: null, bazos: null };
  const counts = { sauto: 0, bazos: 0 };
  let output = null;
  function sourceName(url) {
    if (parseSautoListingId(url)) return "sauto";
    if (parseBazosListing(url)) return "bazos";
    return null;
  }
  function checkedDate(value) {
    if (typeof value !== "string" || !value.endsWith("Z")) return null;
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  try {
    // The collector updates lifecycle timestamps only after its source-coverage
    // guards pass, and commits the archive only after both sources finish.
    for (const row of source.prepare(
      "SELECT source_url, last_checked_at FROM vehicle_app",
    ).iterate()) {
      const name = sourceName(row.source_url);
      const checked = checkedDate(row.last_checked_at);
      if (!name || !checked) continue;
      if (checked.getTime() > now.getTime() + 300000) {
        throw new Error("Mobile snapshot source timestamp is in the future");
      }
      if (!latest[name] || checked > latest[name]) latest[name] = checked;
    }
    for (const name of Object.keys(latest)) {
      if (!latest[name] || now.getTime() - latest[name].getTime() > maxAgeMs) {
        throw new Error("Mobile snapshot source is missing or stale: " + name);
      }
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "carprice-mobile-"));
    const temporaryPath = path.join(directory, "snapshot.tmp.db");
    output = new Database(temporaryPath);
    output.pragma("journal_mode = DELETE");
    output.exec(
      "CREATE TABLE vehicle_app (id INTEGER PRIMARY KEY, " +
      fields.map((field) => '"' + field + '" TEXT').join(", ") +
      ", is_active INTEGER NOT NULL DEFAULT 1, missing_checks INTEGER NOT NULL DEFAULT 0)",
    );
    const insert = output.prepare(
      "INSERT INTO vehicle_app (" + fields.map((field) => '"' + field + '"').join(", ") +
      ") VALUES (" + fields.map(() => "?").join(", ") + ")",
    );
    const candidates = source.prepare(
      "SELECT " + fields.map((field) => '"' + field + '"').join(", ") +
      " FROM vehicle_app WHERE is_active = 1 AND missing_checks = 0" +
      " AND last_seen_at IS NOT NULL AND last_seen_at = last_checked_at ORDER BY rowid",
    );
    const seen = new Set();
    output.transaction(() => {
      for (const row of candidates.iterate()) {
        const name = sourceName(row.source_url);
        const checked = checkedDate(row.last_checked_at);
        if (!name || !checked || checked.getTime() !== latest[name].getTime()) continue;
        const key = name === "sauto"
          ? "sauto:" + parseSautoListingId(row.source_url)
          : "bazos:" + parseBazosListing(row.source_url).key;
        if (seen.has(key)) continue;
        seen.add(key);
        insert.run(fields.map((field) => row[field] ?? null));
        counts[name] += 1;
      }
    })();
    const count = counts.sauto + counts.bazos;
    if (!counts.sauto || !counts.bazos || count > 1000000) {
      throw new Error("Mobile snapshot source counts are invalid");
    }
    output.exec(
      "CREATE INDEX idx_mobile_brand_model ON vehicle_app(brand_norm, model_norm);" +
      "CREATE INDEX idx_mobile_year ON vehicle_app(year);" +
      "CREATE INDEX idx_mobile_source_url ON vehicle_app(source_url);",
    );
    output.close();
    output = null;
    const bytes = fs.statSync(temporaryPath).size;
    if (bytes < 512 || bytes > 128 * 1024 * 1024) {
      throw new Error("Mobile snapshot exceeds the supported download size");
    }
    const hash = createHash("sha256").update(fs.readFileSync(temporaryPath)).digest("hex");
    const filename = "vehicles-" + hash + ".db";
    const snapshotPath = path.join(directory, filename);
    fs.renameSync(temporaryPath, snapshotPath);
    const dataThrough = new Date(Math.min(latest.sauto.getTime(), latest.bazos.getTime()));
    return {
      path: snapshotPath,
      manifest: {
        schema_version: 1,
        file: filename,
        sha256: hash,
        size_bytes: bytes,
        row_count: count,
        generated_at: new Date().toISOString(),
        data_through: dataThrough.toISOString(),
        coverage: "known_listings_confirmed_by_latest_complete_source_index",
        price_freshness: "existing_prices_not_refetched",
        sources: Object.fromEntries(Object.keys(counts).map((name) => [name, {
          complete: true,
          row_count: counts[name],
          observed_at: latest[name].toISOString(),
        }])),
      },
    };
  } finally {
    if (output) output.close();
    source.close();
  }
}

let mobileSnapshot = null;
try {
  if (vehicleDb) mobileSnapshot = createMobileVehicleSnapshot(VEHICLES_DB_PATH);
  if (mobileSnapshot) {
    console.log("Mobile vehicle snapshot ready", mobileSnapshot.manifest);
  }
} catch (error) {
  // A snapshot failure must not take down pricing or publish an empty database.
  console.error("Mobile vehicle snapshot unavailable:", error.message);
}

app.get("/mobile-db/manifest.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!mobileSnapshot ||
      Date.now() - Date.parse(mobileSnapshot.manifest.data_through) > 48 * 60 * 60 * 1000) {
    return res.status(503).json({ error: "fresh_mobile_snapshot_unavailable" });
  }
  return res.json(mobileSnapshot.manifest);
});

app.get("/mobile-db/:filename", (req, res) => {
  if (!mobileSnapshot || req.params.filename !== mobileSnapshot.manifest.file) {
    return res.status(404).json({ error: "mobile_snapshot_not_found" });
  }
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.type("application/vnd.sqlite3");
  return res.sendFile(mobileSnapshot.path, (error) => {
    if (error && !res.headersSent) res.status(503).end();
  });
});

function vehicleDbRequired(res) {
  if (vehicleDb) {
    return true;
  }

  res.status(503).json({
    found: false,
    error: "Cenova databaze neni na serveru nastavena.",
  });
  return false;
}

function requireSearchLogAdmin(req, res) {
  if (!SEARCH_LOGS_ADMIN_KEY) {
    res.status(503).json({
      ok: false,
      error: "SEARCH_LOGS_ADMIN_KEY neni nastaven.",
    });
    return false;
  }

  if (req.headers.authorization !== `Bearer ${SEARCH_LOGS_ADMIN_KEY}`) {
    res.status(401).json({
      ok: false,
      error: "Neplatne opravneni pro cteni search logs.",
    });
    return false;
  }

  return true;
}

function mapLegacyEstimatePayload(input = {}) {
  return {
    brand: input.brand,
    model: input.model,
    year: input.year,
    mileage: input.mileage,
    mileageKm: input.mileageKm || input.mileage,
    fuel: input.fuel,
    motor: input.motor || input.engine,
    modelDetail: input.modelDetail || input.trim || input.equipment,
    kw: input.kw || input.powerKw,
    drive: input.drive,
    transmission: input.transmission,
  };
}

function legacyEstimateResponse(result, input = {}) {
  return {
    price_estimate: Number(result.price_czk || 0),
    low: Number(result.low_czk || 0),
    high: Number(result.high_czk || 0),
    count: Number(result.count || 0),
    found: Boolean(result.found),
    reasoning: result.found
      ? `Odhad podle ${result.count} podobnych vozu z aktualni databaze CarPrice.`
      : "Pro zadane parametry nebylo nalezeno dost podobnych vozu.",
    used_data: {
      brand: String(input.brand || ""),
      model: String(input.model || ""),
      year: Number(input.year || 0),
      mileage: Number(input.mileageKm || input.mileage || 0),
      fuel: String(input.fuel || ""),
      engine: String(input.engine || input.motor || ""),
      vin: input.vin || null,
    },
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "AutoScan Pricing Backend",
    version: "2.0.0",
    vehicleDb: vehicleDb ? vehicleDb.health() : null,
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    vehicleDb: vehicleDb ? vehicleDb.health() : null,
  });
});

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    ts: Date.now(),
    vehicleDbReady: Boolean(vehicleDb),
  });
});

app.get("/price/health", (_req, res) => {
  if (!vehicleDb) {
    return res.status(503).json({
      ok: false,
      error: "VEHICLES_DB_PATH neni nastaven nebo databaze nejde otevrit.",
    });
  }
  return res.json(vehicleDb.health());
});

app.post("/price/estimate", (req, res) => {
  if (!vehicleDbRequired(res)) return;

  try {
    return res.json(vehicleDb.estimatePrice(req.body || {}));
  } catch (error) {
    return res.status(500).json({
      found: false,
      error: error.message,
    });
  }
});

app.post(["/search-logs", "/api/search-logs"], (req, res) => {
  try {
    const result = searchLogs.insert(req.body || {}, {
      userAgent: req.headers["user-agent"],
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get(["/search-logs", "/api/search-logs"], (req, res) => {
  if (!requireSearchLogAdmin(req, res)) return;

  return res.json({
    ok: true,
    items: searchLogs.list({
      limit: req.query.limit,
      offset: req.query.offset,
    }),
  });
});

app.get(["/search-logs/summary", "/api/search-logs/summary"], (req, res) => {
  if (!requireSearchLogAdmin(req, res)) return;

  return res.json({
    ok: true,
    summary: searchLogs.summary({
      days: req.query.days,
      limit: req.query.limit,
    }),
  });
});

app.post("/vehicle-ai/upsert", (req, res) => {
  if (!VEHICLE_INGEST_API_KEY || !vehicleIngestDb) {
    return res.status(503).json({ ok: false, error: "Vehicle ingest neni nakonfigurovan." });
  }
  if (!isAuthorizedIngestRequest(req.headers.authorization, VEHICLE_INGEST_API_KEY)) {
    return res.status(401).json({ ok: false, error: "Neplatne opravneni pro zapis." });
  }
  try {
    const result = vehicleIngestDb.upsert(req.body?.records);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/vehicle-ai/lookup", (req, res) => {
  if (!VEHICLE_INGEST_API_KEY || !vehicleIngestDb) {
    return res.status(503).json({ ok: false, error: "Vehicle lookup neni nakonfigurovan." });
  }
  if (!isAuthorizedIngestRequest(req.headers.authorization, VEHICLE_INGEST_API_KEY)) {
    return res.status(401).json({ ok: false, error: "Neplatne opravneni pro cteni." });
  }
  try {
    const vehicle = vehicleIngestDb.lookup(req.body?.vin);
    if (!vehicle) return res.status(404).json({ ok: false, found: false });
    return res.json({ ok: true, found: true, vehicle });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post(["/estimate", "/api/estimate"], (req, res) => {
  if (!vehicleDbRequired(res)) return;

  try {
    const payload = mapLegacyEstimatePayload(req.body || {});
    const result = vehicleDb.estimatePrice(payload);
    return res.json(legacyEstimateResponse(result, req.body || {}));
  } catch (error) {
    return res.status(500).json({
      error: "Estimate failed",
      detail: error.message,
    });
  }
});

app.get("/comps", (req, res) => {
  if (!vehicleDb) {
    return res.status(503).json({
      error: "Cenova databaze neni na serveru nastavena.",
      items: [],
    });
  }

  try {
    const limit = req.query.limit ? Number(req.query.limit) : 12;
    return res.json(vehicleDb.findComps(req.query || {}, limit));
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      items: [],
    });
  }
});

app.get("/vin/decode/:vin", async (req, res) => {
  const vinInput = req.params.vin;
  const modelYear = req.query.modelYear ? Number(req.query.modelYear) : null;
  const refresh = String(req.query.refresh || "0") === "1";

  const v = validateVin(normalizeVin(vinInput));
  if (!v.ok) {
    return res.status(400).json({
      vin: v.vin,
      valid: false,
      reason: v.reason,
      source: "local",
      confidence: 1.0,
    });
  }

  if (!refresh) {
    const cached = cache.get(v.vin);
    if (cached) return res.json(JSON.parse(cached.payload_json));
  }

  try {
    const payload = await decodeVinPipeline(v.vin, {
      modelYear,
      timeoutMs: NHTSA_TIMEOUT_MS,
    });

    cache.upsert({
      vin: v.vin,
      valid: 1,
      payload_json: JSON.stringify(payload),
      source: payload.source || "mixed",
      confidence: payload.confidence || 0.5,
      now: Date.now(),
    });

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      vin: v.vin,
      valid: false,
      reason: error.message,
      source: "backend",
      confidence: 0,
    });
  }
});

app.listen(PORT, () => {
  console.log(`AutoScan Pricing Backend listening on port ${PORT}`);
});
