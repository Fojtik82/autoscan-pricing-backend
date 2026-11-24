// Public sale listings only. No contacts, descriptions, images, or account actions.
const HOST = 'www.motoinzerce.cz';
const ROOT = `https://${HOST}`;
const UA = 'CarPriceBot/1.0 (+https://github.com/Fojtik82/autoscan-pricing-backend)';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const decode = text => String(text || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const plain = html => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const fold = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const numeric = text => { const digits = String(text || '').match(/[0-9][0-9\s.\u00a0]*/); return digits ? Number(digits[0].replace(/[^0-9]/g, '')) : null; };

export function listingIdentity(input) {
  let url;
  try { url = new URL(input, ROOT); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password) return null;
  const match = /^\/motorky\/([a-z0-9-]+)\/(\d+)-[a-z0-9-]+\.html$/i.exec(url.pathname);
  return match ? { id: match[2], brandSlug: match[1], url: ROOT + url.pathname } : null;
}

// Rules for our UA, with specific agent groups taking precedence over wildcard.
export function robotsAllows(body, path) {
  const groups = []; let current = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, ''); const pos = line.indexOf(':');
    if (pos < 0) continue;
    const key = line.slice(0, pos).trim().toLowerCase(); const value = line.slice(pos + 1).trim();
    if (key === 'user-agent') { if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); }
    else if (current && (key === 'allow' || key === 'disallow') && value) current.rules.push({ key, value });
    else if (current && key === 'crawl-delay' && Number(value) > 1) throw new Error('robots crawl-delay exceeds configured pace');
  }
  const scored = groups.map(g => ({ ...g, score: Math.max(-1, ...g.agents.map(a => a === '*' ? 0 : 'carpricebot'.includes(a) ? a.length : -1)) }));
  const best = Math.max(-1, ...scored.map(g => g.score));
  const matches = scored.filter(g => g.score === best && best >= 0).flatMap(g => g.rules).filter(r => {
    const regex = r.value.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\$$/, '$');
    return new RegExp('^' + regex).test(path);
  }).sort((a, b) => b.value.replace(/[*$]/g, '').length - a.value.replace(/[*$]/g, '').length || (a.key === 'allow' ? -1 : 1));
  return !matches.length || matches[0].key === 'allow';
}

export function parseMotoIndex(html) {
  const header = /id=["']vypis-info["'][^>]*>\s*Zobrazuji inzeráty:\s*(\d+)\s*-\s*(\d+)\s*z\s*(\d+)/i.exec(html);
  if (!header) throw new Error('Unrecognized MotoInzerce index');
  const entries = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<br\s*\/?>\s*([^<]+)<\/a>/gi)) {
    const item = listingIdentity(decode(match[1]));
    if (item) entries.set(item.id, { ...item, brand: plain(match[2]), model: plain(match[3]) });
  }
  const [first, last, total] = header.slice(1).map(Number);
  if (last < first || last > total || entries.size !== last - first + 1) throw new Error('Incomplete MotoInzerce page');
  return { first, last, total, entries: [...entries.values()] };
}

