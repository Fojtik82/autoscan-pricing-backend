import { parseBazosListing } from "./bazos_lifecycle.js";

const CURRENT_YEAR = new Date().getUTCFullYear();

const PERSONAL_CATEGORIES = [
  ["alfa", "Alfa Romeo"], ["audi", "Audi"], ["bmw", "BMW"],
  ["citroen", "Citroen"], ["dacia", "Dacia"], ["fiat", "Fiat"],
  ["ford", "Ford"], ["honda", "Honda"], ["hyundai", "Hyundai"],
  ["chevrolet", "Chevrolet"], ["kia", "Kia"], ["mazda", "Mazda"],
  ["mercedes", "Mercedes-Benz"], ["mitsubishi", "Mitsubishi"],
  ["nissan", "Nissan"], ["opel", "Opel"], ["peugeot", "Peugeot"],
  ["renault", "Renault"], ["seat", "Seat"], ["suzuki", "Suzuki"],
  ["skoda", "Skoda"], ["toyota", "Toyota"], ["volkswagen", "Volkswagen"],
  ["volvo", "Volvo"], ["ostatni", null],
].map(([slug, brand]) => ({ host: "auto.bazos.cz", slug, group: "auto", brand }));

const UTILITY_CATEGORIES = ["dodavka", "pickup", "mikrobus"].map((slug) => ({
  host: "auto.bazos.cz",
  slug,
  group: "dodavky",
  brand: null,
}));

const MOTORCYCLE_CATEGORIES = [
  "cestovni", "ctyrkolky", "chopper", "enduro", "minibike", "mopedy",
  "silnicni", "skutry", "vodni", "snezne", "trikolky", "veterani",
].map((slug) => ({
  host: "motorky.bazos.cz",
  slug,
  group: "motorky",
  brand: null,
}));

export const BAZOS_DAILY_CATEGORIES = [
  ...PERSONAL_CATEGORIES,
  ...UTILITY_CATEGORIES,
  ...MOTORCYCLE_CATEGORIES,
];

export function normalizeBazosText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function canonicalBazosUrl(host, href) {
  try {
    const url = new URL(href, `https://${host}/`);
    const listing = parseBazosListing(url.href);
    return listing ? url.href : null;
  } catch {
    return null;
  }
}

