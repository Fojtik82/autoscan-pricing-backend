import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeNhtsaResponse } from "./normalize.js";
import { decodeWithNhtsaBest } from "./nhtsa.js";
import { decodeVinLocal } from "./local_vin_decode.js";
import { applyFuelDriveEngineInference } from "./infer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readVagMap() {
  try {
    const p = path.join(__dirname, "vag_vds_map.json");
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mergePayload(base, extra) {
  // nechceme přepsat existující hodnoty null -> null, ale doplnit chybějící
  const out = { ...base };
  for (const k of Object.keys(extra)) {
    if (out[k] === null || out[k] === undefined || out[k] === "") {
      out[k] = extra[k];
    }
  }
  // confidence vezmeme max
  out.confidence = Math.max(
    Number(out.confidence || 0),
    Number(extra.confidence || 0)
  );
  // source si pamatujeme jako array
  const s1 = Array.isArray(base.sources)
    ? base.sources
    : (base.source ? [base.source] : []);
  const s2 = Array.isArray(extra.sources)
    ? extra.sources
    : (extra.source ? [extra.source] : []);
  out.sources = [...new Set([...s1, ...s2])];
  out.source = out.sources[0] || out.source || "mixed";
  return out;
}

export async function decodeVinPipeline(vin, { modelYear, timeoutMs }) {
  // A) Lokální decode (WMI + rok + VAG heuristika)
  const vagMap = readVagMap();
  let payload = decodeVinLocal(vin, vagMap);

  // B) NHTSA (zkusíme "lepší" decode + použijeme modelYear z VIN, když není)
  const yearForNhtsa = modelYear || payload.year || null;
  try {
    const nhtsaJson = await decodeWithNhtsaBest(vin, yearForNhtsa, timeoutMs);
    const nhtsaPayload = normalizeNhtsaResponse(vin, nhtsaJson);
    payload = mergePayload(payload, nhtsaPayload);
  } catch (e) {
    payload = mergePayload(payload, {
      vin,
      valid: true,
      reason: "NHTSA decode failed",
      error: String(e?.message || e),
      source: "nhtsa_error",
      confidence: 0.5,
      sources: ["nhtsa_error"],
    });
  }

  // finální úklid
  if (!payload.brand && !payload.model && !payload.year) {
    payload.confidence = Math.min(payload.confidence, 0.45);
  }

  // C) Infer (engine + fuel + drive) když chybí
  payload = applyFuelDriveEngineInference(payload);

  return payload;
}