export function parseMotoDetail(html, item) {
  if (!listingIdentity(item.url) || !item.brand || !item.model) throw new Error('Invalid listing identity');
  const heading = /<h1\b[^>]*id=["']vypis-detail["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const category = /<strong>Zařazení:<\/strong>\s*<h2>\s*<a\b[^>]*href=["']\/podle-typu\/([^"']+)["'][^>]*>/i.exec(html);
  const detailId = /Výpis inzerátu id\s*(\d+)/i.exec(plain(html));
  if (!heading || !category || !detailId || detailId[1] !== item.id || fold(plain(heading[1])) !== fold(item.brand + ' ' + item.model)) throw new Error('Unrecognized or mismatched MotoInzerce detail');
  const validCategory = /^(?:detske-moto|chopper|minibike|moped|motokolo|nakedbike|pitbike|sidecar|silnicni-cestovni|silnicni-enduro|silnicni-sportovni|skutr|supermoto|terenni-cross|trial|zavodni-enduro|zavodni-silnicni)\/?$/i;
  if (!validCategory.test(category[1])) return { status: 'excluded', id: item.id };
  const field = label => plain(new RegExp('<strong>' + label + ':<\\/strong>([\\s\\S]*?)(?:<br\\s*\\/?>|<\\/p>)', 'i').exec(html)?.[1]);
  const year = numeric(field('Vyrobeno')); const ccm = numeric(field('Objem'));
  const mileage = numeric(field('Najeto')); const rawKw = field('Výkon').match(/\d+(?:[.,]\d+)?/); const kw = rawKw ? Number(rawKw[0].replace(',', '.')) : null;
  const priceText = plain(/<p\b[^>]*id=["']detail-cena["'][^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1]);
  const price = /kč/i.test(priceText) ? numeric(priceText) : null;
  if (!year || year < 1886 || year > new Date().getUTCFullYear() + 1 || !price || price < 1000 || !fold(item.brand) || !fold(item.model)) return { status: 'unsupported', id: item.id };
  return { status: 'parsed', id: item.id, row: { brand: item.brand, model: item.model, year: String(year), mileage,
    fuel: '', motor: '', price, transmission: '', drive: '', kw, body: 'motocykl',
    source_url: item.url, source_db: 'motoinzerce_daily_cloud', title: plain(heading[1]), brand_norm: fold(item.brand), model_norm: fold(item.model),
    fuel_norm: '', motor_norm: '', trim_norm: '', transmission_norm: '', drive_norm: '', engine_ccm: ccm, engine_l: ccm ? String(ccm / 1000) : null } };
}

// Bounded incremental import; incomplete indexes never deactivate data.
export async function collectMotoInzerce({ fetchImpl = fetch, maxPages = 150, maxDetails = 100, paceMs = 1000, known = new Map() } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200 || !Number.isInteger(maxDetails) || maxDetails < 1 || maxDetails > 200 || paceMs < 1000) throw new Error('Invalid crawl budget');
  let nextTime = 0; let robots = '';
  async function read(url, isRobots = false) {
    const parsed = new URL(url, ROOT);
    if (parsed.origin !== ROOT || parsed.username || parsed.password || (!isRobots && !robotsAllows(robots, parsed.pathname + parsed.search))) throw new Error('URL blocked by robots or host policy');
    await delay(Math.max(0, nextTime - Date.now())); nextTime = Date.now() + paceMs;
    const response = await fetchImpl(parsed.href, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (response.status !== 200) {
      const error = new Error('MotoInzerce HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const html = await response.text();
    if (html.length > 4_000_000 || /<title>\s*(just a moment|access denied|captcha)/i.test(html)) throw new Error('Unexpected MotoInzerce response');
    return html;
  }
  robots = await read(ROOT + '/robots.txt', true);
  const entries = new Map(); let total = null; let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const result = parseMotoIndex(await read(ROOT + '/motorky/' + (page ? '?od=' + (page * 10) : '')));
    // The number of ads may change while pages are being fetched. The index
    // is never used to deactivate records, so keep verified results even if
    // its total changes; the completeness flag remains conservative.
    if (result.first !== page * 10 + 1) throw new Error('Incomplete MotoInzerce index');
    total = result.total; for (const item of result.entries) entries.set(item.id, item);
    if (result.last === result.total) { complete = entries.size === total; break; }
  }
  // Reserve capacity for price refreshes so old active rows are not starved.
  const ordered = selectMotoDetails([...entries.values()], known, maxDetails);
  const results = [];
  let detailErrors = 0;
  for (const item of ordered) {
    try {
      results.push(parseMotoDetail(await read(item.url), item));
    } catch (error) {
      // A vanished or malformed ad is not evidence that the whole index has
      // disappeared. Rate limiting/access challenges must stop the crawl.
      if (error.status === 403 || error.status === 429 || /blocked by robots|challenge/i.test(error.message)) throw error;
      detailErrors += 1;
      if (detailErrors > 10) throw new Error('MotoInzerce detail error budget exceeded');
    }
  }
  if (ordered.length && !results.length) throw new Error('MotoInzerce no details could be verified');
  return { source: 'motoinzerce', indexComplete: complete, indexed: entries.size, results, detailErrors,
    deactivationSafe: false, detailsComplete: detailErrors === 0 && ordered.length === entries.size };
}

export function selectMotoDetails(all, known, maxDetails) {
  const fresh = all.filter(item => !known.has(item.id));
  const existing = all.filter(item => known.has(item.id)).sort((a, b) => String(known.get(a.id) || '').localeCompare(String(known.get(b.id) || '')));
  const share = Math.floor(maxDetails / 2);
  const chosen = [...fresh.slice(0, share), ...existing.slice(0, maxDetails - share)];
  return [...chosen, ...fresh, ...existing].filter((item, index, array) => array.findIndex(other => other.id === item.id) === index).slice(0, maxDetails);
}

export async function updateMotoInzerce(db, { dryRun = false, collect = collectMotoInzerce } = {}) {
  const existing = db.prepare("SELECT rowid, source_url, last_checked_at FROM vehicle_app WHERE source_db='motoinzerce_daily_cloud'").all();
  const known = new Map(); const rowsById = new Map();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='motoinzerce_checked'").get()) {
    for (const row of db.prepare('SELECT id, checked_at FROM motoinzerce_checked').all()) known.set(row.id, row.checked_at || '');
  }
  for (const row of existing) {
    const item = listingIdentity(row.source_url); if (!item) continue;
    if (!rowsById.has(item.id)) rowsById.set(item.id, []);
    rowsById.get(item.id).push(row); if (!known.has(item.id)) known.set(item.id, row.last_checked_at || '');
  }
  const batch = await collect({ known });
  const parsed = batch.results.filter(item => item.status === 'parsed');
  const summary = { source: 'motoinzerce', ok: true, dry_run: dryRun, index_complete: batch.indexComplete,
    details_complete: batch.detailsComplete, deactivation_safe: false, indexed: batch.indexed,
    checked: batch.results.length, detail_errors: batch.detailErrors || 0,
    parsed: parsed.length, inserted: 0, updated: 0, deactivated: 0 };
  if (dryRun || !batch.results.length) return summary;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS motoinzerce_checked (id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, status TEXT NOT NULL)');
    const remember = db.prepare('INSERT INTO motoinzerce_checked (id,checked_at,status) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status');
    for (const item of batch.results) remember.run(item.id, now, item.status);
    if (!parsed.length) return;
    const columns = Object.keys(parsed[0].row);
    const insert = db.prepare('INSERT INTO vehicle_app (' + columns.join(',') + ',is_active,last_seen_at,last_checked_at,missing_checks) VALUES (' + columns.map(() => '?').join(',') + ',1,?,?,0)');
    const update = db.prepare('UPDATE vehicle_app SET ' + columns.map(column => column + '=?').join(',') + ',is_active=1,last_seen_at=?,last_checked_at=?,missing_checks=0,missing_since=NULL,inactive_at=NULL WHERE rowid=?');
    for (const item of parsed) {
      const values = columns.map(column => item.row[column] ?? null); const matches = rowsById.get(item.id) || [];
      if (!matches.length) { insert.run(...values, now, now); summary.inserted++; }
      else for (const row of matches) { update.run(...values, now, now, row.rowid); summary.updated++; }
    }
  })();
  return summary;
}
