import { parseNicheListing } from "./source_identity.js";

const SOURCES = [
  { id: "sportovnivozy", host: "www.sportovnivozy.cz", flag: "SPORTOVNIVOZY_ENABLED" },
  { id: "rajveteranu", host: "www.rajveteranu.cz", flag: "RAJVETERANU_ENABLED" },
];
const USER_AGENT = "CarPriceBot/1.0 (+https://github.com/Fojtik82/autoscan-pricing-backend)";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : fallback;
};
const fold = (value) => String(value || "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function decodeEntities(value) {
  const named = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|nbsp|amp|quot|apos|lt|gt);/gi,
    (whole, entity) => {
      const key = entity.toLowerCase();
      if (named[key] !== undefined) return named[key];
      const n = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n) : whole;
    });
}
function text(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function number(value, min, max) {
  const match = String(value || "").match(/^\s*([0-9][0-9\s\u00a0]*)/);
  if (!match) return null;
  const n = Number(match[1].replace(/\s/g, ""));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function isGone(html) {
  const value = fold(text(html));
  return /tento (?:sportovni vuz|veteran|inzerat) (?:byl )?jiz prodan/.test(value)
    || value.includes("inzerat jiz neni aktualni")
    || value.includes("tento inzerat je archivni")
    || value.includes("inzerat byl smazan")
    || value.includes("inzerat neexistuje")
    || value.includes("stranka neexistuje");
}

// Longest matching path; Allow wins ties. Never bypass robots or login.
function robotsPolicy(body) {
  const groups = [];
  let group = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], delay: 0, hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow", "crawl-delay"].includes(field)) {
      group.hasRules = true;
      if (field === "crawl-delay") {
        if (Number.isFinite(Number(value))) group.delay = Math.max(group.delay, Number(value) * 1000);
      } else if (value) {
        const anchored = value.endsWith("$");
        const pattern = (anchored ? value.slice(0, -1) : value).split("*")
          .map((part) => part.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")).join(".*");
        group.rules.push({
          allow: field === "allow", length: value.replace(/[*$]/g, "").length,
          pattern: new RegExp("^" + pattern + (anchored ? "$" : "")),
        });
      }
    }
  }
  const scored = groups.map((entry) => ({
    ...entry,
    score: Math.max(-1, ...entry.agents.map((agent) =>
      agent === "*" ? 0 : "carpricebot".includes(agent) ? agent.length : -1)),
  }));
  const best = Math.max(-1, ...scored.map((entry) => entry.score));
  const selected = best < 0 ? [] : scored.filter((entry) => entry.score === best);
  return {
    delay: Math.max(0, ...selected.map((entry) => entry.delay)),
    allows(url) {
      const path = url.pathname + url.search;
      const rules = selected.flatMap((entry) => entry.rules)
        .filter((rule) => rule.pattern.test(path))
        .sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
      return !rules.length || rules[0].allow;
    },
  };
}

