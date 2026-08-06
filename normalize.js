function fold(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

function pick(result, key) {
  return (result?.[key] ?? "").toString().trim();
}

export function normalizeNhtsaResponse(vin, nhtsaJson) {
  const row = nhtsaJson?.Results?.[0] ?? {};

  const make = pick(row, "Make");
  const model = pick(row, "Model");
  const year = pick(row, "ModelYear");

  const fuel1 = pick(row, "FuelTypePrimary");
  const fuel2 = pick(row, "FuelTypeSecondary");
  const engineModel = pick(row, "EngineModel");
  const displacementL = pick(row, "DisplacementL");
  const bodyClass = pick(row, "BodyClass");
  const driveType = pick(row, "DriveType");
  const transmissionStyle = pick(row, "TransmissionStyle");

  const fuelNorm = normalizeFuel(fuel1 || fuel2);
  const engineNorm = normalizeEngine({ engineModel, displacementL });

  let confidence = 0.60;
  if (make && model && year) confidence += 0.08;
  if (fuelNorm) confidence += 0.04;
  if (engineNorm) confidence += 0.04;
  if (confidence > 0.75) confidence = 0.75;

  return {
    vin,
    valid: true,
    brand: fold(make),
    model: fold(model),
    year: year ? Number(year) : null,
    engine: engineNorm,
    fuel: fuelNorm,
    bodyClass: bodyClass || null,
    drive: driveType || null,
    transmission: transmissionStyle || null,
    source: "nhtsa",
    confidence
  };
}

function normalizeFuel(s) {
  const x = fold(s);
  if (!x) return null;
  if (x.includes("diesel")) return "diesel";
  if (x.includes("gasoline") || x.includes("petrol")) return "petrol";
  if (x.includes("electric")) return "ev";
  if (x.includes("hybrid")) return "hybrid";
  if (x.includes("cng")) return "cng";
  if (x.includes("lpg")) return "lpg";
  return x;
}

function normalizeEngine({ engineModel, displacementL }) {
  const m = engineModel?.trim() || "";
  const d = displacementL?.trim() || "";
  if (!m && !d) return null;

  const disp = d ? d.replace(/[^\d.]/g, "") : "";
  const parts = [];
  if (disp) parts.push(disp);
  if (m) parts.push(m);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
