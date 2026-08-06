import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fold(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

function safeReadJson(filename) {
  try {
    const p = path.join(__dirname, filename);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function pickWeighted(weights) {
  const entries = Object.entries(weights || {}).filter(
    ([, v]) => typeof v === "number" && v > 0
  );
  if (!entries.length) return { value: null, confidence: 0 };

  entries.sort((a, b) => b[1] - a[1]);
  const [bestKey, bestWeight] = entries[0];
  const sum = entries.reduce((acc, [, v]) => acc + v, 0);

  return {
    value: bestKey,
    confidence: sum > 0 ? round2(bestWeight / sum) : 0,
  };
}

function rankedWeights(weights) {
  const entries = Object.entries(weights || {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1]);

  const sum = entries.reduce((acc, [, v]) => acc + v, 0);

  return entries.map(([key, value]) => ({
    value: key,
    confidence: sum > 0 ? round2(value / sum) : 0,
  }));
}

function profileKey(brand, model, year) {
  const b = fold(brand);
  const m = fold(model);
  const y = year ? String(year) : null;
  if (!b || !m) return null;
  if (y) return `${b}_${m}_${y}`;
  return `${b}_${m}_default`;
}

// ---------------- Fallback segment selection ----------------

function isLuxuryBrand(brand) {
  const b = fold(brand);
  return [
    "bmw",
    "mercedes",
    "mercedes-benz",
    "audi",
    "porsche",
    "lexus",
    "jaguar",
    "land_rover",
    "volvo",
  ].includes(b);
}

function isSuvModel(model) {
  const m = fold(model) || "";
  const suvKeywords = [
    "kodiaq",
    "karoq",
    "kamiq",
    "tiguan",
    "touareg",
    "t-roc",
    "troc",
    "q2",
    "q3",
    "q5",
    "q7",
    "q8",
    "x1",
    "x2",
    "x3",
    "x4",
    "x5",
    "x6",
    "glc",
    "gle",
    "gla",
    "glb",
    "gls",
    "xc40",
    "xc60",
    "xc90",
    "enqyaq",
    "enyaq"
  ];
  return suvKeywords.includes(m) || suvKeywords.some((k) => m.includes(k));
}

function pickFallbackKey(brand, model) {
  if (isSuvModel(model)) return "__default_suv";
  if (isLuxuryBrand(brand)) return "__default_luxury";
  return "__default_compact";
}

// --- ENGINE -> fuel/drive pravidla (jednoduché a účinné) ---
function engineToFuel(engine) {
  const e = fold(engine) || "";
  if (!e) return null;
  if (e.includes("tdi") || e.includes("dci") || e.includes("cdti") || e.includes("hdi"))
    return "diesel";
  if (e.includes("tsi") || e.includes("tfsi") || e.includes("mpi") || e.includes("fse"))
    return "petrol";
  if (e.includes("tgi") || e.includes("cng")) return "cng";
  if (e.includes("hybrid")) return "hybrid";
  if (e.includes("ev") || e.includes("electric")) return "ev";
  return null;
}

function normalizeEngine(e) {
  if (!e) return null;
  return String(e).trim().toLowerCase().replace(/\s+/g, " ");
}

function boostCandidatesToTop(candidates, topValue, topConfidence) {
  if (!Array.isArray(candidates) || !candidates.length) return candidates;

  const list = candidates.map((x) => ({ ...x }));
  const idx = list.findIndex((x) => x.value === topValue);
  if (idx < 0) return candidates;

  const rest = list.filter((_, i) => i !== idx);
  const restSum =
    rest.reduce((a, x) => a + (Number(x.confidence) || 0), 0) || 1;

  list[idx].confidence = round2(topConfidence);

  const remaining = 1 - topConfidence;
  for (const x of rest) {
    x.confidence = round2(remaining * ((Number(x.confidence) || 0) / restSum));
  }

  return list.sort(
    (a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
  );
}

export function applyFuelDriveEngineInference(payload) {
  const profiles = safeReadJson("model_profiles.json");
  const engines = safeReadJson("engine_profiles.json");

  const brand = payload.brand;
  const model = payload.model;
  const year = payload.year;

  const exactKey = profileKey(brand, model, year);
  const fallbackKey = profileKey(brand, model, null);
  const fb = pickFallbackKey(brand, model);

  const hasModelSpecific =
    (exactKey && profiles[exactKey]) || (fallbackKey && profiles[fallbackKey]);
  const hasEngineSpecific =
    (exactKey && engines[exactKey]) || (fallbackKey && engines[fallbackKey]);

  const modelProfile =
    (exactKey && profiles[exactKey]) ||
    (fallbackKey && profiles[fallbackKey]) ||
    profiles[fb] ||
    null;

  const engineProfile =
    (exactKey && engines[exactKey]) ||
    (fallbackKey && engines[fallbackKey]) ||
    engines[fb] ||
    null;

  // když nemáme nic, vrátíme původní payload
  if (!modelProfile && !engineProfile) return payload;

  const out = { ...payload };
  out.inference_notes = Array.isArray(out.inference_notes)
    ? out.inference_notes
    : [];

  if (!hasModelSpecific && modelProfile) {
    out.inference_notes.push(`fallback model profile used: ${fb}`);
  }
  if (!hasEngineSpecific && engineProfile) {
    out.inference_notes.push(`fallback engine profile used: ${fb}`);
  }

  // 1) ENGINE inference (ideálně první – pak můžeme zpřesnit fuel/drive)
  if (engineProfile?.engine_weights) {
    out.engine_candidates = rankedWeights(engineProfile.engine_weights);

    if (!out.engine) {
      const pick = pickWeighted(engineProfile.engine_weights);
      if (pick.value) {
        out.engine = normalizeEngine(pick.value);
        out.engine_confidence = pick.confidence;
        out.inference_notes.push(
          `engine inferred from profile ${exactKey || fallbackKey || fb}`
        );
        out.confidence = Math.max(Number(out.confidence || 0), 0.82);
      }
    }
  }

  // 2) FUEL inference (pokud chybí) + kandidáti
  if (modelProfile?.fuel_weights) {
    out.fuel_candidates = rankedWeights(modelProfile.fuel_weights);

    if (!out.fuel) {
      const pick = pickWeighted(modelProfile.fuel_weights);
      if (pick.value) {
        out.fuel = pick.value;
        out.fuel_confidence = pick.confidence;
        out.inference_notes.push(
          `fuel inferred from profile ${exactKey || fallbackKey || fb}`
        );
        out.confidence = Math.max(Number(out.confidence || 0), 0.8);
      }
    }
  }

  // 3) DRIVE inference (pokud chybí) + kandidáti
  if (modelProfile?.drive_weights) {
    out.drive_candidates = rankedWeights(modelProfile.drive_weights);

    if (!out.drive) {
      const pick = pickWeighted(modelProfile.drive_weights);
      if (pick.value) {
        out.drive = pick.value;
        out.drive_confidence = pick.confidence;
        out.inference_notes.push(
          `drive inferred from profile ${exactKey || fallbackKey || fb}`
        );
        out.confidence = Math.max(Number(out.confidence || 0), 0.8);
      }
    }
  }

  // 4) Zpřesnění podle engine (když dává jasný signál)
  if (out.engine) {
    const f = engineToFuel(out.engine);

    if (f) {
      if (!out.fuel) {
        out.fuel = f;
        out.inference_notes.push("fuel set from engine heuristic");
      } else if (out.fuel !== f) {
        out.fuel = f;
        out.inference_notes.push("fuel corrected from engine heuristic");
      } else {
        out.inference_notes.push("fuel confirmed by engine heuristic");
      }

      // engine je konkrétní => posílíme jistotu
      out.fuel_confidence = Math.max(Number(out.fuel_confidence || 0), 0.85);

      // srovnáme i kandidáty pro UI
      out.fuel_candidates = boostCandidatesToTop(out.fuel_candidates, f, 0.85);

      out.confidence = Math.max(Number(out.confidence || 0), 0.87);
    }

    // Octavia: petrol/cng -> téměř vždy FWD; diesel -> AWD možné dle výbavy
    if (fold(out.brand) === "skoda" && fold(out.model) === "octavia") {
      if (out.fuel === "diesel") {
        out.inference_notes.push("diesel octavia: awd possible depending on trim");
        if (!out.drive) {
          out.drive = "fwd";
          out.drive_confidence = 0.75;
          out.inference_notes.push("drive defaulted to fwd; awd possible for diesel trims");
        }
      } else if (out.fuel === "petrol" || out.fuel === "cng") {
        if (!out.drive) {
          out.drive = "fwd";
          out.inference_notes.push("drive set to fwd from octavia fuel heuristic");
        } else if (out.drive !== "fwd") {
          out.drive = "fwd";
          out.inference_notes.push("drive corrected to fwd from octavia fuel heuristic");
        } else {
          out.inference_notes.push("drive confirmed as fwd by octavia fuel heuristic");
        }

        out.drive_confidence = Math.max(Number(out.drive_confidence || 0), 0.9);
        out.confidence = Math.max(Number(out.confidence || 0), 0.88);
      }
    }
  }

  return out;
}
