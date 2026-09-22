import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const DOV_FIELDS = ['DatumPrvniRegistrace', 'DatumPrvniRegistraceVCr', 'TovarniZnacka',
  'ObchodniOznaceni', 'MotorTyp', 'MotorMaxVykon', 'Palivo', 'VozidloDruh2',
  'VozidloVyrobce', 'MotorZdvihObjem', 'Barva', 'VozidloKategorie', 'Typ', 'Varianta', 'Verze'];
const VIN_FIELDS = ['VIN', 'Make', 'Model', 'Model Year', 'Year', 'Engine Power (kW)',
  'Engine (full)', 'Engine Model', 'Fuel Type - Primary', 'Transmission', 'Drive', 'Body',
  'Engine Displacement (ccm)', 'Number of Doors', 'Number of Seats'];

export class ProviderError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

// Keys are loaded only in the backend. Never commit this file or ship it in Flutter assets.
export function loadProviderEnvironment() {
  dotenv.config({ path: '/etc/secrets/carprice-vehicle-providers.env' });
}

export function createVehicleProvider({ databasePath = ':memory:', env = process.env,
  fetchImpl = fetch, now = Date.now } = {}) {
  const db = new Database(databasePath);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_cache (
    provider TEXT, vin TEXT, payload TEXT, expires INTEGER, PRIMARY KEY(provider, vin));
    CREATE TABLE IF NOT EXISTS provider_usage (
    provider TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(provider, day));`);
  const pending = new Map();
  const minute = new Map();
  const secrets = [env.DATAOVOZIDLECH_API_KEY, env.VINDECODER_API_KEY, env.VINDECODER_API_SECRET].filter(Boolean);
  const reserve = db.transaction((provider) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const limit = provider === 'dov' ? 1000 : 100;
    const used = db.prepare('SELECT count FROM provider_usage WHERE provider=? AND day=?').get(provider, day)?.count ?? 0;
    if (used >= limit) throw new ProviderError(429, 'vehicle_provider_daily_limit');
    db.prepare('INSERT INTO provider_usage VALUES (?, ?, 1) ON CONFLICT(provider,day) DO UPDATE SET count=count+1').run(provider, day);
    db.prepare('DELETE FROM provider_usage WHERE day < ?').run(day);
  });
  function safe(value) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (text.length > 2000 || secrets.some(s => text.includes(s))) return '';
    return text;
  }
  async function request(provider, vin) {
    let url, headers = { Accept: 'application/json' };
    if (provider === 'dov') {
      if (!env.DATAOVOZIDLECH_API_KEY) throw new ProviderError(503, 'vehicle_provider_not_configured');
      url = `https://api.dataovozidlech.cz/api/vehicletechnicaldata/v2?vin=${vin}`;
      headers.API_KEY = env.DATAOVOZIDLECH_API_KEY;
    } else {
      if (!env.VINDECODER_API_KEY || !env.VINDECODER_API_SECRET) throw new ProviderError(503, 'vehicle_provider_not_configured');
      const sum = createHash('sha1').update(`${vin}|decode|${env.VINDECODER_API_KEY}|${env.VINDECODER_API_SECRET}`).digest('hex').slice(0, 10);
      url = `https://api.vindecoder.eu/3.2/${encodeURIComponent(env.VINDECODER_API_KEY)}/${sum}/decode/${vin}.json`;
    }
    const bucket = Math.floor(now() / 60000);
    let usage = minute.get(provider);
    if (!usage || usage.bucket !== bucket) usage = { bucket, count: 0 };
    if (usage.count >= 20) throw new ProviderError(429, 'vehicle_provider_rate_limit');
    reserve(provider);
    usage.count++;
    minute.set(provider, usage);
    try {
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (response.status === 404) return provider === 'dov' ? { Status: 0 } : { decode: [] };
      if (!response.ok) throw new ProviderError(502, 'vehicle_provider_unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new ProviderError(502, 'vehicle_provider_invalid_response');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (provider === 'dov') {
        if (Number(data.Status) !== 1 || !data.Data || typeof data.Data !== 'object') return { Status: 0 };
        return { Status: 1, Data: Object.fromEntries(DOV_FIELDS.filter(k => k in data.Data).map(k => [k, safe(data.Data[k])])) };
      }
      if (!Array.isArray(data.decode)) throw new ProviderError(502, 'vehicle_provider_invalid_response');
      return { decode: data.decode.filter(row => row && VIN_FIELDS.includes(row.label)).map(row => ({ label: row.label, value: safe(row.value) })) };
    } catch (error) {
      // Upstream URLs and error text can contain credentials. Never log/return them.
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(502, 'vehicle_provider_unavailable');
    }
  }
  async function lookup(provider, rawVin) {
    const vin = String(rawVin ?? '').trim().toUpperCase();
    if (!['dov', 'vindecoder'].includes(provider) || !VIN.test(vin)) throw new ProviderError(400, 'invalid_vehicle_request');
    const cached = db.prepare('SELECT payload FROM provider_cache WHERE provider=? AND vin=? AND expires>?').get(provider, vin, now());
    if (cached) return JSON.parse(cached.payload);
    const key = `${provider}:${vin}`;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 4) throw new ProviderError(429, 'vehicle_provider_busy');
    const promise = request(provider, vin).then(payload => {
      db.prepare('DELETE FROM provider_cache WHERE expires<=?').run(now());
      const ttl = payload.Status === 0 || payload.decode?.length === 0 ? 3600000 : 7 * 86400000;
      db.prepare('INSERT OR REPLACE INTO provider_cache VALUES (?, ?, ?, ?)').run(provider, vin, JSON.stringify(payload), now() + ttl);
      return payload;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  return { lookup, close: () => db.close() };
}

export function registerVehicleProvider(app, provider) {
  app.get('/vehicle-data/:provider/:vin', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.json(await provider.lookup(req.params.provider, req.params.vin)); }
    catch (error) {
      const status = error instanceof ProviderError ? error.status : 503;
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({ error: error instanceof ProviderError ? error.code : 'vehicle_provider_unavailable' });
    }
  });
}
