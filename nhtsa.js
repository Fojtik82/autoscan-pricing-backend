async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`NHTSA HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Zkusíme nejdřív Extended (často vrací víc), pak klasiku jako fallback
export async function decodeWithNhtsaBest(vin, modelYear, timeoutMs = 8000) {
  const base = "https://vpic.nhtsa.dot.gov/api/vehicles/";
  const q = new URLSearchParams({ format: "json" });
  if (modelYear) q.set("modelyear", String(modelYear));

  const urlExt = `${base}DecodeVinValuesExtended/${encodeURIComponent(vin)}?${q.toString()}`;
  const urlStd = `${base}DecodeVinValues/${encodeURIComponent(vin)}?${q.toString()}`;

  try {
    return await fetchJson(urlExt, timeoutMs);
  } catch {
    return await fetchJson(urlStd, timeoutMs);
  }
}
