const FORBIDDEN = new Set(["I", "O", "Q"]);

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};

const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

export function normalizeVin(input) {
  if (!input) return "";
  return String(input).trim().toUpperCase().replace(/[\s-]/g, "");
}

export function validateVin(vinRaw) {
  const vin = normalizeVin(vinRaw);

  if (vin.length !== 17) {
    return { ok: false, vin, reason: "VIN musí mít 17 znaků" };
  }

  for (const ch of vin) {
    if (FORBIDDEN.has(ch)) {
      return { ok: false, vin, reason: `VIN obsahuje zakázaný znak '${ch}'` };
    }
    if (!/[A-Z0-9]/.test(ch)) {
      return { ok: false, vin, reason: `VIN obsahuje neplatný znak '${ch}'` };
    }
  }

  const expected = vin[8]; // 9. znak
  const actual = computeCheckDigit(vin);

  if (expected !== actual) {
    return { ok: false, vin, reason: `Nesedí kontrolní součet (čekám ${actual}, je ${expected})` };
  }

  return { ok: true, vin, reason: null };
}

function valueOfChar(ch) {
  if (/[0-9]/.test(ch)) return Number(ch);
  return TRANSLIT[ch] ?? null;
}

function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = valueOfChar(vin[i]);
    if (v === null) return "?";
    sum += v * WEIGHTS[i];
  }
  const mod = sum % 11;
  return mod === 10 ? "X" : String(mod);
}
