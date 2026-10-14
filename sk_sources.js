import { decodeHtmlEntities, createBazosTaxonomy, parseBazosDetail } from './bazos_scraper.js';
import fs from 'node:fs';

// Shared make/model names contain no price observations or market database.
const genericTaxonomy = JSON.parse(fs.readFileSync(new URL('./vehicle_taxonomy.json', import.meta.url), 'utf8'));
const taxonomyCache = new WeakMap();
const emptyRows = [];
function taxonomyFor(rows) {
  if (!taxonomyCache.has(rows)) taxonomyCache.set(rows, createBazosTaxonomy([...genericTaxonomy, ...rows]));
  return taxonomyCache.get(rows);
}

export const SK_SOURCES = [
  { id: 'bazos_sk', host: 'auto.bazos.sk', sitemap: '/sitemap.php' },
  { id: 'autobazar_eu', host: 'www.autobazar.eu', sitemap: '/sitemapindex/sitemap-listings-index-sk.xml' },
  { id: 'autovia', host: 'www.autovia.sk', sitemap: '/sitemapindex/sitemap-listings-index-sk.xml' },
];
export const foldSk = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseSkListing(input) {
  try {
    const u = new URL(input);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password ||
        (u.port && !['80', '443'].includes(u.port))) return null;
    const source = SK_SOURCES.find(s => s.host.replace(/^www\./, '') === u.hostname.replace(/^www\./, ''));
    if (!source) return null;
    const m = source.id === 'bazos_sk'
      ? /^\/inzerat\/([1-9][0-9]*)\/[^/]+\.php\/?$/.exec(u.pathname)
      : /^\/(?:detail|detail-nove-auto)\/[^/]+\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    if (!m) return null;
    return { source: source.id, id: m[1], key: `${source.id}:${m[1]}`,
      url: `https://${source.host}${u.pathname}` };
  } catch { return null; }
}

export function sitemapLocations(xml) {
  if (!/<(?:urlset|sitemapindex)\b/i.test(xml) || !/<\/(?:urlset|sitemapindex)>/i.test(xml))
    throw new Error('Invalid or incomplete sitemap');
  // Deliberately ignore image:loc and xhtml alternate-language links.
  return [...xml.matchAll(/<(?:url|sitemap)>\s*<loc>([\s\S]*?)<\/loc>/gi)]
    .map(m => decodeHtmlEntities(m[1].trim()));
}

