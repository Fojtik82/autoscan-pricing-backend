import { parseSautoListingId } from "./sauto_lifecycle.js";
import { parseBazosListing } from "./bazos_lifecycle.js";

const PRICE_MAX = 1_000_000_000;
const unknown = () => ({ state: "unknown", price: null });
function validPrice(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const compact = String(value).replace(/[\s\u00a0]/g, "");
  if (!/^\d+$/.test(compact)) return null;
  const price = Number(compact);
  return Number.isSafeInteger(price) && price > 0 && price <= PRICE_MAX ? price : null;
}
function plainText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#(\d+);/g, (_all, code) => {
      const n = Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}
function askingPrice(value) {
  const text = plainText(value);
  const match = /^(\d[\d\s\u00a0]*)\s*(?:K\u010d|CZK)$/i.exec(text);
  if (match) {
    const price = validPrice(match[1]);
    return price !== null ? { state: "priced", price }
      : Number(match[1].replace(/\s/g, "")) === 0 ? { state: "unpriced", price: null } : unknown();
  }
  const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  // A confirmed withdrawal of the numeric asking price is not a network error.
  if (/^(?:dohodou|nabidnete|v textu|cena v textu|na dotaz|zdarma|vymena|vymenou|cenu nabidnete)$/.test(folded)
      || /^\d[\d\s.,]*\s*(?:eur|\u20ac)$/i.test(text)) {
    return { state: "unpriced", price: null };
  }
  return unknown();
}
function observation(value, url = null) {
  return { ...value, url, checkedAt: new Date().toISOString() };
}

export function sautoPriceObservation(item, url = null) {
  if (!item || !Object.prototype.hasOwnProperty.call(item, "price")) return observation(unknown(), url);
  const price = validPrice(item.price);
  if (price !== null) return observation({ state: "priced", price }, url);
  return observation(item.price === null || item.price === 0 || item.price === "0"
    ? { state: "unpriced", price: null } : unknown(), url);
}