function parseCzechDate(value) {
  const match = String(value || "").match(/(\d{1,2})\.(\d{1,2})\.\s*(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseBazosListingPage(html, category) {
  const listings = [];
  const seen = new Set();
  const sections = String(html || "").split(/<div\s+class=["']?inzeraty\s+inzeratyflex["']?\s*>/i).slice(1);
  for (const section of sections) {
    const hrefMatch = section.match(/href=["']([^"']*\/inzerat\/(\d+)\/[^"']+)["']/i);
    if (!hrefMatch) continue;
    const url = canonicalBazosUrl(category.host, hrefMatch[1]);
    const listing = parseBazosListing(url);
    if (!url || !listing || seen.has(listing.key)) continue;
    const titleMatch = section.match(/<(?:h2|span)\s+class=["']?nadpis["']?[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const dateMatch = section.match(/\[(\d{1,2}\.\d{1,2}\.\s*\d{4})\]/);
    seen.add(listing.key);
    listings.push({
      ...listing,
      url,
      title: htmlToText(titleMatch?.[1] || ""),
      postedDate: parseCzechDate(dateMatch?.[1]),
      category,
    });
  }

  const totalMatch = String(html || "").match(/Zobrazeno\s+[\d\s]+-[\d\s]+\s+inzer[aá]t[^<]*\s+z\s+([\d\s]+)/i);
  const total = totalMatch ? Number(totalMatch[1].replace(/\s/g, "")) : listings.length;
  return { listings, total: Number.isFinite(total) ? total : listings.length };
}

export function bazosCategoryPageUrl(category, offset = 0) {
  const suffix = offset > 0 ? `${offset}/` : "";
  return `https://${category.host}/${category.slug}/${suffix}`;
}

export function parseBazosSitemapIndex(xml, expectedHost) {
  const urls = [];
  const pattern = /<loc>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = pattern.exec(String(xml || "")))) {
    const value = decodeHtmlEntities(match[1].trim());
    try {
      const url = new URL(value);
      if (url.hostname === expectedHost && url.pathname === "/sitemapdetail.php") urls.push(url.href);
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return [...new Set(urls)];
}

export function parseBazosSitemapDetail(xml, expectedHost) {
  const keys = new Set();
  const entries = [];
  const pattern = /<url>\s*<loc>([\s\S]*?)<\/loc>(?:\s*<lastmod>([\s\S]*?)<\/lastmod>)?[\s\S]*?<\/url>/gi;
  let match;
  while ((match = pattern.exec(String(xml || "")))) {
    const url = decodeHtmlEntities(match[1].trim());
    const listing = parseBazosListing(url);
    if (!listing || listing.domain !== expectedHost || keys.has(listing.key)) continue;
    keys.add(listing.key);
    entries.push({ ...listing, url, lastmod: match[2]?.trim() || null });
  }
  return entries;
}

export function parseBazosSiteTotal(html, label) {
  const pattern = new RegExp(`Inzer[aá]ty\\s+${label}\\s+celkem:\\s*<b>([\\d\\s]+)<\\/b>`, "i");
  const match = String(html || "").match(pattern);
  return match ? Number(match[1].replace(/\s/g, "")) : null;
}

export function createBazosTaxonomy(rows) {
  const brands = new Map();
  const modelsByBrand = new Map();
  for (const row of rows || []) {
    const brand = String(row.brand || "").trim();
    const model = String(row.model || "").trim();
    const brandNorm = normalizeBazosText(brand);
    const modelNorm = normalizeBazosText(model);
    if (!brandNorm || brandNorm.length < 2) continue;
    if (!brands.has(brandNorm)) brands.set(brandNorm, brand);
    if (
      !modelNorm
      || modelNorm.length < 2
      || !/[a-z]/.test(modelNorm)
      || modelNorm === brandNorm
      || ["prodam", "koupim", "ostatni", "neznamy"].includes(modelNorm)
    ) continue;
    if (!modelsByBrand.has(brandNorm)) modelsByBrand.set(brandNorm, new Map());
    modelsByBrand.get(brandNorm).set(modelNorm, model);
  }
  return {
    brands: [...brands.entries()]
      .map(([norm, name]) => ({ norm, name }))
      .sort((a, b) => b.norm.length - a.norm.length),
    modelsByBrand: new Map(
      [...modelsByBrand.entries()].map(([brand, models]) => [
        brand,
        [...models.entries()]
          .map(([norm, name]) => ({ norm, name }))
          .sort((a, b) => b.norm.length - a.norm.length),
      ]),
    ),
  };
}

function inferBrand(title, description, category, taxonomy) {
  if (category.brand) {
    const requested = normalizeBazosText(category.brand);
    return taxonomy.brands.find(({ norm }) => norm === requested)?.name || category.brand;
  }
  const haystack = ` ${normalizeBazosText(title)} `;
  const matches = taxonomy.brands
    .map((brand) => ({ ...brand, index: haystack.indexOf(` ${brand.norm} `) }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index || b.norm.length - a.norm.length);
  if (matches.length) return matches[0].name;

  const ignored = new Set([
    "prodam", "nabizim", "prodej", "rezervace", "motorka", "motocykl",
    "skutr", "vodni", "snezny", "ctyrkolka", "trikolka", "veteran",
  ]);
  const fallback = normalizeBazosText(title)
    .split(" ")
    .find((token) => token.length >= 3 && !ignored.has(token) && !/^\d/.test(token));
  return fallback ? fallback[0].toUpperCase() + fallback.slice(1) : null;
}

function deriveModel(title, brand) {
  let value = String(title || "")
    .replace(/^(?:prod[aá]m|nab[ií]z[ií]m|prodej|koup[ií]m)\s+/i, "")
    .replace(/^(?:motorka|motocykl|sk[uú]tr|vodn[ií]\s+sk[uú]tr|sn[eě][zž]n[yý]\s+sk[uú]tr|[cč]ty[rř]kolka|t[rř][ií]kolka)\s+/i, "")
    .trim();
  if (brand) {
    const words = brand.split(/[\s-]+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    value = value.replace(new RegExp(`^${words.join("[\\s-]*")}\\s*`, "i"), "");
  }
  const tokens = value.split(/\s+/).filter(Boolean);
  const selected = [];
  for (const token of tokens) {
    if (/^(?:19|20)\d{2}$/.test(token) || /^\d+[.,]\d+/.test(token) || /^\d{2,3}kw$/i.test(token)) break;
    selected.push(token.replace(/[,;|]+$/, ""));
    if (selected.length >= 4) break;
  }
  return selected.join(" ").trim() || null;
}

function looksLikeNonVehicleTitle(title) {
  const norm = normalizeBazosText(title);
  if (/^(?:koupim|hledam|vymenim)\b/.test(norm)) return true;
  return /\b(?:nahradni\s+dily|dily|motor|prevodovka|karburator|blatnik|riditka|sedlo|vyfuk|pneumatiky|pneu|helma|prilba|bunda|kalhoty|boty|rafek)\b/.test(norm);
}

function inferModel(title, brand, taxonomy) {
  const brandNorm = normalizeBazosText(brand);
  const titleNorm = ` ${normalizeBazosText(title)} `;
  const known = taxonomy.modelsByBrand.get(brandNorm) || [];
  const match = known.find(({ norm }) => titleNorm.includes(` ${norm} `));
  return match?.name || deriveModel(title, brand);
}

function extractYear(text) {
  const labelled = String(text).match(/(?:rok(?:\s+v[yý]roby)?|r\.?\s*v\.?|rv|modelov[yý]\s+rok|registrace)\D{0,16}((?:19|20)\d{2})/i);
  const candidates = [labelled?.[1], ...String(text).matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match?.[1]));
  return candidates.find((year) => year >= 1950 && year <= CURRENT_YEAR + 1) || null;
}

function extractMileage(text) {
  const match = String(text).match(/(?:najeto|n[aá]jezd|stav\s+tachometru)\D{0,20}(\d(?:[\d\s.]{0,10}\d)?)\s*(tis(?:[ií]c)?\.?|km)\b/i);
  if (!match) return null;
  let value = Number(match[1].replace(/[\s.]/g, ""));
  if (!Number.isFinite(value)) return null;
  if (/^tis/i.test(match[2] || "")) value *= 1000;
  return value >= 1 && value <= 2_000_000 ? Math.round(value) : null;
}

function extractPrice(html) {
  const match = String(html).match(/Cena:\s*<\/td>[\s\S]{0,300}?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (!match) return null;
  const digits = htmlToText(match[1]).match(/\d+/g)?.join("") || "";
  const price = Number(digits);
  return Number.isFinite(price) && price >= 10_000 && price <= 20_000_000 ? price : null;
}

function extractPower(text) {
  const match = String(text).match(/\b(\d{2,3})\s*kW\b/i);
  const value = Number(match?.[1]);
  return value >= 5 && value <= 1000 ? value : null;
}

function extractCcm(text) {
  const match = String(text).match(/\b(\d{2,4})\s*(?:ccm|cm3|cm³)\b/i);
  const value = Number(match?.[1]);
  return value >= 49 && value <= 9000 ? value : null;
}

function extractVin(text) {
  const labelled = String(text).match(/(?:VIN|W[Ii]N)\s*[:#-]?\s*([A-HJ-NPR-Z0-9]{17})\b/i);
  return labelled?.[1]?.toUpperCase() || null;
}

function extractFuel(text, category) {
  const norm = normalizeBazosText(text);
  if (/\b(?:nafta|diesel|tdi|dci|hdi|cdti|crdi)\b/.test(norm)) return "Diesel";
  if (/\b(?:elektro|electric)\b/.test(norm)) return "Elektro";
  if (/\bhybrid/.test(norm)) return "Hybrid";
  if (/\blpg\b/.test(norm)) return "LPG";
  if (/\bcng\b/.test(norm)) return "CNG";
  if (/\b(?:benzin\w*|tsi|tfsi|mpi)\b/.test(norm) || category.group === "motorky") return "Benzin";
  return null;
}

function extractTransmission(text) {
  const norm = normalizeBazosText(text);
  if (/\b(?:automat|dsg|s tronic|tiptronic|cvt|dct)\b/.test(norm)) return "Automat";
  if (/\bmanual/.test(norm)) return "Manual";
  return null;
}

function inferBody(text, category) {
  if (category.group === "motorky") return "Motorka";
  if (category.slug === "pickup") return "Pick-up";
  if (category.group === "dodavky") return category.slug === "mikrobus" ? "Mikrobus" : "Dodávka";
  const norm = normalizeBazosText(text);
  if (/\b(?:kombi|combi)\b/.test(norm)) return "Kombi";
  if (/\b(?:suv|crossover)\b/.test(norm)) return "SUV";
  if (/\bsedan\b/.test(norm)) return "Sedan";
  if (/\b(?:hatchback|hb)\b/.test(norm)) return "Hatchback";
  if (/\b(?:coupe|kupe)\b/.test(norm)) return "Kupé";
  if (/\b(?:cabrio|kabriolet)\b/.test(norm)) return "Kabriolet";
  return null;
}

export function parseBazosDetail(html, candidate, taxonomy, scrapedAt = new Date().toISOString()) {
  const canonicalMatch = String(html || "").match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
  const sourceUrl = canonicalBazosUrl(candidate.category.host, canonicalMatch?.[1] || candidate.url);
  const listing = parseBazosListing(sourceUrl);
  if (!listing || listing.key !== candidate.key) return null;

  const titleMatch = String(html || "").match(/<h1\s+class=["']?nadpisdetail["']?[^>]*>([\s\S]*?)<\/h1>/i);
  const descriptionMatch = String(html || "").match(/<div\s+class=["']?popisdetail["']?[^>]*>([\s\S]*?)<\/div>/i);
  const title = htmlToText(titleMatch?.[1] || candidate.title || "");
  const description = htmlToText(descriptionMatch?.[1] || "");
  if (looksLikeNonVehicleTitle(title)) return null;
  const text = `${title}\n${description}`;
  const price = extractPrice(html);
  const brand = inferBrand(title, description, candidate.category, taxonomy);
  const model = inferModel(title, brand, taxonomy);
  const year = extractYear(text);
  if (!sourceUrl || !title || !price || !brand || !model || !year) return null;

  const fuel = extractFuel(text, candidate.category);
  const transmission = extractTransmission(text);
  const kw = extractPower(text);
  const engineCcm = extractCcm(text);
  const drive = /\b(?:4x4|awd|4wd|quattro|xdrive)\b/i.test(text) ? "4x4" : null;
  const motorParts = [];
  if (engineCcm) motorParts.push(`${engineCcm} ccm`);
  if (kw) motorParts.push(`${kw} kW`);
  if (fuel) motorParts.push(fuel);
  const motor = motorParts.join(" / ") || null;

  return {
    brand,
    model,
    year: String(year),
    mileage: extractMileage(text)?.toString() || null,
    fuel,
    motor,
    price: String(price),
    transmission,
    drive,
    vin: extractVin(text),
    kw: kw?.toString() || null,
    body: inferBody(text, candidate.category),
    source_url: sourceUrl,
    source_db: `bazos_${candidate.category.group}_daily_cloud`,
    title,
    brand_norm: normalizeBazosText(brand),
    model_norm: normalizeBazosText(model),
    fuel_norm: normalizeBazosText(fuel),
    transmission_norm: normalizeBazosText(transmission),
    drive_norm: drive === "4x4" ? "4x4" : null,
    motor_norm: normalizeBazosText(motor),
    engine_ccm: engineCcm?.toString() || null,
    engine_l: engineCcm ? (Math.round((engineCcm / 1000) * 10) / 10).toFixed(1) : null,
    trim_norm: null,
    is_active: 1,
    last_seen_at: scrapedAt,
    last_checked_at: null,
    missing_since: null,
    missing_checks: 0,
    inactive_at: null,
  };
}
