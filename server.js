import "dotenv/config";
import express from "express";
import { initDb } from "./db.js";
import { decodeVinPipeline } from "./decoder_pipeline.js";
import { initVehicleDb } from "./price_db.js";
import { initVehicleIngestDb, isAuthorizedIngestRequest } from "./vehicle_ingest.js";
import { normalizeVin, validateVin } from "./vin.js";

const PORT = Number(process.env.PORT || 3000);
const SQLITE_PATH = process.env.SQLITE_PATH || "./vin_cache.db";
const NHTSA_TIMEOUT_MS = Number(process.env.NHTSA_TIMEOUT_MS || 8000);
const VEHICLES_DB_PATH =
  process.env.VEHICLES_DB_PATH || process.env.VEHICLE_DB_PATH || "./data/vehicles_ai.db";
const VEHICLE_INGEST_API_KEY = String(process.env.VEHICLE_INGEST_API_KEY || "");

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
let vehicleDb = null;
let vehicleIngestDb = null;

try {
  vehicleDb = initVehicleDb(VEHICLES_DB_PATH);
  if (VEHICLE_INGEST_API_KEY) vehicleIngestDb = initVehicleIngestDb(VEHICLES_DB_PATH);
  console.log("Vehicle price DB loaded", vehicleDb.health());
} catch (error) {
  console.error("Vehicle price DB was not loaded:", error.message);
}

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