async function makeReader(source) {
  let policy = null;
  let queue = Promise.resolve();
  let lastStarted = 0;
  let delay = bounded(process.env.NICHE_REQUEST_DELAY_MS, 600, 500, 60000);
  async function pace() {
    const next = queue.then(async () => {
      await sleep(Math.max(0, lastStarted + delay - Date.now()));
      lastStarted = Date.now();
    });
    queue = next.catch(() => {});
    await next;
  }
  async function read(input, robots = false) {
    let url = new URL(input);
    for (let hop = 0; hop < 4; hop += 1) {
      if (url.protocol !== "https:" || url.username || url.password || url.port
          || ![source.host, source.host.replace(/^www\./, "")].includes(url.hostname)) {
        throw new Error(source.id + ": unsafe redirect or URL");
      }
      if (!robots && !policy.allows(url)) throw new Error(source.id + ": robots disallows URL");
      await pace();
      const response = await fetch(url, {
        redirect: "manual", signal: AbortSignal.timeout(30000),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.8" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error(source.id + ": redirect without location");
        url = new URL(location, url);
        continue;
      }
      if ([404, 410].includes(response.status)) {
        await response.body?.cancel();
        return { status: response.status, url: url.href, html: "" };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(source.id + ": HTTP " + response.status);
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) throw new Error(source.id + ": response too large");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const type = response.headers.get("content-type") || "";
      const charset = /charset\s*=\s*["']?([a-z0-9-]+)/i.exec(type)?.[1] || "utf-8";
      const html = new TextDecoder(charset).decode(bytes);
      const title = text(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
      if (/just a moment|access denied|verify you are human|captcha/i.test(title)) {
        throw new Error(source.id + ": access challenge");
      }
      return { status: 200, url: url.href, html };
    }
    throw new Error(source.id + ": too many redirects");
  }
  const robots = await read("https://" + source.host + "/robots.txt", true);
  policy = robotsPolicy(robots.status === 404 || robots.status === 410 ? "" : robots.html);
  delay = Math.max(delay, policy.delay);
  if (delay > 60000) throw new Error(source.id + ": crawl-delay exceeds run budget");
  return read;
}

export function parseNicheIndex(html, baseUrl) {
  const origin = new URL(baseUrl);
  const source = SOURCES.find((entry) => entry.host === origin.hostname);
  if (!source || !/<h1\b[^>]*>[^<]*kompletn/i.test(html)) {
    throw new Error("Unexpected niche index page");
  }
  const listings = new Map();
  const cards = [...html.matchAll(
    /<table\b[^>]*class=['"](?=[^'"]*\bvypisDilo\b)(?=[^'"]*\bzalamovaniTextu\b)[^'"]*['"][^>]*>([\s\S]*?)<\/table>/gi,
  )];
  for (const card of cards) {
    for (const link of card[1].matchAll(/href\s*=\s*['"]([^'"]+)['"]/gi)) {
      const parsed = parseNicheListing(new URL(decodeEntities(link[1]), baseUrl).href);
      if (parsed?.source === source.id) {
        listings.set(parsed.key, parsed);
        break;
      }
    }
  }
  if (listings.size < 1 || listings.size > 30 || cards.length !== listings.size) {
    throw new Error(source.id + ": invalid index card coverage");
  }
  let pages = 1;
  for (const link of html.matchAll(/href\s*=\s*['"]([^'"]+)['"]/gi)) {
    const url = new URL(decodeEntities(link[1]), baseUrl);
    if (url.origin !== origin.origin || url.pathname !== "/index.php"
        || url.searchParams.get("akce") !== "komplet") continue;
    const page = Number(url.searchParams.get("strana"));
    if (Number.isInteger(page) && page > pages) pages = page;
  }
  return { listings: [...listings.values()], pages };
}

export function parseNicheDetail(html, listing) {
  if (isGone(html)) return { status: "gone" };
  const fields = {};
  const rows = html.matchAll(
    /<td\b[^>]*>\s*([^<>]{1,100})\s*<\/td>\s*<td\b[^>]*>\s*(?:&nbsp;|\s)*<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi,
  );
  for (const row of rows) fields[fold(text(row[1]))] = text(row[2]);
  // Never-edited listings have only an insertion date on both sites.
  if (!fields.znacka || !fields.model
      || !(fields["datum aktualizace"] || fields["datum vlozeni"])) {
    throw new Error(listing.source + ": unrecognized detail structure");
  }
  const year = number(fields["rok vyroby"], 1886, new Date().getUTCFullYear() + 1);
  if (year === null) return { status: "unsupported" };
  const body = text(html);
  // Take the primary gross CZK asking price only, never net VAT or EUR.
  const priceLabel = body.match(/\bCena:\s*([^:]{0,120})/i)?.[1] || "";
  const priceMatch = priceLabel.match(/^([0-9][0-9\s\u00a0]*)\s*(?:K\u010d|CZK)(?=\s|$)/i);
  const price = priceMatch ? number(priceMatch[1], 1000, 1000000000) : null;
  const fuel = fields.palivo || "";
  const fuelText = fold(fuel);
  const fuelNorm = /hybrid/.test(fuelText) ? "hybrid"
    : /nafta|diesel/.test(fuelText) ? "diesel"
    : /benzin/.test(fuelText) ? "benzin"
    : /elektr/.test(fuelText) ? "elektro" : fuelText;
  const transmission = fields.prevodovka || "";
  const drive = fields["pohanena kola"] || "";
  const driveText = fold(drive);
  const engineCcm = number(fields["zdvihovy objem"], 1, 30000);
  const trim = fields.typ || "";
  return {
    status: "parsed",
    row: {
      brand: fields.znacka, model: fields.model, year: String(year),
      mileage: number(fields.najeto, 0, 10000000),
      fuel, motor: trim, price, transmission, drive,
      kw: number(fields.vykon, 1, 5000), body: fields.karoserie || "",
      source_url: listing.url, source_db: listing.source + "_daily_cloud",
      title: text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || ""),
      brand_norm: fold(fields.znacka), model_norm: fold(fields.model),
      fuel_norm: fuelNorm, motor_norm: fold(trim), trim_norm: fold(trim),
      transmission_norm: /auto/.test(fold(transmission)) ? "automat"
        : /man/.test(fold(transmission)) ? "manual" : fold(transmission),
      drive_norm: /4x4|awd/.test(driveText) ? "4x4"
        : /predni/.test(driveText) ? "fwd" : /zadni/.test(driveText) ? "rwd" : driveText,
      engine_ccm: engineCcm, engine_l: engineCcm === null ? null : String(engineCcm / 1000),
    },
  };
}

async function collect(source) {
  const read = await makeReader(source);
  const root = "https://" + source.host;
  const first = await read(root + "/komplet");
  if (first.status !== 200) throw new Error(source.id + ": index unavailable");
  const parsed = parseNicheIndex(first.html, root);
  const maxPages = bounded(process.env.NICHE_MAX_PAGES, 600, 1, 1200);
  if (parsed.pages > maxPages) throw new Error(source.id + ": index exceeds page budget");
  const listings = new Map(parsed.listings.map((item) => [item.key, item]));
  for (let page = 2; page <= parsed.pages; page += 1) {
    const response = await read(root + "/index.php?akce=komplet&strana=" + page);
    if (response.status !== 200) throw new Error(source.id + ": incomplete index");
    const part = parseNicheIndex(response.html, root);
    if (part.pages > parsed.pages || (page < parsed.pages && part.listings.length !== 30)) {
      throw new Error(source.id + ": index changed or page is incomplete");
    }
    for (const item of part.listings) listings.set(item.key, item);
  }
  const expectedMin = Math.max(1, (parsed.pages - 1) * 30 + 1);
  if (listings.size < Math.ceil(expectedMin * 0.99)) {
    throw new Error(source.id + ": insufficient unique index coverage");
  }
  const maxDetails = bounded(process.env.NICHE_MAX_DETAILS, 20000, 1, 50000);
  if (listings.size > maxDetails) throw new Error(source.id + ": detail budget exceeded");
  const candidates = [...listings.values()];
  const results = [];
  let cursor = 0;
  let failure = null;
  async function worker() {
    while (!failure && cursor < candidates.length) {
      const item = candidates[cursor++];
      try {
        const response = await read(item.url);
        let parsedDetail;
        if ([404, 410].includes(response.status)
            || /^\/(?:prodano|smazano)\/?$/.test(new URL(response.url).pathname)) {
          parsedDetail = { status: "gone" };
        } else {
          const actual = parseNicheListing(response.url);
          if (!actual || actual.key !== item.key) throw new Error("Unexpected detail redirect");
          parsedDetail = parseNicheDetail(response.html, actual);
        }
        results.push({ ...parsedDetail, key: item.key });
        if (results.length % 250 === 0) {
          console.log(source.id + ": details " + results.length + "/" + candidates.length);
        }
      } catch (error) {
        failure = new Error(item.url + ": " + String(error.message || error));
      }
    }
  }
  // Two paced workers per source; no proxies, login or challenge bypass.
  await Promise.all([worker(), worker()]);
  if (failure) throw failure;
  const accepted = results.filter((item) => item.status === "parsed");
  if (!accepted.length || results.filter((item) => item.status === "unsupported").length
      > Math.max(3, Math.floor(results.length * 0.02))) {
    throw new Error(source.id + ": unusable detail coverage");
  }
  return { source, results, indexed: listings.size, pages: parsed.pages };
}

function applyCollection(db, batch, { dryRun, missingChecks }) {
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT rowid, source_url, is_active, last_checked_at, missing_checks FROM vehicle_app"
    + " WHERE lower(source_url) LIKE ?",
  ).all("%" + batch.source.id + ".cz/%").filter((row) =>
    parseNicheListing(row.source_url)?.source === batch.source.id);
  const byKey = new Map();
  for (const row of existing) {
    const key = parseNicheListing(row.source_url).key;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const parsed = batch.results.filter((item) => item.status === "parsed");
  const unsupported = new Set(batch.results.filter((item) => item.status === "unsupported")
    .map((item) => item.key));
  const live = new Set(parsed.map((item) => item.key));
  const summary = {
    source: batch.source.id, ok: true, dry_run: dryRun, indexed: batch.indexed,
    parsed: parsed.length, priced: parsed.filter((item) => item.row.price !== null).length,
    unpriced: parsed.filter((item) => item.row.price === null).length,
    unsupported: unsupported.size, inserted: 0, updated: 0, deactivated: 0,
    checked_at: now,
  };
  if (dryRun) return summary;
  // Commit a source atomically only after all index/detail requests succeeded.
  db.transaction(() => {
    const columns = Object.keys(parsed[0].row);
    const insert = db.prepare("INSERT INTO vehicle_app ("
      + columns.join(",") + ",is_active,last_seen_at,last_checked_at,missing_checks)"
      + " VALUES (" + columns.map(() => "?").join(",") + ",1,?,?,0)");
    const update = db.prepare("UPDATE vehicle_app SET "
      + columns.map((column) => column + "=?").join(",")
      + ",is_active=1,last_seen_at=?,last_checked_at=?,missing_checks=0,"
      + "missing_since=NULL,inactive_at=NULL WHERE rowid=?");
    for (const item of parsed) {
      const values = columns.map((column) => item.row[column] ?? null);
      const matches = byKey.get(item.key) || [];
      if (!matches.length) {
        insert.run(...values, now, now);
        summary.inserted += 1;
      } else {
        for (const match of matches) update.run(...values, now, now, match.rowid);
        summary.updated += 1;
      }
    }
    const missing = db.prepare("UPDATE vehicle_app SET last_checked_at=?,"
      + "missing_since=COALESCE(missing_since,?),missing_checks=?,"
      + "is_active=CASE WHEN ? >= ? THEN 0 ELSE is_active END,"
      + "inactive_at=CASE WHEN ? >= ? THEN COALESCE(inactive_at,?) ELSE inactive_at END"
      + " WHERE rowid=?");
    const unknown = db.prepare("UPDATE vehicle_app SET last_checked_at=? WHERE rowid=?");
    for (const row of existing) {
      const key = parseNicheListing(row.source_url).key;
      if (live.has(key)) continue;
      if (unsupported.has(key)) { unknown.run(now, row.rowid); continue; }
      if (String(row.last_checked_at || "").slice(0, 10) === now.slice(0, 10)) continue;
      const checks = Math.max(0, Number(row.missing_checks) || 0) + 1;
      missing.run(now, now, checks, checks, missingChecks, checks, missingChecks, now, row.rowid);
      if (checks >= missingChecks && Number(row.is_active) !== 0) summary.deactivated += 1;
    }
    db.exec("CREATE TABLE IF NOT EXISTS market_source_runs (source TEXT PRIMARY KEY,"
      + " completed_at TEXT NOT NULL, indexed INTEGER NOT NULL, priced INTEGER NOT NULL)");
    db.prepare("INSERT INTO market_source_runs(source,completed_at,indexed,priced)"
      + " VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET completed_at=excluded.completed_at,"
      + "indexed=excluded.indexed,priced=excluded.priced")
      .run(batch.source.id, now, batch.indexed, summary.priced);
  })();
  return summary;
}

export async function updateNicheSources(db, { dryRun = false, missingChecks = 3 } = {}) {
  const summaries = [];
  for (const source of SOURCES) {
    if (process.env[source.flag] === "0") {
      summaries.push({ source: source.id, ok: true, skipped: true, reason: "disabled" });
      continue;
    }
    try {
      const batch = await collect(source);
      const result = applyCollection(db, batch, {
        dryRun, missingChecks: bounded(missingChecks, 3, 1, 30),
      });
      summaries.push(result);
      console.log("NICHE_SOURCE " + JSON.stringify(result));
    } catch (error) {
      // Preserve this source, let other sources publish, and fail the job visibly.
      const result = { source: source.id, ok: false, error: String(error.message) };
      summaries.push(result);
      console.error("NICHE_SOURCE " + JSON.stringify(result));
    }
  }
  return summaries;
}
