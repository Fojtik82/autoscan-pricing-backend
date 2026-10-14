import { parseSautoListingId } from "./sauto_lifecycle.js";
import { parseBazosListing } from "./bazos_lifecycle.js";
import { parseSkListing } from "./sk_sources.js";

export const MARKET_SOURCES = ["sauto", "bazos", "sportovnivozy", "rajveteranu"];

export function parseNicheListing(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || (url.port && !["80", "443"].includes(url.port))) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const source = host === "sportovnivozy.cz" ? "sportovnivozy"
      : host === "rajveteranu.cz" ? "rajveteranu" : null;
    const match = url.pathname.match(/^\/([1-9][0-9]*)-([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!source || !match) return null;
    return {
      source, id: match[1], key: source + ":" + match[1],
      url: "https://www." + host + "/" + match[1] + "-" + match[2],
    };
  } catch { return null; }
}

export function marketSourceId(url, sourceDb = "") {
  const sk = parseSkListing(url);
  if (sk) return sk.source;
  if (parseSautoListingId(url)) return "sauto";
  if (parseBazosListing(url)) return "bazos";
  const niche = parseNicheListing(url);
  if (niche) return niche.source;
  const name = String(sourceDb).toLowerCase();
  return MARKET_SOURCES.find((source) => name.includes(source)) || "other";
}

export function countMarketSources(vehicles, market = 'CZ') {
  const sources = market === 'SK' ? ['bazos_sk', 'autobazar_eu', 'autovia'] : MARKET_SOURCES;
  const counts = Object.fromEntries([...sources, "other"].map((id) => [id, 0]));
  for (const vehicle of vehicles) {
    if (Number.isFinite(vehicle.price_czk) && vehicle.price_czk > 0) {
      const source = marketSourceId(vehicle.url, vehicle.source_db);
      counts[Object.hasOwn(counts, source) ? source : 'other'] += 1;
    }
  }
  return counts;
}
