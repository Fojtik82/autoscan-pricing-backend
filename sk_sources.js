import { decodeHtmlEntities, createBazosTaxonomy, parseBazosDetail } from './bazos_scraper.js';
import fs from 'node:fs';
import { normalizePowertrain } from './vehicle_variant.js';

// Shared make/model names contain no price observations or market database.
const genericTaxonomy = JSON.parse(fs.readFileSync(new URL('./vehicle_taxonomy.json', import.meta.url), 'utf8'));
const taxonomyCache = new WeakMap();
const emptyRows = [];
function taxonomyFor(rows) {
  if (!taxonomyCache.has(rows)) taxonomyCache.set(rows, createBazosTaxonomy([...genericTaxonomy, ...rows]));
  return taxonomyCache.get(rows);
}

export const SK_SOURCES = [
  { id: 'bazos_sk', host: 'auto.bazos.sk', sitemap: '/sitemap.php', indexMode:'categories' },
  { id: 'autobazar_eu', host: 'www.autobazar.eu', sitemap: '/sitemapindex/sitemap-listings-index-sk.xml' },
  { id: 'autovia', host: 'www.autovia.sk', sitemap: '/sitemapindex/sitemap-listings-index-sk.xml' },
  { id: 'bazos_moto_sk', host: 'motocykle.bazos.sk', sitemap: '/sitemap.php', indexMode:'categories' },
];
export const SK_VEHICLE_CATEGORIES = {
  passenger: ['osobne-vozidla', 'suv-terenne-vozidla', 'veterany'],
  motorcycle: ['motocykle', 'vodne-snezne-skutre-stvorkolky'],
  commercial: ['uzitkove-vozidla-do-3-5t', 'nakladne-vozidla-3-5-7-5t',
    'nakladne-vozidla-nad-7-5t', 'tahace-a-kamiony', 'autobusy', 'obytne-privesy-autokaravany-bufety'],
};
export function skVehicleType(category) {
  const slug = foldSk(category).replaceAll(' ', '-');
  return Object.entries(SK_VEHICLE_CATEGORIES).find(([, names]) => names.includes(slug))?.[0] ?? null;
}
const BAZOS_CAR_SLUGS = new Set(['alfa','audi','bmw','citroen','dacia','fiat','ford','honda','hyundai',
  'chevrolet','kia','mazda','mercedes','mitsubishi','nissan','opel','peugeot','renault','seat','suzuki',
  'skoda','toyota','volkswagen','volvo','ostatni','veterany','havarovana']);
