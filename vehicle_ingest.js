import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const TABLE = "vehicle_app";
const COLUMNS = [
  "brand", "model", "year", "mileage", "fuel", "motor", "price", "transmission",
  "drive", "vin", "kw", "body", "source_url", "source_db", "title",
  "brand_norm", "model_norm", "fuel_norm", "transmission_norm", "drive_norm",
  "motor_norm", "engine_ccm", "engine_l", "trim_norm", "equipment",
  "equipment_fold", "color", "first_registration", "doors", "seats",
];
const ALLOWED_SOURCES = new Set([
  "caroffice-anonymized-vehicle",
  "caroffice-anonymized-purchase",
  "caroffice-anonymized-asking",
  "caroffice-anonymized-sold",
]);

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function text(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function numericText(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return "";
  return String(Math.round(number));
}

export function isAuthorizedIngestRequest(authorization, expectedSecret) {
  const expected = String(expectedSecret || "");
  const supplied = String(authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function sanitizeVehicleObservation(record = {}) {
  const vin = text(record.vin, 17).toUpperCase();
  const sourceDb = text(record.source_db, 80).toLowerCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) || !ALLOWED_SOURCES.has(sourceDb)) return null;
  const price = sourceDb === "caroffice-anonymized-vehicle"
    ? ""
    : numericText(record.price, 1000, 100000000);
  if (sourceDb !== "caroffice-anonymized-vehicle" && !price) return null;
  const equipment = text(record.equipment, 12000);
  const transmission = text(record.transmission, 120);
  const drive = text(record.drive, 120);
  const motor = text(record.motor, 300);
  return {
    brand: text(record.brand, 120),
    model: text(record.model, 160),
    year: numericText(record.year, 1886, 2100),
    mileage: numericText(record.mileage, 0, 10000000),
    fuel: text(record.fuel, 120),
    motor,
    price,
    transmission,
    drive,
    vin,
    kw: numericText(record.kw, 1, 5000),
    body: text(record.body, 160),
    source_url: "",
    source_db: sourceDb,
    title: text(record.title, 500),
    brand_norm: fold(record.brand),
    model_norm: fold(record.model),
    fuel_norm: fold(record.fuel),
    transmission_norm: fold(transmission),
    drive_norm: fold(drive),
    motor_norm: fold(motor),
    engine_ccm: numericText(record.engine_ccm, 1, 20000),
    engine_l: text(record.engine_l, 20),
    trim_norm: fold(record.trim || record.trim_norm),
    equipment,
    equipment_fold: fold(equipment).slice(0, 12000),
    color: text(record.color, 120),
    first_registration: text(record.first_registration, 40),
    doors: numericText(record.doors, 1, 20),
    seats: numericText(record.seats, 1, 200),
  };
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (${COLUMNS.map((column) => `"${column}" TEXT`).join(", ")})`);
  const existing = new Set(db.prepare(`PRAGMA table_info(${TABLE})`).all().map((row) => row.name));
  for (const column of COLUMNS) {
    if (!existing.has(column)) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN "${column}" TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS vehicle_app_vin_source_idx ON ${TABLE}(vin, source_db)`);
}

export function initVehicleIngestDb(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const db = new Database(resolvedPath);
  ensureSchema(db);
  const find = db.prepare(`SELECT rowid FROM ${TABLE} WHERE vin = ? AND source_db = ? LIMIT 1`);
  const insert = db.prepare(
    `INSERT INTO ${TABLE} (${COLUMNS.map((column) => `"${column}"`).join(", ")})
     VALUES (${COLUMNS.map(() => "?").join(", ")})`,
  );
  const update = db.prepare(
    `UPDATE ${TABLE} SET ${COLUMNS.map((column) => `"${column}" = ?`).join(", ")} WHERE rowid = ?`,
  );
  const upsertTransaction = db.transaction((records) => {
    let upserted = 0;
    let rejected = 0;
    for (const rawRecord of records) {
      const record = sanitizeVehicleObservation(rawRecord);
      if (!record) {
        rejected += 1;
        continue;
      }
      const values = COLUMNS.map((column) => record[column] ?? "");
      const existing = find.get(record.vin, record.source_db);
      if (existing) update.run(...values, existing.rowid);
      else insert.run(...values);
      upserted += 1;
    }
    return { upserted, rejected };
  });

  return {
    upsert(records) {
      if (!Array.isArray(records) || records.length < 1 || records.length > 250) {
        throw new Error("records musi obsahovat 1 az 250 anonymnich zaznamu.");
      }
      return upsertTransaction(records);
    },
    close() {
      db.close();
    },
  };
}