const text = h => decodeHtmlEntities(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const number = (v, min, max) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// Only read embedded page data. Do not execute page scripts or fetch private APIs.
function pageAdvertisement(html, identity) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts.filter(m => /ld\+json/.test(m[1]))) {
    const schema = JSON.parse(script[2]);
    for (const node of schema['@graph'] ?? [schema]) {
      const car = node.mainEntity;
      if (!car || !['Car', 'Motorcycle', 'Vehicle'].includes(car['@type']) ||
          parseSkListing(car.url)?.key !== identity.key || car.offers?.priceCurrency !== 'EUR' ||
          !String(car.offers.availability).endsWith('/InStock')) continue;
      return { id: identity.id, brandValue: car.brand?.name ?? car.manufacturer,
        carModelValue: car.model, yearValue: car.vehicleModelDate,
        price: car.offers.price, priceCurrency: 'EUR', categoryValue: 'Osobné vozidlá',
        title: car.name, mileage: car.mileageFromOdometer?.value,
        fuelValue: car.vehicleEngine?.fuelType, enginePower: car.vehicleEngine?.enginePower,
        engineCapacity: car.vehicleEngine?.engineDisplacement, gearboxValue: car.vehicleTransmission,
        vin: car.vehicleIdentificationNumber, bodyworkValue: car.bodyType };
    }
  }
  const next = scripts.find(m => /id=["']__NEXT_DATA__["']/.test(m[1]));
  if (next) {
    const p = JSON.parse(next[2]).props?.pageProps;
    const a = p?.advertisement;
    if (p?.statusCode !== undefined && p.statusCode !== 200) return null;
    return a && String(a.id) === identity.id ? a : null;
  }
  const chunks = [];
  for (const s of scripts) {
    for (const m of s[2].matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*$/g)) {
      const a = JSON.parse(m[1]);
      if (a[0] === 1 && typeof a[1] === 'string') chunks.push(a[1]);
    }
  }
  const find = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 40) return null;
    if (String(obj.id) === identity.id && obj.brandValue && obj.carModelValue) return obj;
    for (const v of Object.values(obj)) { const found = find(v, depth + 1); if (found) return found; }
    return null;
  };
  for (const line of chunks.join('').split('\n')) {
    const json = /^[0-9a-f]+:(\[.*|\{.*)$/.exec(line)?.[1];
    if (!json) continue;
    try { const a = find(JSON.parse(json)); if (a) return a; } catch { /* Other Flight records. */ }
  }
  return null;
}

export function skDetailGone(html) {
  const visible = foldSk(text(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')));
  return /(?:inzerat (?:bol |je )?(?:vymazany|zmazany|odstraneny|neaktualny)|inzerat neexistuje|inzerat sa nenasiel)/.test(visible);
}

export function parseSkDetail(html, url, taxonomyRows = emptyRows, now = new Date().toISOString()) {
  const identity = parseSkListing(url);
  if (!identity || skDetailGone(html)) return null;
  let row;
  if (identity.source === 'bazos_sk') {
    // Reuse the Czech title/model taxonomy without changing the CZ parser.
    // Its money parser uses CZK bounds, so validate the EUR field separately.
    const priceText = text(/Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? '');
    if (!/€|EUR/i.test(priceText) || /dohod|spl[aá]tk|mesa[cč]/i.test(priceText)) return null;
    const price = number(priceText.replace(/[^0-9, .\u00a0]/g, ''), 100, 2_000_000);
    if (!price) return null;
    const czUrl = identity.url.replace('auto.bazos.sk', 'auto.bazos.cz');
    const adapted = html.replaceAll('auto.bazos.sk', 'auto.bazos.cz')
      .replace(/(Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>)[\s\S]*?(<\/span>)/i, '$1' + '100000 Kč' + '$2')
      .replace(/najazden[eéých]*|n[aá]jazd/gi, 'nájezd').replace(/pred[aá]m/gi, 'prodám');
    row = parseBazosDetail(adapted, { url: czUrl, key: `auto.bazos.cz:${identity.id}`,
      category: { host: 'auto.bazos.cz', slug: '', group: 'auto', brand: null } }, taxonomyFor(taxonomyRows), now);
    if (!row) return null;
    row.price = String(price);
  } else {
    const a = pageAdvertisement(html, identity);
    if (!a || a.withdrawalOfLeasing || (a.priceCurrency && a.priceCurrency !== 'EUR')) return null;
    const price = number(a.finalPrice ?? a.priceCurrent ?? a.price, 100, 2_000_000);
    const year = number(a.yearValue ?? a.yearNumeric, 1886, new Date(now).getUTCFullYear() + 1);
    const category = foldSk(a.categoryValue);
    if (!price || !year || !a.brandValue || !a.carModelValue ||
        !/osobne|suv|terenne|uzitkove|motocykle|veterany/.test(category)) return null;
    row = { brand: a.brandValue, model: a.carModelValue, year: String(year), price: String(price),
      mileage: number(a.mileage, 0, 2_000_000)?.toString() ?? null,
      fuel: a.fuelValue ?? '', transmission: a.gearboxValue ?? '', drive: a.driveValue ?? '',
      kw: number(a.enginePower, 1, 2000)?.toString() ?? null,
      motor: a.engineCapacity ? `${a.engineCapacity} ccm` : '', body: a.bodyworkValue ?? '',
      vin: /^[A-HJ-NPR-Z0-9]{17}$/.test(a.vin ?? '') ? a.vin : null,
      title: [a.title, a.otherEquipment].filter(Boolean).join(' '),
    };
  }
  return { ...row, source_url: identity.url, source_db: identity.source,
    source_id: identity.id, market: 'SK', currency: 'EUR',
    brand_norm: foldSk(row.brand), model_norm: foldSk(row.model), fuel_norm: foldSk(row.fuel),
    transmission_norm: foldSk(row.transmission), drive_norm: foldSk(row.drive),
    motor_norm: foldSk(row.motor), is_active: 1, last_seen_at: now, last_checked_at: now,
    missing_checks: 0, missing_since: null, inactive_at: null };
}