export function bazosPagePriceObservations(html, category) {
  const prices = new Map();
  const sections = String(html || "")
    .split(/<div\s+class=["']?inzeraty\s+inzeratyflex["']?\s*>/i).slice(1);
  for (const section of sections) {
    const href = /href=["']([^"']*\/inzerat\/\d+\/[^"']+)["']/i.exec(section)?.[1];
    if (!href) continue;
    let url;
    try { url = new URL(href.replace(/&amp;/gi, "&"), "https://" + category.host).href; }
    catch { continue; }
    const listing = parseBazosListing(url);
    if (!listing || listing.domain !== category.host) continue;
    const cell = /<div\b[^>]*class=["']?inzeratycena["']?[^>]*>([\s\S]*?)<\/div>/i.exec(section);
    prices.set(listing.key, observation(cell ? askingPrice(cell[1]) : unknown(), url));
  }
  return prices;
}

export function bazosDetailPriceObservation(html, target) {
  // Search, login and unrelated redirects cannot refresh a concrete ad's price.
  const canonicalTag = /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i.exec(String(html))?.[0];
  const href = canonicalTag && /\bhref=["']([^"']+)["']/i.exec(canonicalTag)?.[1];
  const listing = href && parseBazosListing(href.replace(/&amp;/gi, "&"));
  if (!listing || listing.key !== target.key
      || !/<h1\s+class=["']?nadpisdetail["']?[^>]*>/i.test(html)) {
    return observation(unknown());
  }
  const cell = /Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  return observation(cell ? askingPrice(cell[1]) : unknown(), href);
}

function keyFor(source, url) {
  if (source === "sauto") {
    const id = parseSautoListingId(url);
    return id ? { key: "sauto:" + id, liveKey: id } : null;
  }
  if (source === "bazos") {
    const listing = parseBazosListing(url);
    return listing ? { key: listing.key, liveKey: listing.key } : null;
  }
  throw new Error("Unsupported price refresh source");
}

export function existingPriceTargets(db, source, liveKeys) {
  const targets = new Map();
  const rows = db.prepare("SELECT rowid,source_url,price FROM vehicle_app"
    + " WHERE lower(source_url) LIKE ?").all("%" + source + ".cz/%");
  for (const row of rows) {
    const identity = keyFor(source, row.source_url);
    if (!identity || !liveKeys.has(identity.liveKey)) continue;
    if (!targets.has(identity.key)) {
      targets.set(identity.key, { ...identity, url: row.source_url, rows: [] });
    }
    targets.get(identity.key).rows.push(row);
  }
  return [...targets.values()];
}

export async function fillMissingPriceObservations(targets, prices, fetchPrice, {
  concurrency = 2, maxDetails = 5000, source = "",
} = {}) {
  const missing = targets.filter((target) =>
    !prices.has(target.key) || prices.get(target.key).state === "unknown");
  const budget = Number.isFinite(Number(maxDetails))
    ? Math.max(0, Math.min(50000, Math.floor(Number(maxDetails)))) : 5000;
  const candidates = missing.slice(0, budget);
  const workers = Number.isFinite(Number(concurrency))
    ? Math.max(1, Math.min(4, Math.floor(Number(concurrency)))) : 2;
  let cursor = 0;
  let attempted = 0;
  let failed = 0;
  const errors = [];
  async function worker() {
    // Do not keep hitting a blocked or broken source for thousands of requests.
    while (cursor < candidates.length && failed < 8) {
      const target = candidates[cursor++];
      attempted += 1;
      try {
        const result = await fetchPrice(target);
        if (!result || result.state === "unknown") throw new Error("Unrecognized price/detail");
        prices.set(target.key, result);
      } catch (error) {
        failed += 1;
        if (errors.length < 3) errors.push(String(error.message || error));
      }
      if (attempted % 250 === 0) console.log(source + ": price details " + attempted + "/" + missing.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, candidates.length) }, () => worker()));
  return { requested: missing.length, attempted, failed, not_attempted: missing.length - attempted, errors };
}

export function applyExistingPriceRefresh(db, source, targets, prices, {
  dryRun = false, details = null, indexErrors = [],
} = {}) {
  const summary = {
    source, checked_at: new Date().toISOString(), dry_run: dryRun,
    targeted: targets.length, priced: 0, unpriced: 0, unknown: 0,
    changed_listings: 0, updated_rows: 0, complete: false,
    details, index_errors: indexErrors,
  };
  const accepted = [];
  for (const target of targets) {
    const found = prices.get(target.key);
    const price = found?.state === "priced" ? validPrice(found.price) : null;
    const stamp = Date.parse(found?.checkedAt);
    if (!found || !["priced", "unpriced"].includes(found.state)
        || (found.state === "priced" && price === null)
        || !Number.isFinite(stamp) || stamp > Date.now() + 300000
        || Date.now() - stamp > 24 * 60 * 60 * 1000) {
      summary.unknown += 1;
      continue;
    }
    const next = found.state === "priced" ? String(price) : null;
    const changed = target.rows.some((row) => String(row.price ?? "") !== String(next ?? ""));
    if (changed) summary.changed_listings += 1;
    summary[found.state] += 1;
    accepted.push({ target, found, price, next });
  }
  summary.complete = summary.unknown === 0;
  summary.ok = summary.complete;
  if (dryRun) return summary;
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS listing_price_observations ("
      + "listing_key TEXT PRIMARY KEY, source TEXT NOT NULL, checked_at TEXT NOT NULL,"
      + " state TEXT NOT NULL, price_czk INTEGER, last_numeric_price INTEGER);"
      + "CREATE TABLE IF NOT EXISTS market_price_refresh_runs ("
      + "source TEXT PRIMARY KEY, checked_at TEXT NOT NULL, summary_json TEXT NOT NULL)");
    const update = db.prepare("UPDATE vehicle_app SET price=?,source_url=COALESCE(?,source_url) WHERE rowid=?");
    const remember = db.prepare("INSERT INTO listing_price_observations"
      + "(listing_key,source,checked_at,state,price_czk,last_numeric_price) VALUES(?,?,?,?,?,?)"
      + " ON CONFLICT(listing_key) DO UPDATE SET source=excluded.source,checked_at=excluded.checked_at,"
      + "state=excluded.state,price_czk=excluded.price_czk,"
      + "last_numeric_price=COALESCE(excluded.last_numeric_price,listing_price_observations.last_numeric_price)");
    for (const { target, found, price, next } of accepted) {
      const canonical = found.url && keyFor(source, found.url)?.key === target.key ? found.url : null;
      const lastNumeric = price ?? target.rows.map((row) => validPrice(row.price)).find((value) => value !== null) ?? null;
      for (const row of target.rows) summary.updated_rows += update.run(next, canonical, row.rowid).changes;
      remember.run(target.key, source, found.checkedAt, found.state, price, lastNumeric);
    }
    db.prepare("INSERT INTO market_price_refresh_runs(source,checked_at,summary_json) VALUES(?,?,?)"
      + " ON CONFLICT(source) DO UPDATE SET checked_at=excluded.checked_at,summary_json=excluded.summary_json")
      .run(source, summary.checked_at, JSON.stringify(summary));
  })();
  return summary;
}

export function priceRefreshMetadata(db, now = new Date()) {
  const result = Object.fromEntries(["sauto", "bazos"].map((source) => [source, {
    complete: false, checked_at: null, reason: "not_refreshed",
  }]));
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_price_refresh_runs'").get()) {
    return result;
  }
  for (const row of db.prepare("SELECT source,checked_at,summary_json FROM market_price_refresh_runs").all()) {
    if (!Object.prototype.hasOwnProperty.call(result, row.source)) continue;
    try {
      const summary = JSON.parse(row.summary_json);
      const age = now.getTime() - Date.parse(row.checked_at);
      const fresh = Number.isFinite(age) && age >= -300000 && age <= 48 * 60 * 60 * 1000;
      result[row.source] = {
        complete: fresh && summary.complete === true, checked_at: row.checked_at,
        targeted: summary.targeted, priced: summary.priced,
        unpriced: summary.unpriced, unknown: summary.unknown,
        reason: !fresh ? "stale" : summary.complete ? "refreshed" : "partial_kept_last_known_prices",
      };
    } catch { /* An unreadable status never proves fresh prices. */ }
  }
  return result;
}

