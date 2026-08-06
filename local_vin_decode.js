// A) Lokální dekódování z VIN bez API:
// - WMI (1-3 znaky): značka
// - 10. znak: rok (standardní VIN year code)
// - VAG heuristika přes VDS substring (pozice 4-8) + uživatelská mapa

const WMI_BRAND = {
  // Škoda / VAG
  TMB: "skoda",
  WVW: "volkswagen",
  WVG: "volkswagen",
  WAU: "audi",
  TRU: "audi",
  VSS: "seat",
  // další časté EU
  VF1: "renault",
  VF3: "peugeot",
  VF7: "citroen",
  WBA: "bmw",
  WBS: "bmw",
  WDC: "mercedes",
  WDD: "mercedes",
  ZFA: "fiat",
  ZAR: "alfa_romeo",
  YV1: "volvo",
  YV4: "volvo"
};

const YEAR_CODE = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
  T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030,
  // 2001-2009
  1: 2001, 2: 2002, 3: 2003, 4: 2004, 5: 2005, 6: 2006, 7: 2007, 8: 2008, 9: 2009
};

function fold(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

function isVagBrand(brand) {
  return ["skoda", "volkswagen", "audi", "seat"].includes(brand || "");
}

export function decodeVinLocal(vin, vagMap = {}) {
  const wmi = vin.slice(0, 3);
  const brand = WMI_BRAND[wmi] || null;

  const yearChar = vin[9]; // 10. znak (index 9)
  const year = YEAR_CODE[yearChar] || null;

  // základní confidence: značka+rok umíme velmi dobře
  let confidence = 0.62;
  if (brand) confidence += 0.08;
  if (year) confidence += 0.08;

  let model = null;

  // VAG heuristika: substring VIN[3..8] (pozice 4-8) jako "VDS key"
  if (brand && isVagBrand(brand)) {
    const key5 = vin.slice(3, 8); // 5 znaků
    const hit = vagMap?.[key5];
    if (hit?.model) {
      model = fold(hit.model);
      confidence += Number(hit.confidence || 0.12);
    }
  }

  if (confidence > 0.85) confidence = 0.85;

  return {
    vin,
    valid: true,
    brand,
    model,
    year,
    engine: null,
    fuel: null,
    bodyClass: null,
    drive: null,
    transmission: null,
    source: "local_vin",
    sources: ["local_vin"],
    confidence
  };
}