const BAZOS_UTILITY_SLUGS = new Set(['dodavka','mikrobus','pickup','autobusy','karavany','nakladne','ostatniuzitkova','havarovanauzitkova']);
const BAZOS_MOTO_SLUGS = new Set(['cestne','cestovne','enduro','chopper','minibike','mopedy','skutre','vodne','snezne','stvorkolky','trojkolky','veterany']);
export function bazosSkCategorySlugs(source) {
  return source.id === 'bazos_moto_sk' ? [...BAZOS_MOTO_SLUGS] : [...BAZOS_CAR_SLUGS,...BAZOS_UTILITY_SLUGS];
}
export const foldSk = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseSkListing(input) {
  try {
    const u = new URL(input);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password ||
        (u.port && !['80', '443'].includes(u.port))) return null;
    const source = SK_SOURCES.find(s => s.host.replace(/^www\./, '') === u.hostname.replace(/^www\./, ''));
    if (!source) return null;
    const m = source.id.startsWith('bazos_')
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
export function pageAdvertisement(html, identity) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
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
  for (const script of scripts.filter(m => /ld\+json/.test(m[1]))) {
    let schema; try { schema = JSON.parse(script[2]); } catch { continue; }
    const nodes = schema['@graph'] ?? (Array.isArray(schema) ? schema : [schema]);
    const crumbs = nodes.find(n => n['@type'] === 'BreadcrumbList')?.itemListElement ?? [];
    const category = crumbs.map(n => n.item).find(u => typeof u === 'string' && /\/vysledky\/[^/]+\/$/.test(u));
    for (const node of nodes) {
      const car = node.mainEntity;
      if (!car || !['Car', 'Motorcycle', 'Vehicle','BusOrCoach'].includes(car['@type']) ||
          parseSkListing(car.url)?.key !== identity.key || car.offers?.priceCurrency !== 'EUR' ||
          !String(car.offers.availability).endsWith('/InStock')) continue;
      return { id: identity.id, brandValue: car.brand?.name ?? car.manufacturer,
        carModelValue: car.model, yearValue: car.vehicleModelDate,
        price: car.offers.price, priceCurrency: 'EUR', categoryValue: category?.split('/').filter(Boolean).at(-1) ??
          (car['@type'] === 'Motorcycle' ? 'Motocykle' : car['@type'] === 'Car' ? 'Osobné vozidlá' : ''),
        title: car.name, description: car.description, equipment: car.additionalProperty,
        mileage: car.mileageFromOdometer?.value,
        fuelValue: car.vehicleEngine?.fuelType, enginePower: car.vehicleEngine?.enginePower,
        engineCapacity: car.vehicleEngine?.engineDisplacement, gearboxValue: car.vehicleTransmission,
        vin: car.vehicleIdentificationNumber, bodyworkValue: car.bodyType };
    }
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
  if (identity.source.startsWith('bazos_')) {
    const originalTitle = text(/<h1\s+class=["']?nadpisdetail["']?[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
    const titleWords = foldSk(originalTitle).replace(/^(?:predam|prodam|predaj)\s+/, '');
    if (/^(?:motor|prevodovka|diely|nahradne diely|pneumatiky|pneu|helma|prilba|kolesa|disky|kupim|hladam)\b/.test(titleWords) ||
        /\b(?:na nahradne diely|na diely|rozpredam|rozpredavam|rozoberam|po dieloch)\b/.test(titleWords)) return null;
    const host = new URL(identity.url).host;
    const moto = identity.source === 'bazos_moto_sk';
    const slugs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => {
      try { const u = new URL(m[1], identity.url); return u.host === host && /^\/[a-z]+\/$/.test(u.pathname) ? u.pathname.slice(1,-1) : null; } catch { return null; }
    });
    const slug = slugs.find(s => moto ? BAZOS_MOTO_SLUGS.has(s) : BAZOS_CAR_SLUGS.has(s) || BAZOS_UTILITY_SLUGS.has(s));
    if (!slug) return null; // Spare parts, tyres and clothing never enter the vehicle catalogue.
    const vehicleType = moto ? 'motorcycle' : BAZOS_UTILITY_SLUGS.has(slug) ? 'commercial' : 'passenger';
    // Reuse the Czech title/model taxonomy without changing the CZ parser.
    // Its money parser uses CZK bounds, so validate the EUR field separately.
    const priceText = text(/Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? '');
    const unpriced = /dohod|pon[uú]kn|v texte|na dotaz|nerozhoduje/i.test(priceText);
    if ((!/€|EUR/i.test(priceText) && !unpriced) || /spl[aá]tk|mesa[cč]/i.test(priceText)) return null;
    const price = number(priceText.replace(/[^0-9, .\u00a0]/g, ''), 100, 2_000_000);
    if (!price && !unpriced) return null;
    const czHost = moto ? 'motorky.bazos.cz' : 'auto.bazos.cz';
    const czUrl = identity.url.replace(host, czHost);
    const adapted = html.replaceAll(host, czHost)
      .replace(/(Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>)[\s\S]*?(<\/span>)/i, '$1' + '100000 Kč' + '$2')
      .replace(/(<h1\s+class=["']?nadpisdetail["']?[^>]*>)([\s\S]*?)(<\/h1>)/i,
        (_,start,title,end)=>start+title.replace(/\b(?:motor|prevodovka)\b/gi,'pohon')+end)
      .replace(/najazden[eéých]*|n[aá]jazd/gi, 'nájezd').replace(/pred[aá]m/gi, 'prodám');
    row = parseBazosDetail(adapted, { url: czUrl, key: `${czHost}:${identity.id}`,
      allowIncomplete: true,
      category: { host: czHost, slug, group: moto ? 'motorky' : vehicleType === 'commercial' ? 'dodavky' : 'auto', brand: null } }, taxonomyFor(taxonomyRows), now);
    if (!row) return null;
    row.price = price ? String(price) : null;
    row.title = originalTitle;
    row.vehicle_type = vehicleType;
    row.category = slug;
    row.description = text(/<div\s+class=["']?popisdetail["']?[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? '');
    // Bazos publishes free-form equipment only; retain the exact advert wording.
    row.equipment = row.description;
    row.equipment_json = '[]';
    row.equipment_source = 'advertisement_description';
  } else {
    const a = pageAdvertisement(html, identity);
    if (!a || a.withdrawalOfLeasing || (a.priceCurrency && a.priceCurrency !== 'EUR')) return null;
    const price = number(a.finalPrice ?? a.priceCurrent ?? a.price, 100, 2_000_000);
    const year = number(a.yearValue ?? a.yearNumeric, 1886, new Date(now).getUTCFullYear() + 1);
    const vehicleType = skVehicleType(a.categoryValue);
    if (!a.brandValue || !a.carModelValue ||
        !vehicleType) return null;
    const equipmentText = text(a.carEquipmentValue ?? '');
    const equipmentItems = Array.isArray(a.carEquipment) ? a.carEquipment
      .map(v => typeof v === 'string' ? v : typeof v === 'object' && v ? v.value ?? v.name ?? v.label : null)
      .filter(v => typeof v === 'string' && v.trim()) : [];
    if (equipmentText) equipmentItems.push(...equipmentText.split(/,\s*/));
    const equipment = [...new Set(equipmentItems.map(text).filter(Boolean))];
    row = { brand: a.brandValue, model: a.carModelValue, year: year ? String(year) : null, price: price ? String(price) : null,
      mileage: number(a.mileage, 0, 2_000_000)?.toString() ?? null,
      fuel: a.fuelValue ?? '', transmission: a.gearboxValue ?? '', drive: a.driveValue ?? '',
      kw: number(a.enginePower, 1, 2000)?.toString() ?? null,
      motor: a.engineCapacity ? `${a.engineCapacity} ccm` : '', body: a.bodyworkValue ?? '',
      vin: /^[A-HJ-NPR-Z0-9]{17}$/.test(a.vin ?? '') ? a.vin : null,
      title: a.title ?? '', vehicle_type: vehicleType, category: a.categoryValue,
      description: text(a.description ?? ''), other_equipment: text(a.otherEquipment ?? ''),
      equipment: equipmentText || equipment.join(', '), equipment_json: JSON.stringify(equipment),
      equipment_ids_json: JSON.stringify(Array.isArray(a.carEquipment) ? a.carEquipment.filter(v => typeof v === 'number') : []),
      equipment_source: 'published_equipment',
      color: a.colorValue ?? '', seats: a.numberOfSeatsValue ?? null, doors: a.numberOfDoorsValue ?? null,
      engine_ccm: number(a.engineCapacity, 1, 30000)?.toString() ?? null,
      engine_l: a.engineCapacity ? String(Number(a.engineCapacity) / 1000) : null,
      condition: a.conditionValue ?? '', emission_standard: a.emissionStandardValue ?? '',
      additional_information: text(a.additionalInformationValue ?? ''),
    };
  }
  return { ...row, source_url: identity.url, source_db: identity.source,
    source_id: identity.id, market: 'SK', currency: 'EUR',
    brand_norm: foldSk(row.brand), model_norm: foldSk(row.model), fuel_norm: normalizePowertrain(row) || foldSk(row.fuel),
    transmission_norm: foldSk(row.transmission), drive_norm: foldSk(row.drive),
    motor_norm: foldSk(row.motor), is_active: 1, last_seen_at: now, last_checked_at: now,
    trim_norm: foldSk([row.title,row.equipment,row.other_equipment,row.description].filter(Boolean).join(' ')),
    listing_status: row.price && row.year ? 'priced' : row.price ? 'missing_year' : 'unpriced',
    missing_checks: 0, missing_since: null, inactive_at: null };
}
